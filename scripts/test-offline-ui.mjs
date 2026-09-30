// Без сети, соединение, длинный текст, хранилище ключей (п. 169–173).
//
//   - нет сети: «Ожидание сети…» в шапке, отправленное — с часиками, а не
//     «Не отправлено»; сеть вернулась — «Обновление…», сообщение ушло,
//     на сервере одно;
//   - сеть есть, а сервер недоступен: досылается, после пятой неудачи —
//     «Не отправлено»; отказ сервера — «Не отправлено» сразу;
//   - текст длиннее 4000 знаков не обрезается: «×2» на кнопке, уходит
//     двумя сообщениями по пробелу; остаток — когда меньше 100 знаков;
//   - хранилище ключей: состояние в профиле; другая вкладка сменила схему
//     базы — эта закрывает её и просит перезагрузиться.
//
// Требует Postgres, key-server и server.js на 3006 и ЧИСТУЮ базу.

import pg from 'pg';
import { launch, finish } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': `10.0.46.${nextIp++}` } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return { context, page };
}
const register = (page, u) => page.evaluate(async u => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'password123', confirmPassword: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
}, u);
const ROOM = '.chat-item[data-room-id]:not([data-room-id=""])';

const { context: aliceCtx, page: alice } = await openApp('alice');
await register(alice, 'alice');
const { page: bob } = await openApp('bob');
await register(bob, 'bob');
const { code, roomId } = await alice.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Связь' }) });
    const link = await api(`/api/chats/${c.chat.id}/link`, { method: 'POST', body: JSON.stringify({ requireApproval: false }) });
    return { code: link.code, roomId: c.chat.room_id };
});
await bob.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
for (const p of [alice, bob]) {
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
    await p.locator(ROOM).first().click();
    await p.waitForTimeout(900);
}
const count = async () => Number((await db.query("SELECT count(*) FROM messages WHERE room_id = $1 AND message_type <> 'system'", [roomId])).rows[0].count);
const lastBubble = () => alice.evaluate(() => {
    const b = [...document.querySelectorAll('#chat-messages .message.sent')].at(-1);
    return { text: b?.querySelector('.message-text')?.textContent, sending: b?.classList.contains('is-sending'),
        failed: b?.classList.contains('is-failed'), id: b?.dataset.messageId || null };
});
const status = () => alice.evaluate(() => document.getElementById('chat-status').textContent);

/* ------------------------- нет сети ------------------------- */

await aliceCtx.setOffline(true);
await alice.waitForTimeout(300);
check('нет сети — «Ожидание сети…» в шапке сразу', await status() === 'Ожидание сети…', await status());
await alice.fill('#message-input', 'без сети');
await alice.press('#message-input', 'Enter');
await alice.waitForTimeout(800);
let b = await lastBubble();
check('отправленное без сети — часики, не «Не отправлено»', b.text?.startsWith('без сети') && b.sending && !b.failed, JSON.stringify(b));
await alice.waitForTimeout(1500);
check('и через пару секунд — всё ещё часики', (await lastBubble()).sending);
const before = await count();
await aliceCtx.setOffline(false);
await alice.waitForFunction(() => socket.connected, null, { timeout: 15000 });
const seen = [];
for (let i = 0; i < 30; i++) {
    seen.push(await status());
    await alice.waitForTimeout(100);
}
await alice.waitForTimeout(2000);
b = await lastBubble();
check('сеть вернулась — сообщение ушло само', !b.sending && !b.failed && b.id, JSON.stringify(b));
check('на сервере одно такое сообщение', await count() === before + 1, `${before} → ${await count()}`);
check('после подключения шапка снова обычная', !['Ожидание сети…', 'Подключение…', 'Обновление…'].includes(await status()), await status());

/* ------------------------- сервер недоступен ------------------------- */

await alice.route('**/api/messages/encrypted', route => route.abort('connectionrefused'));
await alice.fill('#message-input', 'сервер лежит');
await alice.press('#message-input', 'Enter');
await alice.waitForTimeout(1200);
b = await lastBubble();
check('обрыв запроса при сети — часики, досылается', b.sending && !b.failed, JSON.stringify(b));
for (let i = 0; i < 4; i++) {
    await alice.evaluate(() => flushPending());
    await alice.waitForTimeout(500);
}
b = await lastBubble();
check('после пятой неудачи — «Не отправлено · Повторить»', b.failed && !b.sending, JSON.stringify(b));
await alice.unroute('**/api/messages/encrypted');
await alice.locator('#chat-messages .message.is-failed .link-inline', { hasText: 'Повторить' }).last().click();
await alice.waitForTimeout(1500);
b = await lastBubble();
check('«Повторить» досылает', !b.failed && !b.sending && b.id, JSON.stringify(b));

// Отказ сервера — «Не отправлено» сразу.
await alice.route('**/api/messages/encrypted', route => route.fulfill({ status: 400, contentType: 'application/json',
    body: JSON.stringify({ success: false, message: 'Сервер против' }) }));
await alice.fill('#message-input', 'откажут');
await alice.press('#message-input', 'Enter');
await alice.waitForTimeout(1200);
b = await lastBubble();
check('отказ сервера — «Не отправлено» сразу', b.failed && !b.sending, JSON.stringify(b));
await alice.unroute('**/api/messages/encrypted');

/* ------------------------- длинный текст ------------------------- */

const word = 'слово ';
const long = word.repeat(700).trim(); // 4199 знаков
await alice.fill('#message-input', word.repeat(660).trim()); // 3959
const near = await alice.evaluate(() => ({ counter: document.getElementById('message-counter').textContent,
    hidden: document.getElementById('message-counter').hidden, parts: document.getElementById('send-btn').dataset.parts }));
check('до предела меньше 100 знаков — виден остаток', !near.hidden && near.counter === String(4000 - 3959) && !near.parts, JSON.stringify(near));
await alice.fill('#message-input', long);
const over = await alice.evaluate(() => ({ value: document.getElementById('message-input').value.length,
    hidden: document.getElementById('message-counter').hidden, parts: document.getElementById('send-btn').dataset.parts,
    label: document.getElementById('send-btn').getAttribute('aria-label') }));
check('длиннее 4000 — не обрезано, на кнопке «×2»', over.value === long.length && over.hidden && over.parts === '×2'
    && over.label === 'Отправить 2 сообщениями', JSON.stringify(over));
const beforeLong = await count();
await alice.press('#message-input', 'Enter');
await alice.waitForTimeout(3000);
const parts = await alice.evaluate(() => [...document.querySelectorAll('#chat-messages .message.sent .message-text')].slice(-2)
    .map(t => t.firstChild.textContent));
check('ушло двумя сообщениями, по пробелу, по порядку, без потерь', await count() === beforeLong + 2
    && parts.every(p => p.length <= 4000 && !p.startsWith(' ') && !p.endsWith(' ')) && parts.join(' ') === long,
    `${parts.map(p => p.length)}`);

/* ------------------------- хранилище ключей ------------------------- */

await alice.click('#profile-btn');
await alice.waitForTimeout(800);
const storage = await alice.evaluate(() => ({ shown: !document.getElementById('storage-section').hidden,
    text: document.getElementById('storage-state').textContent }));
check('в профиле — можно ли браузеру стереть ключи', storage.shown && storage.text.length > 20, JSON.stringify(storage));
await alice.keyboard.press('Escape');

// Другая вкладка открывает базу ключей новой версией — эта отпускает её.
const other = await aliceCtx.newPage();
await other.goto(`${BASE}/manifest.webmanifest`);
const upgraded = await other.evaluate(() => new Promise(resolve => {
    const probe = indexedDB.open('nyxo-e2ee');
    probe.onsuccess = () => {
        const version = probe.result.version;
        probe.result.close();
        const next = indexedDB.open('nyxo-e2ee', version + 1);
        next.onsuccess = () => { next.result.close(); resolve('открылась'); };
        next.onblocked = () => resolve('заблокирована');
        setTimeout(() => resolve('висит'), 5000);
    };
}));
await alice.waitForTimeout(300);
const toast = await alice.evaluate(() => document.getElementById('toast').textContent);
check('новая схема в другой вкладке: старая закрыла базу и просит перезагрузиться', upgraded === 'открылась'
    && toast.includes('Nyxo обновился') && toast.includes('Перезагрузить'), `${upgraded} / ${toast}`);

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
