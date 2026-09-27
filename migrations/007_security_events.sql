-- Журнал событий безопасности аккаунта: входы, неверные пароли, смена
-- пароля, устройства, вход по QR. Человек видит его в профиле и замечает
-- чужое. Адресов здесь нет — только какой браузер (по User-Agent) и когда.
-- Старше 90 дней записи удаляются.
CREATE TABLE IF NOT EXISTS security_events (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, created_at DESC);
