-- Таблица сессий. Раньше её заводил connect-pg-simple при первом входе, а
-- уборщик анонимных аккаунтов (routes/auth.js) заглядывает в неё с первых
-- секунд — на свежей базе он падал с «relation "session" does not exist».
-- Схема — как у connect-pg-simple (node_modules/connect-pg-simple/table.sql);
-- если таблица уже есть, ничего не меняется.
CREATE TABLE IF NOT EXISTS "session" (
    "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
    "sess" json NOT NULL,
    "expire" timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
