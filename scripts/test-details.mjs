// Детали из макетов.
//
//   - группа сообщений одного автора: 3 px между пузырями, «хвостик» только
//     у последнего, в группе имя автора один раз сверху, аватар — у
//     последнего;
//   - список чатов: «Вы:» и ✓/✓✓ у своего последнего, «Имя:» в группе,
//     время акцентным цветом, если есть непрочитанное;
//   - поле ввода: подсказка про Enter и Shift+Enter, пока оно в фокусе; в
//     блоке ответа — подсказка Esc и крестик 44×44;
//   - загрузка файла: строка «Автор и дата из файла удалены, шифруется»;
//   - перетаскивание и вставка: сколько файлов и что метаданные удалят;
//   - тост «Сообщение удалено · Вернуть» с полоской оставшегося времени;
//   - срок исчезающих сообщений — радиокнопками;
//   - подключение устройства на телефоне — окном снизу экрана, с пометкой,
//     что название браузера определил сервер;
//   - обрыв — «Подключение…» в шапке открытого чата; заготовки пузырей
//     и при подгрузке старой истории.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-details.mjs

import { launch, finish } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, extraHTTPHeaders: { 'X-Forwarded-For': `10.0.18.${nextIp++}` }, ...options });
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
async function openRoom(page) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator(ROOM).first().click();
    await page.waitForTimeout(1200);
}
async function send(page, text) {
    await page.fill('#message-input', text);
    await page.press('#message-input', 'Enter');
    await page.waitForTimeout(900);
}

const alice = await openApp('alice');
await register(alice, 'alice');
const bob = await openApp('bob');
await register(bob, 'bob');
const carol = await openApp('carol');
await register(carol, 'carol');
const code = await alice.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Втроём' }) });
    return (await api(`/api/chats/${c.chat.id}/link`, { method: 'POST', body: JSON.stringify({ requireApproval: false }) })).code;
});
for (const p of [bob, carol]) await p.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
for (const p of [alice, bob, carol]) await openRoom(p);

/* ------------------------- группа ------------------------- */

for (const t of ['первое от Боба', 'второе от Боба', 'третье от Боба']) await send(bob, t);
await alice.waitForTimeout(800);
const group = await alice.evaluate(() => {
    const bubbles = [...document.querySelectorAll('#chat-messages .message.received')].filter(b => /от Боба/.test(b.textContent));
    const rect = b => b.getBoundingClientRect();
    const shown = (b, sel) => getComputedStyle(b.querySelector(sel)).display !== 'none';
    const tail = b => parseFloat(getComputedStyle(b).borderBottomLeftRadius);
    return {
        count: bubbles.length,
        gaps: bubbles.slice(1).map((b, i) => Math.round(rect(b).top - rect(bubbles[i]).bottom)),
        ends: bubbles.map(b => b.classList.contains('group-end')),
        author: bubbles.map(b => shown(b, '.message-author')),
        avatar: bubbles.map(b => shown(b, '.message-avatar')),
        tails: bubbles.map(tail),
    };
});
check('группа: между пузырями 3 px', group.count === 3 && group.gaps.every(g => g === 3), JSON.stringify(group.gaps));
check('«хвостик» только у последнего', JSON.stringify(group.ends) === '[false,false,true]'
    && group.tails[2] < group.tails[0] && group.tails[2] < group.tails[1], JSON.stringify(group.tails));
check('имя автора — один раз сверху', JSON.stringify(group.author) === '[true,false,false]', JSON.stringify(group.author));
check('аватар — у последнего', JSON.stringify(group.avatar) === '[false,false,true]', JSON.stringify(group.avatar));

/* ------------------------- список чатов ------------------------- */

await send(alice, 'моё последнее');
const live = await alice.evaluate(sel => document.querySelector(`${sel} .chat-last`)?.textContent, ROOM);
check('«Вы:» — сразу после отправки, без перечитывания списка', /Вы: моё последнее$/.test(live || ''), live);
await bob.waitForTimeout(1500);
await alice.evaluate(() => loadChats());
await alice.waitForTimeout(800);
const own = await alice.evaluate(sel => document.querySelector(`${sel} .chat-last`)?.textContent, ROOM);
check('своё последнее — «Вы:» и отметка', /^✓✓?Вы: моё последнее$/.test(own || ''), own);
await alice.locator('.chat-item[data-room-id=""]').first().click();
await alice.waitForTimeout(800);
await send(carol, 'от Кэрол');
await alice.waitForTimeout(1500);
await alice.evaluate(() => loadChats());
await alice.waitForTimeout(800);
const theirs = await alice.evaluate(sel => ({
    last: document.querySelector(`${sel} .chat-last`)?.textContent,
    unreadTime: document.querySelector(`${sel} .chat-time`)?.classList.contains('has-unread'),
    color: getComputedStyle(document.querySelector(`${sel} .chat-time`)).color,
}), ROOM);
check('в группе чужое — «Имя:»', theirs.last === 'carol: от Кэрол', theirs.last);
check('есть непрочитанное — время акцентным цветом', theirs.unreadTime, JSON.stringify(theirs));
await alice.locator(ROOM).first().click();
await alice.waitForTimeout(1000);

/* ------------------------- поле ввода ------------------------- */

const hint = async () => alice.evaluate(() => getComputedStyle(document.querySelector('.composer-hint')).visibility);
await alice.click('#chat-messages');
const before = await hint();
await alice.focus('#message-input');
const focused = await hint();
check('подсказка «Enter — отправить · Shift+Enter — новая строка» — пока поле в фокусе',
    before === 'hidden' && focused === 'visible'
    && (await alice.textContent('.composer-hint')) === 'Enter — отправить · Shift+Enter — новая строка', `${before} → ${focused}`);
const theirBox = await alice.locator('#chat-messages .message.received', { hasText: 'от Кэрол' }).boundingBox();
await alice.mouse.click(theirBox.x + 20, theirBox.y + 10, { button: 'right' });
await alice.click('#reply-message-btn');
const reply = await alice.evaluate(() => {
    const r = document.getElementById('cancel-reply-btn').getBoundingClientRect();
    return { hint: document.querySelector('.reply-preview-hint')?.textContent, w: Math.round(r.width), h: Math.round(r.height) };
});
check('в блоке ответа — «Esc — отменить» и крестик 44×44', reply.hint === 'Esc — отменить' && reply.w === 44 && reply.h === 44, JSON.stringify(reply));
await alice.click('#cancel-reply-btn');

/* ------------------------- файлы ------------------------- */

let release = null;
await alice.route('**/api/blobs?**', route => new Promise(resolve => { release = () => route.continue().then(resolve, resolve); }));
await alice.evaluate(() => { sendFiles([new File(['заметка'], 'note.txt', { type: 'text/plain' })]); });
await alice.waitForSelector('#upload-status:not([hidden])', { timeout: 5000 }).catch(() => null);
check('загрузка: «Автор и дата из файла удалены, шифруется»',
    (await alice.textContent('#upload-status-note')) === 'Автор и дата из файла удалены, шифруется', await alice.textContent('#upload-status-note'));
if (release) release();
await alice.unroute('**/api/blobs?**');
await alice.waitForTimeout(1500);

const drop = await alice.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['a'], 'a.txt', { type: 'text/plain' }));
    data.items.add(new File(['b'], 'b.txt', { type: 'text/plain' }));
    document.querySelector('.main-content').dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
    const zone = { count: document.getElementById('drop-zone-count').textContent, note: document.querySelector('.drop-zone-note').textContent };
    document.querySelector('.main-content').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    return { ...zone, list: document.querySelectorAll('#send-files-list li').length,
        dialogNote: document.querySelector('.send-files-note')?.textContent || '' };
});
check('над окном: сколько файлов и что метаданные удалят', drop.count === 'Отпустите, чтобы отправить 2 файла'
    && /удалены/.test(drop.note), JSON.stringify(drop));
check('в окне отправки — список файлов и пояснение про метаданные', drop.list === 2 && /удаляются автор, дата и место съёмки/.test(drop.dialogNote),
    JSON.stringify(drop));
await alice.click('#send-files-cancel');

/* ------------------------- тост «Вернуть» ------------------------- */

const mineBox = await alice.locator('#chat-messages .message.sent', { hasText: 'моё последнее' }).boundingBox();
await alice.mouse.click(mineBox.x + 20, mineBox.y + 10, { button: 'right' });
await alice.click('#delete-message-btn');
const bar = await alice.evaluate(() => {
    const el = document.querySelector('#toast .toast-progress');
    return el ? { duration: getComputedStyle(el).animationDuration, text: document.getElementById('toast').textContent } : null;
});
check('тост «Сообщение удалено · Вернуть» — с полоской оставшегося времени', bar && /Вернуть/.test(bar.text) && parseFloat(bar.duration) >= 4,
    JSON.stringify(bar));
await alice.click('#toast .toast-action');
await alice.waitForTimeout(300);

/* ------------------------- срок радиокнопками ------------------------- */

await alice.click('#chat-menu-btn');
await alice.waitForFunction(() => document.getElementById('chat-menu-modal').open);
const radios = await alice.evaluate(() => ({
    count: document.querySelectorAll('#chat-expiry-options input[type="radio"][name="chat-expiry"]').length,
    checked: document.querySelector('#chat-expiry-options input:checked')?.value,
    select: Boolean(document.getElementById('chat-expiry-select')),
}));
check('срок исчезающих — радиокнопками, выбран текущий', radios.count === 5 && radios.checked === '0' && !radios.select, JSON.stringify(radios));
await alice.check('#chat-expiry-options input[value="3600"]');
await alice.waitForTimeout(800);
check('выбор радиокнопки меняет срок', (await alice.textContent('#chat-expiry')).includes('1 час'), await alice.textContent('#chat-expiry'));
await alice.check('#chat-expiry-options input[value="0"]');
await alice.waitForTimeout(600);
await alice.keyboard.press('Escape');

/* ------------------------- соединение и история ------------------------- */

// Переподключение — через 4 с, чтобы «Подключение…» (ждёт 400 мс) успело показаться.
await alice.evaluate(() => {
    socket.io.reconnectionDelay(4000);
    socket.io.reconnectionDelayMax(4000);
    socket.io.engine.close();
});
await alice.waitForTimeout(2200);
const banner = await alice.evaluate(() => {
    const el = document.getElementById('connection-status');
    return { shown: !el.hidden, text: el.textContent.trim(), bg: getComputedStyle(el).backgroundColor,
        spinner: Boolean(el.querySelector('.connection-spinner')), header: document.getElementById('chat-status').textContent };
});
// Чат открыт — состояние соединения в шапке вместо «в сети» (п. 171).
check('обрыв — «Подключение…» в шапке открытого чата', banner.header === 'Подключение…', JSON.stringify(banner));
await alice.waitForTimeout(4000);
check('переподключились — в шапке снова статус собеседника', await alice.evaluate(() =>
    document.getElementById('connection-status').hidden && !/Подключение|Обновление|Ожидание/.test(document.getElementById('chat-status').textContent)));

await alice.route('**/api/messages/*?limit=*&before=*', async route => { await new Promise(r => setTimeout(r, 800)); await route.continue(); });
const skeleton = await alice.evaluate(async () => {
    historyPaging.hasMore = true;
    historyPaging.oldestId = historyPaging.oldestId || 1;
    const loading = loadOlderMessages();
    await new Promise(r => setTimeout(r, 200));
    const during = document.querySelectorAll('#chat-messages .history-skeleton .message-skeleton').length;
    await loading;
    return { during, after: document.querySelectorAll('#chat-messages .history-skeleton').length };
});
check('заготовки пузырей и при подгрузке старой истории', skeleton.during === 3 && skeleton.after === 0, JSON.stringify(skeleton));
await alice.unroute('**/api/messages/*?limit=*&before=*');

/* ------------------------- подключение устройства на телефоне ------------------------- */

const phoneCtx = await browser.newContext({ viewport: { width: 375, height: 700 }, isMobile: true, hasTouch: true,
    extraHTTPHeaders: { 'X-Forwarded-For': '10.0.18.200' } });
const phone = await phoneCtx.newPage();
phone.on('pageerror', e => errors.push(`phone: ${e.message}`));
await phone.goto(BASE, { waitUntil: 'networkidle' });
await phone.evaluate(async () => {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'bob@example.com', password: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
});
await phone.evaluate(() => { resetLinkScan(); openModal(document.getElementById('link-scan-modal')); });
await phone.waitForTimeout(500);
const sheet = await phone.evaluate(() => {
    const r = document.querySelector('#link-scan-modal .modal-content').getBoundingClientRect();
    return { bottom: Math.round(r.bottom), width: Math.round(r.width), vh: window.innerHeight, vw: window.innerWidth,
        note: Boolean(document.querySelector('.link-server-note')) };
});
check('подключение устройства на телефоне — окном снизу экрана', Math.abs(sheet.bottom - sheet.vh) <= 1 && sheet.width === sheet.vw,
    JSON.stringify(sheet));
check('и с пометкой, что название браузера определил сервер', sheet.note);

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
