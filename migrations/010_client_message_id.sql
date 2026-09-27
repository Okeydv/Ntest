-- id сообщения, который назначает клиент. Если ответ на отправку потерялся
-- (сеть оборвалась, человек нажал «Повторить»), повтор приходит с тем же
-- id, и сервер отдаёт уже сохранённое сообщение вместо второго такого же.
-- Уникальность — в пределах пользователя: id случайный (128 бит), так что
-- это не слабее пары «устройство + id», а открытый путь (бот) идёт и без
-- устройства.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS messages_user_client_id ON messages (user_id, client_id) WHERE client_id IS NOT NULL;
