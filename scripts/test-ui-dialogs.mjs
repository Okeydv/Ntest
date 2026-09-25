// Сквозной тест окон, меню и тостов.
//
// Проверяется:
//   - окна — настоящие <dialog>: фокус внутри, Esc закрывает, клик по
//     затемнению закрывает, фокус возвращается на кнопку, которой открыли
//   - тост виден поверх открытого окна; ошибка не исчезает по таймеру
//   - меню сообщения открывается кнопкой «⋯» с клавиатуры, ходит стрелками,
//     закрывается Esc с возвратом фокуса; правый клик — у точки клика
//   - удаление с «Вернуть»: отмена возвращает сообщение и не трогает сервер;
//     без отмены через 5 секунд сообщение удаляется; при закрытии страницы
//     удаление не теряется
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-ui-dialogs.mjs

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import pg from 'pg';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
let nextIp = 50;
async function openApp(label) {
    const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': `10.0.2.${nextIp++}` } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return { page, context, label };
}
const register = (app, u) => app.page.evaluate(async u => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'password123', confirmPassword: 'password123' }) });
    if (!r.success) throw new Error(r.message);
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
}, u);
const openRoom = async page => {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator('.chat-item[data-room-id]:not([data-room-id=""])').first().click({ timeout: 8000 });
    await page.waitForTimeout(900);
};
async function send(page, text) {
    await page.fill('#message-input', text);
    await page.press('#message-input', 'Enter');
    await page.waitForTimeout(1000);
}
const isOpen = (page, id) => page.evaluate(id => document.getElementById(id).open, id);
const activeId = page => page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.className));

/* ------------------------- окна ------------------------- */

const alice = await openApp('alice');
await register(alice, 'alice');
const page = alice.page;

await page.click('#new-chat-btn');
check('окно — настоящий <dialog>, открыто модально', await page.evaluate(() => {
    const d = document.getElementById('new-chat-modal');
    return d.tagName === 'DIALOG' && d.open && d.matches(':modal');
}));
check('фокус внутри окна', await page.evaluate(() =>
    document.getElementById('new-chat-modal').contains(document.activeElement)));
await page.keyboard.press('Escape');
check('Esc закрывает', !(await isOpen(page, 'new-chat-modal')));
check('фокус вернулся на кнопку, которой открыли', await activeId(page) === 'new-chat-btn', await activeId(page));

await page.click('#new-chat-btn');
await page.mouse.click(5, 5);
check('клик по затемнению закрывает', !(await isOpen(page, 'new-chat-modal')));

await page.click('#new-chat-btn');
await page.click('#new-chat-modal .modal-body', { position: { x: 5, y: 5 } });
check('клик внутри окна не закрывает', await isOpen(page, 'new-chat-modal'));

await page.fill('#new-chat-name', '');
await page.click('#create-chat-btn');
const fieldError = await page.textContent('#new-chat-modal [data-msg-for="new-chat-name"]');
await page.click('#new-chat-modal .close-modal');
check('крестик закрывает, ошибки полей сбрасываются',
    !(await isOpen(page, 'new-chat-modal')) && fieldError.length > 0
    && (await page.textContent('#new-chat-modal [data-msg-for="new-chat-name"]')) === '');

/* ------------------------- тосты ------------------------- */

await page.click('#new-chat-btn');
await page.evaluate(() => showToast('Ошибка поверх окна', 'error'));
await page.waitForTimeout(400);
const onTop = await page.evaluate(() => {
    const t = document.getElementById('toast');
    const r = t.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#toast') === t;
});
check('тост виден поверх открытого окна и доступен для нажатия', onTop);
await page.click('#toast .toast-close');
check('его крестик нажимается, окно при этом остаётся открытым',
    await isOpen(page, 'new-chat-modal') && !(await page.evaluate(() => document.getElementById('toast').matches(':popover-open'))));
await page.evaluate(() => showToast('Ошибка поверх окна', 'error'));
await page.keyboard.press('Escape');
await sleep(4000);
check('ошибка не исчезает по таймеру', await page.evaluate(() => document.getElementById('toast').matches(':popover-open')));
await page.click('#toast .toast-close');
check('и закрывается крестиком', !(await page.evaluate(() => document.getElementById('toast').matches(':popover-open'))));
await page.evaluate(() => showToast('Готово', 'success'));
await sleep(3600);
check('обычный тост прячется сам', !(await page.evaluate(() => document.getElementById('toast').matches(':popover-open'))));

/* ------------------------- меню сообщения ------------------------- */

const code = await page.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Меню' }) });
    return (await api(`/api/chats/invite/${c.chat.id}`)).code;
});
const bob = await openApp('bob');
await register(bob, 'bob');
await bob.page.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
await openRoom(page);
await openRoom(bob.page);
await send(page, 'первое');
await send(bob.page, 'от Боба');
await page.waitForTimeout(500);

const mine = page.locator('#chat-messages .message', { hasText: 'первое' });
await mine.locator('.message-more').focus();
await page.keyboard.press('Enter');
const menuOpen = () => page.evaluate(() => document.getElementById('message-menu').matches(':popover-open'));
check('кнопка «⋯» открывает меню с клавиатуры', await menuOpen());
check('фокус на первом пункте', await activeId(page) === 'reply-message-btn', await activeId(page));
await page.keyboard.press('ArrowDown');
const second = await activeId(page);
check('стрелки ходят по пунктам, скрытые пропускаются', second === 'delete-message-btn', second);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);   // toggle приходит асинхронно
check('Esc закрывает меню', !(await menuOpen()));
check('и фокус возвращается на «⋯»', await page.evaluate(() => document.activeElement.classList.contains('message-more')));

const theirs = page.locator('#chat-messages .message', { hasText: 'от Боба' });
const box = await theirs.boundingBox();
await page.mouse.click(box.x + 20, box.y + 10, { button: 'right' });
const menuBox = await page.evaluate(() => {
    const r = document.getElementById('message-menu').getBoundingClientRect();
    return { x: r.left, y: r.top };
});
check('правый клик открывает меню у точки клика',
    await menuOpen() && Math.abs(menuBox.x - (box.x + 20)) < 16 && Math.abs(menuBox.y - (box.y + 10)) < 16,
    JSON.stringify(menuBox));
const visibleItems = await page.evaluate(() =>
    [...document.querySelectorAll('#message-menu .menu-item')].filter(b => b.offsetParent !== null).map(b => b.id));
check('у чужого сообщения нет «Редактировать» и «Удалить»', JSON.stringify(visibleItems) === '["reply-message-btn"]',
    JSON.stringify(visibleItems));
await page.mouse.click(5, 300);
check('клик мимо закрывает меню', !(await menuOpen()));

/* ------------------------- удаление с отменой ------------------------- */

const idOf = text => page.evaluate(t => [...document.querySelectorAll('#chat-messages .message')]
    .find(m => m.textContent.includes(t))?.dataset.messageId, text);
const deletedInDb = async id => (await db.query('SELECT deleted FROM messages WHERE id = $1', [id])).rows[0].deleted === 1;
async function deleteViaMenu(text) {
    const target = page.locator('#chat-messages .message', { hasText: text });
    await target.hover();
    await target.locator('.message-more').click();
    await page.click('#delete-message-btn');
}

const firstId = await idOf('первое');
await deleteViaMenu('первое');
check('после «Удалить» сообщение сразу пропадает с экрана',
    await page.evaluate(id => document.querySelector(`[data-message-id="${id}"]`).hidden, firstId));
check('в тосте есть «Вернуть»', (await page.textContent('#toast')).includes('Вернуть'));
await page.click('#toast .toast-action');
check('«Вернуть» возвращает сообщение', await page.evaluate(id => !document.querySelector(`[data-message-id="${id}"]`).hidden, firstId));
await sleep(6000);
check('и на сервере оно не удалено', !(await deletedInDb(firstId)));

await deleteViaMenu('первое');
await sleep(6000);
check('без отмены через 5 секунд удалено на сервере', await deletedInDb(firstId));
// Сервер ставит отметку раньше, чем отвечает (ещё стирает содержимое), —
// ждём ответа, а не ровно отметки в базе.
const removed = await page.waitForFunction(id => !document.querySelector(`[data-message-id="${id}"]`), firstId,
    { timeout: 3000 }).then(() => true, () => false);
check('и убрано с экрана', removed);

await send(page, 'удалю и уйду');
const leaveId = await idOf('удалю и уйду');
await deleteViaMenu('удалю и уйду');
await page.goto('about:blank');
await sleep(1500);
check('закрыли страницу во время отмены — удаление не потерялось', await deletedInDb(leaveId));

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await browser.close();
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
