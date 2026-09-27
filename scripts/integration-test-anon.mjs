// Срок анонимного аккаунта (lib/anon.js, server.js, routes/auth.js).
//
//   - при входе выбирается срок: «пока открыта вкладка» (30 минут без
//     активности), 1 день, 7 дней; другой — 400; по умолчанию — вкладка;
//   - кука сессии живёт столько же;
//   - любой запрос — активность; открытый сокет — тоже, срок не идёт;
//   - срок проверяется на любом запросе и при подключении сокета: истёк —
//     аккаунт удаляется сразу, запрос получает 401 ANON_EXPIRED, сокеты
//     отключаются;
//   - жёсткий потолок — 7 дней с создания, даже с открытой вкладкой;
//   - уборка по таймеру удаляет тех, кто больше не заходит.
//
// Требует поднятых Postgres, key-server и server.js на 3006 (с
// ANON_SWEEP_INTERVAL_MS=2000) и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/integration-test-anon.mjs

import { io as ioClient } from 'socket.io-client';
import pg from 'pg';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

let nextIp = 1;
function client() {
    const cookies = new Map();
    const ip = `10.34.0.${nextIp++}`;
    const c = {
        ip,
        header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        absorb(r) {
            for (const s of (r.headers.getSetCookie?.() ?? [])) {
                const [pair] = s.split(';');
                const i = pair.indexOf('=');
                cookies.set(pair.slice(0, i), pair.slice(i + 1));
                if (pair.startsWith('connect.sid=')) c.sessionCookie = s;
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
        connect() {
            c.sock = ioClient(BASE, { extraHeaders: { Cookie: c.header(), 'X-Forwarded-For': ip }, transports: ['websocket'], reconnection: false });
            c.disconnected = new Promise(r => c.sock.once('disconnect', () => r(true)));
            return new Promise((resolve, reject) => {
                c.sock.once('connect', resolve);
                c.sock.once('connect_error', reject);
            });
        },
    };
    return c;
}
async function anonymous(lifetime) {
    const c = client();
    const r = await c.req('POST', '/api/register/anonymous', lifetime ? { lifetime } : {});
    if (!r.json?.success) throw new Error(`регистрация: ${r.status} ${JSON.stringify(r.json)}`);
    c.userId = r.json.user.id;
    c.anon = r.json.user.anon;
    return c;
}
const exists = async id => (await db.query('SELECT 1 FROM users WHERE id = $1', [id])).rows.length === 1;
const backdate = (id, column, interval) => db.query(`UPDATE users SET ${column} = now() - $2::interval WHERE id = $1`, [id, interval]);
const cookieDays = c => {
    const m = /Expires=([^;]+)/i.exec(c.sessionCookie || '');
    return m ? (new Date(m[1]) - Date.now()) / 864e5 : null;
};

/* ------------------------- выбор срока ------------------------- */

const bad = await client().req('POST', '/api/register/anonymous', { lifetime: 'forever' });
check('неизвестный срок — 400', bad.status === 400);
const tab = await anonymous();
check('по умолчанию — «пока открыта вкладка», 30 минут', tab.anon.lifetime === 'tab' && tab.anon.idleSeconds === 1800, JSON.stringify(tab.anon));
check('кука — на 30 минут', Math.abs(cookieDays(tab) * 24 * 60 - 30) < 2, String(cookieDays(tab) * 24 * 60));
const week = await anonymous('week');
check('7 дней: кука на 7 дней, потолок — 7 дней от создания', Math.abs(cookieDays(week) - 7) < 0.01
    && Math.abs(new Date(week.anon.deadline) - Date.now() - 7 * 864e5) < 60e3, JSON.stringify(week.anon));
const auth = (await week.req('GET', '/api/auth')).json;
check('/api/auth отдаёт сведения о сроке', auth.user.isAnonymous && auth.user.anon.lifetime === 'week', JSON.stringify(auth.user));

/* ------------------------- активность ------------------------- */

await backdate(tab.userId, 'last_active_at', '10 minutes');
await tab.req('GET', '/api/chats');
const touched = (await db.query('SELECT now() - last_active_at < interval \'1 minute\' AS fresh FROM users WHERE id = $1', [tab.userId])).rows[0];
check('запрос — это активность: отметка обновлена', touched.fresh === true);

// Вкладка открыта (сокет подключён) — срок бездействия не идёт.
await tab.connect();
await backdate(tab.userId, 'last_active_at', '40 minutes');
const alive = await tab.req('GET', '/api/chats');
check('с открытой вкладкой аккаунт жив, хоть запросов давно не было', alive.status === 200 && await exists(tab.userId));

/* ------------------------- срок вышел ------------------------- */

const idle = await anonymous('tab');
await backdate(idle.userId, 'last_active_at', '31 minutes');
const expired = await idle.req('GET', '/api/chats');
check('вкладку закрыли больше 30 минут назад — запрос получает 401 ANON_EXPIRED, аккаунт удалён сразу',
    expired.status === 401 && expired.json?.code === 'ANON_EXPIRED' && !(await exists(idle.userId)), JSON.stringify(expired.json));
check('и сессии больше нет', (await idle.req('GET', '/api/auth')).json.authenticated === false);

// Жёсткий потолок — даже с открытой вкладкой.
await week.connect();
await backdate(week.userId, 'created_at', '7 days 1 minute');
const capped = await week.req('GET', '/api/chats');
check('7 дней с создания — удалён даже с открытой вкладкой, сокет отключён',
    capped.json?.code === 'ANON_EXPIRED' && !(await exists(week.userId))
    && await Promise.race([week.disconnected, sleep(3000).then(() => false)]), JSON.stringify(capped.json));

// Вернулся после срока — проверка при подключении сокета.
const day = await anonymous('day');
await backdate(day.userId, 'last_active_at', '25 hours');
await day.connect().catch(() => {});
check('сокет после срока — аккаунт удалён, сокет отключён',
    await Promise.race([day.disconnected, sleep(3000).then(() => false)]) && !(await exists(day.userId)));

// Больше не заходит — удаляет уборка.
const gone = await anonymous('day');
const stays = await anonymous('day');
await backdate(gone.userId, 'last_active_at', '25 hours');
await backdate(stays.userId, 'last_active_at', '23 hours');
await sleep(3500);
check('уборка удаляет тех, у кого срок вышел, и не трогает остальных', !(await exists(gone.userId)) && await exists(stays.userId));

// Одного дня бездействия мало для недельного.
const weekly = await anonymous('week');
await backdate(weekly.userId, 'last_active_at', '3 days');
check('недельный после 3 дней бездействия жив', (await weekly.req('GET', '/api/chats')).status === 200);

// Зарегистрированный аккаунт срок не проверяет вовсе.
const regular = client();
const reg = await regular.req('POST', '/api/register', { username: 'regular', email: 'regular@example.com', password: 'password123', confirmPassword: 'password123' });
await db.query("UPDATE users SET created_at = now() - interval '30 days' WHERE id = $1", [reg.json.user.id]);
check('обычный аккаунт не трогается', (await regular.req('GET', '/api/chats')).status === 200);

for (const c of [tab, week, day]) c.sock?.close();
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
