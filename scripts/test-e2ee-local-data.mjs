// Сквозной тест: что остаётся в браузере после удаления.
//
// Расшифрованный текст (а в нём и ключи вложений) хранится в IndexedDB:
// второй раз конверт не расшифровать. Проверяется, что он стирается:
//   - когда сообщение удалили, пока получатель в сети;
//   - когда удалили, пока его не было, — при следующем открытии чата;
//   - когда сообщение исчезло по сроку;
//   - когда из чата вышли — всё по этому чату;
//   - при выходе из аккаунта — всё, и устройство отзывается на сервере;
//     а если выйти, оставив устройство, — не стирается ничего, и после
//     входа то же устройство читает старую переписку.
// История приходит страницами: удалённое за пределами открытой страницы
// тоже стирается, старые страницы догружаются по порядку и расшифровываются.
// И что превью полученного сообщения в комнате лежит под этой комнатой
// (раньше — под чатом отправителя, и после перезагрузки его не было).
// И что о новом устройстве аккаунта узнают остальные — сразу или при
// следующем запуске, — а отозвать его можно из профиля.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-e2ee-local-data.mjs

import { launch, finish } from './lib/browser.mjs';
import pg from 'pg';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label, context) {
    context = context || await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': `10.0.8.${nextIp++}` } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
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
const waitText = (page, text) => page.waitForFunction(t =>
    [...document.querySelectorAll('#chat-messages .message-text')].some(el => el.textContent === t), text, { timeout: 8000 })
    .then(() => true, () => false);
const idOf = async (roomId, n) => (await db.query(
    "SELECT id FROM messages WHERE room_id = $1 AND message_type <> 'system' ORDER BY id LIMIT 1 OFFSET $2", [roomId, n])).rows[0].id;

// Всё, что лежит в IndexedDB: тексты сообщений и служебные записи.
const local = page => page.evaluate(async () => {
    const idb = await new Promise((resolve, reject) => {
        const r = indexedDB.open('nyxo-e2ee');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
    const dump = name => new Promise(resolve => {
        const store = idb.transaction(name).objectStore(name);
        const keys = store.getAllKeys();
        const values = store.getAll();
        values.onsuccess = () => resolve(keys.result.map((k, i) => [String(k), values.result[i]]));
    });
    const plaintext = await dump('plaintext');
    const meta = await dump('meta');
    const counts = {};
    for (const name of idb.objectStoreNames) counts[name] = (await dump(name)).length;
    idb.close();
    return { texts: plaintext.map(([, v]) => String(v)), meta: Object.fromEntries(meta), counts };
});
const hasText = (dump, text) => dump.texts.some(t => t.includes(text));

/* ------------------------- удаление в сети ------------------------- */

const alice = await openApp('alice');
await register(alice, 'alice');
const bob = await openApp('bob');
const bobInfo = await register(bob, 'bob');
const room = await alice.page.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Двое' }) });
    return { roomId: c.chat.room_id, chatId: c.chat.id, code: (await api(`/api/chats/invite/${c.chat.id}`)).code };
});
await bob.page.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), room.code);
await openRoom(alice.page, room.roomId);
await openRoom(bob.page, room.roomId);

await send(alice.page, 'секрет один');
await send(alice.page, 'секрет два');
await waitText(bob.page, 'секрет два');
let dump = await local(bob.page);
check('у получателя расшифрованное лежит в IndexedDB', hasText(dump, 'секрет один') && hasText(dump, 'секрет два'));
const preview = dump.meta[`preview:room:${room.roomId}`];
check('превью полученного — под комнатой, а не под чатом отправителя', preview && preview.text === 'секрет два',
    JSON.stringify(Object.keys(dump.meta).filter(k => k.startsWith('preview:'))));

const oneId = await idOf(room.roomId, 0);
await alice.page.evaluate(id => api(`/api/messages/${id}`, { method: 'DELETE' }), oneId);
await sleep(800);
dump = await local(bob.page);
check('удалили, пока получатель в сети, — текст стёрт у него сразу', !hasText(dump, 'секрет один'));
check('а соседнее сообщение на месте', hasText(dump, 'секрет два'));

/* ------------------------- удаление без получателя ------------------------- */

await bob.page.goto('about:blank');
const twoId = await idOf(room.roomId, 1);
await alice.page.evaluate(id => api(`/api/messages/${id}`, { method: 'DELETE' }), twoId);
await bob.page.goto(BASE, { waitUntil: 'networkidle' });
dump = await local(bob.page);
check('пока получателя не было, текст ещё у него', hasText(dump, 'секрет два'));
await openRoom(bob.page, room.roomId);
dump = await local(bob.page);
check('при открытии чата стёрт — в истории его больше нет', !hasText(dump, 'секрет два'));
check('и превью про него тоже', !dump.meta[`preview:room:${room.roomId}`]);

/* ------------------------- исчезнувшее по сроку ------------------------- */

await alice.page.evaluate(chatId => api(`/api/chats/${chatId}/set-default-expiry`, {
    method: 'POST', body: JSON.stringify({ expirySeconds: 2 }) }), room.chatId);
await send(alice.page, 'исчезну через две секунды');
check('исчезающее дошло', await waitText(bob.page, 'исчезну через две секунды'));
check('и лежит у получателя', hasText(await local(bob.page), 'исчезну'));
await sleep(3500);
check('после срока стёрто и у получателя', !hasText(await local(bob.page), 'исчезну'));
await alice.page.evaluate(chatId => api(`/api/chats/${chatId}/set-default-expiry`, {
    method: 'POST', body: JSON.stringify({ expirySeconds: 0 }) }), room.chatId);

/* ------------------------- выход из чата ------------------------- */

await send(alice.page, 'останется до выхода');
await waitText(bob.page, 'останется до выхода');
check('перед выходом текст есть', hasText(await local(bob.page), 'останется до выхода'));
bob.page.once('dialog', d => d.accept());
await bob.page.evaluate(() => deleteChat());
await sleep(800);
dump = await local(bob.page);
check('после выхода из чата от него ничего не осталось', !hasText(dump, 'останется до выхода')
    && !dump.meta[`conv:room:${room.roomId}`] && !dump.meta[`preview:room:${room.roomId}`]);

/* ------------------------- выход из аккаунта ------------------------- */

await bob.page.click('#logout-btn');
await bob.page.waitForFunction(() => document.getElementById('logout-modal').open);
check('перед выходом предупреждают, что ключи придётся сверять заново',
    /сверить их заново/.test(await bob.page.textContent('#logout-modal')));
await bob.page.click('#logout-wipe-btn');
await sleep(1500);
dump = await local(bob.page);
const leftovers = Object.entries(dump.counts).filter(([, n]) => n > 0);
check('после выхода IndexedDB пуст: ни ключей, ни переписки', leftovers.length === 0, JSON.stringify(leftovers));
const revoked = await db.query('SELECT revoked_at FROM devices WHERE id = $1', [bobInfo.deviceId]);
check('и устройство отозвано на сервере', revoked.rows[0]?.revoked_at !== null);

// Выйти, оставив устройство: ключи и переписка остаются, при следующем
// входе привязывается то же устройство — собеседникам сверять нечего.
const loginOn = async (app, u) => app.page.evaluate(async u => {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: `${u}@example.com`, password: 'password123' }) });
    if (!r.success) throw new Error(r.message);
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
    return e2eeDeviceId;
}, u);

const ivy = await openApp('ivy');
const ivyInfo = await register(ivy, 'ivy');
const ivyRoom = await alice.page.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'С Айви' }) });
    return { roomId: c.chat.room_id, code: (await api(`/api/chats/invite/${c.chat.id}`)).code };
});
await ivy.page.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), ivyRoom.code);
await openRoom(alice.page, ivyRoom.roomId);
await openRoom(ivy.page, ivyRoom.roomId);
await send(alice.page, 'прочитаю и после выхода');
check('до выхода сообщение у Айви', await waitText(ivy.page, 'прочитаю и после выхода'));
await ivy.page.click('#logout-btn');
await ivy.page.waitForFunction(() => document.getElementById('logout-modal').open);
await ivy.page.click('#logout-keep-btn');
await sleep(1500);
check('«оставив устройство» — вышли, окно входа на экране',
    await ivy.page.evaluate(() => !currentUser && !document.getElementById('logout-modal').open));
check('и устройство не отозвано',
    (await db.query('SELECT revoked_at FROM devices WHERE id = $1', [ivyInfo.deviceId])).rows[0]?.revoked_at === null);
check('а переписка осталась в браузере', hasText(await local(ivy.page), 'прочитаю и после выхода'));
const ivyAgain = await loginOn(ivy, 'ivy');
check('после входа — то же устройство', ivyAgain === ivyInfo.deviceId, `${ivyInfo.deviceId} → ${ivyAgain}`);
await openRoom(ivy.page, ivyRoom.roomId);
check('и старое сообщение читается', await waitText(ivy.page, 'прочитаю и после выхода'));

/* ------------------------- история страницами ------------------------- */

// Айви не в сети, пока Алиса пишет 12 сообщений и удаляет старое, которое
// Айви уже прочитала. Потом Айви открывает чат страницами по 5.
const oldReadId = (await db.query(
    "SELECT id FROM messages WHERE room_id = $1 AND message_type <> 'system' ORDER BY id LIMIT 1", [ivyRoom.roomId])).rows[0].id;
await ivy.page.goto('about:blank');
for (let i = 1; i <= 12; i++) await send(alice.page, `страница ${i}`);
await alice.page.evaluate(id => api(`/api/messages/${id}`, { method: 'DELETE' }), oldReadId);
await sleep(500);

const historyRequests = [];
ivy.page.on('request', r => { if (/\/api\/messages\/\d+\?/.test(r.url())) historyRequests.push(new URL(r.url()).search); });
await ivy.page.setViewportSize({ width: 1000, height: 420 });
await ivy.page.goto(BASE, { waitUntil: 'networkidle' });
await sleep(1200);
await ivy.page.evaluate(() => { historyPageSize = 5; });
await ivy.page.locator(`.chat-item[data-room-id="${ivyRoom.roomId}"]`).click();
await waitText(ivy.page, 'страница 12');
const firstLoad = await ivy.page.evaluate(() => document.querySelectorAll('#chat-messages .message').length);
check('чат открывается с последней страницы, а не со всей истории',
    historyRequests[0] === '?limit=5' && firstLoad < 12, `${historyRequests.join(' ')}; сообщений ${firstLoad}`);
check('удалённое, пока устройства не было, стёрто и за пределами страницы',
    !hasText(await local(ivy.page), 'прочитаю и после выхода'));

for (let i = 0; i < 6 && await ivy.page.evaluate(() => historyPaging.hasMore); i++) {
    await ivy.page.evaluate(() => { document.getElementById('chat-messages').scrollTop = 0; });
    await sleep(900);
}
const shown = await ivy.page.evaluate(() => ({
    texts: [...document.querySelectorAll('#chat-messages .message-text')].map(t => t.textContent),
    separators: document.querySelectorAll('#chat-messages .day-separator').length,
    more: historyPaging.hasMore,
}));
const expected = Array.from({ length: 12 }, (_, i) => `страница ${i + 1}`);
check('листая вверх, догрузили всё: по порядку, без повторов, всё расшифровано',
    !shown.more && JSON.stringify(shown.texts.filter(t => t.startsWith('страница'))) === JSON.stringify(expected)
    && historyRequests.slice(1).every(q => /^\?limit=5&before=\d+$/.test(q)), JSON.stringify(shown));
check('страницы одного дня — под одним разделителем', shown.separators === 1, String(shown.separators));
const listPreview = await ivy.page.evaluate(id =>
    document.querySelector(`.chat-item[data-room-id="${id}"] .chat-last`)?.textContent, ivyRoom.roomId);
check('старые страницы не перебивают превью в списке чатов', listPreview === 'страница 12', listPreview);
await ivy.page.setViewportSize({ width: 1280, height: 720 });

/* ------------------------- новые устройства аккаунта ------------------------- */

const toastText = page => page.evaluate(() =>
    document.getElementById('toast').matches(':popover-open') ? document.getElementById('toast').textContent : '');

const laptop = await openApp('hank-laptop');
await register(laptop, 'hank');
check('первое устройство ни о чём не предупреждает', !(await toastText(laptop.page)).includes('новое устройство'));
const phoneApp = await openApp('hank-phone');
await loginOn(phoneApp, 'hank');
await sleep(800);
check('устройство в сети сразу узнаёт о новом — по понятному имени',
    (await toastText(laptop.page)).includes('подключено новое устройство «Chrome, Linux»'),
    await toastText(laptop.page));
check('а само новое — нет', !(await toastText(phoneApp.page)).includes('новое устройство'));

await laptop.page.goto('about:blank');
const tabletApp = await openApp('hank-tablet');
const tabletId = await loginOn(tabletApp, 'hank');
await laptop.page.goto(BASE, { waitUntil: 'networkidle' });
await sleep(1500);
check('вернувшееся в сеть узнаёт о подключённом без него', (await toastText(laptop.page)).includes('подключено новое устройство'),
    await toastText(laptop.page));

await laptop.page.click('#toast .toast-action');
await laptop.page.waitForFunction(() => document.getElementById('profile-modal').open);
const listed = await laptop.page.evaluate(() => [...document.querySelectorAll('#devices-list .device-item')].length);
check('«Устройства» открывает профиль со списком', listed === 3, `${listed} в списке`);
laptop.page.once('dialog', d => d.accept());
await laptop.page.locator('#devices-list .device-item').last().locator('button').click();
await sleep(1000);
check('устройство отзывается из профиля', (await db.query('SELECT revoked_at FROM devices WHERE id = $1', [tabletId])).rows[0].revoked_at !== null
    && await laptop.page.evaluate(() => document.querySelectorAll('#devices-list .device-item').length) === 2);

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
