-- Ключи привязываются к устройству, а не к пользователю.
--
-- Зачем: и multi-device, и групповое E2EE на sender keys требуют адресации
-- по устройству. В схеме sender keys групповой ключ раздаётся попарно
-- КАЖДОМУ устройству каждого участника, поэтому per-device identity нужна
-- для групп тоже, а не только ради нескольких устройств у одного человека.
--
-- device_id — это devices.id из схемы Node-приложения. FOREIGN KEY здесь
-- намеренно нет, по той же причине, что и у user_id в 0001_init.sql:
-- сервисы логически развязаны, целостность обеспечивается приложением.
--
-- Значение 0 — маркер «устройство неизвестно». Им заполняются строки,
-- созданные до этой миграции. Клиентского E2EE-модуля не существовало, так
-- что на практике таких строк нет, но миграция обязана быть корректной и
-- при их наличии: иначе ALTER TABLE упадёт на NOT NULL.

ALTER TABLE identity_keys    ADD COLUMN IF NOT EXISTS device_id BIGINT NOT NULL DEFAULT 0;
ALTER TABLE signed_prekeys   ADD COLUMN IF NOT EXISTS device_id BIGINT NOT NULL DEFAULT 0;
ALTER TABLE one_time_prekeys ADD COLUMN IF NOT EXISTS device_id BIGINT NOT NULL DEFAULT 0;

-- DEFAULT снимается сразу же: дальше device_id обязан приходить явно.
-- С дефолтом любой забытый bind тихо писал бы ключи в слот устройства 0.
ALTER TABLE identity_keys    ALTER COLUMN device_id DROP DEFAULT;
ALTER TABLE signed_prekeys   ALTER COLUMN device_id DROP DEFAULT;
ALTER TABLE one_time_prekeys ALTER COLUMN device_id DROP DEFAULT;

-- user_id входил в PRIMARY KEY и получал NOT NULL от него. PK ниже
-- пересобирается, поэтому NOT NULL закрепляется явно.
ALTER TABLE identity_keys  ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE signed_prekeys ALTER COLUMN user_id SET NOT NULL;

-- Одна identity и один signed prekey на УСТРОЙСТВО, а не на пользователя.
ALTER TABLE identity_keys  DROP CONSTRAINT IF EXISTS identity_keys_pkey;
ALTER TABLE identity_keys  ADD PRIMARY KEY (user_id, device_id);

ALTER TABLE signed_prekeys DROP CONSTRAINT IF EXISTS signed_prekeys_pkey;
ALTER TABLE signed_prekeys ADD PRIMARY KEY (user_id, device_id);

-- Пулы one-time prekeys у устройств независимые: key_id уникален внутри
-- устройства, а не внутри аккаунта. Иначе второе устройство не смогло бы
-- нумеровать свои OPK с единицы.
ALTER TABLE one_time_prekeys DROP CONSTRAINT IF EXISTS one_time_prekeys_user_id_key_id_key;
ALTER TABLE one_time_prekeys ADD CONSTRAINT one_time_prekeys_user_device_key_id_key
    UNIQUE (user_id, device_id, key_id);

DROP INDEX IF EXISTS idx_otpk_user;
CREATE INDEX IF NOT EXISTS idx_otpk_user_device ON one_time_prekeys(user_id, device_id);
