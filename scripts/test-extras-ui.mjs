// Поле ввода, сообщения, меню чата, жесты (п. 184–200, 204–208).
//
//   - черновик переживает перезагрузку (IndexedDB), в списке — «Черновик:»,
//     с ответом;
//   - клавиатура: буква вне поля — в поле; Ctrl+↑ — ответ на последнее;
//     Ctrl+K — поиск чатов; Alt+↓ — соседний чат; «Отправка: Ctrl+Enter»;
//   - ссылки нажимаются (только http/https, noopener noreferrer),
//     подозрительные — с подтверждением;
//   - «Копировать» — первым пунктом; «Выбрать» — несколько, панель
//     «Удалить N», Esc — выход;
//   - меню чата: «Отметить непрочитанным» (точка), «Без звука» на 1 час;
//   - поиск по сообщениям на устройстве, Ctrl+F;
//   - CloseWatcher у меню; тост смахивается; пульс счётчика;
//   - доступность: лента role=log, счётчик «N непрочитанных»;
//   - экран приватности; пружинка у короткого списка.
//
// Требует Postgres, key-server и server.js на 3006 и ЧИСТУЮ базу.

import pg from 'pg';
import { launch, finish } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': `10.0.48.${nextIp++}` }, ...options });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => {});
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
const say = async (page, text) => {
    await page.fill('#message-input', text);
    await page.press('#message-input', 'Enter');
    await page.waitForTimeout(700);
};

const alice = await openApp('alice');
await register(alice, 'alice');
const bob = await openApp('bob');
await register(bob, 'bob');
const { code } = await alice.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Разное' }) });
    await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Второй' }) });
    const link = await api(`/api/chats/${c.chat.id}/link`, { method: 'POST', body: JSON.stringify({ requireApproval: false }) });
    return { code: link.code };
});
await bob.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
for (const p of [alice, bob]) {
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
}
await alice.locator(ROOM).first().click();
await bob.locator(ROOM).first().click();
await alice.waitForTimeout(900);

/* ------------------------- ссылки ------------------------- */

await say(bob, 'смотри https://example.org/путь?a=1, и ещё xn--80ak6aa92e.com: https://xn--80ak6aa92e.com/ и ftp://нельзя');
await alice.waitForTimeout(1200);
const links = await alice.evaluate(() => [...[...document.querySelectorAll('#chat-messages .message')].at(-1).querySelectorAll('a.message-link')]
    .map(a => ({ href: a.href, text: a.textContent, target: a.target, rel: a.rel, suspicious: a.dataset.suspicious || '' })));
check('ссылки нажимаются: только http(s), без запятой, в новой вкладке, noopener noreferrer', links.length === 2
    && links[0].text === 'https://example.org/путь?a=1' && links.every(l => l.target === '_blank' && l.rel === 'noopener noreferrer'),
    JSON.stringify(links));
check('punycode — через подтверждение', links[1]?.suspicious === '1');

/* ------------------------- меню: копировать, выбрать ------------------------- */

await say(bob, 'второе');
await say(bob, 'третье');
await alice.waitForTimeout(800);
const last = alice.locator('#chat-messages .message', { hasText: 'третье' });
const box = await last.boundingBox();
await alice.mouse.click(box.x + 20, box.y + 10, { button: 'right' });
await alice.waitForTimeout(200);
const items = await alice.evaluate(() => [...document.querySelectorAll('#message-menu > .menu-item')].filter(b => !b.hidden).map(b => b.textContent.trim()));
check('«Копировать» — первым пунктом, есть «Выбрать»', items[0] === 'Копировать' && items.includes('Выбрать'), items.join('|'));
check('меню сообщения закрывается «Назад» (CloseWatcher)', await alice.evaluate(() => !('CloseWatcher' in window) || menuWatcher !== null));
await alice.click('#copy-message-btn');
await alice.waitForTimeout(300);
check('«Копировать» кладёт текст в буфер', await alice.evaluate(() => navigator.clipboard.readText()) === 'третье');

await alice.mouse.click(box.x + 20, box.y + 10, { button: 'right' });
await alice.click('#select-message-btn');
await alice.locator('#chat-messages .message', { hasText: 'второе' }).click();
const sel = await alice.evaluate(() => ({ n: selectedIds.size, bar: !document.getElementById('selection-bar').hidden,
    count: document.getElementById('selection-count').textContent, del: document.getElementById('selection-delete').disabled }));
check('«Выбрать»: отмечаются касанием, внизу панель; чужие не удалить', sel.n === 2 && sel.bar && sel.count === '2 сообщения' && sel.del,
    JSON.stringify(sel));
await alice.keyboard.press('Control+c');
await alice.waitForTimeout(200);
const copied = await alice.evaluate(() => navigator.clipboard.readText());
check('Ctrl+C — с именами', /bob: второе\n.*bob: третье/.test(copied), copied);
await alice.keyboard.press('Escape');
check('Esc — выход из выбора', await alice.evaluate(() => !selecting() && document.getElementById('selection-bar').hidden));

/* ------------------------- клавиатура ------------------------- */

await alice.evaluate(() => document.activeElement.blur());
await alice.keyboard.press('a');
check('буква вне поля — в поле', await alice.evaluate(() => document.activeElement.id === 'message-input'
    && document.getElementById('message-input').value === 'a'));
await alice.fill('#message-input', '');
await alice.keyboard.press('Control+ArrowUp');
check('Ctrl+↑ в пустом поле — ответ на последнее', await alice.evaluate(() =>
    !document.getElementById('reply-preview').classList.contains('hidden')
    && document.getElementById('reply-preview-text').textContent === 'третье'));
await alice.keyboard.press('Control+ArrowUp');
check('ещё Ctrl+↑ — на предыдущее', await alice.evaluate(() => document.getElementById('reply-preview-text').textContent === 'второе'));
await alice.keyboard.press('Escape');
await alice.keyboard.press('Control+k');
check('Ctrl+K — поиск чатов', await alice.evaluate(() => document.activeElement.id === 'search-input'));
await alice.keyboard.press('Escape');
await alice.evaluate(() => document.activeElement.blur());
const before = await alice.evaluate(() => currentChatId);
await alice.keyboard.press('Alt+ArrowDown');
await alice.waitForTimeout(900);
check('Alt+↓ — соседний чат', await alice.evaluate(b => currentChatId !== b, before));
await alice.keyboard.press('Alt+ArrowUp');
await alice.waitForTimeout(900);
check('Alt+↑ — обратно', await alice.evaluate(b => currentChatId === b, before));
check('при открытии чата — фокус в поле', await alice.evaluate(() => document.activeElement.id === 'message-input'));
await alice.evaluate(() => localStorage.setItem('nyxo-send-key', 'ctrl'));
await alice.fill('#message-input', 'строка');
await alice.press('#message-input', 'Enter');
check('«Отправка: Ctrl+Enter»: Enter — перенос', await alice.evaluate(() => document.getElementById('message-input').value.includes('строка')));
await alice.press('#message-input', 'Control+Enter');
await alice.waitForTimeout(900);
check('Ctrl+Enter — отправка', await alice.evaluate(() => document.getElementById('message-input').value === ''));
await alice.evaluate(() => localStorage.removeItem('nyxo-send-key'));

/* ------------------------- черновик ------------------------- */

await alice.fill('#message-input', '');
await alice.focus('#message-input');
await alice.keyboard.press('Control+ArrowUp');
await alice.fill('#message-input', 'недописанное');
await alice.locator('.chat-item', { hasText: 'Второй' }).click();
await alice.waitForTimeout(1200);
const listDraft = await alice.evaluate(() => [...document.querySelectorAll('.chat-item')].find(i => i.textContent.includes('Разное'))
    ?.querySelector('.chat-last')?.textContent);
check('в списке — «Черновик: …»', listDraft === 'Черновик: недописанное', listDraft);
await alice.reload({ waitUntil: 'networkidle' });
await alice.waitForTimeout(1500);
await alice.locator(ROOM).first().click();
await alice.waitForTimeout(1200);
const draft = await alice.evaluate(() => ({ text: document.getElementById('message-input').value,
    reply: !document.getElementById('reply-preview').classList.contains('hidden') }));
check('черновик с ответом пережил перезагрузку', draft.text === 'недописанное' && draft.reply, JSON.stringify(draft));
await alice.fill('#message-input', '');
await alice.keyboard.press('Escape');

/* ------------------------- поиск ------------------------- */

await alice.keyboard.press('Control+f');
await alice.fill('#chat-search-input', 'ВТОР');
await alice.waitForFunction(() => document.getElementById('chat-search-count').textContent !== '', null, { timeout: 5000 }).catch(() => {});
await alice.waitForTimeout(150);
const found = await alice.evaluate(() => ({ count: document.getElementById('chat-search-count').textContent,
    lit: document.querySelector('#chat-messages .message.is-highlighted')?.textContent?.includes('второе') }));
check('Ctrl+F — поиск по сообщениям на устройстве, без учёта регистра', found.count === '1 из 1' && found.lit, JSON.stringify(found));
await alice.press('#chat-search-input', 'Escape');

/* ------------------------- меню чата ------------------------- */

await alice.click('#chat-menu-btn');
await alice.click('#mute-chat-btn');
check('«Без звука» — выбор срока', await alice.evaluate(() => !document.getElementById('mute-for').hidden));
await alice.click('#mute-for [data-mute-for="3600"]');
await alice.waitForTimeout(900);
const muted = (await db.query("SELECT muted, muted_until > now() + interval '55 minutes' AND muted_until < now() + interval '65 minutes' AS hour FROM chats WHERE name = 'Разное' AND user_id = (SELECT id FROM users WHERE username = 'alice')")).rows[0];
check('«Без звука на 1 час» — на сервере час', muted && muted.muted && muted.hour, JSON.stringify(muted));
await alice.locator('.chat-item', { hasText: 'Второй' }).click();
await alice.waitForTimeout(700);
await alice.locator(ROOM).first().click({ button: 'right' });
await alice.click('#chat-item-menu [data-action="unread"]');
await alice.waitForTimeout(900);
const dot = await alice.evaluate(() => {
    const b = document.querySelector('.chat-item[data-room-id]:not([data-room-id=""]) .chat-badge');
    return { cls: b?.className, text: b?.textContent, label: b?.getAttribute('aria-label') };
});
check('«Отметить непрочитанным» — точка', dot.cls?.includes('is-marked') && dot.text === '' && dot.label === 'отмечен непрочитанным', JSON.stringify(dot));
await alice.locator(ROOM).first().click();
await alice.waitForTimeout(1200);
check('открыл — отметка снята', await alice.evaluate(() => !document.querySelector('.chat-item[data-room-id]:not([data-room-id=""]) .chat-badge.is-marked')));

/* ------------------------- доступность, пружинка, приватность ------------------------- */

const a11y = await alice.evaluate(() => ({
    log: document.getElementById('chat-messages').getAttribute('role'),
    label: document.getElementById('chat-messages').getAttribute('aria-label'),
    input: document.getElementById('message-input').dir,
    spring: getComputedStyle(document.getElementById('chats-list'), '::before').height,
    listH: document.getElementById('chats-list').clientHeight,
}));
check('лента — role=log «Сообщения», поле ввода dir=auto', a11y.log === 'log' && a11y.label === 'Сообщения' && a11y.input === 'auto', JSON.stringify(a11y));
check('короткий список «пружинит» — прокрутка есть всегда', Math.round(parseFloat(a11y.spring)) === a11y.listH + 1
    && await alice.evaluate(() => { const l = document.getElementById('chats-list'); return l.scrollHeight > l.clientHeight; }), JSON.stringify(a11y));
await alice.evaluate(() => {
    localStorage.setItem('nyxo-privacy-cover', '1');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
});
const covered = await alice.evaluate(() => !document.getElementById('privacy-cover').hidden);
await alice.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
});
check('экран приватности: свернули — плашка, вернулись — нет', covered && await alice.evaluate(() => document.getElementById('privacy-cover').hidden));

/* ------------------------- жесты на телефоне ------------------------- */

const phone = await openApp('phone', { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
await phone.evaluate(async () => {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'bob@example.com', password: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
});
await phone.waitForTimeout(800);
// Тост смахивается вниз.
await phone.evaluate(() => showToast('Смахни меня', 'info', { duration: 60000 }));
await phone.waitForTimeout(300);
const t = await phone.locator('#toast').boundingBox();
const cdp = await phone.context().newCDPSession(phone);
const swipe = async (x, y, dx, dy, steps = 8) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / steps, y: y + dy * i / steps }] });
        await phone.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await phone.waitForTimeout(500);
};
await swipe(t.x + t.width / 2, t.y + t.height / 2, 0, 80);
check('тост смахивается вниз', await phone.evaluate(() => !document.getElementById('toast').matches(':popover-open')));
// Свайп строки влево — в архив.
const row = await phone.locator('.chat-item', { hasText: 'Разное' }).boundingBox();
await swipe(row.x + row.width - 30, row.y + row.height / 2, -row.width * 0.7, 0, 12);
await phone.waitForTimeout(1200);
check('свайп строки влево дальше 45% — «В архив»', await phone.evaluate(() =>
    ![...document.querySelectorAll('.chat-item')].some(i => i.textContent.includes('Разное')) && Boolean(document.querySelector('.archive-toggle'))));

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
