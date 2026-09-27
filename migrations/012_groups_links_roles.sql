-- Группы, роли, ссылки-приглашения и запросы на вход.
--
-- Вид комнаты: группа (общее название, роли, ссылки) или личный чат на
-- двоих (название — имя собеседника). Все старые комнаты — группы: чем
-- они были на самом деле, по данным не понять, а группа ничего не ломает.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'group';
ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_kind_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_kind_check CHECK (kind IN ('group', 'direct'));

-- Роль участника. Администратором становится первый участник по порядку
-- записи — обычно это создатель: он записывался при создании комнаты.
ALTER TABLE room_participants ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE room_participants DROP CONSTRAINT IF EXISTS room_participants_role_check;
ALTER TABLE room_participants ADD CONSTRAINT room_participants_role_check CHECK (role IN ('admin', 'member'));
UPDATE room_participants rp SET role = 'admin'
WHERE rp.id = (SELECT min(o.id) FROM room_participants o WHERE o.room_id = rp.room_id)
  AND NOT EXISTS (SELECT 1 FROM room_participants a WHERE a.room_id = rp.room_id AND a.role = 'admin');

-- Старые шестизначные коды отключаются: их легко подобрать, срока у них
-- нет, и впускали они без спроса. Новую ссылку администратор создаёт
-- кнопкой.
UPDATE rooms SET code = NULL WHERE code IS NOT NULL;

-- У группы одно название на всех. Раньше у каждого участника была своя
-- подпись («Чат с Анной»); теперь все видят имя комнаты.
UPDATE chats c SET name = r.name, avatar = upper(left(r.name, 1))
FROM rooms r WHERE c.room_id = r.id AND r.kind = 'group' AND c.name IS DISTINCT FROM r.name;

-- Ссылка-приглашение. token — 12 знаков после /join#; у комнаты не больше
-- одной действующей ссылки: «Сменить ссылку» отзывает прежнюю.
CREATE TABLE IF NOT EXISTS invite_links (
    id SERIAL PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ,
    member_limit INTEGER,
    require_approval BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS invite_links_active_room ON invite_links(room_id) WHERE revoked_at IS NULL;

-- Запрос на вход по ссылке с одобрением. Ждущий запрос у человека в
-- комнате — один: повторный переход по ссылке его не множит.
CREATE TABLE IF NOT EXISTS join_requests (
    id SERIAL PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    link_id INTEGER REFERENCES invite_links(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS join_requests_pending ON join_requests(room_id, user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_join_requests_user ON join_requests(user_id);
