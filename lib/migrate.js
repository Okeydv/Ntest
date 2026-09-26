'use strict';

/*
 * Версионные миграции схемы. Раньше initDatabase() на каждом старте
 * прогонял все CREATE TABLE IF NOT EXISTS и ALTER TABLE подряд: схема
 * нигде не имела версии, а ALTER ... ADD CONSTRAINT брали блокировки на
 * больших таблицах при каждом перезапуске.
 *
 * Теперь схема — файлы migrations/NNN_имя.sql (или .js с функцией up).
 * Каждый применяется один раз, в своей транзакции, и записывается в
 * schema_migrations. Упавшая миграция откатывается целиком, сервер не
 * стартует. Два сервера, стартующих разом, не мешают друг другу: миграции
 * идут под advisory-блокировкой.
 *
 * Уже написанную и применённую миграцию не правят — пишут следующую.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
// Номер блокировки — любой постоянный; этот ни с чем в приложении не пересекается.
const LOCK_KEY = 74_201_001;

function listMigrations(dir) {
    const files = fs.readdirSync(dir).filter(f => /^\d{3}_[\w-]+\.(sql|js)$/.test(f)).sort();
    const seen = new Map();
    for (const file of files) {
        const version = parseInt(file, 10);
        if (seen.has(version)) throw new Error(`две миграции с номером ${version}: ${seen.get(version)} и ${file}`);
        seen.set(version, file);
    }
    return [...seen].map(([version, file]) => ({ version, file }));
}

async function migrate(pool, { dir = MIGRATIONS_DIR, log } = {}) {
    const migrations = listMigrations(dir);
    const client = await pool.connect();
    const applied = [];
    try {
        await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
        for (const { version, file } of migrations) {
            if (done.has(version)) continue;
            const fullPath = path.join(dir, file);
            await client.query('BEGIN');
            try {
                if (file.endsWith('.sql')) {
                    await client.query(fs.readFileSync(fullPath, 'utf8'));
                } else {
                    await require(fullPath).up(client, { log });
                }
                await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [version, file]);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                error.message = `миграция ${file}: ${error.message}`;
                throw error;
            }
            applied.push(file);
            if (log) log.info({ migration: file }, 'миграция применена');
        }
        return applied;
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
        client.release();
    }
}

module.exports = { migrate, listMigrations, MIGRATIONS_DIR };
