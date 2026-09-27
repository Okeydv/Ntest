// Лента переписки и статус собеседника.
//
//   - «в сети» и зелёная точка меняются вживую, ушедший — «был(а) в 14:05»,
//     скрывший статус — «был(а) недавно» и сам не видит чужой; у
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
// Лента может ещё доезжать (после цитаты, «↓», нового сообщения): пузырь,
// измеренный на ходу, к клику уже в другом месте. Ждём, пока прокрутка
// замрёт на несколько кадров, и только тогда меряем и нажимаем.
const scrollSettled = page => page.waitForFunction(() => new Promise(resolve => {
    const list = document.getElementById('chat-messages');
    let last = list.scrollTop, still = 0;
    const tick = () => {
        still = list.scrollTop === last ? still + 1 : 0;
        last = list.scrollTop;
        if (still >= 5) resolve(true); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}));
async function openMenu(page, text) {
    await scrollSettled(page);
    await bubble(page, text).scrollIntoViewIfNeeded();
    await scrollSettled(page);
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
    return (await api(`/api/chats/${c.chat.id}/link`, { method: 'POST', body: JSON.stringify({ requireApproval: false }) })).code;
});
await bobPage.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
await openRoom(alice);
await openRoom(bobPage);

/* ------------------------- в сети ------------------------- */

check('собеседник на месте — «в сети»', await status(alice) === 'в сети', await status(alice));
const dots = () => alice.evaluate(() => ({
    list: Boolean(document.querySelector('.chat-item.active .chat-avatar-small.is-online')),
    header: document.getElementById('chat-avatar').classList.contains('is-online'),
}));
let dot = await dots();
check('зелёная точка — и в списке, и в шапке', dot.list && dot.header, JSON.stringify(dot));
const bobContext = bobPage.context();
await bobPage.close();
await sleep(1500);
check('ушёл — «был(а) в …» без перезагрузки', /^был\(а\) в \d{2}:\d{2}$/.test(await status(alice)), await status(alice));
dot = await dots();
check('и точки больше нет', !dot.list && !dot.header, JSON.stringify(dot));
await alice.reload({ waitUntil: 'networkidle' });
await alice.waitForTimeout(1200);
await alice.locator(ROOM).first().click();
await alice.waitForTimeout(1000);
check('время ухода помнит и сервер (после перезагрузки)', /^был\(а\) в \d{2}:\d{2}$/.test(await status(alice)), await status(alice));
let bob = await bobContext.newPage();
bob.on('pageerror', e => errors.push(`bob: ${e.message}`));
await bob.goto(BASE, { waitUntil: 'networkidle' });
await sleep(1500);
check('вернулся — снова «в сети»', await status(alice) === 'в сети', await status(alice));
await send(alice, 'точка на месте?');
dot = await dots();
check('новое сообщение перерисовало строку чата — точка осталась', dot.list && dot.header, JSON.stringify(dot));

// «Скрывать, когда я в сети»: собеседник видит «был(а) недавно», и
// скрывший сам не видит чужой статус.
await bob.evaluate(() => api('/api/user/presence', { method: 'POST', body: JSON.stringify({ hidden: true }) }));
await alice.waitForTimeout(1000);
check('Боб скрыл статус — у Алисы «был(а) недавно», хотя он в сети', await status(alice) === 'был(а) недавно', await status(alice));
dot = await dots();
check('и точки нет', !dot.list && !dot.header, JSON.stringify(dot));
await bob.evaluate(async () => { await loadChats(); });
await bob.locator(ROOM).first().click();
await bob.waitForTimeout(1000);
check('скрывший сам не видит, что Алиса в сети', await status(bob) === 'был(а) недавно', await status(bob));
await bob.evaluate(() => api('/api/user/presence', { method: 'POST', body: JSON.stringify({ hidden: false }) }));
await alice.waitForTimeout(1000);
check('открыл статус — снова «в сети»', await status(alice) === 'в сети', await status(alice));

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
    shown: document.getElementById('jump-down').classList.contains('is-visible'),
    count: document.getElementById('jump-down-count').textContent,
    top: document.getElementById('chat-messages').scrollTop,
}));
check('новое не прокручивает ленту, появляется «↓ 1»', jump.shown && jump.count === '1' && jump.top < 50, JSON.stringify(jump));
await alice.click('#jump-down');
await alice.waitForTimeout(900);
const after = await alice.evaluate(() => {
    const list = document.getElementById('chat-messages');
    return { hidden: !document.getElementById('jump-down').classList.contains('is-visible'), gap: list.scrollHeight - list.scrollTop - list.clientHeight };
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

// Строка реакций — сверху меню, 6 штук и «+», картинки со своего сервера.
await openMenu(alice, 'пока Алиса читает историю');
const row = await alice.evaluate(() => {
    const menu = document.getElementById('message-menu');
    const choices = [...menu.querySelectorAll('#reaction-row .reaction-choice')];
    const img = choices[0]?.querySelector('img.emoji');
    const r = choices[0]?.getBoundingClientRect();
    return {
        first: menu.firstElementChild?.id, count: choices.length, more: Boolean(menu.querySelector('.reaction-more')),
        src: img?.getAttribute('src'), size: r ? [Math.round(r.width), Math.round(r.height)] : null,
    };
});
check('строка реакций — сверху меню: 6 реакций и «+», кнопки 44×44',
    row.first === 'reaction-row' && row.count === 6 && row.more && row.size?.[0] === 44 && row.size?.[1] === 44, JSON.stringify(row));
const svg = await fetch(`http://127.0.0.1:3006${row.src}`);
check('картинка реакции — со своего сервера', svg.status === 200 && /svg/.test(svg.headers.get('content-type') || ''), row.src);
await alice.click('#reaction-row .reaction-more');
await alice.waitForTimeout(300);
const picker = await alice.evaluate(() => ({
    open: document.getElementById('reaction-picker').matches(':popover-open'),
    count: document.querySelectorAll('#reaction-picker .reaction-pick').length,
}));
check('«+» открывает весь набор', picker.open && picker.count >= 50, JSON.stringify(picker));
await alice.click('#reaction-picker .reaction-pick[data-emoji="🎉"]');
await alice.waitForTimeout(800);
check('реакция из набора ставится', await bubble(bob, 'пока Алиса читает историю').locator('.reaction[data-emoji="🎉"]').count() === 1);

// Две одинаковые — счётчик 2, своя выделена.
await openMenu(bob, 'пока Алиса читает историю');
await bob.click('#reaction-row .reaction-choice[data-emoji="👍"]');
await openMenu(alice, 'пока Алиса читает историю');
await alice.click('#reaction-row .reaction-choice[data-emoji="👍"]');
await alice.waitForTimeout(1000);
const counted = await chip(alice).evaluate(el => ({ count: el.querySelector('.reaction-count').textContent, mine: el.classList.contains('mine') }));
check('счётчик: две реакции 👍, своя выделена', counted.count === '2' && counted.mine, JSON.stringify(counted));
check('у собеседника тоже 2 и тоже выделена его', await chip(bob).evaluate(el =>
    el.querySelector('.reaction-count').textContent === '2' && el.classList.contains('mine')));
await chip(alice).click({ button: 'right' });
await alice.waitForTimeout(300);
const who = await alice.evaluate(() => ({
    open: document.getElementById('reaction-who').matches(':popover-open'),
    names: [...document.querySelectorAll('#reaction-who li')].map(li => li.textContent),
}));
check('правый клик по реакции — кто поставил', who.open && who.names.includes('bob') && who.names.includes('Вы'), JSON.stringify(who));
await alice.keyboard.press('Escape');
const outside = await alice.evaluate(async () => {
    const id = [...document.querySelectorAll('#chat-messages .message')].at(-1).dataset.messageId;
    return api('/api/reactions', { method: 'POST', body: JSON.stringify({ messageId: Number(id), emoji: '🦄' }) });
});
check('эмодзи не из набора сервер не принимает', outside.success === false, JSON.stringify(outside));

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
