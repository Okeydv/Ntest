// Поле ввода, файлы, список чатов и уведомления.
//
//   - поле многострочное: Shift+Enter — перенос, Enter — отправка, поле
//     растёт с текстом;
//   - картинка из буфера и файл, брошенный в окно, уходят после
//     подтверждения; размеры картинки едут в данных вложения, и у
//     получателя место под неё оставлено заранее;
//   - у долгой отправки файла — полоска с прогрессом, её можно отменить;
//   - в списке чатов — время последнего сообщения, открытый чат с новым
//     сообщением поднимается наверх;
//   - ширина списка меняется мышью и клавиатурой, запоминается, есть
//     компактный режим 76px;
//   - уведомления браузера — без текста и имени.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-composer.mjs

import { launch, finish } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };

// Набор, оборвавшийся на ожидании, не должен сойти за пройденный.
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label, { notifications = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, extraHTTPHeaders: { 'X-Forwarded-For': `10.0.15.${nextIp++}` } });
    if (notifications) {
        // Настоящее уведомление в безголовом браузере не увидеть — подменяем
        // конструктор и записываем, что показали бы.
        await context.addInitScript(() => {
            window.__notes = [];
            window.Notification = class {
                static permission = 'granted';
                static requestPermission() { return Promise.resolve('granted'); }
                constructor(title, options) { window.__notes.push({ title, ...options }); }
                addEventListener() {}
                close() {}
            };
        });
    }
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
// PNG нужного размера, нарисованный в самой странице.
const pngFile = (page, w, h, name) => page.evaluateHandle(async ([w, h, name]) => {
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').fillRect(0, 0, w, h);
    return new File([await canvas.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' });
}, [w, h, name]);
const modalOpen = page => page.evaluate(() => document.getElementById('send-files-modal').open);
const bubbles = page => page.evaluate(() => document.querySelectorAll('#chat-messages .message').length);

const alice = await openApp('alice', { notifications: true });
await register(alice, 'alice');
const bob = await openApp('bob');
await register(bob, 'bob');
const code = await alice.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Двое' }) });
    return (await api(`/api/chats/invite/${c.chat.id}`)).code;
});
await bob.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
await openRoom(alice);
await openRoom(bob);

/* ------------------------- многострочное поле ------------------------- */

check('поле ввода — textarea', await alice.evaluate(() => document.getElementById('message-input').tagName === 'TEXTAREA'));
const oneLine = await alice.evaluate(() => document.getElementById('message-input').offsetHeight);
await alice.click('#message-input');
await alice.keyboard.type('строка 1');
await alice.keyboard.press('Shift+Enter');
await alice.keyboard.type('строка 2');
await alice.keyboard.press('Shift+Enter');
await alice.keyboard.type('строка 3');
const typed = await alice.evaluate(() => ({ value: document.getElementById('message-input').value, height: document.getElementById('message-input').offsetHeight }));
check('Shift+Enter переносит строку', typed.value === 'строка 1\nстрока 2\nстрока 3', JSON.stringify(typed.value));
check('поле растёт с текстом', typed.height > oneLine + 20, `${oneLine} → ${typed.height}`);
await alice.keyboard.press('Enter');
await alice.waitForTimeout(1200);
const multiline = await bob.evaluate(() => [...document.querySelectorAll('#chat-messages .message-text')].at(-1)?.textContent);
check('Enter отправляет, переносы доходят', multiline === 'строка 1\nстрока 2\nстрока 3', JSON.stringify(multiline));
check('после отправки поле снова в одну строку', await alice.evaluate(() => document.getElementById('message-input').offsetHeight) <= oneLine + 1);

/* ------------------------- вставка и перетаскивание ------------------------- */

const picture = await pngFile(alice, 240, 90, 'снимок.png');
const before = await bubbles(bob);
await alice.evaluate(file => {
    const data = new DataTransfer();
    data.items.add(file);
    document.getElementById('message-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, picture);
check('вставленная картинка не уходит сама — спрашиваем', await modalOpen(alice));
check('в окне — имя и размер', (await alice.textContent('#send-files-list')).includes('снимок.png'));
await alice.click('#send-files-cancel');
await alice.waitForTimeout(1000);
check('«Отмена» — ничего не отправлено', await bubbles(bob) === before);

await alice.evaluate(file => {
    const data = new DataTransfer();
    data.items.add(file);
    document.getElementById('message-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, picture);
await alice.click('#send-files-confirm');
await bob.waitForSelector('#chat-messages .message-image', { timeout: 15000 }).catch(() => null);
const received = await bob.evaluate(() => {
    const img = [...document.querySelectorAll('#chat-messages .message-image')].at(-1);
    return img ? { w: img.getAttribute('width'), h: img.getAttribute('height') } : null;
});
check('картинка дошла с размерами из данных вложения', received && received.w === '240' && received.h === '90', JSON.stringify(received));
const placeholder = await bob.evaluate(() => {
    const p = { blob: '0'.repeat(32), key: btoa(String.fromCharCode(...new Uint8Array(32))), iv: btoa(String.fromCharCode(...new Uint8Array(12))),
        name: 'x.png', mime: 'image/png', size: 10, w: 400, h: 100 };
    const el = createEncryptedAttachmentElement(p);
    document.body.appendChild(el);
    const box = el.querySelector('.attachment-skeleton')?.getBoundingClientRect();
    el.remove();
    return box ? Math.round(box.width / box.height) : null;
});
check('место под картинку — её формы, ещё до расшифровки', placeholder === 4, String(placeholder));
const odd = await bob.evaluate(() => e2ee.decodePayload(JSON.stringify({ v: 1, t: 'file', blob: '0'.repeat(32),
    key: btoa(String.fromCharCode(...new Uint8Array(32))), iv: btoa(String.fromCharCode(...new Uint8Array(12))),
    name: 'x.png', mime: 'image/png', size: 1, w: -5, h: 'много' })));
check('странные размеры отбрасываются, вложение остаётся', odd.t === 'file' && odd.w === undefined && odd.h === undefined, JSON.stringify(odd));

const note = await alice.evaluateHandle(() => new File(['заметка'], 'заметка.txt', { type: 'text/plain' }));
await alice.evaluate(file => {
    const data = new DataTransfer();
    data.items.add(file);
    document.querySelector('.main-content').dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
}, note);
check('над окном с файлом — подсказка «Отпустите…»', await alice.isVisible('#drop-zone'));
await alice.evaluate(file => {
    const data = new DataTransfer();
    data.items.add(file);
    document.querySelector('.main-content').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
}, note);
check('брошенный файл — тоже через подтверждение', await modalOpen(alice) && !(await alice.isVisible('#drop-zone')));
await alice.click('#send-files-confirm');
await alice.waitForTimeout(2500);
check('брошенный файл отправлен', (await bob.textContent('#chat-messages')).includes('заметка.txt'));

/* ------------------------- прогресс и отмена ------------------------- */

let release = null;
await alice.route('**/api/blobs?**', route => new Promise(resolve => { release = () => route.continue().then(resolve, resolve); }));
const big = await pngFile(alice, 64, 64, 'большой.png');
const beforeCancel = await bubbles(bob);
await alice.evaluate(file => { sendFiles([file]); }, big);
await alice.waitForSelector('#upload-status:not([hidden])', { timeout: 5000 }).catch(() => null);
check('долгая отправка — полоска с именем файла', await alice.isVisible('#upload-status')
    && (await alice.textContent('#upload-status-name')).includes('большой.png'));
await alice.click('#upload-cancel-btn');
await alice.waitForTimeout(800);
check('«Отменить» — полоска пропала', !(await alice.isVisible('#upload-status')));
check('и сказано, что отправка отменена', (await alice.textContent('#toast')).includes('Отправка отменена'));
if (release) release();
await alice.unroute('**/api/blobs?**');
await alice.waitForTimeout(1500);
check('отменённое не отправлено', await bubbles(bob) === beforeCancel);

/* ------------------------- время в списке ------------------------- */

const times = await alice.evaluate(() => [...document.querySelectorAll('#chats-list .chat-item .chat-time')].map(t => t.textContent));
check('в списке — время последнего сообщения', times.length >= 2 && times.every(t => /^\d{2}:\d{2}$/.test(t)), JSON.stringify(times));
await alice.locator(BOT).first().click();
await alice.waitForTimeout(800);
await alice.locator(ROOM).first().click();
await alice.waitForTimeout(1000);
await alice.fill('#message-input', 'поднимаю чат');
await alice.press('#message-input', 'Enter');
await alice.waitForTimeout(1200);
check('чат с новым сообщением — наверху списка', await alice.evaluate(() =>
    document.querySelector('#chats-list .chat-item')?.dataset.roomId !== ''));
check('и он по-прежнему выделен как открытый', await alice.evaluate(() =>
    document.querySelector('#chats-list .chat-item.active')?.dataset.roomId !== ''));

/* ------------------------- ширина списка ------------------------- */

const sidebarWidth = () => alice.evaluate(() => Math.round(document.querySelector('.sidebar').getBoundingClientRect().width));
const start = await sidebarWidth();
const handle = await alice.locator('#sidebar-resizer').boundingBox();
const y = handle.y + handle.height / 2;
await alice.mouse.move(handle.x + handle.width / 2, y);
await alice.mouse.down();
await alice.mouse.move(handle.x + 100, y, { steps: 5 });
await alice.mouse.up();
const wider = await sidebarWidth();
check('границу списка можно тянуть', Math.abs(wider - (start + 100)) <= 6, `${start} → ${wider}`);
await alice.mouse.move(handle.x + 100, y);
await alice.mouse.down();
await alice.mouse.move(60, y, { steps: 5 });
await alice.mouse.up();
const compact = await alice.evaluate(() => ({
    width: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
    compact: document.querySelector('.sidebar').classList.contains('is-compact'),
    titles: [...document.querySelectorAll('#chats-list .chat-item')].every(i => i.title),
    search: getComputedStyle(document.querySelector('.search-container')).display,
}));
check('уже 160px — компактный список 76px', compact.compact && compact.width === 76 && compact.search === 'none', JSON.stringify(compact));
check('в компактном имя чата — подсказкой', compact.titles);
await alice.reload({ waitUntil: 'networkidle' });
await alice.waitForTimeout(1000);
check('ширина запоминается', await sidebarWidth() === 76);
await alice.focus('#sidebar-resizer');
await alice.keyboard.press('ArrowRight');
check('стрелка вправо из компактного — самый узкий обычный', await sidebarWidth() === 240, String(await sidebarWidth()));
await alice.keyboard.press('End');
check('End — самый широкий', await sidebarWidth() === 480, String(await sidebarWidth()));
await alice.keyboard.press('Enter');
check('Enter — ширина по умолчанию', await sidebarWidth() === 340, String(await sidebarWidth()));
check('граница сообщает ширину экранному диктору', await alice.getAttribute('#sidebar-resizer', 'aria-valuenow') === '340');

/* ------------------------- уведомления ------------------------- */

await alice.click('#profile-btn');
await alice.waitForFunction(() => document.getElementById('profile-modal').open);
await alice.locator('#notify-toggle').check();
await alice.waitForTimeout(300);
await alice.keyboard.press('Escape');
await alice.locator(ROOM).first().click();
await alice.waitForTimeout(1000);
await alice.evaluate(() => { window.__notes = []; });
await bob.fill('#message-input', 'секрет в открытом чате');
await bob.press('#message-input', 'Enter');
await alice.waitForTimeout(1200);
check('чат открыт и на экране — уведомления нет', await alice.evaluate(() => window.__notes.length === 0));
await alice.locator(BOT).first().click();
await alice.waitForTimeout(800);
// Сообщение комнаты несёт chat_id отправителя. Совпади он с номером
// открытого у получателя чата с ботом — раньше оно рисовалось бы там.
check('сообщение комнаты не попадает в открытый чат с ботом с тем же номером', await alice.evaluate(async () => {
    const before = document.querySelectorAll('#chat-messages .message').length;
    await handleNewMessage({ id: 999999, chat_id: currentChatId, room_id: 999999, user_id: -1, text: 'чужое', message_type: 'text', sent: 1 });
    return document.querySelectorAll('#chat-messages .message').length === before;
}));
await alice.waitForTimeout(500);
await alice.evaluate(() => { window.__notes = []; });
await bob.fill('#message-input', 'секрет для уведомления');
await bob.press('#message-input', 'Enter');
await alice.waitForTimeout(1500);
const notes = await alice.evaluate(() => window.__notes);
check('сообщение в другом чате — уведомление', notes.length === 1, JSON.stringify(notes));
check('в уведомлении нет ни текста, ни имени', notes.length && notes[0].title === 'Nyxo' && notes[0].body === 'Новое сообщение'
    && !JSON.stringify(notes).includes('секрет') && !JSON.stringify(notes).includes('bob'), JSON.stringify(notes));
await alice.click('#profile-btn');
await alice.waitForFunction(() => document.getElementById('profile-modal').open);
check('настройка видна включённой', await alice.isChecked('#notify-toggle'));
await alice.locator('#notify-toggle').uncheck();
await alice.keyboard.press('Escape');
await alice.evaluate(() => { window.__notes = []; });
await bob.fill('#message-input', 'после выключения');
await bob.press('#message-input', 'Enter');
await alice.waitForTimeout(1500);
check('выключили — уведомлений нет', await alice.evaluate(() => window.__notes.length === 0));

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
