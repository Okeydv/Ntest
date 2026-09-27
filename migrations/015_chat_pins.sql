-- Закрепление, «Без звука» и архив — у записи чата, то есть у каждого
-- участника свои и одни на всех его устройствах.
--
-- pin_position — место среди закреплённых (1, 2, …), NULL — не закреплён.
-- Закреплённые идут сверху в этом порядке, остальные — по последнему
-- сообщению. Не больше пяти и без дыр в порядке — следит сервер
-- (routes/chats.js), изменения одного пользователя идут по очереди.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS pin_position INTEGER;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
