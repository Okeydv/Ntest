-- Исходная схема: всё, что до появления версионных миграций делал
-- initDatabase() на каждом старте сервера.
--
-- Все команды идемпотентны. Новая база получает здесь схему целиком, а
-- старая — созданная ещё без миграций, возможно, без части колонок и с
-- прежними внешними ключами — доводится до того же состояния. Дальше
-- схема меняется только новыми файлами в этой папке.

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    unique_code TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    password TEXT,
    avatar TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rooms (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chats (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    room_id INTEGER REFERENCES rooms(id),
    name TEXT NOT NULL,
    avatar TEXT NOT NULL,
    online INTEGER DEFAULT 0,
    is_bot INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id),
    room_id INTEGER REFERENCES rooms(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    file_url TEXT,
    file_name TEXT,
    file_type TEXT,
    message_type TEXT DEFAULT 'text',
    sent INTEGER DEFAULT 1,
    time TEXT NOT NULL,
    status TEXT DEFAULT 'sent',
    edited_at TEXT,
    deleted INTEGER DEFAULT 0,
    reply_to_id INTEGER REFERENCES messages(id)
);

CREATE TABLE IF NOT EXISTS unread (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS room_participants (
    id SERIAL PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    user_id INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS reactions (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    UNIQUE(message_id, user_id, emoji)
);

-- Реестр устройств. Ключи E2EE привязаны к устройству, а не к аккаунту
-- (см. e2ee-key-server/migrations/0002_device_scoped_keys.sql), поэтому
-- серверу нужен список: без него неизвестно, кому раздавать ключи и что
-- отзывать. revoked_at, а не DELETE: id устройства встречается в
-- ключевом материале, переиспользовать его нельзя.
CREATE TABLE IF NOT EXISTS devices (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id) WHERE revoked_at IS NULL;

-- Конверты сообщений: под E2EE одно сообщение превращается в N
-- шифротекстов, по одному на каждое устройство каждого получателя.
--
-- Строка messages при этом остаётся и хранит только метаданные (кто, в
-- каком чате, когда, на что отвечает) — на messages(id) висят внешние
-- ключи из message_expiry, reactions и messages.reply_to_id, и делать
-- конверт единственной записью означало бы переделать все три без
-- выигрыша в приватности: метаданные всё равно видны серверу.
--
-- header лежит BYTEA, а не JSONB, намеренно: он используется как AAD
-- при AES-GCM, то есть должен вернуться байт в байт. JSONB нормализует
-- ключи и порядок полей, после чего проверка AAD развалилась бы.
-- Сервер внутрь не смотрит, он только переносит.
CREATE TABLE IF NOT EXISTS message_envelopes (
    id BIGSERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    recipient_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    sender_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    envelope_type SMALLINT NOT NULL,
    header BYTEA NOT NULL,
    ciphertext BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, recipient_device_id)
);
CREATE INDEX IF NOT EXISTS idx_envelopes_recipient ON message_envelopes(recipient_device_id, message_id);

-- Зашифрованные вложения. Сервер хранит непрозрачные байты: файл
-- шифруется на клиенте своим ключом, а ключ едет внутри E2EE-сообщения.
-- Ни имени, ни типа, ни содержимого сервер не знает — только размер.
--
-- message_id заполняется при отправке сообщения; до этого вложение
-- принадлежит только загрузившему, и если сообщение так и не ушло,
-- уборщик удалит его через час.
CREATE TABLE IF NOT EXISTS encrypted_blobs (
    id TEXT PRIMARY KEY,
    uploader_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    size INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_blobs_message ON encrypted_blobs(message_id);

-- Групповые сообщения (sender keys): один шифротекст на всех получателей
-- вместо конверта на каждое устройство. header — BYTEA по той же
-- причине, что у конвертов: он идёт в AAD и возвращается байт в байт.
CREATE TABLE IF NOT EXISTS message_group_payloads (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    header BYTEA NOT NULL,
    ciphertext BYTEA NOT NULL,
    signature BYTEA NOT NULL
);

-- Раздача sender key: попарно зашифрованное состояние цепочки
-- отправителя, по конверту на каждое устройство группы.
--
-- Отдельная таблица, а не конверт при сообщении, намеренно. Если бы ключ
-- ехал внутри сообщения, удаление этого сообщения (или таймер исчезающих)
-- забирало бы ключ с собой, и устройство, которое было офлайн, не
-- прочитало бы уже ничего из дальнейшей переписки. Здесь конверт живёт,
-- пока его не заберёт получатель (подтверждение), не уйдёт он из группы
-- или не будет отозвано его устройство.
CREATE TABLE IF NOT EXISTS sender_key_envelopes (
    id BIGSERIAL PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    sender_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    recipient_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    envelope_type SMALLINT NOT NULL,
    header BYTEA NOT NULL,
    ciphertext BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sender_key_envelopes_recipient
    ON sender_key_envelopes(recipient_device_id, room_id, id);

-- Текст больше не обязателен: у зашифрованного сообщения его нет вовсе,
-- содержимое живёт в конвертах.
ALTER TABLE messages ALTER COLUMN text DROP NOT NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL;

-- Системные сообщения — без автора (см. postSystemMessage в server.js).
ALTER TABLE messages ALTER COLUMN user_id DROP NOT NULL;
UPDATE messages SET user_id = NULL WHERE message_type = 'system' AND user_id IS NOT NULL;

-- Приглашение можно отключить — тогда кода нет вовсе (UNIQUE допускает
-- сколько угодно NULL).
ALTER TABLE rooms ALTER COLUMN code DROP NOT NULL;

-- Момент отправки с часовым поясом. Колонка time — строка «ЧЧ:ММ» в поясе
-- СЕРВЕРА: у собеседника в другом поясе время было неверным, а дня не
-- было вовсе. Форматирует теперь клиент, в своём поясе.
--
-- Колонка добавляется БЕЗ значения по умолчанию, и только потом ей
-- ставится DEFAULT now(): ADD COLUMN ... DEFAULT now() записал бы всем
-- старым сообщениям время самой миграции — вся прежняя история
-- оказалась бы отправленной «сегодня в 14:03». Настоящей даты у старых
-- сообщений нет (была только строка «ЧЧ:ММ»), поэтому у них NULL, и
-- клиент показывает прежнюю строку без дня.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE messages ALTER COLUMN created_at DROP NOT NULL;
ALTER TABLE messages ALTER COLUMN created_at SET DEFAULT now();

-- Одноразовые починки данных до появления миграций отмечались здесь.
CREATE TABLE IF NOT EXISTS schema_flags (
    name TEXT PRIMARY KEY,
    done_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Если таблицы chats/messages были созданы ДО появления комнат,
-- CREATE TABLE IF NOT EXISTS их не тронет и колонки room_id не будет.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS room_id INTEGER REFERENCES rooms(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS room_id INTEGER REFERENCES rooms(id);

-- Удаление чата/выход из комнаты падало с нарушением FK — messages.chat_id
-- (NOT NULL, без ON DELETE) не давал снести свою же запись в chats, если
-- пользователь уже что-то написал, а chats.room_id не давал снести саму
-- комнату. chat_id уходит в NULL (история комнаты остаётся видна
-- остальным по room_id), осиротевшие chats удаляются вместе с room.
ALTER TABLE messages ALTER COLUMN chat_id DROP NOT NULL;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_chat_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL;
ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_room_id_fkey;
ALTER TABLE chats ADD CONSTRAINT chats_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;

-- Реакции исчезают вместе со своим сообщением.
ALTER TABLE reactions DROP CONSTRAINT IF EXISTS reactions_message_id_fkey;
ALTER TABLE reactions ADD CONSTRAINT reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
-- Ответ на удалённое сообщение просто теряет связь с оригиналом.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_reply_to_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON DELETE SET NULL;
-- Остальное удаляется в правильном порядке приложением (DELETE
-- /api/chats/:chatId), каскад — страховка на случай ошибки в этом порядке.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_room_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;
ALTER TABLE unread DROP CONSTRAINT IF EXISTS unread_chat_id_fkey;
ALTER TABLE unread ADD CONSTRAINT unread_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE;
ALTER TABLE room_participants DROP CONSTRAINT IF EXISTS room_participants_room_id_fkey;
ALTER TABLE room_participants ADD CONSTRAINT room_participants_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats(user_id);
CREATE INDEX IF NOT EXISTS idx_reactions_msg_user ON reactions(message_id, user_id);

-- Анонимные аккаунты без почты и пароля.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password DROP NOT NULL;

-- Исчезающие сообщения. Срок — TIMESTAMPTZ: было TIMESTAMP без пояса, а
-- срок приходил из JS Date, и при разных поясах у Node и базы сообщения
-- исчезали на несколько часов раньше или позже.
CREATE TABLE IF NOT EXISTS message_expiry (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    auto_delete_on_read BOOLEAN DEFAULT FALSE
);
ALTER TABLE message_expiry ALTER COLUMN expires_at TYPE TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_message_expiry_expires_at ON message_expiry(expires_at);

CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    default_message_expiry INTEGER
);
