// Уведомления, service worker и «Поделиться» (п. 168, 201–203).
//
//   - service worker ставится и управляет страницей, ничего не кэширует;
//   - уведомление — через registration.showNotification, у каждого чата
//     свой tag chat:<id>; в открытом чате при окне в фокусе — нет;
//   - «В уведомлении»: по умолчанию «Новое сообщение», «имя и текст» —
//     имя чата и расшифрованный текст;
//   - прочитали чат — его уведомления закрыты;
//   - непрочитанное — точка на значке вкладки;
//   - звук: на компьютере только без фокуса, не чаще раза в секунду;
//   - «Поделиться»: POST /share перехватывает service worker, страница
//     спрашивает «Куда отправить?», текст встаёт в поле ввода;
//   - манифест: id, launch_handler, share_target, ярлык.
//
// Требует Postgres, key-server и server.js на 3006 и ЧИСТУЮ базу.

import { launch, finish } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': `10.0.45.${nextIp++}` } });
    await context.grantPermissions(['notifications'], { origin: BASE });
    // Безголовый Chromium не показывает уведомлений (разрешение — всегда
    // «denied», showNotification отказывает). Проверяем свою логику:
    // что и с каким tag показано и что закрыто, — подменив системную часть.
    await context.addInitScript(() => {
        // Разрешение там тоже всегда «denied».
        Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
        let shown = [];
        ServiceWorkerRegistration.prototype.showNotification = async function (title, options = {}) {
            shown = shown.filter(n => !options.tag || n.tag !== options.tag);
            const note = { title, body: options.body, tag: options.tag, renotify: options.renotify, data: options.data,
                close() { shown = shown.filter(n => n !== note); } };
            shown.push(note);
        };
        ServiceWorkerRegistration.prototype.getNotifications = async function (filter = {}) {
            return shown.filter(n => !filter.tag || n.tag === filter.tag);
        };
    });
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
const { code } = await alice.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Уведомления' }) });
    const link = await api(`/api/chats/${c.chat.id}/link`, { method: 'POST', body: JSON.stringify({ requireApproval: false }) });
    return { code: link.code };
});
await bob.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
for (const p of [alice, bob]) {
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
}

/* ------------------------- service worker ------------------------- */

await bob.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 }).catch(() => {});
const sw = await bob.evaluate(async () => ({
    controlled: navigator.serviceWorker.controller !== null,
    script: (await navigator.serviceWorker.getRegistration())?.active?.scriptURL,
    caches: await caches.keys(),
}));
check('service worker управляет страницей и ничего не кэширует', sw.controlled && sw.script.endsWith('/sw.js') && sw.caches.length === 0,
    JSON.stringify(sw));
check('манифест: id, launch_handler, share_target, ярлык', await bob.evaluate(async () => {
    const m = await (await fetch('/manifest.webmanifest')).json();
    return m.id === '/' && m.launch_handler.client_mode[0] === 'focus-existing' && m.share_target.method === 'POST'
        && m.share_target.action === '/share' && m.shortcuts[0].url === '/?action=new-chat';
}));

/* ------------------------- уведомления ------------------------- */

// Боб включает уведомления (push в безголовом браузере не подпишется —
// это не мешает уведомлениям из открытой вкладки).
await bob.evaluate(() => { localStorage.setItem('nyxo-notify', '1'); });
const bobChatId = await bob.evaluate(() => Number(document.querySelector('.chat-item[data-room-id]:not([data-room-id=""])').dataset.id));
const notes = () => bob.evaluate(async () => (await (await navigator.serviceWorker.getRegistration()).getNotifications())
    .map(n => ({ title: n.title, body: n.body, tag: n.tag, renotify: n.renotify })));
const sendFromAlice = async text => {
    await alice.fill('#message-input', text);
    await alice.press('#message-input', 'Enter');
};
await alice.locator(ROOM).first().click();
await alice.waitForTimeout(800);

// Чат не открыт — уведомление.
await sendFromAlice('первое');
await bob.waitForTimeout(1500);
let list = await notes();
check('новое в неоткрытом чате — уведомление через service worker, tag чата', list.length === 1
    && list[0].tag === `chat:${bobChatId}` && list[0].renotify === true && list[0].body === 'Новое сообщение' && list[0].title === 'Nyxo', JSON.stringify(list));
check('непрочитанное — точка на значке вкладки', await bob.evaluate(() =>
    document.querySelector('link[rel="icon"]').getAttribute('href').startsWith('data:image/png')));

// «Имя и текст».
await bob.evaluate(() => localStorage.setItem('nyxo-notify-content', 'full'));
await sendFromAlice('второе, с текстом');
await bob.waitForTimeout(1500);
list = await notes();
check('«имя и текст» — имя чата и расшифрованный текст, прежнее заменено', list.length === 1
    && list[0].title === 'Уведомления' && list[0].body === 'alice: второе, с текстом', JSON.stringify(list));

// Открыл чат — уведомления чата закрыты.
await bob.locator(ROOM).first().click();
await bob.waitForTimeout(1500);
list = await notes();
check('прочитал чат — его уведомления закрыты, точки нет', list.length === 0 && await bob.evaluate(() =>
    !document.querySelector('link[rel="icon"]').getAttribute('href').startsWith('data:image/png')), JSON.stringify(list));

// Открытый чат, окно в фокусе — без уведомления; без фокуса — с ним.
await sendFromAlice('в открытый');
await bob.waitForTimeout(1500);
check('открытый чат и окно в фокусе — уведомления нет', (await notes()).length === 0);
await bob.evaluate(() => { document.hasFocus = () => false; });
await sendFromAlice('в открытый, окно без фокуса');
await bob.waitForTimeout(1500);
check('окно без фокуса — уведомление есть', (await notes()).length === 1);
await bob.evaluate(() => { delete document.hasFocus; });

/* ------------------------- звук ------------------------- */

const ring = await bob.evaluate(() => {
    const msg = { room_id: currentRoomId, chat_id: currentChatId };
    lastRingAt = 0;
    const focused = shouldRing(msg);
    document.hasFocus = () => false;
    const blurred = shouldRing(msg);
    const again = shouldRing(msg);
    delete document.hasFocus;
    return { focused, blurred, again };
});
check('звук на компьютере: в фокусе — нет, без фокуса — да, не чаще раза в секунду', !ring.focused && ring.blurred && !ring.again,
    JSON.stringify(ring));

/* ------------------------- «Поделиться» ------------------------- */

await bob.evaluate(async () => {
    const form = new FormData();
    form.append('title', 'Статья');
    form.append('text', 'Посмотри');
    form.append('url', 'https://example.org/a');
    await fetch('/share', { method: 'POST', body: form });
});
await bob.goto(`${BASE}/?share=1`, { waitUntil: 'networkidle' });
await bob.waitForSelector('#share-modal[open]', { timeout: 8000 }).catch(() => {});
const picker = await bob.evaluate(() => ({
    open: document.getElementById('share-modal').open,
    chats: [...document.querySelectorAll('#share-chats .share-chat > span:last-child')].map(b => b.textContent.trim()),
    url: location.search,
}));
check('«Поделиться» — «Куда отправить?» со списком чатов, адрес очищен', picker.open && picker.chats.includes('Уведомления')
    && picker.url === '', JSON.stringify(picker));
await bob.locator('#share-chats .share-chat', { hasText: 'Уведомления' }).click();
await bob.waitForTimeout(1500);
const shared = await bob.evaluate(async () => ({ input: document.getElementById('message-input').value, caches: await caches.keys() }));
check('текст и ссылка — в поле ввода, присланное стёрто', shared.input === 'Статья\nПосмотри\nhttps://example.org/a' && shared.caches.length === 0,
    JSON.stringify(shared));

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
