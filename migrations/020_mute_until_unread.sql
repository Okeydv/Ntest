-- «Без звука» на время: muted_until — до какого момента; NULL при muted —
-- навсегда. «Отметить непрочитанным» — отдельный флаг, а не сдвиг
-- last_read_id назад: иначе собеседники увидели бы, что их сообщение снова
-- «не прочитано». Снимается любой отметкой «прочитано» и открытием чата.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS marked_unread BOOLEAN NOT NULL DEFAULT FALSE;
