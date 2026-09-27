-- Статус «в сети»: когда пользователь был в сети последний раз (момент,
-- когда закрылся его последний сокет) и скрывает ли он это. Кто скрывает,
-- тот и сам не видит чужой статус — как в Telegram.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_presence BOOLEAN NOT NULL DEFAULT FALSE;
