'use strict';

/*
 * Аватар пользователя: цвет с буквой ('#RRGGBB') или эмодзи на градиенте
 * ('e:<номер эмодзи>:<номер градиента>'). Набор — public/avatars.json,
 * общий с клиентом; сервер принимает только значения из него. Фото — позже
 * и только зашифрованными.
 */

const path = require('path');
const AVATARS = require(path.join(__dirname, '..', 'public', 'avatars.json'));

function normalizeAvatar(value) {
    const s = String(value || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
    const m = /^e:(\d{1,2}):(\d{1,2})$/.exec(s);
    if (m && Number(m[1]) < AVATARS.emoji.length && Number(m[2]) < AVATARS.gradients.length) return `e:${Number(m[1])}:${Number(m[2])}`;
    return null;
}

module.exports = { AVATARS, normalizeAvatar };
