// Код безопасности (safety number): способ убедиться, что между
// собеседниками никто не встал.
//
// X3DH защищает от чтения на сервере, но только если ключи собеседника
// настоящие. Ключи раздаёт сервер, и при первом контакте он может выдать
// свои — клиент не отличит. Код безопасности закрывает эту дыру: каждая
// сторона считает его по ключам, которые видит сама, и если числа при
// сверке (вживую или по другому каналу) совпали, подмены не было.
//
// Схема та же, что у Signal (NumericFingerprintGenerator): у каждого
// пользователя свой 30-значный отпечаток, код — два отпечатка подряд в
// одинаковом для обеих сторон порядке. Отличие одно: ключи здесь не на
// аккаунт, а на устройство, поэтому отпечаток пользователя строится по
// ключам ВСЕХ его устройств. Новое устройство меняет код — и это не
// побочный эффект, а суть: подсунуть собеседнику лишнее «устройство» —
// самый простой способ для сервера читать переписку.

import { fromB64 } from './e2ee.js';

const subtle = globalThis.crypto.subtle;

// 5200 итераций SHA-512, как у Signal: перебор ключей под совпадающий
// отпечаток должен стоить дорого, а один расчёт — нет (десятки мс).
const ITERATIONS = 5200;
const DOMAIN = new TextEncoder().encode('Nyxo-Fingerprint-v1');

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

function u64(n) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(n));
    return out;
}

/**
 * Ключевой материал пользователя: device_id и оба identity-ключа каждого
 * устройства, по возрастанию device_id. Порядок фиксирован, иначе две
 * стороны получили бы разные отпечатки для одного и того же набора.
 */
function keyMaterial(devices) {
    const sorted = [...devices].sort((a, b) => a.deviceId - b.deviceId);
    return concat(...sorted.flatMap(d => [
        u64(d.deviceId),
        fromB64(d.signingKey),
        fromB64(d.dhKey),
    ]));
}

function chunkToDigits(bytes, offset) {
    // 5 байт = 40 бит, в Number помещается без потерь.
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * 256 + bytes[offset + i];
    return String(value % 100000).padStart(5, '0');
}

/**
 * Отпечаток одного пользователя — 30 цифр.
 *
 * devices: [{ deviceId, signingKey, dhKey }], ключи в base64.
 */
export async function userFingerprint(userId, devices) {
    if (!devices.length) throw new Error('fingerprint: нет ни одного устройства с ключами');
    const material = keyMaterial(devices);
    let hash = new Uint8Array(await subtle.digest('SHA-512',
        concat(DOMAIN, material, new TextEncoder().encode(String(userId)))));
    for (let i = 0; i < ITERATIONS; i++) {
        hash = new Uint8Array(await subtle.digest('SHA-512', concat(hash, material)));
    }
    let digits = '';
    for (let offset = 0; offset < 30; offset += 5) digits += chunkToDigits(hash, offset);
    return digits;
}

/**
 * Код безопасности пары — 60 цифр. Отпечатки идут в лексикографическом
 * порядке, поэтому у обоих собеседников код выглядит одинаково.
 */
export function combineFingerprints(a, b) {
    return a < b ? a + b : b + a;
}

/** 60 цифр → 12 групп по 5, так их удобно читать вслух. */
export function formatSafetyNumber(number) {
    return number.match(/.{5}/g) || [];
}
