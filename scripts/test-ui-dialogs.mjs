// Сквозной тест окон, меню и тостов.
//
// Проверяется:
//   - окна — настоящие <dialog>: фокус внутри, Esc закрывает, клик по
//     затемнению закрывает, фокус возвращается на кнопку, которой открыли
//   - тост виден поверх открытого окна; ошибка не исчезает по таймеру
//   - окно стоит по центру; выделение текста, отпущенное на затемнении,
//     окно не закрывает; тост, показанный до окна, поднимается над ним
//   - переписка — одна остановка Tab, стрелки ходят по сообщениям, Enter
//     открывает меню, Esc возвращает фокус на сообщение; «⋯» не сдвигает
//     время; правый клик — у точки клика
//   - «Повторить» после ошибки отправляет в тот чат, где была ошибка
//   - на телефоне: открытый чат прячет список, «назад» (и системная тоже)
//     возвращает к нему; тост не сжимается в узкую колонку
//   - удаление с «Вернуть»: пузырь плавно сжимается, отмена возвращает
//     сообщение и не трогает сервер;
//     без отмены через 5 секунд сообщение удаляется; при закрытии страницы
//     удаление не теряется
//   - ошибка сервера показывается с кодом; «Отчёт об ошибке» в профиле
//     собирает код и ошибки страницы без почты и адресов с параметрами
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-ui-dialogs.mjs

import { launch, finish } from './lib/browser.mjs';
import pg from 'pg';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await launch();
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
const centered = await page.evaluate(() => {
    const r = document.getElementById('new-chat-modal').getBoundingClientRect();
    return Math.abs(r.left + r.width / 2 - innerWidth / 2) < 2 && Math.abs(r.top + r.height / 2 - innerHeight / 2) < 2;
});
check('окно стоит по центру, а не в углу', centered);
await page.mouse.click(5, 5);
check('клик по затемнению закрывает', !(await isOpen(page, 'new-chat-modal')));

// Выделяют текст в окне и отпускают кнопку мыши снаружи.
await page.click('#new-chat-btn');
const title = await page.locator('#new-chat-modal .modal-header').boundingBox();
await page.mouse.move(title.x + 30, title.y + title.height / 2);
await page.mouse.down();
await page.mouse.move(5, 5, { steps: 5 });
await page.mouse.up();
check('выделение, отпущенное на затемнении, окно не закрывает', await isOpen(page, 'new-chat-modal'));
await page.keyboard.press('Escape');

// Ошибка показана раньше, чем открыли окно.
await page.evaluate(() => showToast('Ошибка до окна', 'error'));
await page.click('#new-chat-btn');
const toastOnTop = await page.evaluate(() => {
    const t = document.getElementById('toast');
    const r = t.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#toast') === t;
});
check('тост, показанный до окна, поднимается над затемнением', toastOnTop);
await page.click('#toast .toast-close');
await page.keyboard.press('Escape');

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
const tabStops = await page.evaluate(() => [...document.querySelectorAll('#chat-messages *')]
    .filter(el => el.tabIndex >= 0 && !el.hidden).length);
check('вся переписка — одна остановка Tab', tabStops === 1, tabStops);
const timeAligned = await page.evaluate(() => {
    const m = [...document.querySelectorAll('#chat-messages .message')].find(el => el.textContent.includes('первое'));
    // Последнее в строке (статус или время) стоит у правого края: невидимая
    // «⋯» места в строке не занимает.
    const meta = m.querySelector('.message-meta');
    return meta.getBoundingClientRect().right - meta.lastElementChild.getBoundingClientRect().right;
});
check('«⋯» не занимает места в строке времени', timeAligned < 2, `последнее в строке отстоит от края на ${timeAligned}px`);
await page.focus('#chat-messages .message[tabindex="0"]');
check('остановка — последнее сообщение', (await page.evaluate(() => document.activeElement.textContent)).includes('от Боба'));
await page.keyboard.press('ArrowUp');
check('стрелка вверх — предыдущее сообщение', (await page.evaluate(() => document.activeElement.textContent)).includes('первое'));
await page.keyboard.press('Enter');
const menuOpen = () => page.evaluate(() => document.getElementById('message-menu').matches(':popover-open'));
check('Enter открывает меню сообщения', await menuOpen());
check('фокус на первом пункте', await activeId(page) === 'reply-message-btn', await activeId(page));
await page.keyboard.press('ArrowDown');
const second = await activeId(page);
check('стрелки ходят по пунктам, скрытые пропускаются', second === 'delete-message-btn', second);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);   // toggle приходит асинхронно
check('Esc закрывает меню', !(await menuOpen()));
check('и фокус возвращается на сообщение', await page.evaluate(() =>
    document.activeElement.classList.contains('message') && document.activeElement.textContent.includes('первое')));

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

/* ------------------------- приглашение ------------------------- */

check('вход по коду виден в переписке строкой, не пузырём', await page.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .message-system')].some(el => el.textContent.startsWith('bob вошёл'))));
await page.click('#get-chat-code-btn');
await page.waitForFunction(() => document.getElementById('invite-modal').open);
const shownCode = await page.textContent('#invite-code-display');
await page.click('#reset-invite-btn');
await page.waitForTimeout(700);
const newCode = await page.textContent('#invite-code-display');
check('«Сменить код» показывает новый код', /^[A-Z0-9]{6}$/.test(newCode) && newCode !== shownCode, `${shownCode} → ${newCode}`);
await page.click('#disable-invite-btn');
await page.waitForTimeout(700);
check('«Отключить приглашение» прячет код и объясняет', await page.evaluate(() =>
    document.getElementById('invite-code-box').hidden && document.getElementById('invite-text').textContent.includes('отключено')));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('и то и другое видно в переписке', await page.evaluate(() => {
    const lines = [...document.querySelectorAll('#chat-messages .message-system')].map(el => el.textContent);
    // О себе — «Вы …»: себе строка в третьем лице читалась бы странно.
    return lines.includes('Вы сменили код приглашения') && lines.includes('Вы отключили приглашение');
}));

/* ------------------------- цитата ответа ------------------------- */

const quoteOf = (p, text) => p.evaluate(t => {
    const m = [...document.querySelectorAll('#chat-messages .message')].find(x => x.querySelector('.message-text')?.textContent === t);
    return m ? m.querySelector('.reply-to-text')?.textContent ?? null : null;
}, text);
const bobsBubble = page.locator('#chat-messages .message', { hasText: 'от Боба' });
const bobsBox = await bobsBubble.boundingBox();
await page.mouse.click(bobsBox.x + 20, bobsBox.y + 10, { button: 'right' });
await page.click('#reply-message-btn');
await send(page, 'отвечаю Бобу');
check('цитата зашифрованного сообщения видна у отправителя', await quoteOf(page, 'отвечаю Бобу') === 'от Боба',
    String(await quoteOf(page, 'отвечаю Бобу')));
await bob.page.waitForTimeout(800);
check('и у получателя — сразу, по сокету', await quoteOf(bob.page, 'отвечаю Бобу') === 'от Боба',
    String(await quoteOf(bob.page, 'отвечаю Бобу')));
await openRoom(bob.page);
check('и после перезагрузки', await quoteOf(bob.page, 'отвечаю Бобу') === 'от Боба', String(await quoteOf(bob.page, 'отвечаю Бобу')));

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
// Записываем высоту пузыря на каждом кадре: сжимается плавно, а не скачком.
await page.evaluate(id => {
    const el = document.querySelector(`[data-message-id="${id}"]`);
    window.__heights = [];
    const tick = () => { window.__heights.push(el.hidden ? 0 : el.getBoundingClientRect().height); if (!el.hidden) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
}, firstId);
await deleteViaMenu('первое');
await page.waitForTimeout(400);
const heights = await page.evaluate(() => window.__heights);
const full = heights[0];
check('удалённое сжимается плавно (~150 мс), а не пропадает скачком',
    heights.some(h => h > 0 && h < full - 1) && heights.at(-1) === 0, heights.map(h => Math.round(h)).join(' '));
check('после «Удалить» сообщение пропадает с экрана',
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

/* ------------------------- «Повторить» — в свой чат ------------------------- */

const other = await bob.page.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Второй' }) });
    return { roomId: c.chat.room_id, code: (await api(`/api/chats/invite/${c.chat.id}`)).code };
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), other.code);
// Первый — чат «Меню», а не верхний в списке: вверху теперь «Второй», где
// только что появилось системное «вошёл в чат».
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.locator('.chat-item', { hasText: 'Меню' }).click();
await page.waitForTimeout(900);
const firstRoom = await page.evaluate(() => currentRoomId);
const count = async roomId => Number((await db.query(
    "SELECT count(*) FROM messages WHERE room_id = $1 AND deleted = 0 AND message_type <> 'system'", [roomId])).rows[0].count);
const beforeFirst = await count(firstRoom);
const beforeSecond = await count(other.roomId);
// Сервер один раз отказывает — отправка падает с ошибкой.
let refuse = true;
await page.route('**/api/messages/encrypted', route => {
    if (refuse) {
        refuse = false;
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'сбой' }) });
    }
    return route.continue();
});
await send(page, 'повтори меня');
check('ошибка отправки предлагает «Повторить»', (await page.textContent('#toast')).includes('Повторить'));
// Переключаемся в другой чат и только потом жмём «Повторить».
await page.locator(`.chat-item[data-room-id="${other.roomId}"]`).click();
await page.waitForTimeout(600);
await page.click('#toast .toast-action');
await page.waitForTimeout(1500);
check('«Повторить» отправляет в тот чат, где была ошибка',
    await count(firstRoom) === beforeFirst + 1 && await count(other.roomId) === beforeSecond,
    `первый: ${beforeFirst}→${await count(firstRoom)}, второй: ${beforeSecond}→${await count(other.roomId)}`);
await page.unroute('**/api/messages/encrypted');

/* ------------------------- телефон ------------------------- */

const phone = await browser.newContext({ viewport: { width: 375, height: 740 }, extraHTTPHeaders: { 'X-Forwarded-For': '10.0.2.99' } });
const phonePage = await phone.newPage();
phonePage.on('pageerror', e => errors.push(`phone: ${e.message}`));
await phonePage.goto(BASE, { waitUntil: 'networkidle' });
await phonePage.evaluate(async () => {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
});
const listShown = () => phonePage.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).visibility === 'visible'
    && document.querySelector('.sidebar').getBoundingClientRect().left >= 0);
check('на телефоне сначала виден список чатов', await listShown());
await phonePage.locator('.chat-item').first().click();
await phonePage.waitForTimeout(800);
check('открытый чат прячет список и показывает переписку',
    !(await listShown()) && await phonePage.isVisible('#message-input') && await phonePage.isVisible('#chat-back-btn'));
check('невидимый список не ловит Tab', await phonePage.evaluate(() => document.querySelector('.sidebar').inert));
await phonePage.click('#chat-back-btn');
await phonePage.waitForTimeout(500);
check('«назад» возвращает к списку', await listShown());
await phonePage.locator('.chat-item').first().click();
await phonePage.waitForTimeout(800);
await phonePage.goBack();
await phonePage.waitForTimeout(500);
check('системная «назад» — тоже', await listShown());
await phonePage.evaluate(() => showToast('Сообщение не отправлено: ключи устройств собеседника не совпадают с известными', 'error'));
const toastBox = await phonePage.evaluate(() => {
    const r = document.getElementById('toast').getBoundingClientRect();
    return { width: r.width, center: r.left + r.width / 2 };
});
check('тост на телефоне не сжат в колонку и стоит по центру',
    toastBox.width > 375 * 0.8 && Math.abs(toastBox.center - 375 / 2) < 2, JSON.stringify(toastBox));

/* ------------------------- движение ------------------------- */

const css = await page.evaluate(() => {
    const sheet = [...document.styleSheets].find(x => x.href && x.href.includes('style.css'));
    const rules = [...sheet.cssRules];
    const root = getComputedStyle(document.documentElement);
    return {
        looseHover: rules.filter(r => r instanceof CSSStyleRule && r.selectorText.includes(':hover')).map(r => r.selectorText),
        longest: Math.max(...['--dur-1', '--dur-2', '--dur-3'].map(v => parseFloat(root.getPropertyValue(v)))),
        text: rules.map(r => r.cssText).join('\n'),
    };
});
check('ховеры — только там, где есть мышь', css.looseHover.length === 0, css.looseHover.join(', '));
check('анимации не дольше 250 мс и без «отскока»', css.longest <= 250 && !css.text.includes('1.26'), `${css.longest} мс`);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.locator('.chat-item', { hasText: 'Меню' }).click();
await page.waitForTimeout(900);
check('история при открытии чата не анимируется', await page.evaluate(() =>
    document.querySelectorAll('#chat-messages .message').length > 0 && document.querySelectorAll('#chat-messages .is-new').length === 0));
await send(page, 'свежее');
check('а новое сообщение — да', await page.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .message')].at(-1).classList.contains('is-new')));
const fresh = page.locator('#chat-messages .message', { hasText: 'свежее' });
const freshBox = await fresh.boundingBox();
await page.mouse.click(freshBox.x + 30, freshBox.y + 12, { button: 'right' });
const origin = await page.evaluate(() => {
    const m = document.getElementById('message-menu');
    return { origin: m.style.transformOrigin, left: parseFloat(m.style.left), top: parseFloat(m.style.top) };
});
const [ox, oy] = origin.origin.split(' ').map(parseFloat);
check('меню раскрывается из точки клика', Math.abs(origin.left + ox - (freshBox.x + 30)) < 1
    && Math.abs(origin.top + oy - (freshBox.y + 12)) < 1, JSON.stringify(origin));
await page.keyboard.press('Escape');

check('на телефоне приложение занимает видимую высоту', await phonePage.evaluate(() =>
    Math.abs(document.querySelector('.app').getBoundingClientRect().height - innerHeight) < 1));

/* ------------------------- название чата с разметкой ------------------------- */

await page.evaluate(() => api('/api/chats', { method: 'POST', body: JSON.stringify({ name: '<img src=x onerror=alert(1)>' }) }));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const markup = await page.evaluate(() => {
    const item = [...document.querySelectorAll('.chat-item')].find(i => i.textContent.includes('onerror'));
    return item && { imgs: item.querySelectorAll('img').length, avatar: item.querySelector('.chat-avatar-small').textContent };
});
check('название чата с разметкой показывается текстом, и буква в аватаре тоже', markup && markup.imgs === 0 && markup.avatar === '<',
    JSON.stringify(markup));

/* ------------------------- бот ------------------------- */

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.locator('.chat-item', { hasText: 'Бот' }).click();
await page.waitForTimeout(800);
await send(page, 'привет, бот');
await page.waitForTimeout(2000);
const botBubbles = await page.evaluate(() => [...document.querySelectorAll('#chat-messages .message')]
    .map(m => ({ sent: m.classList.contains('sent'), text: m.querySelector('.message-text')?.textContent })));
check('ответы бота — слева, как чужие, а своё — справа',
    botBubbles.length >= 3 && botBubbles.filter(b => b.text === 'привет, бот').every(b => b.sent)
    && botBubbles.filter(b => b.text !== 'привет, бот').every(b => !b.sent), JSON.stringify(botBubbles));
const botReply = page.locator('#chat-messages .message.received').last();
const botBox = await botReply.boundingBox();
await page.mouse.click(botBox.x + 20, botBox.y + 10, { button: 'right' });
const botMenu = await page.evaluate(() =>
    [...document.querySelectorAll('#message-menu .menu-item')].filter(b => b.offsetParent !== null).map(b => b.id));
check('у ответа бота нет «Редактировать» и «Удалить»', JSON.stringify(botMenu) === '["reply-message-btn"]', JSON.stringify(botMenu));
await page.keyboard.press('Escape');

/* ------------------------- отчёт об ошибке ------------------------- */

// Ошибка сервера: таблица на миг пропадает. Человек видит код ошибки.
await db.query('ALTER TABLE chats RENAME TO chats_hidden');
const failed = await page.evaluate(() => api('/api/chats'));
await db.query('ALTER TABLE chats_hidden RENAME TO chats');
const errorCode = (failed.message.match(/\(код ([0-9a-f]{12})\)$/) || [])[1];
check('ошибка сервера показывается с кодом', Boolean(errorCode) && failed.errorId === errorCode, failed.message);

await page.evaluate(() => console.error(`сломалось при проверке: ${location.origin}/api/chats?secret=1 и https://tracker.example/p?id=7`));
await page.click('#profile-btn');
await page.click('#error-report-btn');
await page.waitForFunction(() => document.getElementById('error-report-modal').open);
const report = await page.inputValue('#error-report-text');
check('«Отчёт об ошибке» в профиле: код ошибки сервера и ошибка страницы',
    report.includes(`код: ${errorCode}`) && report.includes('GET /api/chats → 500') && report.includes('сломалось при проверке'),
    report);
check('в отчёте нет почты, адресов с параметрами и чужих сайтов',
    !report.includes('alice@example.com') && !report.includes('secret=1') && !report.includes('tracker.example')
    && report.includes('/api/chats и [адрес]'), report);
await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
await page.click('#copy-error-report-btn');
check('«Скопировать» кладёт отчёт в буфер обмена', await page.evaluate(() => navigator.clipboard.readText()) === report);
await page.keyboard.press('Escape');

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
