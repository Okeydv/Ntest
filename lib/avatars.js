'use strict';

/*
 * Аватар пользователя — цвет с первой буквой имени ('#RRGGBB'). Эмодзи на
 * градиенте были и убраны: старые значения сбрасывает migrations/018. Фото —
 * позже и только зашифрованными.
 */

function normalizeAvatar(value) {
    const s = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : null;
}

module.exports = { normalizeAvatar };
