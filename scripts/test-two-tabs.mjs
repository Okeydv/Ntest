// Две вкладки одного браузера шифруют одновременно.
//
// Вкладки делят одну IndexedDB — одно устройство, одно состояние цепочек.
// Без общей блокировки обе брали бы одно и то же состояние и шифровали
// двумя разными текстами одним ключом и IV (AES-GCM с повтором nonce
// раскрывает оба текста). Проверяется:
//   - две вкладки разом шлют по шесть сообщений — у получателя нет двух
//     конвертов с одинаковым заголовком (заголовок определяет ключ и IV);
//   - получатель читает все двенадцать;
//   - две вкладки, открытые разом на новом профиле, заводят одно
//     устройство, а не два.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-two-tabs.mjs

import { launch, finish } from './lib/browser.mjs';
import pg from 'pg';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };

const browser = await launch();
const errors = [];
const watch = (page, label) => page.on('pageerror', e => errors.push(`${label}: ${e.message}`));

const aliceContext = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '10.0.13.1' } });
const tab1 = await aliceContext.newPage();
watch(tab1, 'tab1');
await tab1.goto(BASE, { waitUntil: 'networkidle' });
await tab1.evaluate(async () => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: 'alice', email: 'alice@example.com', password: 'password123', confirmPassword: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
});
const bobContext = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '10.0.13.2' } });
const bob = await bobContext.newPage();
watch(bob, 'bob');
await bob.goto(BASE, { waitUntil: 'networkidle' });
const bobDevice = await bob.evaluate(async () => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: 'bob', email: 'bob@example.com', password: 'password123', confirmPassword: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
    return e2eeDeviceId;
});
const room = await tab1.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Вкладки' }) });
    return { chatId: c.chat.id, roomId: c.chat.room_id, code: (await api(`/api/chats/invite/${c.chat.id}`)).code };
});
await bob.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), room.code);

// Вторая вкладка того же браузера — то же устройство.
const tab2 = await aliceContext.newPage();
watch(tab2, 'tab2');
await tab2.goto(BASE, { waitUntil: 'networkidle' });
await tab2.waitForFunction(() => typeof e2eeDeviceId === 'number' && e2eeDeviceId > 0, null, { timeout: 10000 });
const devices = await Promise.all([tab1, tab2].map(t => t.evaluate(() => e2eeDeviceId)));
check('вторая вкладка — то же устройство', devices[0] === devices[1], JSON.stringify(devices));

const burst = (tab, label) => tab.evaluate(async ([chatId, label]) => {
    await Promise.all(Array.from({ length: 6 }, (_, i) =>
        sendEncryptedPayload(chatId, e2ee.encodeText(`${label}-${i}`))));
}, [room.chatId, label]);
await Promise.all([burst(tab1, 'первая'), burst(tab2, 'вторая')]);

const headers = (await db.query(
    `SELECT encode(e.header, 'hex') AS h FROM message_envelopes e JOIN messages m ON m.id = e.message_id
     WHERE e.recipient_device_id = $1 AND m.room_id = $2`, [bobDevice, room.roomId])).rows.map(r => r.h);
check('у получателя 12 конвертов, и ни один заголовок не повторяется',
    headers.length === 12 && new Set(headers).size === 12, `${headers.length} конвертов, разных ${new Set(headers).size}`);

await bob.reload({ waitUntil: 'networkidle' });
await bob.waitForTimeout(1200);
await bob.locator('.chat-item[data-room-id]:not([data-room-id=""])').first().click();
await bob.waitForTimeout(3000);
const read = await bob.evaluate(() => [...document.querySelectorAll('#chat-messages .message-text')].map(t => t.textContent));
const expected = ['первая', 'вторая'].flatMap(l => Array.from({ length: 6 }, (_, i) => `${l}-${i}`));
check('получатель прочитал все двенадцать', expected.every(t => read.includes(t)),
    `не прочитано: ${expected.filter(t => !read.includes(t)).join(', ')}`);

// Новый профиль, две вкладки разом: устройство должно быть одно.
const freshContext = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '10.0.13.3' } });
const fresh1 = await freshContext.newPage();
watch(fresh1, 'fresh1');
await fresh1.goto(BASE, { waitUntil: 'networkidle' });
await fresh1.evaluate(async () => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: 'carol', email: 'carol@example.com', password: 'password123', confirmPassword: 'password123' }) });
    currentUser = r.user;
});
const fresh2 = await freshContext.newPage();
watch(fresh2, 'fresh2');
await fresh2.goto(BASE, { waitUntil: 'networkidle' });
await Promise.all([fresh1, fresh2].map(p => p.evaluate(() => setupE2EE())));
const carolDevices = Number((await db.query(
    "SELECT count(*) FROM devices d JOIN users u ON u.id = d.user_id WHERE u.username = 'carol' AND d.revoked_at IS NULL")).rows[0].count);
check('две вкладки нового профиля завели одно устройство', carolDevices === 1, `устройств: ${carolDevices}`);

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
