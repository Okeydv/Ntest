// Лента переписки и статус собеседника.
//
//   - «В сети» меняется вживую, когда собеседник уходит и возвращается; у
//     группы — число участников;
//   - при открытии чата — разделитель «Непрочитанные» перед первым новым;
//   - подряд идущие сообщения одного автора собираются в группу;
//   - новое, пока читаешь историю, не прокручивает ленту — появляется «↓»
//     со счётчиком;
//   - цитата ведёт к исходному сообщению и подсвечивает его;
//   - реакция ставится из меню сообщения и снимается нажатием, у
//     собеседника меняется сразу;
//   - Esc отменяет ответ и правку;
//   - черновик и место в ленте остаются за чатом;
//   - пока грузится история — скелетон;
//   - «уменьшить движение» оставляет затухание, но убирает сдвиг.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-feed.mjs

import { launch, finish } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label, viewport = { width: 1100, height: 800 }) {
    const context = await browser.newContext({ viewport, extraHTTPHeaders: { 'X-Forwarded-For': `10.0.14.${nextIp++}` } });
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
const BOT = '.chat-item[data-room-id=""]';
async function openRoom(page) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator(ROOM).first().click();
    await page.waitForTimeout(1000);
}
async function send(page, text) {
    await page.fill('#message-input', text);
    await page.press('#message-input', 'Enter');
    await page.waitForTimeout(1000);
}
const status = page => page.evaluate(() => document.getElementById('chat-status').textContent);
const bubble = (page, text) => page.locator('#chat-messages .message', { hasText: text }).last();
async function openMenu(page, text) {
    await bubble(page, text).scrollIntoViewIfNeeded();
    const box = await bubble(page, text).boundingBox();
    await page.mouse.click(box.x + 20, box.y + 10, { button: 'right' });
    await page.waitForTimeout(150);
}

// Низкое окно у Алисы: ленте хватает нескольких сообщений, чтобы появилась прокрутка.
const alice = await openApp('alice', { width: 1100, height: 560 });
await register(alice, 'alice');
const bobPage = await openApp('bob');
await register(bobPage, 'bob');
const code = await alice.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Двое' }) });
    return (await api(`/api/chats/invite/${c.chat.id}`)).code;
});
await bobPage.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
await openRoom(alice);
await openRoom(bobPage);

/* ------------------------- в сети ------------------------- */

check('собеседник на месте — «В сети»', await status(alice) === 'В сети', await status(alice));
const bobContext = bobPage.context();
await bobPage.close();
await sleep(1500);
check('ушёл — «Не в сети» без перезагрузки', await status(alice) === 'Не в сети', await status(alice));
let bob = await bobContext.newPage();
bob.on('pageerror', e => errors.push(`bob: ${e.message}`));
await bob.goto(BASE, { waitUntil: 'networkidle' });
await sleep(1500);
check('вернулся — снова «В сети»', await status(alice) === 'В сети', await status(alice));

/* ------------------------- непрочитанные и группы ------------------------- */

await bob.locator(ROOM).first().click();
await bob.waitForTimeout(800);
await send(bob, 'раннее от Боба');
await openRoom(alice);
await alice.locator(BOT).first().click();
await alice.waitForTimeout(800);
for (const n of [1, 2, 3]) await send(bob, `непрочитанное ${n}`);
await alice.locator(ROOM).first().click();
await alice.waitForTimeout(1200);
const separator = await alice.evaluate(() => {
    const sep = document.querySelector('#chat-messages .unread-separator');
    return sep ? { text: sep.textContent, next: sep.nextElementSibling?.textContent || '' } : null;
});
check('разделитель «Непрочитанные» — перед первым новым',
    separator && separator.text === 'Непрочитанные' && separator.next.includes('непрочитанное 1'), JSON.stringify(separator));
const grouped = await alice.evaluate(() => [1, 2, 3].map(n =>
    [...document.querySelectorAll('#chat-messages .message')].find(m => m.textContent.includes(`непрочитанное ${n}`))
        .classList.contains('is-continuation')));
check('подряд от одного автора — группа (первое открывает её)',
    JSON.stringify(grouped) === '[false,true,true]', JSON.stringify(grouped));
await send(alice, 'ответ Алисы');
check('своё сообщение группу прерывает', await alice.evaluate(() =>
    ![...document.querySelectorAll('#chat-messages .message')].at(-1).classList.contains('is-continuation')));

/* ------------------------- «↓» к новым ------------------------- */

for (const n of [1, 2, 3, 4]) await send(alice, `заполняю ленту ${n}\nвторая строка\nтретья строка`);
const scrollable = await alice.evaluate(() => {
    const list = document.getElementById('chat-messages');
    list.scrollTop = 0;
    return list.scrollHeight > list.clientHeight + 200;
});
check('у Алисы лента прокручивается', scrollable);
await alice.waitForTimeout(300);
await send(bob, 'пока Алиса читает историю');
await alice.waitForTimeout(500);
const jump = await alice.evaluate(() => ({
    shown: !document.getElementById('jump-down').hidden,
    count: document.getElementById('jump-down-count').textContent,
    top: document.getElementById('chat-messages').scrollTop,
}));
check('новое не прокручивает ленту, появляется «↓ 1»', jump.shown && jump.count === '1' && jump.top < 50, JSON.stringify(jump));
await alice.click('#jump-down');
await alice.waitForTimeout(900);
const after = await alice.evaluate(() => {
    const list = document.getElementById('chat-messages');
    return { hidden: document.getElementById('jump-down').hidden, gap: list.scrollHeight - list.scrollTop - list.clientHeight };
});
check('«↓» ведёт вниз и прячется', after.hidden && after.gap < 5, JSON.stringify(after));

/* ------------------------- цитата ------------------------- */

await openMenu(alice, 'раннее от Боба');
await alice.click('#reply-message-btn');
await send(alice, 'это про раннее');
await alice.evaluate(() => { document.getElementById('chat-messages').scrollTop = document.getElementById('chat-messages').scrollHeight; });
await bubble(alice, 'это про раннее').locator('.reply-to').click();
await alice.waitForTimeout(700);
const target = await alice.evaluate(() => {
    const el = [...document.querySelectorAll('#chat-messages .message')].find(m => m.textContent.includes('раннее от Боба')
        && !m.querySelector('.reply-to'));
    const r = el.getBoundingClientRect();
    const list = document.getElementById('chat-messages').getBoundingClientRect();
    return { lit: el.classList.contains('is-highlighted'), inView: r.top >= list.top - 1 && r.bottom <= list.bottom + 1 };
});
check('цитата ведёт к исходному и подсвечивает его', target.lit && target.inView, JSON.stringify(target));

/* ------------------------- Esc ------------------------- */

await openMenu(alice, 'ответ Алисы');
await alice.click('#reply-message-btn');
await alice.press('#message-input', 'Escape');
check('Esc отменяет ответ', await alice.evaluate(() => document.getElementById('reply-preview').classList.contains('hidden')));
// Зашифрованное не правится — правку проверяем в чате с ботом.
await alice.locator(BOT).first().click();
await alice.waitForTimeout(800);
await send(alice, 'правлю это');
await openMenu(alice, 'правлю это');
await alice.click('#edit-message-btn');
check('правка подставляет текст', await alice.inputValue('#message-input') === 'правлю это');
await alice.press('#message-input', 'Escape');
check('Esc отменяет правку', await alice.evaluate(() => editingMessageId === null)
    && await alice.inputValue('#message-input') === '');
await alice.locator(ROOM).first().click();
await alice.waitForTimeout(1200);

/* ------------------------- реакции ------------------------- */

await bob.reload({ waitUntil: 'networkidle' });
await bob.waitForTimeout(1000);
await bob.locator(ROOM).first().click();
await bob.waitForTimeout(1200);
await openMenu(alice, 'пока Алиса читает историю');
check('в меню сообщения есть реакции', await alice.locator('#reaction-row .reaction-choice').first().isVisible());
await alice.click('#reaction-row .reaction-choice[data-emoji="👍"]');
await alice.waitForTimeout(800);
const chip = page => bubble(page, 'пока Алиса читает историю').locator('.reaction[data-emoji="👍"]');
check('реакция видна у себя', await chip(alice).count() === 1);
check('и у собеседника — без перезагрузки', await chip(bob).count() === 1);
check('новая реакция появляется с анимацией', await chip(bob).evaluate(el => el.classList.contains('is-new')));
await chip(alice).click();
await alice.waitForTimeout(800);
check('нажатие на свою реакцию снимает её у обоих', await chip(alice).count() === 0 && await chip(bob).count() === 0);

/* ------------------------- черновик и место ------------------------- */

await alice.fill('#message-input', 'недописанное');
await alice.evaluate(() => { document.getElementById('chat-messages').scrollTop = 0; });
await alice.waitForTimeout(300);
await alice.locator(BOT).first().click();
await alice.waitForTimeout(800);
check('в другом чате поле пустое', await alice.inputValue('#message-input') === '');
await alice.locator(ROOM).first().click();
await alice.waitForTimeout(1200);
check('черновик вернулся', await alice.inputValue('#message-input') === 'недописанное');
const place = await alice.evaluate(() => {
    const list = document.getElementById('chat-messages');
    return { top: list.scrollTop, gap: list.scrollHeight - list.scrollTop - list.clientHeight };
});
check('и место в ленте — там, где читали, а не внизу', place.top < 80 && place.gap > 100, JSON.stringify(place));
check('черновик не пишется в хранилище браузера', await alice.evaluate(() =>
    !JSON.stringify({ ...localStorage }).includes('недописанное') && !JSON.stringify({ ...sessionStorage }).includes('недописанное')));
await alice.fill('#message-input', '');

/* ------------------------- статус и скелетон ------------------------- */

await alice.evaluate(() => {
    window.__animated = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (...args) { window.__animated.push(this.className); return original.apply(this, args); };
});
await bob.goto('about:blank');
await send(alice, 'дойдёт позже');
await bob.goto(BASE, { waitUntil: 'networkidle' });
await bob.waitForTimeout(1000);
await bob.locator(ROOM).first().click();
await bob.waitForTimeout(1500);
check('смена ✓ на ✓✓ — с затуханием', await alice.evaluate(() => window.__animated.some(c => c.includes('message-status'))));

await alice.route('**/api/messages/*?limit=*', async route => { await sleep(700); await route.continue(); });
await alice.locator(BOT).first().click();
await alice.waitForTimeout(300);
check('пока грузится история — скелетон',
    await alice.evaluate(() => document.querySelectorAll('#chat-messages .message-skeleton').length > 0));
await alice.waitForTimeout(1200);
check('после загрузки скелетона нет',
    await alice.evaluate(() => document.querySelectorAll('#chat-messages .message-skeleton').length === 0
        && document.querySelectorAll('#chat-messages .message').length > 0));
await alice.unroute('**/api/messages/*?limit=*');

/* ------------------------- уменьшить движение ------------------------- */

await alice.emulateMedia({ reducedMotion: 'reduce' });
await alice.locator(ROOM).first().click();
await alice.waitForTimeout(1200);
await send(bob, 'при уменьшенном движении');
const motion = await bubble(alice, 'при уменьшенном движении').evaluate(el => {
    const s = getComputedStyle(el);
    return { name: s.animationName, duration: s.animationDuration };
});
check('«уменьшить движение»: новое сообщение гаснет, а не въезжает',
    motion.name === 'fadeIn' && parseFloat(motion.duration) > 0, JSON.stringify(motion));

/* ------------------------- группа ------------------------- */

const carol = await openApp('carol');
await register(carol, 'carol');
await carol.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
await openRoom(alice);
check('у группы — число участников', /^3 участника · (в сети|не в сети)$/.test(await status(alice)), await status(alice));

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
