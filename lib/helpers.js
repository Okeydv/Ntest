'use strict';

// Мелочи, которые нужны сразу нескольким частям сервера.

const crypto = require('crypto');
const { dbGet } = require('./db');

function getSocketRoomKey(chatId, roomId) {
    return roomId ? `room:${roomId}` : `chat:${chatId}`;
}

function normalizeAvatarColor(value) {
    const color = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : '#667EEA';
}

function getCurrentTime() {
    const now = new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
}

async function generateUniqueCodeAsync() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let attempts = 0; attempts < 100; attempts++) {
        const bytes = crypto.randomBytes(8);
        const code = Array.from(bytes).map(b => chars[b % chars.length]).join('');
        const row = await dbGet('SELECT id FROM users WHERE unique_code = $1', [code]);
        if (!row) return code;
    }
    throw new Error('Could not generate unique code');
}

async function generateAnonymousUsernameAsync() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempts = 0; attempts < 100; attempts++) {
        const bytes = crypto.randomBytes(5);
        const suffix = Array.from(bytes).map(b => chars[b % chars.length]).join('');
        const username = `Гость-${suffix}`;
        const row = await dbGet('SELECT id FROM users WHERE username = $1', [username]);
        if (!row) return username;
    }
    throw new Error('Could not generate anonymous username');
}

function generateInviteCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(6);
    return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

async function generateInviteCodeAsync() {
    for (let attempts = 0; attempts < 100; attempts++) {
        const code = generateInviteCode();
        const row = await dbGet('SELECT id FROM rooms WHERE code = $1', [code]);
        if (!row) return code;
    }
    throw new Error('Could not generate invite code');
}

/*
 * «Chrome, Linux» по User-Agent. Только из этих слов: название, которое
 * прислал бы сам клиент, могло быть любым — хоть «iPhone Ивана».
 */
function deviceLabelFromUa(ua = '') {
    ua = String(ua);
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Браузер';
    const os = /Android/.test(ua) ? 'Android' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad'
        : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${browser}, ${os}` : browser;
}

/*
 * Поля запроса — строки. JSON разрешает прислать вместо строки объект или
 * массив, и проверки вида value.length > 32 такой объект пропускали:
 * у объекта length — undefined, а undefined > 32 — false. undefined и
 * null пропускаются: пустые поля каждый обработчик проверяет сам.
 */
const onlyStrings = (...values) => values.every(v => v === undefined || v === null || typeof v === 'string');
const BAD_FIELDS = { success: false, message: 'Некорректные данные' };

module.exports = {
    onlyStrings, BAD_FIELDS,
    deviceLabelFromUa,
    getSocketRoomKey, normalizeAvatarColor, getCurrentTime,
    generateUniqueCodeAsync, generateAnonymousUsernameAsync, generateInviteCode, generateInviteCodeAsync,
};
