// Сквозной тест базовых вещей интерфейса.
//
// Проверяется:
//   - время сообщения показывается в поясе того, кто читает: собеседники в
//     Москве и Токио видят разное время одного сообщения
//   - разделители дней: «Сегодня», «Вчера», дата с годом для прошлых лет;
//     удалили последнее сообщение дня — ушёл и разделитель
//   - код приглашения принимается в любом регистре, с пробелами и дефисом
//   - двойной клик по «Зарегистрироваться» отправляет один запрос
//   - Enter, которым подтверждают слово в IME, сообщение не отправляет
//   - превью в списке чатов не показывает удалённое сообщение
//   - разделители дней не наезжают друг на друга при прокрутке
//   - время на своих сообщениях читается: контраст не ниже 4,5:1
//   - ручная смена темы меняет и theme-color (цвет строки состояния)
//   - на телефоне: поля ввода не мельче 16px, зона нажатия «⋯» 44×44,
//     подпись в шапке в одну строку с многоточием
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-ui-basics.mjs

import { chromium } from 'playwright';
import pg from 'pg';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const errors = [];
let nextIp = 30;
async function openApp(label, timezoneId) {
    const context = await browser.newContext({ timezoneId, extraHTTPHeaders: { 'X-Forwarded-For': `10.0.1.${nextIp++}` } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return { page, label };
}
const register = (app, u) => app.page.evaluate(async u => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'password123', confirmPassword: 'password123' }) });
    if (!r.success) throw new Error(r.message);
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
}, u);
const openRoom = async (app, selector = '.chat-item[data-room-id]:not([data-room-id=""])') => {
    await app.page.reload({ waitUntil: 'networkidle' });
    await app.page.waitForTimeout(1200);
    await app.page.locator(selector).first().click({ timeout: 8000 });
    await app.page.waitForTimeout(900);
};
async function send(app, text) {
    await app.page.fill('#message-input', text);
    await app.page.press('#message-input', 'Enter');
    await app.page.waitForTimeout(1000);
}
const lastTime = app => app.page.evaluate(() => {
    const list = document.querySelectorAll('#chat-messages .message-time');
    const t = list[list.length - 1];
    return { text: t.textContent, iso: t.getAttribute('datetime') };
});
const separators = app => app.page.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .day-separator')].map(s => s.textContent));

/* ------------------------- регистрация: двойной клик ------------------------- */

const alice = await openApp('alice', 'Europe/Moscow');
let registerCalls = 0;
alice.page.on('request', r => { if (r.url().endsWith('/api/register') && r.method() === 'POST') registerCalls++; });
await alice.page.click('.auth-tab[data-tab="register"]');
await alice.page.fill('#register-username', 'alice');
await alice.page.fill('#register-email', 'alice@example.com');
await alice.page.fill('#register-password', 'password123');
await alice.page.fill('#register-confirm-password', 'password123');
await alice.page.evaluate(() => { const b = document.getElementById('register-btn'); b.click(); b.click(); });
await alice.page.waitForTimeout(3000);
check('двойной клик по «Зарегистрироваться» — один запрос', registerCalls === 1, `запросов: ${registerCalls}`);
const loggedIn = await alice.page.evaluate(() => Boolean(currentUser));
check('и регистрация прошла без ошибки', loggedIn);

/* ------------------------- код приглашения ------------------------- */

const code = await alice.page.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Время' }) });
    return (await api(`/api/chats/invite/${c.chat.id}`)).code;
});
const bob = await openApp('bob', 'Asia/Tokyo');
await register(bob, 'bob');
const messy = ` ${code.slice(0, 3).toLowerCase()}-${code.slice(3).toLowerCase()} `;
const joined = await bob.page.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), messy);
check('код приглашения принимается в нижнем регистре, с пробелами и дефисом', joined.success === true, `«${messy}»`);
const placeholder = await bob.page.getAttribute('#join-chat-code', 'placeholder');
check('пример в поле — 6 символов, как настоящий код', placeholder.length === 6 && code.length === 6, placeholder);

/* ------------------------- время в поясе читающего ------------------------- */

await openRoom(alice);
await openRoom(bob);
await send(alice, 'который час?');
await bob.page.waitForTimeout(600);
const [aTime, bTime] = [await lastTime(alice), await lastTime(bob)];
const at = new Date(aTime.iso);
const expect = tz => new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(at);
check('у отправителя время по Москве', aTime.text === expect('Europe/Moscow'), `${aTime.text} vs ${expect('Europe/Moscow')}`);
check('у получателя то же сообщение — по Токио', bTime.text === expect('Asia/Tokyo'), `${bTime.text} vs ${expect('Asia/Tokyo')}`);
check('и это один и тот же момент', aTime.iso === bTime.iso && aTime.text !== bTime.text);

/* ------------------------- разделители дней ------------------------- */

check('первое сообщение дня — под «Сегодня»', JSON.stringify(await separators(bob)) === '["Сегодня"]',
    JSON.stringify(await separators(bob)));
await send(alice, 'второе сегодня');
check('второе сообщение того же дня разделителя не добавляет', (await separators(alice)).length === 1);

const room = (await db.query("SELECT id FROM rooms ORDER BY id DESC LIMIT 1")).rows[0].id;
const ids = (await db.query("SELECT id FROM messages WHERE room_id = $1 AND message_type <> 'system' ORDER BY id", [room])).rows.map(r => r.id);
// Первое — «год назад», второе — «вчера». Новое сообщение будет сегодня.
// Системное «вошёл в чат» — туда же, «год назад»: оно было раньше всех.
await db.query("UPDATE messages SET created_at = now() - interval '400 days' WHERE id = $1 OR (room_id = $2 AND message_type = 'system')", [ids[0], room]);
await db.query("UPDATE messages SET created_at = now() - interval '1 day' WHERE id = $1", [ids[1]]);
await send(alice, 'снова сегодня');
await openRoom(bob);
const seps = await separators(bob);
const lastYear = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Tokyo' })
    .format(new Date(Date.now() - 400 * 864e5));
check('разделители: дата с годом, «Вчера», «Сегодня»',
    seps.length === 3 && seps[0] === lastYear && seps[1] === 'Вчера' && seps[2] === 'Сегодня', JSON.stringify(seps));

// Дни — отдельными блоками: при прокрутке к концу подписи прошлых дней
// уезжают вверх вместе со своими днями, а не прилипают стопкой друг на
// друга.
await bob.page.setViewportSize({ width: 1000, height: 380 });
await bob.page.evaluate(() => { const m = document.getElementById('chat-messages'); m.scrollTop = m.scrollHeight; });
await bob.page.waitForTimeout(300);
const overlap = await bob.page.evaluate(() => {
    const list = document.getElementById('chat-messages');
    const box = list.getBoundingClientRect();
    const rects = [...list.querySelectorAll('.day-separator span')].map(s => s.getBoundingClientRect())
        .filter(r => r.bottom > box.top && r.top < box.bottom);
    let hits = 0;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        if (rects[i].top < rects[j].bottom && rects[j].top < rects[i].bottom) hits++;
    }
    return { scrolls: list.scrollHeight > list.clientHeight, hits, groups: list.querySelectorAll(':scope > .day-group').length };
});
check('в конце переписки разделители дней не наезжают друг на друга',
    overlap.scrolls && overlap.hits === 0 && overlap.groups === 3, JSON.stringify(overlap));
await bob.page.setViewportSize({ width: 1280, height: 720 });

// Время на своём пузыре: белый с прозрачностью поверх градиента. Берём
// самую светлую точку градиента — там контраст хуже всего.
const contrast = await alice.page.evaluate(() => {
    const bubble = [...document.querySelectorAll('#chat-messages .message.sent')].at(-1);
    const meta = bubble.querySelector('.message-meta');
    const stops = [...getComputedStyle(bubble).backgroundImage.matchAll(/rgba?\(([^)]+)\)/g)]
        .map(m => m[1].split(',').map(Number).slice(0, 3));
    const ink = getComputedStyle(meta).color.match(/\d+/g).map(Number);
    const alpha = Number(getComputedStyle(meta).opacity);
    const lum = rgb => {
        const [r, g, b] = rgb.map(c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = bg => {
        const fg = ink.map((c, i) => alpha * c + (1 - alpha) * bg[i]);
        const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
    };
    return { stops: stops.length, min: Math.min(...stops.map(ratio)) };
});
check('время на своих сообщениях — контраст не ниже 4,5:1', contrast.stops >= 2 && contrast.min >= 4.5,
    `${contrast.min.toFixed(2)}:1`);

await openRoom(alice);
const lastId = (await db.query('SELECT max(id) AS id FROM messages WHERE room_id = $1', [room])).rows[0].id;
// Пузырь убирает сокет-событие messageDeleted — как у всех участников.
await alice.page.evaluate(id => api(`/api/messages/${id}`, { method: 'DELETE' }), lastId);
await alice.page.waitForTimeout(800);
const lastYearMoscow = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' })
    .format(new Date(Date.now() - 400 * 864e5));
const afterDelete = await separators(alice);
check('удалили единственное сообщение дня — ушёл и разделитель «Сегодня»',
    JSON.stringify(afterDelete) === JSON.stringify([lastYearMoscow, 'Вчера']), JSON.stringify(afterDelete));

/* ------------------------- Enter и IME ------------------------- */

let sends = 0;
alice.page.on('request', r => { if (r.method() === 'POST' && /\/api\/messages(\/encrypted)?$/.test(r.url())) sends++; });
await alice.page.fill('#message-input', 'にほん');
await alice.page.evaluate(() => {
    const input = document.getElementById('message-input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
});
await alice.page.waitForTimeout(800);
check('Enter при наборе через IME не отправляет', sends === 0 && await alice.page.inputValue('#message-input') === 'にほん');
await alice.page.press('#message-input', 'Enter');
await alice.page.waitForTimeout(1000);
check('обычный Enter отправляет', sends === 1);
check('у поля ввода подсказка «Отправить» на клавиатуре', await alice.page.getAttribute('#message-input', 'enterkeyhint') === 'send');

/* ------------------------- превью без удалённого ------------------------- */

const preview = await alice.page.evaluate(async () => {
    const chats = (await api('/api/chats')).chats;
    const bot = chats.find(c => c.is_bot);
    await api('/api/messages', { method: 'POST', body: JSON.stringify({ chatId: bot.id, text: 'первое боту' }) });
    await new Promise(r => setTimeout(r, 2500));   // бот отвечает с задержкой
    const botReply = (await api(`/api/messages/${bot.id}`)).messages.at(-1).text;
    const sent = await api('/api/messages', { method: 'POST', body: JSON.stringify({ chatId: bot.id, text: 'это я удалю' }) });
    await api(`/api/messages/${sent.message.id}`, { method: 'DELETE' });
    const after = (await api('/api/chats')).chats.find(c => c.is_bot);
    return { botReply, last: after.last_message };
});
check('превью чата не показывает удалённое сообщение', preview.last === preview.botReply, JSON.stringify(preview));

/* ------------------------- тема и строка состояния ------------------------- */

const themeColors = () => alice.page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    colors: [...document.querySelectorAll('meta[name="theme-color"]')].map(m => m.content),
}));
const before = await themeColors();
await alice.page.locator('[data-theme-toggle]:visible').first().click();
const after = await themeColors();
const expectColor = t => t === 'light' ? '#f4f4f7' : '#08080e';
check('ручная смена темы красит и строку состояния',
    before.theme !== after.theme && after.colors.length === 2 && after.colors.every(c => c === expectColor(after.theme))
    && before.colors.every(c => c === expectColor(before.theme)), JSON.stringify({ before, after }));
await alice.page.reload({ waitUntil: 'networkidle' });
const reloaded = await themeColors();
check('и после перезагрузки тоже', reloaded.theme === after.theme && reloaded.colors.every(c => c === expectColor(after.theme)),
    JSON.stringify(reloaded));

/* ------------------------- телефон ------------------------- */

const phoneContext = await browser.newContext({ viewport: { width: 375, height: 700 }, isMobile: true, hasTouch: true,
    timezoneId: 'Asia/Tokyo', extraHTTPHeaders: { 'X-Forwarded-For': '10.0.1.99' } });
const phone = await phoneContext.newPage();
phone.on('pageerror', e => errors.push(`phone: ${e.message}`));
await phone.goto(BASE, { waitUntil: 'networkidle' });
const fontSizes = await phone.evaluate(() => ['login-email', 'login-password', 'message-input', 'search-input']
    .map(id => parseFloat(getComputedStyle(document.getElementById(id)).fontSize)));
check('на телефоне поля ввода не мельче 16px — Safari не увеличивает страницу', fontSizes.every(px => px >= 16),
    JSON.stringify(fontSizes));

await phone.evaluate(async () => {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'bob@example.com', password: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
});
await phone.reload({ waitUntil: 'networkidle' });
await phone.waitForTimeout(1200);
await phone.locator('.chat-item[data-room-id]:not([data-room-id=""])').first().click();
await phone.waitForTimeout(1200);

const touch = await phone.evaluate(() => {
    const more = [...document.querySelectorAll('#chat-messages .message-more')].at(-1);
    const r = more.getBoundingClientRect();
    const zone = getComputedStyle(more, '::before');
    const width = r.width - parseFloat(zone.left) - parseFloat(zone.right);
    const height = r.height - parseFloat(zone.top) - parseFloat(zone.bottom);
    // Точка за краем видимой кнопки, но внутри зоны нажатия.
    const away = more.closest('.message').classList.contains('sent') ? -1 : 1;
    const hit = document.elementFromPoint(r.left + r.width / 2 + away * 20, r.top + r.height / 2);
    return { width, height, hit: Boolean(hit && hit.closest('.message-more') === more) };
});
check('зона нажатия «⋯» на тач-экране — не меньше 44×44',
    touch.width >= 44 && touch.height >= 44 && touch.hit, JSON.stringify(touch));

const subline = await phone.evaluate(() => {
    const text = document.querySelector('#chat-encryption .encryption-badge-text');
    text.textContent = 'Зашифровано сквозным шифрованием, но ключи собеседника ещё не сверены';
    const line = document.querySelector('.chat-subline');
    const header = document.querySelector('.chat-header').getBoundingClientRect();
    return {
        oneLine: line.getBoundingClientRect().height < 24,
        inside: line.getBoundingClientRect().right <= header.right,
        cut: text.scrollWidth > text.clientWidth && getComputedStyle(text).textOverflow === 'ellipsis',
        status: document.getElementById('chat-status').scrollWidth <= document.getElementById('chat-status').clientWidth,
    };
});
check('подпись в шапке на телефоне — в одну строку, длинная обрезана многоточием',
    subline.oneLine && subline.inside && subline.cut && subline.status, JSON.stringify(subline));
await phoneContext.close();

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await browser.close();
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
