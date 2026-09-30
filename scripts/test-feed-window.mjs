// Окно ленты (п. 174–183).
//
//   - сервер: срезы around и after, hasMore / hasNewer;
//   - много непрочитанного — чат открывается на первом непрочитанном с
//     разделителем, а не внизу; в DOM — не вся история;
//   - прочитано то, что было на экране: счётчик в списке уменьшается сразу,
//     не обнуляясь; дочитали до конца (догрузка новее) — ноль;
//   - «↓» с 45px; долгое нажатие — «Всё прочитано»;
//   - переход по цитате вне окна — срезом; «↓» сначала возвращает к цитате;
//   - в DOM не больше 150 сообщений;
//   - плавающая дата — только пока крутят;
//   - новое внизу — одним движением: без is-new у своего;
//   - удалённое сначала гаснет, потом исчезает.
//
// Требует Postgres, key-server и server.js на 3006 и ЧИСТУЮ базу.

import { launch, finish } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label, viewport = { width: 1100, height: 700 }) {
    const context = await browser.newContext({ viewport, extraHTTPHeaders: { 'X-Forwarded-For': `10.0.47.${nextIp++}` } });
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

const alice = await openApp('alice');
await register(alice, 'alice');
const bob = await openApp('bob');
await register(bob, 'bob');
const { code, chatId } = await alice.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Окно' }) });
    const link = await api(`/api/chats/${c.chat.id}/link`, { method: 'POST', body: JSON.stringify({ requireApproval: false }) });
    return { code: link.code, chatId: c.chat.id };
});
await bob.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
for (const p of [alice, bob]) {
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
}

// Алиса пишет 8 и читает их; потом Боб пишет 90 — Алиса их не видела.
await alice.locator(ROOM).first().click();
await alice.waitForTimeout(800);
const say = async (page, text) => {
    await page.fill('#message-input', text);
    await page.press('#message-input', 'Enter');
};
for (let i = 1; i <= 8; i++) await say(alice, `старое ${i}`);
await alice.waitForTimeout(1500);
await alice.evaluate(() => document.querySelector('.chat-item[data-room-id]:not([data-room-id=""])')?.blur());
await alice.locator('.chat-item', { hasText: 'Бот' }).click();
await alice.waitForTimeout(600);
await bob.locator(ROOM).first().click();
await bob.waitForTimeout(800);
for (let i = 1; i <= 90; i++) await say(bob, `новое ${i}`);
await bob.waitForTimeout(3000);

/* ------------------------- сервер ------------------------- */

const api = (page, url) => page.evaluate(u => api(u), url);
const all = await api(alice, `/api/messages/${chatId}?limit=200`);
const ids = all.messages.map(m => m.id);
const mid = ids[40];
const around = await api(alice, `/api/messages/${chatId}?around=${mid}&limit=10`);
check('around: половина до (с ним), половина после', around.messages.length === 10 && around.messages[4].id === mid
    && around.hasMore && around.hasNewer, around.messages.map(m => m.id).join(','));
const after = await api(alice, `/api/messages/${chatId}?after=${ids[ids.length - 3]}&limit=10`);
check('after: только новее, hasNewer — нет', after.messages.length === 2 && !after.hasNewer, JSON.stringify(after.messages.map(m => m.id)));
const bad = await alice.evaluate(u => fetch(u).then(r => r.status), `/api/messages/${chatId}?around=${mid}&after=${mid}`);
check('around и after вместе — 400', bad === 400);

/* ------------------------- открытие на непрочитанном ------------------------- */

await alice.evaluate(() => { historyOpenSize = 40; });
const badgeBefore = await alice.evaluate(() => Number(document.querySelector('.chat-item[data-room-id]:not([data-room-id=""]) .chat-badge')?.textContent));
await alice.locator(ROOM).first().click();
await alice.waitForTimeout(2000);
const opened = await alice.evaluate(() => {
    const list = document.getElementById('chat-messages');
    const sep = list.querySelector('.unread-separator');
    const r = sep && sep.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    return { sep: Boolean(sep), next: sep?.nextElementSibling?.querySelector('.message-text')?.textContent,
        inView: r ? r.top >= box.top - 5 && r.bottom <= box.bottom : false,
        count: list.querySelectorAll('.message[data-message-id]').length, hasNewer: historyPaging.hasNewer };
});
check('90 непрочитанных — открылось на первом непрочитанном, разделитель на экране', opened.sep && opened.next?.startsWith('новое 1')
    && opened.inView && opened.hasNewer, JSON.stringify(opened));
check('в DOM — не вся история', opened.count < ids.length, `${opened.count} из ${ids.length}`);

await alice.waitForTimeout(1200);
const badgeMid = await alice.evaluate(() => Number(document.querySelector('.chat-item[data-room-id]:not([data-room-id=""]) .chat-badge')?.textContent || 0));
check('прочитано то, что на экране: счётчик уменьшился, но не до нуля', badgeBefore === 90 && badgeMid > 0 && badgeMid < 90,
    `${badgeBefore} → ${badgeMid}`);

/* ------------------------- «↓» ------------------------- */

const jump = await alice.evaluate(() => document.getElementById('jump-down').classList.contains('is-visible'));
check('новое за окном — «↓» видна', jump);
// Долгое нажатие на «↓» — отметить всё прочитанным.
const jd = await alice.locator('#jump-down').boundingBox();
await alice.mouse.move(jd.x + jd.width / 2, jd.y + jd.height / 2);
await alice.mouse.down();
await alice.waitForTimeout(700);
await alice.mouse.up();
await alice.waitForTimeout(1000);
const afterLong = await alice.evaluate(() => ({
    badge: document.querySelector('.chat-item[data-room-id]:not([data-room-id=""]) .chat-badge')?.textContent || '',
    toast: document.getElementById('toast').textContent,
}));
check('долгое нажатие на «↓» — всё прочитано', afterLong.badge === '' && afterLong.toast.includes('Всё прочитано'), JSON.stringify(afterLong));

// Нажатие — в конец: окно перестраивается на последние.
await alice.click('#jump-down');
await alice.waitForTimeout(1500);
const atEnd = await alice.evaluate(() => ({
    last: [...document.querySelectorAll('#chat-messages .message-text')].at(-1)?.textContent,
    hasNewer: historyPaging.hasNewer,
    bottom: (l => l.scrollHeight - l.scrollTop - l.clientHeight)(document.getElementById('chat-messages')),
}));
check('«↓» — в самый конец, и новее ничего нет', atEnd.last?.startsWith('новое 90') && !atEnd.hasNewer && atEnd.bottom < 80, JSON.stringify(atEnd));
await alice.evaluate(() => { const l = document.getElementById('chat-messages'); l.scrollTop = l.scrollHeight - l.clientHeight - 120; });
await alice.waitForTimeout(400);
check('«↓» появляется уже с 45px от низа', await alice.evaluate(() => document.getElementById('jump-down').classList.contains('is-visible')));

/* ------------------------- плавающая дата ------------------------- */

await alice.evaluate(() => { document.getElementById('chat-messages').scrollTop -= 300; });
await alice.waitForTimeout(100);
const scrolling = await alice.evaluate(() => document.getElementById('chat-messages').classList.contains('is-scrolling'));
await alice.waitForTimeout(900);
const still = await alice.evaluate(() => document.getElementById('chat-messages').classList.contains('is-scrolling'));
check('плавающая дата — пока крутят и 500 мс после', scrolling && !still);

/* ------------------------- цитата и возврат ------------------------- */

// Боб отвечает на «старое 1» — оно далеко за окном у Алисы.
const oldId = all.messages.find(m => m.message_type !== 'system').id;
await bob.evaluate(id => startReply({ id, author: 'alice', text: 'старое 1' }), oldId);
await say(bob, 'про самое старое');
await alice.waitForTimeout(2000);
await alice.click('#jump-down');
await alice.waitForTimeout(1200);
const replyBubble = alice.locator('#chat-messages .message', { hasText: 'про самое старое' });
await replyBubble.locator('.reply-to').click();
await alice.waitForTimeout(1800);
const quote = await alice.evaluate(id => ({
    found: Boolean(document.querySelector(`#chat-messages .message[data-message-id="${id}"]`)),
    returns: quoteReturns.length,
    jump: document.getElementById('jump-down').classList.contains('is-visible'),
}), oldId);
check('цитата вне окна — срез вокруг неё, «↓» помнит, откуда пришли', quote.found && quote.returns === 1 && quote.jump, JSON.stringify(quote));
await alice.click('#jump-down');
await alice.waitForTimeout(1800);
const back = await alice.evaluate(() => {
    const el = [...document.querySelectorAll('#chat-messages .message')].find(m => m.textContent.includes('про самое старое'));
    const r = el?.getBoundingClientRect();
    const box = document.getElementById('chat-messages').getBoundingClientRect();
    return { back: Boolean(el) && r.top >= box.top && r.bottom <= box.bottom, returns: quoteReturns.length };
});
check('«↓» сначала вернула к сообщению с цитатой', back.back && back.returns === 0, JSON.stringify(back));

/* ------------------------- не больше 150 в DOM ------------------------- */

await alice.evaluate(() => { historyPageSize = 50; });
for (let i = 0; i < 8; i++) {
    await alice.evaluate(() => { document.getElementById('chat-messages').scrollTop = 0; });
    await alice.waitForTimeout(1300);
}
const dom = await alice.evaluate(() => document.querySelectorAll('#chat-messages .message[data-message-id], #chat-messages .message-system[data-message-id]').length);
check('в DOM не больше 150 сообщений', dom <= 150, String(dom));

/* ------------------------- новое одним движением, удаление ------------------------- */

await alice.click('#jump-down');
await alice.waitForTimeout(1500);
await say(alice, 'одним движением');
await alice.waitForTimeout(80);
const motion = await alice.evaluate(() => {
    const own = [...document.querySelectorAll('#chat-messages .message.sent')].at(-1);
    return { isNew: own.classList.contains('is-new'), animated: document.getAnimations().length > 0 };
});
check('своё новое — без въезда is-new, анимацией сдвига', !motion.isNew && motion.animated, JSON.stringify(motion));
await alice.waitForTimeout(1500);
const own = alice.locator('#chat-messages .message.sent', { hasText: 'одним движением' });
const ownId = await own.getAttribute('data-message-id');
await alice.evaluate(id => removeMessageElement(document.querySelector(`#chat-messages [data-message-id="${id}"]`)), ownId);
await alice.waitForTimeout(60);
const fading = await alice.evaluate(id => document.querySelector(`#chat-messages [data-message-id="${id}"]`)?.classList.contains('is-removing'), ownId);
await alice.waitForTimeout(700);
const gone = await alice.evaluate(id => !document.querySelector(`#chat-messages [data-message-id="${id}"]`), ownId);
check('удаление: сначала гаснет, потом исчезает', fading && gone, `${fading} ${gone}`);

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
