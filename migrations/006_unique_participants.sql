-- Участник комнаты — один раз. Вход по коду шёл не в транзакции, и
-- двойное нажатие могло записать участника дважды (и завести ему две
-- записи чата). Дубли убираются, дальше их не даёт уникальный индекс.
DELETE FROM room_participants a
USING room_participants b
WHERE a.room_id = b.room_id AND a.user_id = b.user_id AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS room_participants_room_user ON room_participants(room_id, user_id);

-- Лишние записи чата той же комнаты у того же пользователя: остаётся
-- самая ранняя. Сообщения на удаляемую запись теряют chat_id (ON DELETE
-- SET NULL) — в комнате их всё равно находят по room_id.
DELETE FROM chats a
USING chats b
WHERE a.room_id IS NOT NULL AND a.room_id = b.room_id AND a.user_id = b.user_id AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS chats_user_room ON chats(user_id, room_id) WHERE room_id IS NOT NULL;
