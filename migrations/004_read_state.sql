-- Что участник прочитал и что до него дошло.
--
-- Раньше непрочитанное считалось по messages.sent = 0 и status, а у
-- сообщений собеседников sent = 1 — счётчик был всегда 0, и «прочитано»
-- чужим сообщениям никто не ставил. Теперь у каждой записи чата участника
-- (chats — своя у каждого участника комнаты) хранится id последнего
-- прочитанного и последнего доставленного на его устройства сообщения.
-- Из них считаются и счётчик, и статусы своих сообщений у собеседника.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_read_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_delivered_id INTEGER NOT NULL DEFAULT 0;

-- Можно не сообщать собеседникам, что прочитал. Тогда и сам не видишь,
-- прочитали ли тебя (как в Signal).
ALTER TABLE users ADD COLUMN IF NOT EXISTS send_read_receipts BOOLEAN NOT NULL DEFAULT TRUE;

-- Всё, что уже есть, считаем прочитанным: прежний счётчик всё равно
-- показывал ноль, и вспыхнуть сотнями непрочитанных после обновления —
-- хуже.
UPDATE chats c SET
    last_read_id = COALESCE(t.top, 0),
    last_delivered_id = COALESCE(t.top, 0)
FROM (
    SELECT c2.id, (SELECT max(m.id) FROM messages m
                   WHERE (c2.room_id IS NOT NULL AND m.room_id = c2.room_id)
                      OR (c2.room_id IS NULL AND m.chat_id = c2.id)) AS top
    FROM chats c2
) t
WHERE t.id = c.id;
