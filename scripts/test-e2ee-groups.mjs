// Сквозной тест групп на sender keys.
//
// Четыре участника в одной комнате. Проверяется:
//   - сообщение в группу — один шифротекст на всех, ключ раздаётся только
//     в первый раз, дальше конвертов нет вовсе
//   - у каждого отправителя свой ключ
//   - ушедший из группы не получает новый ключ, остальные меняют свой
//   - новое устройство получает ключ и читает новое, но не старое
//   - удаление сообщения не уносит ключ: устройство, которое было офлайн,
//     всё равно прочитает то, что пришло после
//   - разговор двоих остаётся попарным (у Double Ratchet есть DH-рэтчет)
//   - зашифрованное нельзя редактировать: правка ушла бы открытым текстом
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-e2ee-groups.mjs

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import pg from 'pg';
import sharp from 'sharp';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

let fails = 0;
const check = (l, c, d = '') => {
    console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`);
    if (!c) fails++;
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
async function openPage(context, label) {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return page;
}
// Регистраций с одного IP не больше трёх в час, а участников здесь больше.
// Лимит не трогаем: сервер доверяет одному прокси-хопу, и у каждого
// участника свой адрес — как у разных людей за балансировщиком.
let nextIp = 10;
async function openApp(label) {
    const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': `10.0.0.${nextIp++}` } });
    return { context, page: await openPage(context, label), label, posts: [] };
}
const register = (app, u) => app.page.evaluate(async u => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'password123', confirmPassword: 'password123' }) });
    if (!r.success) throw new Error(r.message);
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
    return { userId: r.user.id, deviceId: e2eeDeviceId };
}, u);
const login = (page, u) => page.evaluate(async u => {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: `${u}@example.com`, password: 'password123' }) });
    if (!r.success) throw new Error(r.message);
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
    return { userId: r.user.id, deviceId: e2eeDeviceId };
}, u);
// Тела отправленных зашифрованных сообщений — по ним видно, что ушло на сервер.
const watchPosts = app => app.page.on('request', r => {
    if (r.method() === 'POST' && r.url().endsWith('/api/messages/encrypted')) app.posts.push(JSON.parse(r.postData()));
});
const openRoom = async (page, roomId) => {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator(`.chat-item[data-room-id="${roomId}"]`).click({ timeout: 8000 });
    await page.waitForTimeout(900);
};
async function send(app, text) {
    await app.page.fill('#message-input', text);
    await app.page.click('#send-btn');
    await app.page.waitForTimeout(1200);
    return app.posts[app.posts.length - 1];
}
const texts = page => page.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .message-text')].map(el => el.textContent));
const dist = post => Buffer.from(post.group.header, 'base64').subarray(1, 17).toString('hex');
const lastMessageId = async roomId =>
    (await db.query('SELECT max(id) AS id FROM messages WHERE room_id = $1', [roomId])).rows[0].id;
async function pendingKeys(roomId) {
    // Получатели забирают ключи асинхронно — даём им время.
    for (let i = 0; i < 20; i++) {
        const n = Number((await db.query('SELECT count(*) FROM sender_key_envelopes WHERE room_id = $1', [roomId])).rows[0].count);
        if (n === 0) return 0;
        await new Promise(r => setTimeout(r, 200));
    }
    return Number((await db.query('SELECT count(*) FROM sender_key_envelopes WHERE room_id = $1', [roomId])).rows[0].count);
}

/* ------------------------- группа из четырёх ------------------------- */

const alice = await openApp('alice');
await register(alice, 'alice');
watchPosts(alice);
const created = await alice.page.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Группа' }) });
    return { roomId: c.chat.room_id, code: (await api(`/api/chats/invite/${c.chat.id}`)).code };
});
const ROOM = created.roomId;

const members = {};
for (const name of ['bob', 'carol', 'dave']) {
    const app = await openApp(name);
    const info = await register(app, name);
    watchPosts(app);
    await app.page.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), created.code);
    members[name] = { ...app, info };
}
const { bob, carol, dave } = members;
for (const app of [alice, bob, carol, dave]) await openRoom(app.page, ROOM);

const first = await send(alice, 'первое в группу');
check('сообщение в группу — один шифротекст, без попарных конвертов',
    !!first.group && !first.envelopes, Object.keys(first).join(','));
check('ключ раздан трём собеседникам', first.keyEnvelopes.length === 3,
    JSON.stringify(first.keyEnvelopes.map(e => e.recipientDeviceId)));
const allRead = async (apps, text) =>
    (await Promise.all(apps.map(a => texts(a.page)))).every(list => list.includes(text));
check('все трое прочитали', await allRead([bob, carol, dave], 'первое в группу'));

const firstId = await lastMessageId(ROOM);
const stored = await db.query(
    `SELECT m.text, (SELECT count(*) FROM message_envelopes e WHERE e.message_id = m.id) AS envelopes,
            (SELECT count(*) FROM message_group_payloads g WHERE g.message_id = m.id) AS payloads
     FROM messages m WHERE m.id = $1`, [firstId]);
check('в базе: текста нет, один групповой шифротекст, ноль конвертов',
    stored.rows[0].text === null && Number(stored.rows[0].payloads) === 1 && Number(stored.rows[0].envelopes) === 0);
check('получатели забрали ключи с сервера', await pendingKeys(ROOM) === 0);

const second = await send(alice, 'второе');
check('второе сообщение — без раздачи ключа', second.keyEnvelopes.length === 0);
check('и его прочитали все', await allRead([bob, carol, dave], 'второе'));
check('ключ тот же', dist(second) === dist(first));

const bobs = await send(bob, 'ответ Боба');
check('у Боба свой ключ, он раздаёт его сам', bobs.keyEnvelopes.length === 3 && dist(bobs) !== dist(first));
check('ответ Боба прочитали все', await allRead([alice, carol, dave], 'ответ Боба'));

const photo = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#6d5efc' } }).png().toBuffer();
await alice.page.setInputFiles('#file-input', { name: 'group.png', mimeType: 'image/png', buffer: photo });
await alice.page.waitForTimeout(1500);
const photoPost = alice.posts[alice.posts.length - 1];
check('фото в группу уходит тем же групповым шифротекстом', !!photoPost.group && photoPost.blobIds.length === 1);
const photoSeen = await Promise.all([bob, carol, dave].map(a => a.page.waitForSelector('#chat-messages img.message-image',
    { timeout: 8000 }).then(() => true, () => false)));
check('фото расшифровали все трое', photoSeen.every(Boolean), JSON.stringify(photoSeen));

/* ------------------------- выход из группы ------------------------- */

await carol.page.evaluate(async () => api(`/api/chats/${currentChatId}`, { method: 'DELETE' }));
const afterLeave = await send(alice, 'Кэрол уже не прочтёт');
check('после выхода участника ключ сменился', dist(afterLeave) !== dist(first));
check('новый ключ роздан только оставшимся',
    JSON.stringify(afterLeave.keyEnvelopes.map(e => e.recipientDeviceId).sort())
    === JSON.stringify([bob.info.deviceId, dave.info.deviceId].sort()));
check('оставшиеся читают', await allRead([bob, dave], 'Кэрол уже не прочтёт'));
const carolKeys = await db.query('SELECT count(*) FROM sender_key_envelopes WHERE recipient_device_id = $1',
    [carol.info.deviceId]);
check('у ушедшей нет ни одного ключа группы на сервере', Number(carolKeys.rows[0].count) === 0);

/* ------------------------- новое устройство, которое было офлайн ------------------------- */

// Телефон Боба входит и сразу пропадает из сети (страница закрыта,
// ключи остались в его IndexedDB).
const phoneContext = await browser.newContext();
let phonePage = await openPage(phoneContext, 'bob-phone');
const phone = await login(phonePage, 'bob');
await phonePage.close();

await openRoom(alice.page, ROOM);
const forPhone = await send(alice, 'сообщение, которое принесло ключ');
check('ключ получает только новое устройство',
    JSON.stringify(forPhone.keyEnvelopes.map(e => e.recipientDeviceId)) === JSON.stringify([phone.deviceId]));
const carrierId = await lastMessageId(ROOM);
await send(alice, 'после удаления первого');
// Удаляем сообщение, вместе с которым раздавался ключ. Будь ключ его
// частью, телефон не прочитал бы и следующее.
await alice.page.evaluate(id => api(`/api/messages/${id}`, { method: 'DELETE' }), carrierId);

phonePage = await openPage(phoneContext, 'bob-phone');
await openRoom(phonePage, ROOM);
const phoneTexts = await texts(phonePage);
check('телефон, бывший офлайн, читает пришедшее после — ключ не ушёл с удалённым сообщением',
    phoneTexts.includes('после удаления первого'), JSON.stringify(phoneTexts));
check('а то, что было до его появления, — нет',
    !phoneTexts.includes('первое в группу') && !phoneTexts.includes('ответ Боба'));

/* ------------------------- двое — попарно ------------------------- */

const pair = await alice.page.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Вдвоём' }) });
    return { roomId: c.chat.room_id, code: (await api(`/api/chats/invite/${c.chat.id}`)).code };
});
await dave.page.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), pair.code);
await openRoom(alice.page, pair.roomId);
await openRoom(dave.page, pair.roomId);
const direct = await send(alice, 'только тебе');
check('разговор двоих остаётся попарным', !direct.group && direct.envelopes?.length === 1);
check('и читается', (await texts(dave.page)).includes('только тебе'));

/* ------------------------- правка и перезагрузка ------------------------- */

const editVisible = await alice.page.evaluate(() => {
    showMessageMenu(10, 10, { id: 1, user_id: currentUser.id, encrypted: true, text: 'x' });
    const shown = !elements.editMessageBtn.hidden && elements.editMessageBtn.offsetParent !== null;
    hideMessageMenu();
    return shown;
});
check('у зашифрованного сообщения нет пункта «Редактировать»', !editVisible);

await openRoom(dave.page, ROOM);
const daveAfterReload = await texts(dave.page);
check('после перезагрузки история группы на месте',
    ['первое в группу', 'второе', 'ответ Боба', 'после удаления первого'].every(t => daveAfterReload.includes(t)),
    JSON.stringify(daveAfterReload));

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));

await browser.close();
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
