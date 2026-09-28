// Отклик интерфейса (docs/motion.md, п. 128–135, 149).
//
//   - своё сообщение появляется сразу, до шифрования и ответа сервера:
//     поле пустое, пузырь «отправляется» с часиками; потом — id и отметка;
//   - двойной Enter — одно сообщение;
//   - не ушло — «Не отправлено · Повторить · Удалить» в пузыре; повтор —
//     с тем же clientId, сообщение одно;
//   - «Ответить» ставит курсор в поле, над текстом — имя автора;
//   - правая кнопка поля: скрепка / «Отправить» / «Сохранить», плашка
//     «Редактирование»; кнопка не забирает фокус у поля;
//   - профиль открывается сразу, разделы — по мере ответов, не
//     загрузившийся — «Не удалось загрузить · Повторить»;
//   - нажатие сжимает кнопку, наведение — только для мыши, маленькие
//     кнопки на тач-экране — с зоной 44×44;
//   - ошибка в шапке профиля — отдельной строкой, а не колонкой сбоку;
//   - смена темы — перетеканием, без круга; аватар — только цвет;
//   - телефон: экран входа прокручивается пальцем, долгое нажатие не
//     выделяет текст интерфейса.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-motion-ui.mjs

import pg from 'pg';
import { launch, finish } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': `10.0.23.${nextIp++}` }, ...options });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return page;
}
const register = (page, u) => page.evaluate(async u => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'password123', confirmPassword: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
}, u);
const ROOM = '.chat-item[data-room-id]:not([data-room-id=""])';
const roomCount = async roomId => Number((await db.query("SELECT count(*) FROM messages WHERE room_id = $1 AND message_type <> 'system'", [roomId])).rows[0].count);

const alice = await openApp('alice');
await register(alice, 'alice');
const bob = await openApp('bob');
await register(bob, 'bob');
const { code, roomId } = await alice.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Отклик' }) });
    const link = await api(`/api/chats/${c.chat.id}/link`, { method: 'POST', body: JSON.stringify({ requireApproval: false }) });
    return { code: link.code, roomId: c.chat.room_id };
});
await bob.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
for (const p of [alice, bob]) {
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
    await p.locator(ROOM).first().click();
    await p.waitForTimeout(1000);
}

/* ------------------------- своё — сразу ------------------------- */

// Сервер отвечает медленно — пузырь не ждёт.
await alice.route('**/api/messages/encrypted', async route => { await sleep(1500); await route.continue(); });
await alice.fill('#message-input', 'медленная сеть');
await alice.press('#message-input', 'Enter');
await alice.waitForTimeout(150);
const early = await alice.evaluate(() => {
    const bubble = [...document.querySelectorAll('#chat-messages .message')].at(-1);
    return {
        input: document.getElementById('message-input').value,
        text: bubble.querySelector('.message-text')?.textContent,
        sending: bubble.classList.contains('is-sending'),
        clientId: bubble.dataset.clientId || null,
        id: bubble.dataset.messageId || null,
        timer: Boolean(bubble.querySelector('.message-status use[href="#i-timer"]')),
        preview: document.querySelector('.chat-item.active .chat-last')?.textContent,
    };
});
check('по Enter сразу: поле пустое, пузырь «отправляется» с часиками, превью в списке',
    early.input === '' && early.text === 'медленная сеть' && early.sending && early.clientId && !early.id && early.timer
    && early.preview.includes('медленная сеть'), JSON.stringify(early));
await alice.waitForTimeout(2500);
const settled = await alice.evaluate(cid => {
    const bubble = document.querySelector(`#chat-messages .message[data-client-id="${cid}"]`);
    return bubble && { id: bubble.dataset.messageId, sending: bubble.classList.contains('is-sending'),
        status: bubble.querySelector('.message-status').dataset.status,
        count: [...document.querySelectorAll('#chat-messages .message')].filter(m => m.textContent.includes('медленная сеть')).length };
}, early.clientId);
check('ответ пришёл — тот же пузырь получил id и отметку, второго нет',
    settled && settled.id && !settled.sending && settled.status !== 'sending' && settled.count === 1, JSON.stringify(settled));
await alice.unroute('**/api/messages/encrypted');

// Двойной Enter.
const before = await roomCount(roomId);
await alice.fill('#message-input', 'один раз');
await alice.press('#message-input', 'Enter');
await alice.press('#message-input', 'Enter');
await alice.waitForTimeout(1500);
check('двойной Enter — одно сообщение', await roomCount(roomId) === before + 1);

// Не ушло — «Повторить» с тем же clientId.
await alice.route('**/api/messages/encrypted', route => route.fulfill({ status: 500, contentType: 'application/json',
    body: JSON.stringify({ success: false, message: 'сервер упал' }) }));
await alice.fill('#message-input', 'повторю');
await alice.press('#message-input', 'Enter');
await alice.waitForTimeout(1000);
const failed = await alice.evaluate(() => {
    const bubble = document.querySelector('#chat-messages .message.is-failed');
    return bubble && { text: bubble.querySelector('.message-failed').textContent.replace(/\s+/g, ' ').trim(), cid: bubble.dataset.clientId };
});
check('не ушло — в пузыре «Не отправлено · Повторить · Удалить»', failed && failed.text === 'Не отправлено · Повторить · Удалить',
    JSON.stringify(failed));
await alice.unroute('**/api/messages/encrypted');
const sentIds = [];
alice.on('request', r => { if (r.url().endsWith('/api/messages/encrypted')) sentIds.push(JSON.parse(r.postData()).clientId); });
await alice.locator('.message.is-failed button', { hasText: 'Повторить' }).click();
await alice.waitForTimeout(1500);
check('«Повторить» — с тем же clientId, сообщение одно и дошло',
    sentIds.length === 1 && sentIds[0] === failed.cid
    && Number((await db.query('SELECT count(*) FROM messages WHERE client_id = $1', [failed.cid])).rows[0].count) === 1
    && await alice.locator('#chat-messages .message', { hasText: 'повторю' }).count() === 1
    && await alice.locator('#chat-messages .message.is-failed').count() === 0, JSON.stringify(sentIds));
await bob.waitForTimeout(800);
check('и собеседник его видит', await bob.locator('#chat-messages .message', { hasText: 'повторю' }).count() === 1);

/* ------------------------- ответ ------------------------- */

await bob.fill('#message-input', 'ответь мне');
await bob.press('#message-input', 'Enter');
await alice.waitForTimeout(1200);
await alice.locator('#chat-messages .message', { hasText: 'ответь мне' }).click({ button: 'right' });
await alice.click('#reply-message-btn');
const reply = await alice.evaluate(() => ({
    focus: document.activeElement.id,
    author: document.getElementById('reply-preview-author').textContent,
    text: document.getElementById('reply-preview-text').textContent,
}));
check('«Ответить» — курсор в поле, над текстом имя автора', reply.focus === 'message-input' && reply.author === 'bob'
    && reply.text === 'ответь мне', JSON.stringify(reply));
await alice.fill('#message-input', 'отвечаю');
await alice.press('#message-input', 'Enter');
await alice.waitForTimeout(150);
check('в пузыре ответа сразу видна цитата', await alice.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .message')].at(-1).querySelector('.reply-to-author')?.textContent === 'bob'));

/* ------------------------- кнопка поля ------------------------- */

const mode = () => alice.getAttribute('#send-btn', 'data-mode');
await alice.fill('#message-input', '');
const empty = await mode();
await alice.fill('#message-input', 'текст');
const typed = await mode();
check('пустое поле — скрепка, есть текст — «Отправить»; левой скрепки нет',
    empty === 'attach' && typed === 'send' && await alice.locator('#attach-btn').count() === 0, `${empty} → ${typed}`);
await alice.click('#send-btn');
await alice.waitForTimeout(200);
check('кнопка не забирает фокус у поля', await alice.evaluate(() => document.activeElement.id) === 'message-input');
const bot = alice.locator('.chat-item', { hasText: 'Бот' });
await bot.click();
await alice.waitForTimeout(800);
await alice.fill('#message-input', 'поправлю');
await alice.press('#message-input', 'Enter');
await alice.waitForTimeout(1200);
await alice.locator('#chat-messages .message.sent', { hasText: 'поправлю' }).click({ button: 'right' });
await alice.click('#edit-message-btn');
const editing = await alice.evaluate(() => ({
    mode: document.getElementById('send-btn').dataset.mode,
    bar: !document.getElementById('edit-preview').classList.contains('hidden'),
    text: document.getElementById('edit-preview-text').textContent,
}));
check('правка: кнопка «Сохранить», над полем — «Редактирование»', editing.mode === 'save' && editing.bar && editing.text === 'поправлю',
    JSON.stringify(editing));
await alice.fill('#message-input', 'поправил');
await alice.press('#message-input', 'Enter');
await alice.waitForTimeout(100);
check('исправленный текст — сразу в пузыре, плашка ушла', await alice.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .message.sent .message-text')].some(t => t.textContent === 'поправил')
    && document.getElementById('edit-preview').classList.contains('hidden') && document.getElementById('send-btn').dataset.mode === 'attach'));

/* ------------------------- профиль ------------------------- */

await alice.route('**/api/user/code', async route => { await sleep(1500); await route.continue(); });
await alice.route('**/api/blocks', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false}' }));
const t0 = Date.now();
await alice.click('#profile-btn');
await alice.waitForFunction(() => document.getElementById('profile-modal').open);
const openedIn = Date.now() - t0;
const profile = await alice.evaluate(() => ({
    name: document.getElementById('profile-username').textContent,
    codeLoading: document.getElementById('user-code-display').parentElement.classList.contains('is-loading'),
}));
check('профиль открывается сразу: имя уже есть, код — заготовкой', openedIn < 500 && profile.name === 'alice' && profile.codeLoading,
    `${openedIn} мс ${JSON.stringify(profile)}`);
await alice.waitForTimeout(2000);
const sections = await alice.evaluate(() => ({
    code: document.getElementById('user-code-display').textContent,
    blocked: document.querySelector('#blocked-section .section-error')?.textContent,
    blockedShown: !document.getElementById('blocked-section').hidden || document.querySelector('#blocked-section .section-error') !== null,
    devices: document.querySelectorAll('#devices-list .device-item').length,
}));
check('разделы заполнились по своим ответам, упавший — «Не удалось загрузить · Повторить»',
    /^[A-Z0-9]{4}-/.test(sections.code) && sections.devices === 1 && sections.blocked === 'Не удалось загрузить · Повторить',
    JSON.stringify(sections));
await alice.unroute('**/api/blocks');
await alice.unroute('**/api/user/code');
await alice.keyboard.press('Escape');
await alice.waitForTimeout(300);

// Шапка профиля (аватар и имя в ряд): ошибка — строкой под ними.
await alice.route('**/api/user', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false}' }));
await alice.click('#profile-btn');
await alice.waitForSelector('.profile-info > .section-error');
const headError = await alice.evaluate(() => {
    const info = document.querySelector('.profile-info').getBoundingClientRect();
    const row = document.querySelector('.profile-info > .section-error').getBoundingClientRect();
    const avatar = document.getElementById('profile-avatar').getBoundingClientRect();
    return { full: Math.round(row.width) === Math.round(info.width), below: row.top >= avatar.bottom - 1, oneLine: row.height < 40 };
});
check('ошибка в шапке профиля — отдельной строкой под аватаром, в одну строку', headError.full && headError.below && headError.oneLine,
    JSON.stringify(headError));
await alice.unroute('**/api/user');
await alice.keyboard.press('Escape');
await alice.waitForTimeout(300);

/* ------------------------- нажатие и касание ------------------------- */

const press = await alice.evaluate(() => {
    const sheet = [...document.styleSheets].find(x => x.href && x.href.includes('style.css'));
    const text = [...sheet.cssRules].map(r => r.cssText).join('\n');
    const root = getComputedStyle(document.documentElement);
    return {
        tokens: ['--ease-out', '--ease-in-out', '--ease-drawer', '--dur-press', '--dur-screen'].every(t => root.getPropertyValue(t).trim()),
        scale: /\.btn:active:not\(:disabled\)[^{]*\{[^}]*scale\(0\.96\)/.test(text),
        hover: !/@media \(hover: hover\) \{/.test(text),
        easeIn: /ease-in[^-]|cubic-bezier\(0\.4, 0, 1, 1\)/.test(text.replace(/--ease-in-out/g, '')),
        touch: /touch-action: manipulation/.test(text),
    };
});
check('токены движения, отклик scale(0.96), наведение только для мыши, без ease-in, touch-action',
    press.tokens && press.scale && press.hover && !press.easeIn && press.touch, JSON.stringify(press));
const phone = await openApp('phone', { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
const hit = await phone.evaluate(() => {
    const btn = document.querySelector('.icon-btn-sm');
    const r = btn.getBoundingClientRect();
    const zone = getComputedStyle(btn, '::before');
    return { w: r.width, inset: zone.top, content: zone.content };
});
// Кнопка 34px, зона выходит за неё на 5px с каждой стороны.
check('маленькие кнопки на тач-экране — зона 44×44', hit.content !== 'none' && Math.abs(parseFloat(hit.inset) + 5) < 0.5,
    JSON.stringify(hit));

/* ------------------------- вид чата ------------------------- */

await alice.locator(ROOM).first().click();
await alice.waitForTimeout(800);
const look = await alice.evaluate(() => {
    const header = document.getElementById('chat-header');
    const list = document.getElementById('chat-messages');
    const sent = [...document.querySelectorAll('#chat-messages .message.sent.group-end')].at(-1);
    const received = document.querySelector('#chat-messages .message.received');
    return {
        headerBg: getComputedStyle(header).backgroundColor,
        blur: getComputedStyle(header).backdropFilter,
        topPad: parseFloat(getComputedStyle(list).paddingTop),
        headerH: header.getBoundingClientRect().height,
        tail: sent ? getComputedStyle(sent, '::after').content : null,
        receivedBorder: received ? getComputedStyle(received).borderTopWidth : null,
        pattern: getComputedStyle(document.querySelector('.main-content'), '::before').maskImage !== 'none'
            || getComputedStyle(document.querySelector('.main-content'), '::before').webkitMaskImage !== 'none',
        themeColor: document.querySelector('meta[name="theme-color"]').content,
    };
});
check('шапка полупрозрачная с размытием, лента начинается под ней',
    /rgba?\(.*,\s*0\.\d+\)|\/ 0\.\d+\)|color-mix/.test(look.headerBg) && look.blur.includes('blur') && look.topPad >= look.headerH, JSON.stringify(look));
check('хвостик у последнего своего, чужой пузырь без рамки, узор фона', look.tail && look.tail !== 'none'
    && look.receivedBorder === '0px' && look.pattern, JSON.stringify(look));
check('строка состояния — цвет шапки', ['#14141f', '#ffffff'].includes(look.themeColor), look.themeColor);
check('«1 день» в системной строке не рвётся', await alice.evaluate(() =>
    systemLineText('bob включил(а) исчезающие сообщения: 1 день').includes('1 день')));

/* ------------------------- настройки ------------------------- */

check('в нижней панели «Настройки» вместо «Выйти»', await alice.evaluate(() =>
    Boolean(document.querySelector('.sidebar-footer #settings-btn')) && !document.querySelector('.sidebar-footer #logout-btn')));
await alice.click('#settings-btn');
await alice.waitForFunction(() => document.getElementById('settings-modal').open);
const settings = await alice.evaluate(() => ({
    logout: Boolean(document.querySelector('#settings-modal #logout-btn')),
    typing: document.getElementById('typing-toggle').checked,
    sounds: document.getElementById('sounds-toggle').checked,
}));
check('в «Настройках» — «печатает», звуки (выключены), выход', settings.logout && settings.typing && !settings.sounds, JSON.stringify(settings));
await alice.check('input[name="chat-bg"][value="plain"]');
check('«Фон: без фона»', await alice.evaluate(() => document.documentElement.dataset.chatBg === 'plain'));
await alice.check('input[name="chat-bg"][value="gradient"]');
await alice.keyboard.press('Escape');

/* ------------------------- «печатает…» ------------------------- */

await bob.locator(ROOM).first().click();
await bob.waitForTimeout(600);
await bob.type('#message-input', 'пишу');
await alice.waitForTimeout(600);
const typing = await alice.evaluate(() => ({
    header: document.getElementById('chat-status').textContent,
    dots: document.querySelectorAll('#chat-status .typing-dots i').length,
    list: document.querySelector('.chat-item.active')?.classList.contains('is-typing'),
}));
check('собеседник печатает — в шапке «печатает» с тремя точками, в списке тоже', /печатает/.test(typing.header) && typing.dots === 3
    && typing.list, JSON.stringify(typing));
await bob.press('#message-input', 'Enter');
await alice.waitForTimeout(1200);
check('пришло сообщение — «печатает» снялось', await alice.evaluate(() => !/печатает/.test(document.getElementById('chat-status').textContent)));

/* ------------------------- эмодзи ------------------------- */

await alice.fill('#message-input', '🔥');
await alice.press('#message-input', 'Enter');
await alice.waitForTimeout(1000);
const emoji = await alice.evaluate(() => {
    const bubble = [...document.querySelectorAll('#chat-messages .message')].at(-1);
    return { cls: bubble.classList.contains('is-emoji'), count: bubble.dataset.emojiCount,
        size: getComputedStyle(bubble.querySelector('.message-text')).fontSize, bg: getComputedStyle(bubble).backgroundImage };
});
check('одно эмодзи — 64px, без пузыря', emoji.cls && emoji.count === '1' && emoji.size === '64px' && emoji.bg === 'none', JSON.stringify(emoji));
check('«ок 🔥» — обычный пузырь', await alice.evaluate(() => emojiOnlyCount('ок 🔥') === 0 && emojiOnlyCount('👍👍👍') === 3
    && emojiOnlyCount('👍👍👍👍') === 0 && emojiOnlyCount('🇷🇺') === 1));

/* ------------------------- аватар ------------------------- */

const avatars = await alice.evaluate(async () => ({
    emoji: (await api('/api/user/avatar', { method: 'POST', body: JSON.stringify({ avatar: 'e:0:2' }) })).success,
    color: (await api('/api/user/avatar', { method: 'POST', body: JSON.stringify({ avatar: '#2dd4a7' }) })).avatar,
    picker: document.getElementById('avatar-emoji-picker') !== null,
    set: (await fetch('/avatars.json')).status,
}));
check('аватар — только цвет: эмодзи сервер не принимает, выбора эмодзи нет', avatars.emoji === false && avatars.color === '#2DD4A7'
    && !avatars.picker && avatars.set === 404, JSON.stringify(avatars));

/* ------------------------- тема ------------------------- */

const themeBefore = await alice.evaluate(() => document.documentElement.dataset.theme);
await alice.locator('[data-theme-toggle]:visible').first().click();
await alice.waitForTimeout(60);
const fade = await alice.evaluate(() => document.getAnimations().filter(a => a.effect && a.effect.pseudoElement
    && a.effect.pseudoElement.startsWith('::view-transition')).map(a => ({
    el: a.effect.pseudoElement, duration: a.effect.getTiming().duration,
    clip: a.effect.getKeyframes().some(k => 'clipPath' in k),
    opacity: a.effect.getKeyframes().some(k => 'opacity' in k),
})));
await alice.waitForFunction(t => document.documentElement.dataset.theme !== t, themeBefore);
check('смена темы — перетеканием за 400 мс, без круга', fade.length >= 2 && fade.every(f => !f.clip)
    && fade.some(f => f.opacity) && fade.some(f => f.duration === 400), JSON.stringify(fade));

/* ------------------------- телефон: экраны и свайп назад ------------------------- */

await phone.evaluate(async () => {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'bob@example.com', password: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
});
await phone.waitForTimeout(800);
await phone.locator(ROOM).first().click();
await phone.waitForTimeout(600);
const opened = await phone.evaluate(() => ({
    open: document.getElementById('app').classList.contains('is-chat-open'),
    main: getComputedStyle(document.querySelector('.main-content')).transform,
    side: getComputedStyle(document.getElementById('sidebar')).transform,
}));
check('телефон: чат въехал справа, список ушёл на четверть', opened.open && opened.main === 'none'
    && /matrix\(1, 0, 0, 1, -97\.5/.test(opened.side), JSON.stringify(opened));
const back = await phone.evaluate(async () => {
    const area = document.querySelector('.main-content');
    const at = (x, y) => new Touch({ identifier: 7, target: area, clientX: x, clientY: y });
    area.dispatchEvent(new TouchEvent('touchstart', { touches: [at(60, 400)], changedTouches: [at(60, 400)], bubbles: true }));
    const mid = [];
    for (const x of [90, 140, 200]) {
        area.dispatchEvent(new TouchEvent('touchmove', { touches: [at(x, 404)], changedTouches: [at(x, 404)], bubbles: true }));
        mid.push(getComputedStyle(document.getElementById('app')).getPropertyValue('--back'));
    }
    const swiping = document.getElementById('app').classList.contains('is-swiping-back');
    area.dispatchEvent(new TouchEvent('touchend', { changedTouches: [at(200, 404)], bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    return { mid, swiping, open: document.getElementById('app').classList.contains('is-chat-open') };
});
check('свайп вправо — чат идёт за пальцем, дальше 35% — назад к списку', back.swiping && Number(back.mid[2]) > 0.35 && !back.open,
    JSON.stringify(back));

const select = await phone.evaluate(() => ({
    app: getComputedStyle(document.getElementById('app')).userSelect,
    logo: getComputedStyle(document.querySelector('.sidebar .brand-word, .sidebar-header') || document.getElementById('app')).userSelect,
    input: getComputedStyle(document.getElementById('message-input')).userSelect,
}));
check('телефон: долгое нажатие не выделяет интерфейс (логотип), поле ввода — выделяется',
    select.app === 'none' && select.logo === 'none' && select.input === 'text', JSON.stringify(select));

// Экран входа ниже формы регистрации: прокручивается пальцем.
const low = await browser.newContext({ viewport: { width: 390, height: 520 }, hasTouch: true, isMobile: true });
const auth = await low.newPage();
auth.on('pageerror', e => errors.push(`auth: ${e.message}`));
await auth.goto(BASE, { waitUntil: 'networkidle' });
await auth.click('.auth-tab[data-tab="register"]');
await auth.waitForTimeout(300);
const cdp = await low.newCDPSession(auth);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 420 }] });
for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 420 - 25 * i }] });
    await auth.waitForTimeout(16);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await auth.waitForTimeout(500);
const authScroll = await auth.evaluate(() => ({
    scrolled: document.querySelector('.auth-screen').scrollTop,
    bottom: Math.round(document.querySelector('.auth-container').getBoundingClientRect().bottom),
    vh: innerHeight,
}));
check('телефон: форма регистрации выше экрана — экран входа прокручивается пальцем', authScroll.scrolled > 100
    && authScroll.bottom <= authScroll.vh, JSON.stringify(authScroll));
await low.close();

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
