// Групповое шифрование: sender keys.
//
// Попарная схема (e2ee.js) шифрует каждое сообщение отдельно под каждое
// устройство каждого участника: в группе из 10 человек по 3 устройства это
// 29 шифрований и 29 конвертов на одно «привет». Sender keys, как в Signal
// и Megolm, делают так:
//
//   - у каждого отправляющего устройства в каждой группе свой sender key:
//     цепочка ключей (chain key) и пара Ed25519 для подписи;
//   - текущее состояние цепочки один раз раздаётся всем устройствам группы
//     обычными попарными E2EE-сообщениями (distribution);
//   - дальше каждое сообщение шифруется ОДИН раз ключом из цепочки, и
//     все получатели расшифровывают один и тот же шифротекст.
//
// Цепочка проворачивается на каждом сообщении (HMAC, как симметричная
// часть Double Ratchet), поэтому новый участник, получивший состояние
// цепочки сейчас, не может расшифровать то, что было до него, — это и есть
// «на новом устройстве истории нет».
//
// Чего у sender keys нет по сравнению с попарной схемой: DH-рэтчета. Утёкшее
// состояние цепочки открывает все последующие сообщения до смены ключа.
// Поэтому ключ меняется при любом уходе из группы, а ещё — по возрасту и
// числу сообщений (см. client.js).
//
// Подпись нужна потому, что цепочку знают ВСЕ участники: без неё любой из
// них мог бы зашифровать сообщение от чужого имени.

import { toB64, fromB64 } from './e2ee.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const GROUP_VERSION = 1;
const DIST_LEN = 16;
const CHAIN_LEN = 32;
const PUBKEY_LEN = 32;
const SIGNATURE_LEN = 64;
// Заголовок: версия (1) + id распространения (16) + номер в цепочке (4).
// Фиксированный бинарный формат, а не JSON: он идёт в AAD и обязан быть
// байт в байт одинаковым у всех.
export const GROUP_HEADER_LEN = 1 + DIST_LEN + 4;

// Те же соображения, что в e2ee.js: номер в заголовке задаёт отправитель,
// и без предела сообщение с номером 4 млрд заставило бы вывести 4 млрд
// ключей.
const MAX_SKIP = 2000;
const MAX_STORED_SKIPPED = 2000;
const MAX_ITERATION = 0xffffffff;

const MSG_INFO = enc.encode('Nyxo-SenderKey-Msg-v1');
const ZERO_SALT = new Uint8Array(32);

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

async function hmac(keyBytes, data) {
    const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await subtle.sign('HMAC', key, data));
}

/** Один шаг цепочки: seed ключа сообщения и следующий chain key. */
async function chainStep(chainKey) {
    return {
        seed: await hmac(chainKey, new Uint8Array([1])),
        next: await hmac(chainKey, new Uint8Array([2])),
    };
}

/**
 * Ключ AES-GCM и IV из seed. IV детерминированный: каждый seed
 * используется ровно один раз, поэтому пара (ключ, IV) не повторяется.
 */
async function messageKeys(seed) {
    const ikm = await subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits']);
    const bits = new Uint8Array(await subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: ZERO_SALT, info: MSG_INFO }, ikm, 44 * 8));
    return {
        key: await subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
        iv: bits.slice(32, 44),
    };
}

function serializeHeader(distributionId, iteration) {
    const out = new Uint8Array(GROUP_HEADER_LEN);
    out[0] = GROUP_VERSION;
    out.set(distributionId, 1);
    new DataView(out.buffer).setUint32(1 + DIST_LEN, iteration);
    return out;
}

export function parseGroupHeader(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== GROUP_HEADER_LEN) {
        throw new Error('групповой заголовок: неверная длина');
    }
    if (bytes[0] !== GROUP_VERSION) throw new Error(`групповой заголовок: версия ${bytes[0]} не поддерживается`);
    return {
        distributionId: bytes.slice(1, 1 + DIST_LEN),
        iteration: new DataView(bytes.buffer, bytes.byteOffset).getUint32(1 + DIST_LEN),
    };
}

/* ========================================================================
   Отправитель
   ===================================================================== */

/**
 * Новый sender key. Приватная часть подписи неизвлекаемая: в IndexedDB
 * она попадает структурным клонированием, как identity-ключи устройства.
 */
export async function createSenderKey() {
    const signing = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    return {
        distributionId: crypto.getRandomValues(new Uint8Array(DIST_LEN)),
        chainKey: crypto.getRandomValues(new Uint8Array(CHAIN_LEN)),
        iteration: 0,
        signingPrivate: signing.privateKey,
        signingPublic: new Uint8Array(await subtle.exportKey('raw', signing.publicKey)),
        createdAt: Date.now(),
    };
}

/**
 * Что раздаётся получателям: ТЕКУЩЕЕ состояние цепочки. Получатель сможет
 * расшифровать сообщения с этого номера и дальше, но не раньше.
 */
export function senderKeyDistribution(senderKey) {
    return {
        dist: toB64(senderKey.distributionId),
        iter: senderKey.iteration,
        chain: toB64(senderKey.chainKey),
        sign: toB64(senderKey.signingPublic),
    };
}

/**
 * Зашифровать сообщение для группы. Мутирует senderKey (цепочка уходит
 * вперёд): вызывающий обязан сохранить его ДО отправки. Иначе после сбоя
 * тот же номер ушёл бы повторно с другим текстом — а IV здесь
 * детерминированный, и повтор пары (ключ, IV) в GCM раскрывает оба текста.
 */
export async function encryptGroup(senderKey, plaintext) {
    if (senderKey.iteration >= MAX_ITERATION) throw new Error('sender key исчерпан — нужен новый');
    const header = serializeHeader(senderKey.distributionId, senderKey.iteration);
    const { seed, next } = await chainStep(senderKey.chainKey);
    const { key, iv } = await messageKeys(seed);
    const ciphertext = new Uint8Array(await subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: header }, key, enc.encode(plaintext)));
    const signature = new Uint8Array(await subtle.sign(
        { name: 'Ed25519' }, senderKey.signingPrivate, concat(header, ciphertext)));

    senderKey.chainKey = next;
    senderKey.iteration += 1;
    return { header, ciphertext, signature };
}

/* ========================================================================
   Получатель
   ===================================================================== */

/** Состояние получателя из distribution. Бросает на битых полях. */
export function importDistribution(d) {
    const distributionId = fromB64(d.dist);
    const chainKey = fromB64(d.chain);
    const signingPublic = fromB64(d.sign);
    if (distributionId.length !== DIST_LEN || chainKey.length !== CHAIN_LEN
        || signingPublic.length !== PUBKEY_LEN
        || !Number.isInteger(d.iter) || d.iter < 0 || d.iter > MAX_ITERATION) {
        throw new Error('distribution: некорректные поля');
    }
    return { distributionId, chainKey, iteration: d.iter, signingPublic, skipped: new Map() };
}

export const distributionKey = distributionId => toB64(distributionId);

/**
 * Расшифровать групповое сообщение. Состояние сессии меняется только
 * после успешной расшифровки: подделка не должна сдвигать цепочку.
 *
 * Сообщение с номером меньше текущего расшифровывается только ключом из
 * пропущенных — один раз. Повтор того же сообщения поэтому не проходит.
 */
export async function decryptGroup(session, header, ciphertext, signature) {
    const h = parseGroupHeader(header);
    if (!equalBytes(h.distributionId, session.distributionId)) {
        throw new Error('сообщение зашифровано другим sender key');
    }
    if (!(signature instanceof Uint8Array) || signature.length !== SIGNATURE_LEN) {
        throw new Error('подпись: неверная длина');
    }
    const verifyKey = await subtle.importKey('raw', session.signingPublic, { name: 'Ed25519' }, false, ['verify']);
    const signatureOk = await subtle.verify({ name: 'Ed25519' }, verifyKey, signature, concat(header, ciphertext));
    if (!signatureOk) throw new Error('подпись не сходится — сообщение подделано');

    let seed;
    let nextChain = null;
    const newlySkipped = [];
    if (h.iteration < session.iteration) {
        seed = session.skipped.get(h.iteration);
        if (!seed) throw new Error('сообщение уже расшифровано или слишком старое');
    } else {
        if (h.iteration - session.iteration > MAX_SKIP) {
            throw new Error(`пропуск ${h.iteration - session.iteration} сообщений превышает предел ${MAX_SKIP}`);
        }
        let chain = session.chainKey;
        for (let i = session.iteration; i < h.iteration; i++) {
            const step = await chainStep(chain);
            newlySkipped.push([i, step.seed]);
            chain = step.next;
        }
        const step = await chainStep(chain);
        seed = step.seed;
        nextChain = step.next;
    }

    const { key, iv } = await messageKeys(seed);
    let plain;
    try {
        plain = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header }, key, ciphertext);
    } catch {
        throw new Error('шифротекст повреждён или подменён');
    }

    if (nextChain) {
        for (const [i, s] of newlySkipped) session.skipped.set(i, s);
        session.chainKey = nextChain;
        session.iteration = h.iteration + 1;
        // Старые пропущенные ключи вытесняются первыми: Map помнит порядок
        // вставки.
        while (session.skipped.size > MAX_STORED_SKIPPED) {
            session.skipped.delete(session.skipped.keys().next().value);
        }
    } else {
        session.skipped.delete(h.iteration);
    }
    return dec.decode(plain);
}
