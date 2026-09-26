-- Базам, где прежний ADD COLUMN created_at ... DEFAULT now() уже прошёл,
-- возвращаем NULL тем старым сообщениям, кому он проставил своё время.
-- Их легко узнать: now() в одной команде одно на все строки, так что у них
-- одинаковое и самое раннее значение, а обычные сообщения вставляются по
-- одному и так не совпадают.
--
-- До миграций эта починка шла при старте и отмечалась флагом в
-- schema_flags; где флаг уже стоит, её не повторяем.
WITH first AS (SELECT min(created_at) AS t FROM messages)
UPDATE messages SET created_at = NULL
WHERE NOT EXISTS (SELECT 1 FROM schema_flags WHERE name = 'messages_created_at_backfill_undone')
  AND created_at = (SELECT t FROM first)
  AND (SELECT count(*) FROM messages WHERE created_at = (SELECT t FROM first)) > 1;

INSERT INTO schema_flags (name) VALUES ('messages_created_at_backfill_undone') ON CONFLICT DO NOTHING;
