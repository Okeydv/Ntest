// Личные чаты в интерфейсе.
//
//   - профиль: свой код группами по 4, «Сменить код», «Запросы по коду»;
//   - «Новый чат» → «Личный чат»: «Найти» показывает, кто это, потом
//     «Отправить запрос»; свой запрос виден над списком чатов;
//   - у получателя над списком «хочет переписываться» с «Принять»,
//     «Отклонить», «Заблокировать»; принял — открылся чат с именем
//     собеседника, у отправителя — тост и чат в списке;
//   - меню личного чата: «Заблокировать» вместо ссылки и участников;
//     заблокировали — поле ввода выключено, разблокировали — включено;
//   - QR при встрече: в QR код и отпечаток ключей; совпал — собеседник
//     сверен и запрос отправлен, подменённый отпечаток — предупреждение
//     без отметки.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-direct-ui.mjs

import { launch, finish } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, extraHTTPHeaders: { 'X-Forwarded-For': `10.0.20.${nextIp++}` } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    page.on('dialog', d => d.accept());
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return page;
}
const register = (page, u) => page.evaluate(async u => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'password123', confirmPassword: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
}, u);
const ROOM = '.chat-item[data-room-id]:not([data-room-id=""])';
const shown = (page, selector) => page.evaluate(s => {
    const el = document.querySelector(s);
    return Boolean(el) && !el.closest('[hidden]') && el.getClientRects().length > 0;
}, selector);
const toastText = page => page.evaluate(() => document.getElementById('toast').textContent);

const alice = await openApp('alice');
await register(alice, 'alice');
const bob = await openApp('bob');
await register(bob, 'bob');

/* ------------------------- свой код ------------------------- */

await alice.click('#profile-btn');
await alice.waitForFunction(() => document.getElementById('profile-modal').open && document.getElementById('user-code-display').textContent);
const code = await alice.textContent('#user-code-display');
check('в профиле — свой код группами по 4, запросы по коду включены',
    /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) && await alice.isChecked('#code-requests-toggle'), code);
await alice.click('#rotate-user-code-btn');
await alice.waitForTimeout(700);
const newCode = await alice.textContent('#user-code-display');
check('«Сменить код» показывает новый', newCode !== code && /^[A-Z0-9]{4}-/.test(newCode), `${code} → ${newCode}`);
await alice.keyboard.press('Escape');

/* ------------------------- запрос по коду ------------------------- */

await bob.click('#new-chat-btn');
check('в «Новом чате» три пути', (await bob.evaluate(() =>
    [...document.querySelectorAll('#new-chat-modal .choice-card')].filter(c => !c.hidden).map(c => c.dataset.path).join())) === 'direct,group,join');
await bob.click('.choice-card[data-path="direct"]');
await bob.fill('#direct-code', code);
await bob.click('#direct-find-btn');
await bob.waitForTimeout(600);
check('прежний код не находит', (await bob.textContent('[data-msg-for="direct-code"]')).startsWith('Такого кода нет'),
    await bob.textContent('[data-msg-for="direct-code"]'));
await bob.fill('#direct-code', newCode.toLowerCase());
await bob.click('#direct-find-btn');
await bob.waitForTimeout(600);
check('«Найти» показывает, кто это', await bob.textContent('#direct-preview-name') === 'alice'
    && await bob.textContent('#direct-find-btn') === 'Отправить запрос');
await bob.click('#direct-find-btn');
await bob.waitForTimeout(800);
check('запрос отправлен: окно закрыто, тост, запрос над списком',
    !(await bob.evaluate(() => document.getElementById('new-chat-modal').open))
    && /Запрос отправлен/.test(await toastText(bob)) && (await bob.textContent('#my-requests')).includes('запрос на переписку отправлен'),
    await toastText(bob));

await alice.waitForTimeout(600);
const incoming = await alice.evaluate(() => ({
    text: document.getElementById('my-requests').textContent,
    buttons: [...document.querySelectorAll('#my-requests .my-request button')].map(b => b.textContent),
}));
check('у получателя — «хочет переписываться» и три кнопки', incoming.text.includes('bobхочет переписываться')
    && incoming.buttons.join() === 'Принять,Отклонить,Заблокировать', JSON.stringify(incoming));
await alice.click('#my-requests button:has-text("Принять")');
await alice.waitForTimeout(1500);
const opened = await alice.evaluate(() => ({
    name: document.getElementById('chat-name').textContent,
    kind: currentChatMeta()?.kind,
    requests: document.getElementById('my-requests').hidden,
    input: !document.getElementById('message-input').disabled,
}));
check('«Принять» открывает личный чат с именем собеседника', opened.name === 'bob' && opened.kind === 'direct'
    && opened.requests && opened.input, JSON.stringify(opened));
await bob.waitForTimeout(500);
check('отправителю — тост, чат в списке, запрос над списком исчез',
    /alice принял\(а\) запрос/.test(await toastText(bob)) && await bob.locator(ROOM).count() === 1
    && !(await shown(bob, '#my-requests')), await toastText(bob));

/* ------------------------- меню и блокировка ------------------------- */

await alice.click('#chat-menu-btn');
const menu = await alice.evaluate(() => ({
    block: !document.getElementById('block-peer-btn').hidden && document.getElementById('block-peer-label').textContent,
    members: document.getElementById('chat-menu-members-btn').hidden,
    invite: document.getElementById('chat-menu-invite-btn').hidden && document.getElementById('get-chat-code-btn').hidden,
    leave: document.getElementById('delete-chat-label').textContent,
}));
check('меню личного чата: «Заблокировать», без участников и ссылки, «Удалить чат»',
    menu.block === 'Заблокировать' && menu.members && menu.invite && menu.leave === 'Удалить чат', JSON.stringify(menu));
await alice.click('#block-peer-btn');
await alice.waitForTimeout(1000);
check('заблокировали — поле ввода выключено и объясняет', await alice.evaluate(() =>
    document.getElementById('message-input').disabled && document.getElementById('message-input').placeholder === 'Вы заблокировали собеседника'));
await alice.click('#profile-btn');
await alice.waitForFunction(() => document.getElementById('profile-modal').open);
await alice.waitForTimeout(400);
check('в профиле — список заблокированных', (await alice.textContent('#blocked-list')).includes('bob'));
await alice.click('#blocked-list button:has-text("Разблокировать")');
await alice.waitForTimeout(900);
check('разблокировали — список пуст, поле ввода снова включено', await alice.evaluate(() =>
    document.getElementById('blocked-section').hidden && !document.getElementById('message-input').disabled));
await alice.keyboard.press('Escape');

/* ------------------------- QR при встрече ------------------------- */

const carol = await openApp('carol');
await register(carol, 'carol');
await alice.click('#profile-btn');
await alice.click('#profile-meet-btn');
await alice.waitForFunction(() => document.getElementById('meet-modal').open && !document.getElementById('meet-qr').hidden
    // Нарисованный QR — квадрат; пустой холст по умолчанию 300×150.
    && document.getElementById('meet-qr').width === document.getElementById('meet-qr').height, null, { timeout: 10000 });
const payload = await alice.evaluate(async () => {
    const canvas = document.getElementById('meet-qr');
    return decodeQr(canvas, canvas.width, canvas.height);
});
check('в QR — код и отпечаток ключей', new RegExp(`^NYXOUSER1:${newCode.replace(/-/g, '')}:\\d{30}$`).test(payload || ''), payload);
check('под QR — свой код', await alice.textContent('#meet-code') === newCode);

// Камеры в тесте нет: «кадр» с QR подставляется вместо сканера.
const scanAs = (page, value) => page.evaluate(async v => {
    scanWithCamera = async () => v;
    document.getElementById('meet-scan-btn').hidden = false;
}, value);
await carol.click('#new-chat-btn');
await carol.click('.choice-card[data-path="direct"]');
await carol.click('#direct-meet-btn');
await carol.waitForFunction(() => document.getElementById('meet-modal').open);
const forged = payload.replace(/\d{30}$/, '0'.repeat(30));
await scanAs(carol, forged);
await carol.click('#meet-scan-btn');
await carol.waitForTimeout(1500);
const warn = await carol.evaluate(() => ({ cls: document.getElementById('meet-result').className, text: document.getElementById('meet-result').textContent }));
const aliceId = await alice.evaluate(() => currentUser.id);
check('подменённый отпечаток — предупреждение, отметки «сверено» нет',
    warn.cls.includes('is-warn') && /не совпали/.test(warn.text)
    && (await carol.evaluate(async id => (await e2ee.safetyInfo(id)).state, aliceId)) === 'unverified', JSON.stringify(warn));
await scanAs(carol, payload);
await carol.click('#meet-scan-btn');
await carol.waitForTimeout(2000);
check('настоящий QR: собеседник сверен, запрос отправлен (один), окно закрыто',
    (await carol.evaluate(async id => (await e2ee.safetyInfo(id)).state, aliceId)) === 'verified'
    && !(await carol.evaluate(() => document.getElementById('meet-modal').open))
    && (await carol.textContent('#my-requests')).includes('alice')
    && await carol.locator('#my-requests .my-request').count() === 1, await toastText(carol));
await scanAs(carol, 'https://example.com');
await carol.click('#profile-btn');
await carol.click('#profile-meet-btn');
await carol.waitForFunction(() => document.getElementById('meet-modal').open);
await carol.click('#meet-scan-btn');
await carol.waitForTimeout(600);
check('чужой QR — «это не QR пользователя Nyxo»', (await carol.textContent('#meet-result')).includes('Это не QR пользователя Nyxo'));

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
