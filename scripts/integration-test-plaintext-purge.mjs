// Чистка старого открытого текста в комнатах (migrations/009,
// lib/plaintext-purge.js).
//
//   - миграция считает открытые сообщения в комнатах (кроме системных строк
//     и чата с ботом) и назначает срок; сама ничего не стирает;
//   - до срока история отдаёт срок, и в чате видна плашка «сохраните нужное»;
//   - после срока текст и ссылки на файлы стёрты, файл удалён с диска,
//     сообщения помечены удалёнными, участникам ушёл messageDeleted;
//     системные строки и чат с ботом не тронуты;
//   - срок задаёт PLAINTEXT_PURGE_DAYS (0 — сразу), кривое значение — ошибка;
//   - у новых участников комнаты записывается время входа (joined_at).
//
// Требует поднятых Postgres, key-server и server.js на 3006, запущенного с
// PLAINTEXT_PURGE_INTERVAL_MS=2000, и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/integration-test-plaintext-purge.mjs

import { io as ioClient } from 'socket.io-client';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launch, finish } from './lib/browser.mjs';

const require = createRequire(import.meta.url);
const migration = require('../migrations/009_plaintext_purge.js');

const BASE = 'http://127.0.0.1:3006';
const UPLOADS = path.resolve('uploads');
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

let nextIp = 1;
function client() {
    const cookies = new Map();
    const ip = `10.31.0.${nextIp++}`;
    const c = {
        header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        absorb(r) {
            for (const s of (r.headers.getSetCookie?.() ?? [])) {
                const [pair] = s.split(';');
                const i = pair.indexOf('=');
                cookies.set(pair.slice(0, i), pair.slice(i + 1));
            }
        },
        async req(method, url, body) {
            if (!cookies.has('csrf_token')) c.absorb(await fetch(BASE + '/', { headers: { 'X-Forwarded-For': ip } }));
            const r = await fetch(BASE + url, { method,
                headers: { Cookie: c.header(), 'X-CSRF-Token': cookies.get('csrf_token'), 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
                body: body === undefined ? undefined : JSON.stringify(body) });
            c.absorb(r);
            let json = null;
            try { json = await r.json(); } catch { /* не JSON */ }
            return { status: r.status, json };
        },
    };
    return c;
}
async function register(name) {
    const c = client();
    const r = await c.req('POST', '/api/register', { username: name, email: `${name}@example.com`, password: 'password123', confirmPassword: 'password123' });
    c.userId = r.json.user.id;
    return c;
}

const alice = await register('alice');
const bob = await register('bob');
const created = await alice.req('POST', '/api/chats', { name: 'Давний' });
const chatId = created.json.chat.id;
const roomId = created.json.chat.room_id;
const code = (await alice.req('POST', `/api/chats/${chatId}/link`, { requireApproval: false })).json.code;
await bob.req('POST', '/api/chats/join', { code });

/* ------------------------- время входа ------------------------- */

const joined = (await db.query('SELECT user_id, joined_at FROM room_participants WHERE room_id = $1 ORDER BY id', [roomId])).rows;
check('у участников записано время входа', joined.length === 2 && joined.every(r => r.joined_at instanceof Date
    && Math.abs(Date.now() - r.joined_at.getTime()) < 60000), JSON.stringify(joined));

/* ------------------------- старые данные ------------------------- */

// Так выглядела комната до обязательного шифрования.
const fileName = `${Date.now()}-deadbeef00.txt`;
fs.writeFileSync(path.join(UPLOADS, fileName), 'старый файл');
const insert = (text, extra = {}) => db.query(
    `INSERT INTO messages (chat_id, room_id, user_id, text, message_type, sent, time, status, file_url, file_name)
     VALUES ($1, $2, $3, $4, $5, 1, '00:00', 'sent', $6, $7) RETURNING id`,
    [extra.chatId ?? chatId, extra.roomId === undefined ? roomId : extra.roomId, alice.userId, text,
        extra.type || 'text', extra.fileUrl || null, extra.fileName || null]).then(r => r.rows[0].id);
const oldText = await insert('старый секрет');
const oldFile = await insert('', { type: 'file', fileUrl: `/uploads/${fileName}`, fileName: 'note.txt' });
const systemLine = await insert('alice изменил(а) название', { type: 'system' });
const botChat = (await alice.req('GET', '/api/chats')).json.chats.find(c => c.is_bot).id;
const botLine = await insert('боту можно', { chatId: botChat, roomId: null });
await db.query("INSERT INTO message_expiry (message_id, expires_at) VALUES ($1, now() + interval '1 day')", [oldText]);

/* ------------------------- миграция ------------------------- */

check('PLAINTEXT_PURGE_DAYS: по умолчанию 14, 0 — сразу, кривое — ошибка',
    migration.purgeDays({}) === 14 && migration.purgeDays({ PLAINTEXT_PURGE_DAYS: '0' }) === 0
    && (() => { try { migration.purgeDays({ PLAINTEXT_PURGE_DAYS: 'завтра' }); return false; } catch { return true; } })());
const conn = await db.connect();
await migration.up(conn, { days: 14 });
conn.release();
const [row] = (await db.query('SELECT * FROM plaintext_purge WHERE room_id = $1', [roomId])).rows;
const daysLeft = row ? (row.purge_after - Date.now()) / 86400000 : 0;
check('миграция посчитала открытые сообщения комнаты (без системной строки)',
    row && row.message_count === 2 && row.file_count === 1 && row.up_to_message_id === oldFile, JSON.stringify(row));
check('и назначила срок — 14 дней', Math.abs(daysLeft - 14) < 0.01, String(daysLeft));
check('сама миграция ничего не стёрла',
    (await db.query('SELECT text FROM messages WHERE id = $1', [oldText])).rows[0].text === 'старый секрет'
    && fs.existsSync(path.join(UPLOADS, fileName)));
check('чат с ботом под чистку не попал',
    (await db.query('SELECT count(*) FROM plaintext_purge WHERE room_id IS NULL')).rows[0].count === '0');

/* ------------------------- плашка ------------------------- */

const history = (await alice.req('GET', `/api/messages/${chatId}`)).json;
check('история отдаёт срок чистки', history.plaintextPurge?.count === 2 && Boolean(history.plaintextPurge?.purgeAfter),
    JSON.stringify(history.plaintextPurge));
const botHistory = (await alice.req('GET', `/api/messages/${botChat}`)).json;
check('в чате с ботом — нет', !botHistory.plaintextPurge, JSON.stringify(botHistory.plaintextPurge));

const browser = await launch();
const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '10.31.1.1' } });
const page = await context.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(async () => {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
});
await page.locator('.chat-item[data-room-id]:not([data-room-id=""])').first().click();
await page.waitForTimeout(1200);
const notice = await page.evaluate(() => {
    const box = document.getElementById('plaintext-notice');
    return box.hidden ? null : box.textContent;
});
check('в чате плашка: сколько, когда и «сохраните нужное»',
    /Здесь 2 старых сообщения без шифрования/.test(notice || '') && /сохраните нужное/.test(notice || ''), notice);

/* ------------------------- срок вышел ------------------------- */

const sock = ioClient(BASE, { extraHeaders: { Cookie: bob.header() }, transports: ['websocket'], reconnection: false });
const deleted = [];
sock.on('messageDeleted', m => deleted.push(m.id));
await new Promise(r => sock.once('connect', r));
sock.emit('joinChat', `room:${roomId}`);
await sleep(300);
await db.query("UPDATE plaintext_purge SET purge_after = now() - interval '1 second' WHERE room_id = $1", [roomId]);
await sleep(4500);
sock.close();
const rows = Object.fromEntries((await db.query('SELECT id, deleted, text, file_url, file_name FROM messages WHERE id = ANY($1::int[])',
    [[oldText, oldFile, systemLine, botLine]])).rows.map(r => [r.id, r]));
check('старый текст стёрт и помечен удалённым', rows[oldText].deleted === 1 && rows[oldText].text === null, JSON.stringify(rows[oldText]));
check('у файла стёрты ссылка и имя', rows[oldFile].deleted === 1 && rows[oldFile].file_url === null && rows[oldFile].file_name === null,
    JSON.stringify(rows[oldFile]));
check('и сам файл удалён с диска', !fs.existsSync(path.join(UPLOADS, fileName)));
check('срок исчезания тоже убран',
    (await db.query('SELECT count(*) FROM message_expiry WHERE message_id = $1', [oldText])).rows[0].count === '0');
check('системная строка и чат с ботом не тронуты', rows[systemLine].deleted === 0 && rows[systemLine].text !== null
    && rows[botLine].deleted === 0 && rows[botLine].text === 'боту можно');
check('участникам ушёл messageDeleted', deleted.includes(oldText) && deleted.includes(oldFile), JSON.stringify(deleted));
check('запись о чистке снята, плашки больше нет',
    (await db.query('SELECT count(*) FROM plaintext_purge WHERE room_id = $1', [roomId])).rows[0].count === '0'
    && !(await alice.req('GET', `/api/messages/${chatId}`)).json.plaintextPurge);

await finish(browser, fails);
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
