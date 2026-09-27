-- Срок жизни анонимного аккаунта (lib/anon.js): выбранный при входе
-- вариант и момент последней активности. У созданных раньше варианта нет —
-- для них прежний срок, 4 часа.
ALTER TABLE users ADD COLUMN IF NOT EXISTS anon_lifetime TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_anon_lifetime_check;
ALTER TABLE users ADD CONSTRAINT users_anon_lifetime_check CHECK (anon_lifetime IN ('tab', 'day', 'week'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
