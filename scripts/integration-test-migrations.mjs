// Тест миграции created_at у сообщений.
//
//   - база, где колонки ещё нет: старые сообщения получают NULL (настоящей
//     даты у них нет), а не время миграции; новые — момент отправки;
//   - база, где прежняя миграция уже проставила всем старым сообщениям своё
//     время: оно снимается, а у сообщений с настоящим временем остаётся;
//   - починка идёт один раз, повторный запуск ничего не трогает.
//
// Тест сам запускает второй экземпляр server.js (порт 3007) на той же базе:
// миграции идут при старте сервера. Требует поднятых Postgres и сервера на
// 3006 (чтобы схема уже была создана) и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/integration-test-migrations.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };

// Второй экземпляр сервера: ждём строки об окончании инициализации базы.
function startServer() {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            DATABASE_URL: process.env.TEST_DATABASE_URL,
            SESSION_SECRET: 'test-session-secret-at-least-32-chars-long',
            INTERNAL_KEY_SERVER_SECRET: 'test-secret-at-least-32-chars-long-xx',
            KEY_SERVER_URL: 'http://127.0.0.1:7422',
            NODE_ENV: 'development',
            PORT: '3007',
            HOST: '127.0.0.1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error(`сервер не поднялся:\n${log}`)); }, 20000);
        const onData = chunk => {
            log += chunk;
            if (log.includes('База данных инициализирована')) {
                clearTimeout(timer);
                resolve({ stop: () => new Promise(r => { child.once('exit', r); child.kill(); }), log: () => log });
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`сервер вышел с кодом ${code}:\n${log}`)); });
    });
}

// Пользователь и чат, куда складывать «старые» сообщения.
const user = (await db.query(
    `INSERT INTO users (unique_code, username, email, password) VALUES ('MIGRTEST', 'migr', 'migr@example.com', 'x') RETURNING id`)).rows[0].id;
const chat = (await db.query(
    `INSERT INTO chats (user_id, name, avatar) VALUES ($1, 'Старый чат', 'С') RETURNING id`, [user])).rows[0].id;
const insertOld = text => db.query(
    `INSERT INTO messages (chat_id, user_id, text, sent, time, status) VALUES ($1, $2, $3, 1, '09:15', 'read') RETURNING id`,
    [chat, user, text]);

/* ------------------------- колонки ещё нет ------------------------- */

await db.query('ALTER TABLE messages DROP COLUMN created_at');
const old1 = (await insertOld('давнее первое')).rows[0].id;
const old2 = (await insertOld('давнее второе')).rows[0].id;

let server = await startServer();
const oldRows = await db.query('SELECT id, created_at FROM messages WHERE id = ANY($1)', [[old1, old2]]);
check('у старых сообщений нет даты, а не время миграции', oldRows.rows.every(r => r.created_at === null),
    JSON.stringify(oldRows.rows));
const fresh = (await insertOld('новое')).rows[0].id;
const freshRow = (await db.query('SELECT created_at FROM messages WHERE id = $1', [fresh])).rows[0];
check('новое сообщение получает момент отправки', freshRow.created_at instanceof Date
    && Math.abs(Date.now() - freshRow.created_at.getTime()) < 60000);
await server.stop();

/* ------------------------- прежняя миграция уже прошла ------------------------- */

// Так делал прежний ADD COLUMN ... DEFAULT now(): одно время на все старые.
await db.query(`UPDATE messages SET created_at = '2026-03-01T11:03:00Z' WHERE id <> $1`, [fresh]);
await db.query(`UPDATE messages SET created_at = '2026-03-02T08:00:00Z' WHERE id = $1`, [fresh]);
await db.query(`DELETE FROM schema_flags WHERE name = 'messages_created_at_backfill_undone'`);
const stamped = Number((await db.query(`SELECT count(*) FROM messages WHERE created_at = '2026-03-01T11:03:00Z'`)).rows[0].count);

server = await startServer();
const afterRepair = await db.query(`SELECT count(*) FROM messages WHERE created_at = '2026-03-01T11:03:00Z'`);
check('время миграции снято со старых сообщений', Number(afterRepair.rows[0].count) === 0, `было у ${stamped}`);
const keptRow = (await db.query('SELECT created_at FROM messages WHERE id = $1', [fresh])).rows[0];
check('а настоящее время у нового сообщения осталось',
    keptRow.created_at && keptRow.created_at.toISOString() === '2026-03-02T08:00:00.000Z');
await server.stop();

/* ------------------------- один раз ------------------------- */

await db.query(`UPDATE messages SET created_at = '2026-04-01T09:00:00Z' WHERE id = ANY($1)`, [[old1, old2]]);
server = await startServer();
const untouched = await db.query(`SELECT count(*) FROM messages WHERE created_at = '2026-04-01T09:00:00Z'`);
check('повторный запуск ничего не трогает', Number(untouched.rows[0].count) === 2);
await server.stop();

await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
