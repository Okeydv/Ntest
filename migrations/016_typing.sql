-- «Показывать, что я печатаю»: выключивший не рассылает событие typing
-- (lib/sockets.js). По умолчанию включено.
ALTER TABLE users ADD COLUMN IF NOT EXISTS send_typing BOOLEAN NOT NULL DEFAULT TRUE;
