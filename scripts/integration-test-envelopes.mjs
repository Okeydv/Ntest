// Сквозной тест транспорта конвертов (этап A1 E2EE).
//
// Проверяет то, что нельзя проверить в отрыве от сервера: что сервер не
// хранит открытый текст, что каждое устройство получает ИМЕННО свой
// конверт (и по HTTP, и по сокету), что header возвращается байт в байт
// (иначе развалится проверка AAD при AES-GCM), что конверт нельзя
// адресовать устройству вне чата и что отказ по одному конверту не
// оставляет в базе половину сообщения.
//
// Шифрования здесь нет намеренно: вместо шифротекста подставляются
// узнаваемые строки. Проверяется транспорт, а не крипта — она появится
// на этапе A2 и тестируется отдельно.
//
// Требует socket.io-client (dev-зависимость только для теста):
//   npm install --no-save socket.io-client
//
// Запуск — как у scripts/integration-test-devices.mjs, на ЧИСТОЙ базе:
//   node scripts/integration-test-envelopes.mjs
import { io as ioClient } from 'socket.io-client';
const BASE = 'http://127.0.0.1:3006';
let fails = 0;
const check = (l,c,d='') => { console.log(`${c?'ok  ':'FAIL'}  ${l}${d?'  — '+d:''}`); if(!c) fails++; };
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

function jar() {
  const c = new Map();
  return { header:()=>[...c].map(([k,v])=>`${k}=${v}`).join('; '), csrf:()=>c.get('csrf_token')||'',
    absorb:r=>{ for(const s of (r.headers.getSetCookie?.()??[])){ const [p]=s.split(';'); const i=p.indexOf('='); c.set(p.slice(0,i),p.slice(i+1)); } } };
}
async function req(j, method, path, body) {
  const headers = { Cookie: j.header() };
  if (j.csrf()) headers['X-CSRF-Token'] = j.csrf();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE+path, { method, headers, body: body===undefined?undefined:JSON.stringify(body) });
  j.absorb(r); let json=null; try { json = await r.json(); } catch {}
  return { status:r.status, json };
}
const socketFor = (j) => ioClient(BASE, { extraHeaders:{ Cookie:j.header() }, transports:['websocket'] });
const waitMsg = (sock, ms=3000) => new Promise(res => {
  const t = setTimeout(()=>res(null), ms);
  sock.once('newMessage', m => { clearTimeout(t); res(m); });
});

async function user(name, email) {
  const j = jar();
  await req(j, 'GET', '/api/auth');
  const r = await req(j, 'POST', '/api/register', { username:name, email, password:'password123', confirmPassword:'password123' });
  return { j, id: r.json.user.id };
}
async function extraSession(email) {
  const j = jar(); await req(j,'GET','/api/auth');
  await req(j,'POST','/api/login',{ email, password:'password123' });
  return j;
}
const addDevice = async (j, name) => (await req(j,'POST','/api/devices',{ name })).json.device.id;

// --- участники ---------------------------------------------------------
const A = await user('alice','alice@example.com');
const a1 = await addDevice(A.j, 'A-ноутбук');
const chat = await req(A.j, 'POST', '/api/chats', { name: 'Секретный чат' });
const chatIdA = chat.json.chat.id;
const code = (await req(A.j, 'GET', `/api/chats/invite/${chatIdA}`)).json.code;

const B = await user('bob','bob@example.com');
const b1 = await addDevice(B.j, 'B-ноутбук');
const joined = await req(B.j, 'POST', '/api/chats/join', { code });
const chatIdB = joined.json.chat.id;
const Bj2 = await extraSession('bob@example.com');
const b2 = await addDevice(Bj2, 'B-телефон');
check('участники и устройства созданы', !!(a1 && b1 && b2 && chatIdA && chatIdB),
  `A1=${a1} B1=${b1} B2=${b2}`);

// --- сокеты подключаются ПОСЛЕ регистрации устройств --------------------
const sA1 = socketFor(A.j), sB1 = socketFor(B.j), sB2 = socketFor(Bj2);
await new Promise(r => setTimeout(r, 900));
sA1.emit('joinChat', `chat:${chatIdA}`); sB1.emit('joinChat', `chat:${chatIdB}`);
await new Promise(r => setTimeout(r, 400));
const pA1 = waitMsg(sA1), pB1 = waitMsg(sB1), pB2 = waitMsg(sB2);

// --- отправка: свой конверт каждому устройству --------------------------
const sent = await req(A.j, 'POST', '/api/messages/encrypted', {
  chatId: chatIdA,
  envelopes: [
    { recipientDeviceId: a1, envelopeType: 1, header: b64('hdr-a1'), ciphertext: b64('ct-for-a1') },
    { recipientDeviceId: b1, envelopeType: 1, header: b64('hdr-b1'), ciphertext: b64('ct-for-b1') },
    { recipientDeviceId: b2, envelopeType: 1, header: b64('hdr-b2'), ciphertext: b64('ct-for-b2') },
  ],
});
check('зашифрованное сообщение принято', sent.json?.success === true, JSON.stringify(sent.json).slice(0,90));
check('конвертов хватило на все устройства', Array.isArray(sent.json?.missingDeviceIds) && sent.json.missingDeviceIds.length === 0);
check('открытого текста в ответе нет', sent.json?.message?.text === null && sent.json.message.encrypted === true);

// --- сервер не хранит открытый текст -----------------------------------
const hist = await req(B.j, 'GET', `/api/messages/${chatIdB}`);
const m = hist.json.messages.find(x => x.encrypted);
check('в истории сообщение помечено зашифрованным', !!m && m.text === null);
check('B-ноутбук получил ИМЕННО свой конверт',
  Buffer.from(m.envelope.ciphertext,'base64').toString() === 'ct-for-b1',
  Buffer.from(m.envelope.ciphertext,'base64').toString());

const histB2 = await req(Bj2, 'GET', `/api/messages/${chatIdB}`);
const m2 = histB2.json.messages.find(x => x.encrypted);
check('B-телефон получил свой, другой конверт',
  Buffer.from(m2.envelope.ciphertext,'base64').toString() === 'ct-for-b2');

const histA = await req(A.j, 'GET', `/api/messages/${chatIdA}`);
const mA = histA.json.messages.find(x => x.encrypted);
check('отправитель читает свой конверт (история после перезагрузки)',
  Buffer.from(mA.envelope.ciphertext,'base64').toString() === 'ct-for-a1');
check('header возвращается байт в байт (важно для AAD)',
  Buffer.from(mA.envelope.header,'base64').toString() === 'hdr-a1');

// --- доставка по сокету: каждому свой ----------------------------------
const [gA1, gB1, gB2] = await Promise.all([pA1, pB1, pB2]);
check('сокет: отправитель получил свой конверт',
  gA1 && Buffer.from(gA1.envelope.ciphertext,'base64').toString() === 'ct-for-a1');
check('сокет: B-ноутбук получил свой конверт',
  gB1 && Buffer.from(gB1.envelope.ciphertext,'base64').toString() === 'ct-for-b1');
check('сокет: B-телефон получил свой конверт без joinChat (личная комната устройства)',
  gB2 && Buffer.from(gB2.envelope.ciphertext,'base64').toString() === 'ct-for-b2');

// --- проверки на мусор --------------------------------------------------
const outsider = await user('carol','carol@example.com');
const c1 = await addDevice(outsider.j, 'C-ноутбук');
const foreign = await req(A.j, 'POST', '/api/messages/encrypted', { chatId: chatIdA,
  envelopes: [{ recipientDeviceId: c1, envelopeType: 1, header: b64('h'), ciphertext: b64('c') }] });
check('конверт устройству вне чата отклоняется', foreign.status === 403, 'status ' + foreign.status);

const dup = await req(A.j, 'POST', '/api/messages/encrypted', { chatId: chatIdA, envelopes: [
  { recipientDeviceId: b1, envelopeType: 1, header: b64('h'), ciphertext: b64('c') },
  { recipientDeviceId: b1, envelopeType: 2, header: b64('h'), ciphertext: b64('c') }] });
check('дубликат конверта для устройства отклоняется', dup.status === 400);

const badB64 = await req(A.j, 'POST', '/api/messages/encrypted', { chatId: chatIdA,
  envelopes: [{ recipientDeviceId: b1, envelopeType: 1, header: 'не base64!!', ciphertext: b64('c') }] });
check('некорректный base64 отклоняется', badB64.status === 400);

const badType = await req(A.j, 'POST', '/api/messages/encrypted', { chatId: chatIdA,
  envelopes: [{ recipientDeviceId: b1, envelopeType: 9, header: b64('h'), ciphertext: b64('c') }] });
check('неизвестный envelopeType отклоняется', badType.status === 400);

const empty = await req(A.j, 'POST', '/api/messages/encrypted', { chatId: chatIdA, envelopes: [] });
check('пустой список конвертов отклоняется', empty.status === 400);

const noDev = await extraSession('alice@example.com');
const noDevSend = await req(noDev, 'POST', '/api/messages/encrypted', { chatId: chatIdA,
  envelopes: [{ recipientDeviceId: b1, envelopeType: 1, header: b64('h'), ciphertext: b64('c') }] });
check('отправка без устройства в сессии отклоняется', noDevSend.status === 409, 'status ' + noDevSend.status);

// --- неполный набор конвертов ------------------------------------------
const partial = await req(A.j, 'POST', '/api/messages/encrypted', { chatId: chatIdA,
  envelopes: [{ recipientDeviceId: b1, envelopeType: 2, header: b64('h2'), ciphertext: b64('only-b1') }] });
check('неполный набор принимается, но недостающие названы',
  partial.json?.success === true &&
  partial.json.missingDeviceIds.sort((x,y)=>x-y).join(',') === [a1,b2].sort((x,y)=>x-y).join(','),
  'missing: ' + JSON.stringify(partial.json?.missingDeviceIds));
const histB2b = await req(Bj2, 'GET', `/api/messages/${chatIdB}`);
const orphan = histB2b.json.messages.find(x => x.id === partial.json.message.id);
check('устройство без конверта видит envelope: null, а не пустое сообщение',
  orphan && orphan.encrypted === true && orphan.envelope === null);

// --- транзакционность: откат при отказе ---------------------------------
const before = (await req(B.j,'GET',`/api/messages/${chatIdB}`)).json.messages.length;
await req(A.j, 'POST', '/api/messages/encrypted', { chatId: chatIdA, envelopes: [
  { recipientDeviceId: b1, envelopeType: 1, header: b64('h'), ciphertext: b64('c') },
  { recipientDeviceId: c1, envelopeType: 1, header: b64('h'), ciphertext: b64('c') }] });
const after = (await req(B.j,'GET',`/api/messages/${chatIdB}`)).json.messages.length;
check('отказ по одному конверту не оставляет половину сообщения', before === after,
  `до ${before}, после ${after}`);

// --- вложение привязывается только к одному сообщению -------------------
// Два одновременных запроса с одним blobId: проверка владения идёт до
// транзакции, и без повторной проверки внутри неё прошли бы оба.
const up = await fetch(`${BASE}/api/blobs?chatId=${chatIdA}`, { method: 'POST',
  headers: { Cookie: A.j.header(), 'X-CSRF-Token': A.j.csrf(), 'Content-Type': 'application/octet-stream' },
  body: new Uint8Array(64) });
const blobId = (await up.json()).blobId;
const sendWithBlob = () => req(A.j, 'POST', '/api/messages/encrypted', { chatId: chatIdA, blobIds: [blobId],
  envelopes: [{ recipientDeviceId: b1, envelopeType: 2, header: b64('h'), ciphertext: b64('file') }] });
const countBefore = (await req(B.j, 'GET', `/api/messages/${chatIdB}`)).json.messages.length;
const [w1, w2] = await Promise.all([sendWithBlob(), sendWithBlob()]);
const countAfter = (await req(B.j, 'GET', `/api/messages/${chatIdB}`)).json.messages.length;
check('одно вложение нельзя отправить дважды',
  [w1, w2].filter(r => r.json?.success).length === 1 && countAfter === countBefore + 1,
  `статусы ${w1.status}, ${w2.status}; сообщений +${countAfter - countBefore}`);

// --- чат с ботом не шифруется ------------------------------------------
// У Боба два устройства. Если бы получателями бот-чата считались его
// устройства, сообщения боту уходили бы шифротекстом и бот бы молчал.
const botChat = (await req(B.j, 'GET', '/api/chats')).json.chats.find(c => c.is_bot);
const botDevices = await req(B.j, 'GET', `/api/chats/${botChat.id}/devices`);
check('у чата с ботом нет устройств для шифрования',
  botDevices.json?.success === true && botDevices.json.devices.length === 0,
  JSON.stringify(botDevices.json?.devices));
const botSend = await req(B.j, 'POST', '/api/messages/encrypted', { chatId: botChat.id,
  envelopes: [{ recipientDeviceId: b2, envelopeType: 1, header: b64('h'), ciphertext: b64('c') }] });
check('зашифрованное сообщение в чат с ботом не принимается', botSend.status === 403, 'status ' + botSend.status);

sA1.close(); sB1.close(); sB2.close();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
