// Закрепление, «Без звука» и архив (routes/chats.js, migrations/015).
//
//   - сервер: не больше пяти закреплённых; закреплённые сверху в своём
//     порядке, открепили — дыр нет; новый порядок — ровно те же чаты;
//   - список: булавка и слово «закреплён» для экранного диктора, черта
//     между закреплёнными и остальными; новое сообщение не поднимает чат
//     выше закреплённых;
//   - меню строки: правая кнопка, клавиша меню; «Выше»/«Ниже», Alt+Shift+↑/↓,
//     перетаскивание;
//   - второе устройство того же аккаунта видит изменения сразу;
//   - «Без звука»: серый счётчик, в заголовке вкладки не считается;
//   - архив: чат уходит из списка в «Архив · N», оттуда возвращается.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-pins-ui.mjs

import { launch, finish } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, extraHTTPHeaders: { 'X-Forwarded-For': `10.0.22.${nextIp++}` } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return page;
}
const call = (page, url, method = 'GET', body) => page.evaluate(([url, method, body]) =>
    api(url, { method, body: body === undefined ? undefined : JSON.stringify(body) }), [url, method, body]);
const names = page => page.evaluate(() => [...document.querySelectorAll('#chats-list > *')].map(el =>
    el.classList.contains('chats-separator') ? '—' : el.classList.contains('archive-toggle') ? `[${el.textContent}]`
        : `${el.querySelector('.chat-name').textContent}${el.classList.contains('is-pinned') ? '*' : ''}`));

const alice = await openApp('alice');
await alice.evaluate(async () => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: 'alice', email: 'alice@example.com', password: 'password123', confirmPassword: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE();
});
const ids = {};
for (const n of ['Один', 'Два', 'Три', 'Четыре', 'Пять', 'Шесть']) {
    ids[n] = (await call(alice, '/api/chats', 'POST', { name: n })).chat.id;
}
// Второе устройство того же аккаунта.
const tablet = await openApp('tablet');
await tablet.evaluate(async () => {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
});

/* ------------------------- сервер ------------------------- */

for (const n of ['Три', 'Один', 'Пять', 'Два', 'Четыре']) await call(alice, `/api/chats/${ids[n]}/pin`, 'POST', { pinned: true });
const sixth = await call(alice, `/api/chats/${ids['Шесть']}/pin`, 'POST', { pinned: true });
check('шестой не закрепить', sixth.code === 'PIN_LIMIT', JSON.stringify(sixth));
await call(alice, `/api/chats/${ids['Пять']}/pin`, 'POST', { pinned: false });
const listed = (await call(alice, '/api/chats')).chats.filter(c => c.pin_position).map(c => `${c.name}:${c.pin_position}`);
check('закреплённые — в порядке закрепления, открепили — без дыр', listed.join() === 'Три:1,Один:2,Два:3,Четыре:4', listed.join());
const wrong = await call(alice, '/api/chats/pins', 'PUT', { order: [ids['Три'], ids['Один'], ids['Два'], ids['Шесть']] });
check('новый порядок — только из тех же чатов', wrong.success === false);

/* ------------------------- список ------------------------- */

await alice.evaluate(() => loadChats());
await alice.waitForTimeout(500);
let shown = await names(alice);
check('закреплённые сверху, под ними черта', shown.slice(0, 5).join() === 'Три*,Один*,Два*,Четыре*,—', shown.join(' '));
check('для экранного диктора — «закреплён»', await alice.evaluate(() =>
    document.querySelector('.chat-item.is-pinned .chat-marks [role="img"]')?.getAttribute('aria-label') === 'закреплён'));
await tablet.waitForTimeout(500);
check('второе устройство видит закреплённые без перезагрузки', (await names(tablet)).slice(0, 4).join() === 'Три*,Один*,Два*,Четыре*',
    (await names(tablet)).join(' '));

// Правая кнопка — меню строки.
await alice.locator('.chat-item', { hasText: 'Один' }).click({ button: 'right' });
const menu = await alice.evaluate(() => [...document.querySelectorAll('#chat-item-menu .menu-item')].filter(b => !b.hidden).map(b => b.textContent.trim()));
check('меню строки: открепить, выше, ниже, без звука, непрочитанным, в архив', menu.join('|') === 'Открепить|Выше|Ниже|Без звука|Отметить непрочитанным|В архив', menu.join('|'));
await alice.click('#chat-item-menu [data-action="up"]');
await alice.waitForTimeout(700);
check('«Выше» переставляет', (await names(alice)).slice(0, 2).join() === 'Один*,Три*', (await names(alice)).join(' '));

// Клавиатура: Alt+Shift+↓.
await alice.locator('.chat-item', { hasText: 'Один' }).focus();
await alice.keyboard.press('Alt+Shift+ArrowDown');
await alice.waitForTimeout(700);
check('Alt+Shift+↓ переставляет, фокус остаётся на чате', (await names(alice)).slice(0, 2).join() === 'Три*,Один*'
    && await alice.evaluate(() => document.activeElement.querySelector('.chat-name')?.textContent) === 'Один');
await alice.keyboard.press('Shift+F10');
check('Shift+F10 открывает меню строки, фокус — на первом пункте', await alice.evaluate(() =>
    document.getElementById('chat-item-menu').matches(':popover-open') && document.activeElement.dataset.action === 'pin'));
await alice.keyboard.press('Escape');

// Перетаскивание.
await alice.dragAndDrop('.chat-item.is-pinned:has-text("Четыре")', '.chat-item.is-pinned:has-text("Три")', { targetPosition: { x: 40, y: 5 } });
await alice.waitForTimeout(800);
shown = await names(alice);
check('перетаскивание: «Четыре» — первым', shown[0] === 'Четыре*', shown.join(' '));
await tablet.waitForTimeout(500);
check('и на втором устройстве порядок тот же', (await names(tablet))[0] === 'Четыре*');

// Новое в незакреплённом чате не поднимает его выше закреплённых.
await alice.locator('.chat-item', { hasText: 'Шесть' }).click();
await alice.waitForTimeout(800);
await alice.evaluate(() => refreshOpenChatItem({ message_type: 'text', user_id: currentUser.id, sent: 1, created_at: new Date().toISOString() }));
shown = await names(alice);
check('чат с новым сообщением встаёт первым под чертой', shown[4] === '—' && shown[5] === 'Шесть', shown.join(' '));

/* ------------------------- без звука и архив ------------------------- */

await alice.click('#chat-menu-btn');
await alice.click('#mute-chat-btn');
// «Без звука» спрашивает, на сколько (п. 199).
await alice.click('#mute-for [data-mute-for=""]');
await alice.waitForTimeout(700);
const muted = await alice.evaluate(() => ({
    mark: document.querySelector('.chat-item.active .chat-marks [aria-label="без звука"]') !== null,
    meta: currentChatMeta().muted,
}));
check('«Без звука» — отметка в строке', muted.mark && muted.meta === true, JSON.stringify(muted));
const badge = await alice.evaluate(() => {
    const chat = currentChatMeta();
    const el = chatItemElement({ ...chat, unread: 3 }, '');
    return el.querySelector('.chat-badge').className;
});
check('счётчик у чата без звука — серый и в заголовке вкладки не считается', badge === 'chat-badge is-muted', badge);

await alice.locator('.chat-item', { hasText: 'Два' }).click({ button: 'right' });
await alice.click('#chat-item-menu [data-action="archive"]');
await alice.waitForTimeout(800);
shown = await names(alice);
check('в архив: чата нет в списке, внизу — «Архив · 1»; закреплённый при этом откреплён',
    !shown.some(n => n.startsWith('Два')) && shown.at(-1) === '[Архив · 1]', shown.join(' '));
await alice.click('.archive-toggle');
await alice.waitForTimeout(600);
check('«Архив» раскрывается', (await names(alice)).at(-1) === 'Два');
await alice.locator('.chat-item', { hasText: 'Два' }).click({ button: 'right' });
await alice.click('#chat-item-menu [data-action="archive"]');
await alice.waitForTimeout(800);
shown = await names(alice);
check('«Из архива» возвращает чат', shown.includes('Два') && !shown.some(n => n.startsWith('[Архив')), shown.join(' '));

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
