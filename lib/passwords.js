'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Фиктивный bcrypt-хэш без известного пароля. Используется в /api/login, чтобы
// bcrypt.compare выполнялся ВСЕГДА — и когда юзер найден, и когда нет — с
// одинаковой стоимостью (~100мс), иначе разница во времени ответа позволяет
// перебором узнавать зарегистрированные email.
// bcrypt учитывает только первые 72 байта пароля: у двух паролей с общим
// началом такой длины (а по-русски это 36 букв) хеш один и тот же. Поэтому
// пароль сначала сворачивается SHA-256 (в base64 — без нулевых байтов,
// которые bcrypt тоже обрезает). Такие хеши помечены префиксом; старые, без
// него, проверяются как раньше и при удачном входе пересчитываются.
const PASSWORD_PREFIX = 'sha256-bcrypt$';

const prehashPassword = password => crypto.createHash('sha256').update(String(password), 'utf8').digest('base64');

async function hashPassword(password) {
    return PASSWORD_PREFIX + await bcrypt.hash(prehashPassword(password), 12);
}

async function checkPassword(password, stored) {
    if (stored.startsWith(PASSWORD_PREFIX)) {
        return bcrypt.compare(prehashPassword(password), stored.slice(PASSWORD_PREFIX.length));
    }
    return bcrypt.compare(password, stored);
}

const DUMMY_PASSWORD_HASH = PASSWORD_PREFIX + bcrypt.hashSync(prehashPassword(crypto.randomBytes(32).toString('hex')), 12);

module.exports = { hashPassword, checkPassword, DUMMY_PASSWORD_HASH, PASSWORD_PREFIX };
