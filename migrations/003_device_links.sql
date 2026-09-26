-- Привязка нового устройства по QR-коду со старого (routes/link.js).
--
-- Новый браузер показывает одноразовый код, устройство, где уже вошли,
-- подтверждает его. Код в базе — только SHA-256: утечка таблицы не даёт
-- подтвердить чужую привязку. Забрать вход может только сессия, которая
-- привязку начала (session_id), так что подсмотреть код мало.
CREATE TABLE IF NOT EXISTS device_links (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    label TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    approved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_device_links_expires ON device_links(expires_at);
