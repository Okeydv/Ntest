// Сквозной тест сверки ключей (safety numbers).
//
// Проверяется:
//   - у обоих собеседников один и тот же код
//   - отметка «сверено» видна в шапке чата
//   - новое устройство у сверенного собеседника останавливает отправку,
//     набранный текст при этом не пропадает
//   - после повторной сверки код у сторон снова совпадает, отправка идёт
//   - подмена ключа устройства на сервере (как это сделал бы
//     скомпрометированный сервер) не проходит: этому устройству конверт не
//     шифруется, в окне сверки — предупреждение, у самой жертвы — тоже
//   - перезаписать identity своего устройства через API нельзя
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы;
// key-server должен работать на той же базе, что и приложение (TEST_DATABASE_URL):
// подмена ключа делается прямо в его таблицах.
//
// Запуск: TEST_DATABASE_URL=... node scripts/test-e2ee-safety.mjs

import { chromium } from 'playwright';
import pg from 'pg';
import crypto from 'node:crypto';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

let fails = 0;
const check = (l, c, d = '') => {
    console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`);
    if (!c) fails++;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
async function openApp(label) {
    const page = await (await browser.newContext()).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return { page, errors, label };
}
const register = (app, u, e) => app.page.evaluate(async ([u, e]) => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: u, email: e, password: 'password123', confirmPassword: 'password123' }) });
    if (!r.success) throw new Error(r.message);
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
    return { userId: r.user.id, deviceId: e2eeDeviceId };
}, [u, e]);
const login = (app, e) => app.page.evaluate(async e => {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: e, password: 'password123' }) });
    if (!r.success) throw new Error(r.message);
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
    return { userId: r.user.id, deviceId: e2eeDeviceId };
}, e);

const ROOM_CHAT = '.chat-item[data-room-id]:not([data-room-id=""])';
const openRoom = async app => {
    await app.page.reload({ waitUntil: 'networkidle' });
    await app.page.waitForTimeout(1200);
    await app.page.locator(ROOM_CHAT).first().click({ timeout: 8000 });
    await app.page.waitForTimeout(900);
};
const badge = app => app.page.evaluate(() => {
    const b = document.getElementById('chat-encryption');
    return { cls: b.className, text: b.textContent.trim(), disabled: b.disabled };
});
// Открыть окно сверки и дождаться, пока посчитается код.
async function safety(app) {
    await app.page.click('#chat-encryption');
    await app.page.waitForSelector('#safety-list .safety-entry', { timeout: 10000 });
    await app.page.waitForTimeout(300);
    return app.page.evaluate(() => {
        const entry = document.querySelector('#safety-list .safety-entry');
        return {
            number: [...entry.querySelectorAll('.safety-number span')].map(s => s.textContent).join(' '),
            state: entry.querySelector('.safety-state')?.textContent || '',
            warnings: [...entry.querySelectorAll('.safety-warning')].map(w => w.textContent.trim()),
            action: entry.querySelector('button')?.textContent || '',
        };
    });
}
const closeSafety = app => app.page.evaluate(() => closeModal(document.getElementById('safety-modal')));
const clickVerify = async app => {
    await app.page.locator('#safety-list .safety-entry button.btn-primary').click();
    await app.page.waitForTimeout(600);
};
async function send(app, text) {
    await app.page.fill('#message-input', text);
    await app.page.click('#send-btn');
    await app.page.waitForTimeout(1200);
    return app.page.evaluate(() => ({
        toast: document.getElementById('toast').textContent,
        input: document.getElementById('message-input').value,
    }));
}
const roomMessages = async roomId =>
    Number((await db.query('SELECT count(*) FROM messages WHERE room_id = $1', [roomId])).rows[0].count);
const seesText = (app, text) => app.page.evaluate(t =>
    [...document.querySelectorAll('#chat-messages .message-text')].some(el => el.textContent === t), text);

/* ------------------------- участники ------------------------- */

const alice = await openApp('alice');
await register(alice, 'alice', 'alice@example.com');
const code = await alice.page.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Сверка' }) });
    return (await api(`/api/chats/invite/${c.chat.id}`)).code;
});
const bob = await openApp('bob');
const bobInfo = await register(bob, 'bob', 'bob@example.com');
await bob.page.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);

await openRoom(alice);
await openRoom(bob);
const roomId = await alice.page.evaluate(() => currentRoomId);
await send(alice, 'привет');
await bob.page.waitForTimeout(500);
check('переписка идёт', await seesText(bob, 'привет'));

/* ------------------------- код совпадает ------------------------- */

const b0 = await badge(alice);
check('индикатор в зашифрованном чате — кнопка', !b0.disabled && b0.cls.includes('is-on'), b0.text);

const a1 = await safety(alice);
const bo1 = await safety(bob);
check('код — 12 групп по 5 цифр', /^(\d{5} ){11}\d{5}$/.test(a1.number), a1.number);
check('у обоих собеседников один и тот же код', a1.number === bo1.number);
check('до сверки — «Не сверено»', a1.state === 'Не сверено', a1.state);

await clickVerify(alice);
const a2 = await alice.page.evaluate(() =>
    document.querySelector('#safety-list .safety-state').textContent);
check('после отметки — «Сверено»', a2 === 'Сверено', a2);
await closeSafety(alice);
await closeSafety(bob);
const b1 = await badge(alice);
check('шапка говорит, что ключи сверены', /ключи сверены/.test(b1.text) && b1.cls.includes('is-on'), b1.text);

/* ------------------------- новое устройство ------------------------- */

const bobPhone = await openApp('bob-phone');
const phoneInfo = await login(bobPhone, 'bob@example.com');
check('у Боба второе устройство', phoneInfo.deviceId && phoneInfo.deviceId !== bobInfo.deviceId);

await openRoom(alice);
const b2 = await badge(alice);
check('новое устройство у сверенного собеседника видно в шапке',
    b2.cls.includes('is-warn') && /изменились/.test(b2.text), b2.text);

// Новое устройство пишет само. Читать его сообщения можно, но видно, что
// они с устройства, которого не было при сверке.
await openRoom(bobPhone);
await send(bobPhone, 'пишу с телефона');
await send(bob, 'пишу с ноутбука');
const marked = text => alice.page.evaluate(t => {
    const bubble = [...document.querySelectorAll('#chat-messages .message')].find(m => m.textContent.includes(t));
    return bubble ? Boolean(bubble.querySelector('.message-new-device')) : null;
}, text);
check('сообщение с несверенного устройства помечено', await marked('пишу с телефона') === true);
check('а со сверенного — нет', await marked('пишу с ноутбука') === false);

const before = await roomMessages(roomId);
const blocked = await send(alice, 'это не должно уйти');
check('отправка остановлена до повторной сверки',
    await roomMessages(roomId) === before && /сверьте код заново/.test(blocked.toast), blocked.toast);
check('набранный текст не пропал', blocked.input === 'это не должно уйти');


const a3 = await safety(alice);
check('окно сверки объясняет, что изменилось',
    a3.state === 'Изменились после сверки' && a3.warnings.some(w => /новое устройство/.test(w)), a3.state);
check('код с новым устройством другой', a3.number !== a1.number);
await openRoom(bob);
const bo3 = await safety(bob);
check('и снова одинаков у обеих сторон', a3.number === bo3.number);
await closeSafety(bob);

await clickVerify(alice);
await closeSafety(alice);
await openRoom(bobPhone);
const sent = await send(alice, 'после сверки');
await bobPhone.page.waitForTimeout(800);
check('после повторной сверки отправка идёт', sent.input === '' && await roomMessages(roomId) === before + 1);
check('и новое устройство Боба сообщение читает', await seesText(bobPhone, 'после сверки'));
await openRoom(alice);
check('после повторной сверки пометки нет', await marked('пишу с телефона') === false);

/* ------------------------- подмена ключа сервером ------------------------- */

// Так выглядела бы атака скомпрометированного сервера: identity-ключ
// устройства заменён своим, signed prekey переподписан этим ключом —
// подпись в bundle сходится, и без памяти о ключах клиент бы не заметил.
const raw = k => k.export({ type: 'spki', format: 'der' }).subarray(-32);
const fakeId = crypto.generateKeyPairSync('ed25519');
const fakeDh = crypto.generateKeyPairSync('x25519');
const { rows: [spk] } = await db.query(
    'SELECT public_key FROM signed_prekeys WHERE user_id = $1 AND device_id = $2',
    [bobInfo.userId, phoneInfo.deviceId]);
await db.query('UPDATE identity_keys SET identity_signing_key = $1, identity_dh_key = $2 WHERE user_id = $3 AND device_id = $4',
    [raw(fakeId.publicKey), raw(fakeDh.publicKey), bobInfo.userId, phoneInfo.deviceId]);
await db.query('UPDATE signed_prekeys SET signature = $1 WHERE user_id = $2 AND device_id = $3',
    [crypto.sign(null, spk.public_key, fakeId.privateKey), bobInfo.userId, phoneInfo.deviceId]);
// Сессия с телефоном уже есть и построена на настоящем ключе. Чтобы
// клиент пошёл за bundle, забываем её — как после сбоя сессии.
await alice.page.evaluate(async ([u, d]) => {
    const store = await import('/crypto/store.js');
    await store.sessions.drop(u, d);
}, [bobInfo.userId, phoneInfo.deviceId]);

const spoofed = await send(alice, 'после подмены');
check('клиент заметил подмену ключа', /не совпадает с известным/.test(spoofed.toast), spoofed.toast);
const { rows: [last] } = await db.query('SELECT max(id) AS id FROM messages WHERE room_id = $1', [roomId]);
const recipients = (await db.query('SELECT recipient_device_id FROM message_envelopes WHERE message_id = $1', [last.id]))
    .rows.map(r => Number(r.recipient_device_id));
check('подменённому устройству конверт не зашифрован',
    !recipients.includes(phoneInfo.deviceId) && recipients.includes(bobInfo.deviceId), JSON.stringify(recipients));
await bob.page.waitForTimeout(500);
check('настоящее устройство Боба сообщение получило', await seesText(bob, 'после подмены'));

const a4 = await safety(alice);
check('в окне сверки — предупреждение о подмене', a4.warnings.some(w => /не совпадает/.test(w)));
check('код считается по известному ключу, а не по подменённому', a4.number === a3.number);
await closeSafety(alice);

await openRoom(bobPhone);
const victim = await safety(bobPhone);
check('жертва видит, что сервер раздаёт от её имени чужой ключ',
    victim.warnings.some(w => /от имени ваших устройств/.test(w)));

/* ------------------------- перезапись identity ------------------------- */

const overwrite = await alice.page.evaluate(async () => {
    const r = await fetch('/api/keys/identity', { method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ identity_signing_key: btoa('x'.repeat(32)), identity_dh_key: btoa('y'.repeat(32)) }) });
    return r.status;
});
check('перезаписать identity своего устройства нельзя', overwrite === 409, 'status ' + overwrite);

/* ------------------------- итог ------------------------- */

const errors = [alice, bob, bobPhone].flatMap(a => a.errors);
check('ошибок на страницах нет', errors.length === 0, errors.join('; '));

await browser.close();
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
