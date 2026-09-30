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

import { launch, finish } from './lib/browser.mjs';
import pg from 'pg';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };

const browser = await launch();
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

/* ------------------------- ссылка-приглашение ------------------------- */

const code = await alice.page.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Время' }) });
    return (await api(`/api/chats/${c.chat.id}/link`, { method: 'POST', body: JSON.stringify({ requireApproval: false }) })).code;
});
const bob = await openApp('bob', 'Asia/Tokyo');
await register(bob, 'bob');
const messy = ` ${code.slice(0, 3).toLowerCase()}-${code.slice(3).toLowerCase()} `;
const joined = await bob.page.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), messy);
check('код ссылки принимается в нижнем регистре, с пробелами и дефисом', joined.success === true, `«${messy}»`);
const placeholder = await bob.page.getAttribute('#join-chat-code', 'placeholder');
check('пример в поле — ссылка /join# с кодом из 12 знаков, как настоящая', /\/join#[A-Z0-9]{12}$/.test(placeholder) && code.length === 12, placeholder);

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
    // Градиент — самая светлая точка; сплошной фон — его цвет.
    const source = getComputedStyle(bubble).backgroundImage !== 'none' ? getComputedStyle(bubble).backgroundImage : getComputedStyle(bubble).backgroundColor;
    const stops = [...source.matchAll(/rgba?\(([^)]+)\)/g)]
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
check('время на своих сообщениях — контраст не ниже 4,5:1', contrast.stops >= 1 && contrast.min >= 4.5,
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
// Смена темы идёт через View Transition — новая тема применяется чуть позже.
await alice.page.waitForFunction(t => document.documentElement.dataset.theme !== t, before.theme);
const after = await themeColors();
// В приложении строка состояния — цвета шапки.
const expectColor = t => t === 'light' ? '#ffffff' : '#121212';
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

// Старые сообщения этому (новому) устройству не прочитать — пишем своё.
await phone.fill('#message-input', 'с телефона');
await phone.click('#send-btn');
await phone.waitForTimeout(1500);

// На сенсорном экране «⋯» не нужна: меню открывает долгое нажатие.
const touch = await phone.evaluate(() => {
    const more = [...document.querySelectorAll('#chat-messages .message-more')].at(-1);
    const style = getComputedStyle(more);
    return { opacity: style.opacity, pointer: style.pointerEvents };
});
check('«⋯» на тач-экране скрыта и не ловит нажатия', touch.opacity === '0' && touch.pointer === 'none', JSON.stringify(touch));
const bubbleBox = await phone.evaluate(() => {
    const bubble = [...document.querySelectorAll('#chat-messages .message')]
        .filter(b => (b.querySelector('.message-text')?.textContent || '').trim().length > 0).at(-1);
    bubble.scrollIntoView({ block: 'center' });
    const r = bubble.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
});
await phone.evaluate(([x, y]) => {
    const target = document.elementFromPoint(x, y);
    const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y });
    target.dispatchEvent(new TouchEvent('touchstart', { touches: [touch], targetTouches: [touch], changedTouches: [touch], bubbles: true }));
}, [bubbleBox.x + 20, bubbleBox.y + 10]);
await phone.waitForTimeout(550);
const longPress = await phone.evaluate(() => ({
    open: document.getElementById('message-menu').matches(':popover-open'),
    select: !document.getElementById('select-text-btn').hidden,
    userSelect: getComputedStyle(document.querySelector('#chat-messages .message')).userSelect,
    lifted: Boolean(document.querySelector('#chat-messages .message.is-lifted')),
    dim: Boolean(document.querySelector('.main-content > .message-dim.is-shown')),
}));
check('долгое нажатие приподнимает пузырь, остальное гаснет', longPress.lifted && longPress.dim, JSON.stringify(longPress));
check('долгое нажатие (400 мс) открывает меню, в нём — «Выделить текст»', longPress.open && longPress.select, JSON.stringify(longPress));
check('текст в пузыре не выделяется сам', longPress.userSelect === 'none', JSON.stringify(longPress));
await phone.evaluate(([x, y]) => {
    const target = document.elementFromPoint(x, y);
    target.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
}, [bubbleBox.x + 20, bubbleBox.y + 10]);
await phone.waitForTimeout(200);
check('системный contextmenu вслед за долгим нажатием меню второй раз не открывает (Android)',
    await phone.evaluate(() => document.getElementById('message-menu').style.left) !== '30px');
await phone.click('#select-text-btn');
const selected = await phone.evaluate(() => ({
    text: window.getSelection().toString(),
    selectable: Boolean(document.querySelector('#chat-messages .message.is-selectable')),
}));
check('«Выделить текст» выделяет текст сообщения', selected.text.length > 0 && selected.selectable, JSON.stringify(selected));
await phone.evaluate(() => window.getSelection().removeAllRanges());

const enter = await phone.evaluate(() => {
    const input = document.getElementById('message-input');
    input.value = 'строка';
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    const result = { prevented: e.defaultPrevented, hint: input.enterKeyHint, value: input.value };
    input.value = '';
    return result;
});
check('на телефоне Enter — перенос строки, отправка — кнопкой', !enter.prevented && enter.hint === 'enter' && enter.value === 'строка',
    JSON.stringify(enter));
const swipe = await phone.evaluate(() => {
    const bubble = [...document.querySelectorAll('#chat-messages .message')].at(-1);
    const r = bubble.getBoundingClientRect();
    const at = (x, y) => new Touch({ identifier: 2, target: bubble, clientX: x, clientY: y });
    const x = r.left + 10, y = r.top + r.height / 2;
    bubble.dispatchEvent(new TouchEvent('touchstart', { touches: [at(x, y)], changedTouches: [at(x, y)], bubbles: true }));
    const during = [];
    for (const dx of [15, 35, 60, 90]) {
        bubble.dispatchEvent(new TouchEvent('touchmove', { touches: [at(x - dx, y + 2)], changedTouches: [at(x - dx, y + 2)], bubbles: true }));
        during.push(bubble.style.transform);
    }
    const icon = bubble.querySelector('.swipe-reply-icon');
    const iconState = icon && { opacity: icon.style.opacity, ready: icon.classList.contains('is-ready') };
    const transition = bubble.style.transition;
    bubble.dispatchEvent(new TouchEvent('touchend', { changedTouches: [at(x - 90, y + 2)], bubbles: true }));
    return {
        during, iconState, transition,
        reply: !document.getElementById('reply-preview').classList.contains('hidden'),
        text: document.getElementById('reply-preview-text').textContent,
        menu: document.getElementById('message-menu').matches(':popover-open'),
    };
});
check('свайп влево по сообщению — ответ на него', swipe.reply && swipe.text.length > 0 && !swipe.menu, JSON.stringify(swipe));
// До порога 48px — за пальцем, дальше — плавное сопротивление:
// 48 + (1 − 1 / (0,004·(dx − 48) + 1))·100 (п. 186): при 90px — 62,4.
const shiftOf = t => -parseFloat(/-?[\d.]+/.exec(t || '0')[0]);
check('пузырь идёт за пальцем без перехода, дальше 48px — с сопротивлением, значок ответа на пороге',
    swipe.transition === 'none' && swipe.during[1] === 'translateX(-35px)' && Math.abs(shiftOf(swipe.during[3]) - 62.38) < 0.1
    && swipe.iconState && swipe.iconState.opacity === '1' && swipe.iconState.ready, JSON.stringify(swipe));
await phone.click('#cancel-reply-btn');
const inline = await phone.evaluate(() => {
    const bubble = [...document.querySelectorAll('#chat-messages .message.inline-meta')].find(b => b.querySelector('.message-text').textContent.length < 20);
    if (!bubble) return null;
    const text = bubble.querySelector('.message-text').getBoundingClientRect();
    const meta = bubble.querySelector('.message-meta').getBoundingClientRect();
    return { sameLine: Math.abs(meta.bottom - text.bottom) < 6, height: Math.round(bubble.getBoundingClientRect().height) };
});
check('время — в конце строки короткого сообщения, пузырь в одну строку', inline && inline.sameLine && inline.height < 56, JSON.stringify(inline));
await phone.evaluate(() => {
    const bubble = [...document.querySelectorAll('#chat-messages .message')]
        .filter(b => (b.querySelector('.message-text')?.textContent || '').trim()).at(-1);
    const text = bubble.querySelector('.message-text');
    const r = text.getBoundingClientRect();
    const at = () => new Touch({ identifier: 3, target: text, clientX: r.left + 5, clientY: r.top + 5 });
    for (let i = 0; i < 2; i++) {
        text.dispatchEvent(new TouchEvent('touchstart', { touches: [at()], changedTouches: [at()], bubbles: true }));
        text.dispatchEvent(new TouchEvent('touchend', { changedTouches: [at()], bubbles: true }));
    }
});
await phone.waitForTimeout(1200);
check('двойной тап по сообщению — ❤️', await phone.locator('#chat-messages .message .reaction.mine[data-emoji="❤️"]').count() === 1);

const phoneLayout = await phone.evaluate(() => {
    const back = document.getElementById('chat-back-btn');
    const r = back.getBoundingClientRect();
    const style = getComputedStyle(back);
    return {
        back: { w: Math.round(r.width), h: Math.round(r.height), display: style.display, bg: style.backgroundColor, border: style.borderTopWidth },
        invite: getComputedStyle(document.getElementById('get-chat-code-btn')).display,
        badgeText: [...document.querySelectorAll('#chat-encryption span')].map(el => getComputedStyle(el).width).join(),
        badgeIcon: Boolean(document.querySelector('#chat-encryption .icon')),
        badgeLabel: document.querySelector('#chat-encryption .encryption-badge-text')?.textContent,
        overscroll: [getComputedStyle(document.getElementById('chat-messages')).overscrollBehaviorY,
            getComputedStyle(document.getElementById('chats-list')).overscrollBehaviorY],
        manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
    };
});
check('«назад» — стрелка без круга, зона 44×44', phoneLayout.back.w === 44 && phoneLayout.back.h === 44 && phoneLayout.back.display === 'grid'
    && phoneLayout.back.border === '0px' && phoneLayout.back.bg === 'rgba(0, 0, 0, 0)', JSON.stringify(phoneLayout.back));
check('кнопки приглашения в шапке телефона нет (она в меню чата)', phoneLayout.invite === 'none', phoneLayout.invite);
check('статус шифрования — только значком, полная подпись — для диктора',
    phoneLayout.badgeIcon && phoneLayout.badgeText.split(',').every(w => w === '1px' || w === '0px' || w === 'auto')
    && Boolean(phoneLayout.badgeLabel), JSON.stringify(phoneLayout));
check('потянуть список или ленту — не перезагрузка страницы', phoneLayout.overscroll.every(v => v === 'contain'), JSON.stringify(phoneLayout.overscroll));
const manifest = await (await fetch('http://127.0.0.1:3006/manifest.webmanifest')).json();
check('манифест: standalone и иконки', phoneLayout.manifest === '/manifest.webmanifest' && manifest.display === 'standalone'
    && manifest.icons.some(i => i.sizes === '512x512'), JSON.stringify(manifest.icons?.map(i => i.sizes)));

const subline = await phone.evaluate(() => {
    const text = document.querySelector('#chat-encryption .encryption-badge-text');
    text.textContent = 'Зашифровано сквозным шифрованием, но ключи собеседника ещё не сверены';
    const line = document.querySelector('.chat-subline');
    const header = document.querySelector('.chat-header').getBoundingClientRect();
    return {
        oneLine: line.getBoundingClientRect().height < 24,
        inside: line.getBoundingClientRect().right <= header.right,
        // Обрезана многоточием или, если места совсем нет, спрятана только
        // с экрана — диктор её читает.
        cut: (text.scrollWidth > text.clientWidth && getComputedStyle(text).textOverflow === 'ellipsis')
            || (getComputedStyle(text).clipPath === 'inset(50%)' && getComputedStyle(text).display !== 'none'),
        status: document.getElementById('chat-status').scrollWidth <= document.getElementById('chat-status').clientWidth,
    };
});
check('подпись в шапке на телефоне — в одну строку, длинная не вылезает (многоточие или только значок)',
    subline.oneLine && subline.inside && subline.cut && subline.status, JSON.stringify(subline));
await phoneContext.close();

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
