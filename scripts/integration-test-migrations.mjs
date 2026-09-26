// Тест миграции created_at у сообщений.
//
//   - база, где колонки ещё нет: старые сообщения получают NULL (настоящей
//     даты у них нет), а не время миграции; новые — момент отправки;
//   - база, где прежняя миграция уже проставила всем старым сообщениям своё
//     время: оно снимается, а у сообщений с настоящим временем остаётся;
//   - починка идёт один раз, повторный запуск ничего не трогает;
//   - миграции версионные: каждая записана в schema_migrations один раз;
//     упавшая откатывается целиком; два сервера разом не применяют одну
//     миграцию дважды; одинаковые номера — ошибка;
//   - в production без проверки сертификата базы сервер не запускается.
//
// Тест сам запускает второй экземпляр server.js (порт 3007) на той же базе:
// миграции идут при старте сервера. Требует поднятых Postgres и сервера на
// 3006 (чтобы схема уже была создана) и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/integration-test-migrations.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { migrate, listMigrations } = createRequire(import.meta.url)('../lib/migrate.js');
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

// База из времён до версионных миграций: базовые миграции (001, 002) на
// ней не прогонялись, колонки created_at нет. Базовая доводит её до
// нынешней схемы. Более поздние миграции оставляем записанными: их
// таблицы в тестовой базе уже есть, а в настоящей старой базе не было бы
// и самих миграций.
const forgetBaseline = () => db.query('DELETE FROM schema_migrations WHERE version <= 2');
await db.query('ALTER TABLE messages DROP COLUMN created_at');
await forgetBaseline();
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
await forgetBaseline();
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

/* ------------------------- версии схемы ------------------------- */

const versions = (await db.query('SELECT version, name FROM schema_migrations ORDER BY version')).rows;
const files = listMigrations(path.join(ROOT, 'migrations'));
check('в schema_migrations записаны все миграции, по разу',
    JSON.stringify(versions.map(v => [v.version, v.name])) === JSON.stringify(files.map(f => [f.version, f.file])),
    JSON.stringify(versions));

// Сам механизм — на отдельной схеме и своих файлах.
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxo-migr-'));
fs.writeFileSync(path.join(probeDir, '001_first.sql'), 'CREATE TABLE probe_a (id int);');
fs.writeFileSync(path.join(probeDir, '002_broken.sql'), 'CREATE TABLE probe_b (id int);\nSELECT * FROM no_such_table;');
await db.query('DROP SCHEMA IF EXISTS migr_probe CASCADE; CREATE SCHEMA migr_probe');
const probe = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path=migr_probe' });
const tables = async () => (await probe.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'migr_probe' ORDER BY 1")).rows.map(r => r.table_name);
const failure = await migrate(probe, { dir: probeDir }).then(() => null, e => e.message);
const recorded = async () => (await probe.query('SELECT version FROM schema_migrations ORDER BY 1')).rows.map(r => r.version);
check('упавшая миграция откатывается целиком и не записывается',
    /002_broken\.sql/.test(failure || '') && JSON.stringify(await tables()) === '["probe_a","schema_migrations"]'
    && JSON.stringify(await recorded()) === '[1]', `${failure}; ${JSON.stringify(await tables())}`);

fs.writeFileSync(path.join(probeDir, '002_broken.sql'), 'CREATE TABLE probe_b (id int);');
fs.writeFileSync(path.join(probeDir, '003_third.sql'), 'CREATE TABLE probe_c (id int);');
const [one, two] = await Promise.all([migrate(probe, { dir: probeDir }), migrate(probe, { dir: probeDir })]);
check('два сервера, стартующие разом, применяют каждую миграцию один раз',
    JSON.stringify([...one, ...two].sort()) === '["002_broken.sql","003_third.sql"]'
    && JSON.stringify(await recorded()) === '[1,2,3]', JSON.stringify({ one, two }));

fs.writeFileSync(path.join(probeDir, '003_again.sql'), 'SELECT 1;');
check('два файла с одним номером — ошибка, а не выбор наугад',
    /номером 3/.test(await migrate(probe, { dir: probeDir }).then(() => '', e => e.message)));
await probe.end();
await db.query('DROP SCHEMA migr_probe CASCADE');
fs.rmSync(probeDir, { recursive: true, force: true });

/* ------------------------- production без проверки TLS ------------------------- */

// Без DB_CA_CERT и без явного DB_SSL=disable production не запускается:
// TLS без проверки сертификата только выглядит защищённым.
const prod = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: process.env.TEST_DATABASE_URL, PORT: '3008',
        SESSION_SECRET: 'test-session-secret-at-least-32-chars-long', DB_CA_CERT: '', DB_SSL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let prodLog = '';
prod.stdout.on('data', d => { prodLog += d; });
prod.stderr.on('data', d => { prodLog += d; });
const prodCode = await new Promise(resolve => {
    const timer = setTimeout(() => { prod.kill(); resolve('не вышел'); }, 15000);
    prod.once('exit', code => { clearTimeout(timer); resolve(code); });
});
check('production без DB_CA_CERT и DB_SSL=disable не запускается', prodCode === 1 && /DB_CA_CERT/.test(prodLog),
    `код ${prodCode}`);

await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
