'use strict';

/*
 * Коды, которые люди передают друг другу: ссылка-приглашение в группу и
 * код пользователя. 12 знаков без похожих друг на друга (0/O, 1/I/L) —
 * 60 бит, подбором не найти; продиктовать можно.
 */

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(length = 12) {
    // 31 знак: байты за границей кратного отбрасываются, чтобы знаки
    // выпадали равновероятно.
    const out = [];
    while (out.length < length) {
        for (const b of crypto.randomBytes(16)) {
            if (b < 248 && out.length < length) out.push(ALPHABET[b % 31]);
        }
    }
    return out.join('');
}

// Что угодно из того, что человек мог вставить: сам код, «/join#код»,
// полную ссылку, с пробелами и дефисами, в любом регистре.
function normalizeCode(input) {
    const s = String(input || '');
    const tail = s.includes('#') ? s.slice(s.lastIndexOf('#') + 1) : s;
    return tail.toUpperCase().replace(/[\s-]/g, '');
}

const isCode = code => /^[A-Z0-9]{12}$/.test(code);

// K7Q2-MX9A-4TZB — так код показывается и диктуется.
const formatUserCode = code => String(code).match(/.{1,4}/g).join('-');

module.exports = { randomCode, normalizeCode, isCode, formatUserCode };
