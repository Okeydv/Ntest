'use strict';

/*
 * Личные чаты: код пользователя, запросы на переписку и блокировка.
 *
 * Код пользователя — 12 знаков без похожих (K7Q2MX9A4TZB, показывается
 * группами по 4). Он заменяет прежний восьмизначный unique_code: тот
 * показывался в профиле, но ни для чего не использовался, и был
 * чувствителен к регистру. Новый хранится без дефисов, в верхнем регистре,
 * и выдаётся заново всем — старые коды нигде не действовали.
 *
 * Запрос на переписку — без текста: получатель видит только, кто просит.
 * Блокировка запрещает заблокированному и запросы, и сообщения в личном
 * чате.
 */

const { randomCode } = require('../lib/codes');

async function up(client) {
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS code_requests_enabled BOOLEAN NOT NULL DEFAULT TRUE');

    const { rows } = await client.query("SELECT id FROM users WHERE unique_code !~ '^[A-HJKMNP-Z2-9]{12}$' ORDER BY id");
    const taken = new Set((await client.query('SELECT unique_code FROM users')).rows.map(r => r.unique_code));
    for (const { id } of rows) {
        let code;
        do code = randomCode(); while (taken.has(code));
        taken.add(code);
        await client.query('UPDATE users SET unique_code = $1 WHERE id = $2', [code, id]);
    }

    await client.query(`CREATE TABLE IF NOT EXISTS direct_requests (
        id SERIAL PRIMARY KEY,
        from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        decided_at TIMESTAMPTZ,
        CHECK (from_user_id <> to_user_id)
    )`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS direct_requests_pending
        ON direct_requests(from_user_id, to_user_id) WHERE status = 'pending'`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_direct_requests_to ON direct_requests(to_user_id) WHERE status = \'pending\'');
    await client.query('CREATE INDEX IF NOT EXISTS idx_direct_requests_from_day ON direct_requests(from_user_id, created_at)');

    await client.query(`CREATE TABLE IF NOT EXISTS blocks (
        blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (blocker_id, blocked_id),
        CHECK (blocker_id <> blocked_id)
    )`);
}

module.exports = { up };
