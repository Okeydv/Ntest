// Сквозной тест реестра устройств и прокси к e2ee-key-server.
//
// Проверяет то, что видно только через HTTP: что /api/keys/* вообще
// смонтированы, что операции с ключами требуют зарегистрированного
// устройства, что device_id нельзя подделать, что bundle отдаётся набором
// по устройствам, что в приватном режиме доступно ровно одно устройство и
// что отзыв работает.
//
// Каждый «браузер» здесь — отдельный набор cookie, то есть отдельное
// устройство: device_id живёт в сессии, а не в запросе.
//
// Запуск (нужны Postgres, key-server и поднятый server.js):
//
//   PGDATA=/var/lib/postgresql/nyxo-test
//   DB="postgresql:///nyxo_app?host=$PGDATA&port=55432&user=postgres"
//
//   cd e2ee-key-server && DATABASE_URL="$DB" \
//     INTERNAL_SHARED_SECRET=test-secret-at-least-32-chars-long-xx \
//     BIND_ADDR=127.0.0.1:7422 cargo run &
//
//   DATABASE_URL="$DB" SESSION_SECRET=test-session-secret-at-least-32-chars-long \
//     INTERNAL_KEY_SERVER_SECRET=test-secret-at-least-32-chars-long-xx \
//     KEY_SERVER_URL=http://127.0.0.1:7422 PORT=3006 node server.js &
//
//   node scripts/integration-test-devices.mjs
//
// Тест рассчитан на ЧИСТУЮ базу: он регистрирует alice и bob, повторный
// прогон без пересоздания БД упадёт на занятых username.
import crypto from 'node:crypto';
const BASE = 'http://127.0.0.1:3006';
let fails = 0;
const check = (l, c, d='') => { console.log(`${c?'ok  ':'FAIL'}  ${l}${d?'  — '+d:''}`); if(!c) fails++; };

// Отдельная «сессия браузера»: свой набор cookie = своё устройство.
function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies].map(([k,v]) => `${k}=${v}`).join('; '),
    csrf: () => cookies.get('csrf_token') || '',
    absorb: (res) => {
      for (const c of (res.headers.getSetCookie?.() ?? [])) {
        const [pair] = c.split(';'); const i = pair.indexOf('=');
        cookies.set(pair.slice(0,i), pair.slice(i+1));
      }
    },
  };
}

async function req(j, method, path, body) {
  const headers = { Cookie: j.header() };
  if (j.csrf()) headers['X-CSRF-Token'] = j.csrf();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  j.absorb(res);
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const raw = k => k.export({ type:'spki', format:'der' }).subarray(-32);
const b64 = b => Buffer.from(b).toString('base64');

async function uploadKeys(j, opkCount) {
  const id = crypto.generateKeyPairSync('ed25519');
  const dh = crypto.generateKeyPairSync('x25519');
  const spk = crypto.generateKeyPairSync('x25519');
  const spkPub = raw(spk.publicKey);
  const dhPub = raw(dh.publicKey);
  const r1 = await req(j, 'PUT', '/api/keys/identity',
    { identity_signing_key: b64(raw(id.publicKey)), identity_dh_key: b64(dhPub),
      identity_dh_signature: b64(crypto.sign(null, Buffer.concat([Buffer.from('nyxo/identity-dh/v1'), dhPub]), id.privateKey)) });
  const r2 = await req(j, 'PUT', '/api/keys/signed-prekey',
    { key_id: 1, public_key: b64(spkPub), signature: b64(crypto.sign(null, spkPub, id.privateKey)) });
  const keys = Array.from({length:opkCount}, (_,i) => ({ key_id:i+1,
    public_key: b64(raw(crypto.generateKeyPairSync('x25519').publicKey)) }));
  const r3 = await req(j, 'POST', '/api/keys/one-time-prekeys', { keys });
  return [r1.status, r2.status, r3.status];
}

// --- пользователь A, устройство 1 -----------------------------------------
const a1 = jar();
await req(a1, 'GET', '/api/auth');
const regA = await req(a1, 'POST', '/api/register',
  { username:'alice', email:'alice@example.com', password:'password123', confirmPassword:'password123' });
check('регистрация пользователя A', regA.json?.success === true, JSON.stringify(regA.json).slice(0,80));
const userA = regA.json.user.id;

const noDev = await req(a1, 'GET', '/api/keys/one-time-prekeys/count');
check('операции с ключами без устройства отклоняются', noDev.status === 409, 'status ' + noDev.status);
check('роут /api/keys смонтирован (не 404)', noDev.status !== 404);

const d1 = await req(a1, 'POST', '/api/devices', { name: 'Ноутбук' });
check('устройство 1 зарегистрировано', d1.json?.success === true && d1.json.device.id > 0);
check('имя устройства сохранено', d1.json?.device?.name === 'Ноутбук');
check('ключи загружены с устройства 1', (await uploadKeys(a1, 2)).every(s => s === 200));

// --- то же пользователя A, второй «браузер» = второе устройство ------------
const a2 = jar();
await req(a2, 'GET', '/api/auth');
await req(a2, 'POST', '/api/login', { email:'alice@example.com', password:'password123' });
const d2 = await req(a2, 'POST', '/api/devices', { name: 'Телефон' });
check('устройство 2 зарегистрировано у того же аккаунта', d2.json?.success === true);
check('ключи загружены с устройства 2', (await uploadKeys(a2, 3)).every(s => s === 200));

// Подпись DH-ключа личности — от другого DH-ключа: сервер ключей не примет.
{
  const id = crypto.generateKeyPairSync('ed25519');
  const signedDh = raw(crypto.generateKeyPairSync('x25519').publicKey);
  const otherDh = raw(crypto.generateKeyPairSync('x25519').publicKey);
  const r = await req(a2, 'PUT', '/api/keys/identity', { identity_signing_key: b64(raw(id.publicKey)), identity_dh_key: b64(otherDh),
    identity_dh_signature: b64(crypto.sign(null, Buffer.concat([Buffer.from('nyxo/identity-dh/v1'), signedDh]), id.privateKey)) });
  check('подпись не от этого DH-ключа — сервер ключей отказывает', r.status === 400, `${r.status} ${JSON.stringify(r.json).slice(0, 80)}`);
}

// --- пользователь B запрашивает bundle -------------------------------------
const b = jar();
await req(b, 'GET', '/api/auth');
await req(b, 'POST', '/api/register',
  { username:'bob', email:'bob@example.com', password:'password123', confirmPassword:'password123' });
const beforeChat = await req(b, 'GET', `/api/keys/bundle/${userA}`);
check('без общего чата bundle не отдаётся', beforeChat.status === 404, 'status ' + beforeChat.status);
// Ключи — только собеседникам: заводим общий чат.
const shared = await req(a1, 'POST', '/api/chats', { name: 'Общий' });
const code = (await req(a1, 'GET', `/api/chats/invite/${shared.json.chat.id}`)).json.code;
await req(b, 'POST', '/api/chats/join', { code });
const bundle = await req(b, 'GET', `/api/keys/bundle/${userA}`);
const got = (bundle.json?.bundles ?? []).map(x => x.device_id).sort((x,y)=>x-y);
check('bundle отдаёт оба устройства получателя',
  got.length === 2 && got[0] === d1.json.device.id && got[1] === d2.json.device.id,
  'device_id: ' + JSON.stringify(got));
check('у каждого устройства свой identity-ключ',
  bundle.json.bundles[0].identity_dh_key !== bundle.json.bundles[1].identity_dh_key);

// --- device_id нельзя подделать -------------------------------------------
const spoof = await req(b, 'GET', '/api/devices');
check('B видит только свои устройства (их нет)', spoof.json?.devices?.length === 0);
const bindForeign = await req(b, 'POST', `/api/devices/${d1.json.device.id}/bind`);
check('привязка чужого устройства отклоняется', bindForeign.status === 404, 'status ' + bindForeign.status);

// --- повторный вход и bind своего устройства -------------------------------
const a3 = jar();
await req(a3, 'GET', '/api/auth');
await req(a3, 'POST', '/api/login', { email:'alice@example.com', password:'password123' });
const rebind = await req(a3, 'POST', `/api/devices/${d1.json.device.id}/bind`);
check('своё устройство привязывается к новой сессии', rebind.json?.success === true);
check('после bind операции с ключами работают',
  (await req(a3, 'GET', '/api/keys/one-time-prekeys/count')).status === 200);

// --- приватный режим: одно устройство -------------------------------------
const anon = jar();
await req(anon, 'GET', '/api/auth');
const regAnon = await req(anon, 'POST', '/api/register/anonymous');
check('вход в приватном режиме', regAnon.json?.success === true);
const ad1 = await req(anon, 'POST', '/api/devices', { name: 'Аноним-1' });
check('анониму доступно одно устройство (E2EE остаётся)', ad1.json?.success === true);
const ad2 = await req(anon, 'POST', '/api/devices', { name: 'Аноним-2' });
check('второе устройство анониму запрещено', ad2.status === 403, 'status ' + ad2.status);

// --- отзыв устройства ------------------------------------------------------
const rev = await req(a2, 'DELETE', `/api/devices/${d2.json.device.id}`);
check('устройство отозвано', rev.json?.success === true);
check('ключи устройства удалены на key-server', rev.json?.keysRemoved === true);
const after = await req(b, 'GET', `/api/keys/bundle/${userA}`);
check('отозванное устройство исчезло из bundle',
  after.json?.bundles?.length === 1 && after.json.bundles[0].device_id === d1.json.device.id);
const rebindRevoked = await req(a2, 'POST', `/api/devices/${d2.json.device.id}/bind`);
check('отозванное устройство нельзя привязать заново', rebindRevoked.status === 403, 'status ' + rebindRevoked.status);
const list = await req(a3, 'GET', '/api/devices');
check('отозванное устройство остаётся в списке с меткой',
  list.json?.devices?.length === 2 && list.json.devices.some(x => x.revoked_at !== null));

// Лимит устройств на аккаунт: у A сейчас одно активное (второе отозвано).
let lastCreated;
for (let i = 0; i < 10; i++) lastCreated = await req(a3, 'POST', '/api/devices', { name: `Устройство ${i}` });
check('больше десяти активных устройств не завести', lastCreated.status === 403
  && /10 устройств/.test(lastCreated.json?.message), `${lastCreated.status} ${lastCreated.json?.message}`);
const activeCount = (await req(a3, 'GET', '/api/devices')).json.devices.filter(x => !x.revoked_at).length;
check('активных ровно десять', activeCount === 10, String(activeCount));

console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
