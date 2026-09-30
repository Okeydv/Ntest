-- Web Push (lib/push.js). Подписка — адрес службы уведомлений браузера
-- (Google, Apple, Mozilla, Microsoft). Сервер шлёт туда пустой push без
-- текста и без номера чата: служба узнаёт только «этому устройству что-то
-- пришло». Ключи p256dh и auth не хранятся — они нужны лишь для
-- шифрования содержимого, а содержимого нет.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_push_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);

-- Постоянные настройки сервера. Здесь — ключи VAPID, если их не задали
-- переменными окружения: браузер привязывает подписку к публичному ключу,
-- и новый ключ на каждом старте сделал бы все подписки недействительными.
CREATE TABLE IF NOT EXISTS server_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
