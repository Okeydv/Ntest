// Сквозной тест устойчивости попарных сессий и раздачи ключей групп.
//
//   - повтор старого prekey-сообщения без одноразового prekey (сервер может
//     прислать его ещё раз) не заменяет рабочую сессию: раньше сессия
//     строилась по нему заново, и следующее сообщение не расшифровывалось;
//   - встречное начало переписки (оба написали первыми, пока не видели друг
//     друга) не ломает разговор: прежняя сессия уходит в архив, а не
//     стирается, и сообщения по ней читаются;
//   - раздача sender key «для» другой комнаты не принимается: комната
//     внутри раздачи обязана совпасть с комнатой, где пришёл конверт;
//   - signed prekey меняется раз в неделю; сообщение по старому bundle,
//     пришедшее после смены, читается; прежний ключ удаляется через 30 дней.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-e2ee-sessions.mjs

import { launch, finish } from './lib/browser.mjs';
import pg from 'pg';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };

const browser = await launch();
const errors = [];
const warnings = [];
let nextIp = 10;
async function openApp(label) {
    const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': `10.0.7.${nextIp++}` } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'warning') warnings.push(`${label}: ${m.text()}`); });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return { context, page, label };
}
const register = (app, u) => app.page.evaluate(async u => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'password123', confirmPassword: 'password123' }) });
    if (!r.success) throw new Error(r.message);
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
    return { userId: r.user.id, deviceId: e2eeDeviceId };
}, u);
const createRoom = (app, name) => app.page.evaluate(async name => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name }) });
    return { roomId: c.chat.room_id, code: (await api(`/api/chats/invite/${c.chat.id}`)).code };
}, name);
const join = (app, code) => app.page.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
const openRoom = async (page, roomId) => {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator(`.chat-item[data-room-id="${roomId}"]`).click({ timeout: 8000 });
    await page.waitForTimeout(900);
};
async function send(page, text) {
    await page.fill('#message-input', text);
    await page.click('#send-btn');
    await page.waitForTimeout(1200);
}
const texts = page => page.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .message-text')].map(el => el.textContent));
const waitText = (page, text) => page.waitForFunction(t =>
    [...document.querySelectorAll('#chat-messages .message-text')].some(el => el.textContent === t), text, { timeout: 8000 })
    .then(() => true, () => false);

/* ------------------------- повтор prekey-сообщения без OPK ------------------------- */

const alice = await openApp('alice');
const aliceInfo = await register(alice, 'alice');
const bob = await openApp('bob');
const bobInfo = await register(bob, 'bob');
const pair = await createRoom(alice, 'Вдвоём');
await join(bob, pair.code);

// Одноразовые prekeys Боба кончились: первое сообщение Алисы строится только
// на signed prekey — такое можно открыть заново сколько угодно раз.
// Удаляем после перезагрузок: при запуске клиент пополняет пул.
await openRoom(alice.page, pair.roomId);
await openRoom(bob.page, pair.roomId);
await db.query('DELETE FROM one_time_prekeys WHERE user_id = $1', [bobInfo.userId]);
await send(alice.page, 'первое');
check('Боб прочитал первое сообщение', await waitText(bob.page, 'первое'));
const firstId = (await db.query("SELECT min(id) AS id FROM messages WHERE room_id = $1 AND message_type <> 'system'", [pair.roomId])).rows[0].id;
const firstType = (await db.query('SELECT envelope_type FROM message_envelopes WHERE message_id = $1', [firstId])).rows[0].envelope_type;
check('первое сообщение — prekey', Number(firstType) === 1, firstType);

await send(bob.page, 'ответ');
check('Алиса прочитала ответ', await waitText(alice.page, 'ответ'));
await send(alice.page, 'второе');
check('Боб прочитал второе', await waitText(bob.page, 'второе'));

// Сервер присылает первое сообщение ещё раз.
const replay = await bob.page.evaluate(async id => {
    const client = await import('/crypto/client.js');
    const history = await api(`/api/messages/${currentChatId}`);
    const message = history.messages.find(m => m.id === id);
    return client.decryptIncoming({ ...message, id: -1 });
}, firstId);
check('повтор prekey-сообщения отвергнут', replay === null, JSON.stringify(replay));
await send(alice.page, 'третье');
check('и сессия цела: следующее сообщение читается', await waitText(bob.page, 'третье'));
await send(bob.page, 'и в обратную сторону');
check('в обратную сторону тоже', await waitText(alice.page, 'и в обратную сторону'));

/* ------------------------- встречное начало переписки ------------------------- */

const carol = await openApp('carol');
const carolInfo = await register(carol, 'carol');
const dave = await openApp('dave');
await register(dave, 'dave');
const race = await createRoom(carol, 'Встречные');
await join(dave, race.code);
await openRoom(carol.page, race.roomId);
await openRoom(dave.page, race.roomId);
// Сокеты отключены: каждый пишет первым, не видя сообщения другого.
await carol.page.evaluate(() => socket.disconnect());
await dave.page.evaluate(() => socket.disconnect());
await send(carol.page, 'Кэрол первая');
await send(dave.page, 'Дейв первый');
const types = (await db.query(
    `SELECT e.envelope_type FROM message_envelopes e JOIN messages m ON m.id = e.message_id WHERE m.room_id = $1`,
    [race.roomId])).rows.map(r => Number(r.envelope_type));
check('оба начали сессию сами (два prekey-сообщения)', types.length === 2 && types.every(t => t === 1), JSON.stringify(types));
await openRoom(carol.page, race.roomId);
await openRoom(dave.page, race.roomId);
check('Кэрол прочитала первое Дейва', (await texts(carol.page)).includes('Дейв первый'));
check('Дейв прочитал первое Кэрол', (await texts(dave.page)).includes('Кэрол первая'));
await send(carol.page, 'после гонки от Кэрол');
check('после встречного начала Дейв читает Кэрол', await waitText(dave.page, 'после гонки от Кэрол'));
await send(dave.page, 'после гонки от Дейва');
check('и Кэрол читает Дейва', await waitText(carol.page, 'после гонки от Дейва'));
await send(carol.page, 'и ещё раз');
check('и дальше разговор идёт', await waitText(dave.page, 'и ещё раз'));

/* ------------------------- раздача ключа для чужой комнаты ------------------------- */

// Комната B, где есть Боб, но нет Кэрол. Кэрол присылает Бобу в их общий
// чат «раздачу ключа» для комнаты B.
const roomB = await createRoom(bob, 'Без Кэрол');
const shared = await createRoom(carol, 'Кэрол и Боб');
await join(bob, shared.code);
await openRoom(carol.page, shared.roomId);
await openRoom(bob.page, shared.roomId);
warnings.length = 0;
await carol.page.evaluate(async roomB => {
    const group = await import('/crypto/group.js');
    const key = await group.createSenderKey();
    const text = JSON.stringify({ v: 1, t: 'skdm', room: roomB, ...group.senderKeyDistribution(key) });
    await sendEncryptedPayload(currentChatId, text);
}, roomB.roomId);
await bob.page.waitForTimeout(1500);
const stored = await bob.page.evaluate(async ({ roomB, carolDevice }) => {
    const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('nyxo-e2ee');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
    const keys = await new Promise(resolve => {
        const r = db.transaction('groupSessions').objectStore('groupSessions').getAllKeys();
        r.onsuccess = () => resolve(r.result);
    });
    return keys.filter(k => String(k).startsWith(`${roomB}:${carolDevice}:`)).length;
}, { roomB: roomB.roomId, carolDevice: carolInfo.deviceId });
check('ключ «для другой комнаты» не принят', stored === 0, `${stored} сохранено`);
check('и об этом предупреждение', warnings.some(w => w.includes('ключ для другой комнаты')), warnings.join(' | '));

/* ------------------------- ротация signed prekey ------------------------- */

// Запись в IndexedDB страницы — чтобы «состарить» ключи, не дожидаясь недели.
const idbPut = (page, key, value) => page.evaluate(async ({ key, value }) => {
    const idb = await new Promise((resolve, reject) => {
        const r = indexedDB.open('nyxo-e2ee');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
    await new Promise((resolve, reject) => {
        const t = idb.transaction('meta', 'readwrite');
        t.objectStore('meta').put(value, key);
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
    });
    idb.close();
}, { key, value });
const idbKeys = (page, store) => page.evaluate(async store => {
    const idb = await new Promise(resolve => { const r = indexedDB.open('nyxo-e2ee'); r.onsuccess = () => resolve(r.result); });
    const keys = await new Promise(resolve => {
        const r = idb.transaction(store).objectStore(store).getAllKeys();
        r.onsuccess = () => resolve(r.result);
    });
    idb.close();
    return keys;
}, store);
const serverSpk = async deviceId => Number((await db.query(
    'SELECT key_id FROM signed_prekeys WHERE device_id = $1', [deviceId])).rows[0].key_id);

const erin = await openApp('erin');
await register(erin, 'erin');
const frank = await openApp('frank');
const frankInfo = await register(frank, 'frank');
const spkRoom = await createRoom(erin, 'Ротация');
await join(frank, spkRoom.code);
check('у нового устройства signed prekey №1', await serverSpk(frankInfo.deviceId) === 1);

// Ключу Фрэнка «восемь дней»; сам Фрэнк не в сети.
await idbPut(frank.page, 'signedPrekeyCreatedAt', Date.now() - 8 * 24 * 3600 * 1000);
await frank.page.goto('about:blank');
await openRoom(erin.page, spkRoom.roomId);
await send(erin.page, 'по старому ключу');   // bundle ещё со старым SPK
frank.page = await frank.context.newPage();
frank.page.on('pageerror', e => errors.push(`frank: ${e.message}`));
await frank.page.goto(BASE, { waitUntil: 'networkidle' });
await frank.page.waitForTimeout(1500);
check('при запуске старый ключ сменился: на сервере №2', await serverSpk(frankInfo.deviceId) === 2);
await openRoom(frank.page, spkRoom.roomId);
check('сообщение по старому bundle, пришедшее после смены, читается', (await texts(frank.page)).includes('по старому ключу'));
check('прежний ключ пока хранится', JSON.stringify((await idbKeys(frank.page, 'signedPrekeys')).sort()) === '[1,2]',
    JSON.stringify(await idbKeys(frank.page, 'signedPrekeys')));

const gina = await openApp('gina');
await register(gina, 'gina');
const ginaRoom = await createRoom(gina, 'После ротации');
await join(frank, ginaRoom.code);
await openRoom(gina.page, ginaRoom.roomId);
await openRoom(frank.page, ginaRoom.roomId);
await send(gina.page, 'по новому ключу');
check('первый контакт после смены — по новому ключу, читается', await waitText(frank.page, 'по новому ключу'));

// Прошёл месяц: прежний ключ удаляется.
await idbPut(frank.page, 'retiredSignedPrekeys', [{ keyId: 1, retiredAt: Date.now() - 31 * 24 * 3600 * 1000 }]);
await frank.page.reload({ waitUntil: 'networkidle' });
await frank.page.waitForTimeout(1500);
check('через 30 дней прежний ключ удалён', JSON.stringify(await idbKeys(frank.page, 'signedPrekeys')) === '[2]',
    JSON.stringify(await idbKeys(frank.page, 'signedPrekeys')));

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
