// Ядро end-to-end шифрования: X3DH для установления сессии и Double Ratchet
// для самих сообщений. Только WebCrypto, никакого DOM и никаких импортов —
// поэтому файл работает и в браузере, и в Node, и тестируется без браузера
// (см. scripts/test-e2ee-crypto.mjs).
//
// Почему без WASM. Роадмап предполагал WASM-модуль, но всё нужное есть в
// WebCrypto: X25519, Ed25519, HKDF, AES-GCM. И это не компромисс, а строго
// лучше: identity-ключи устройства создаются неизвлекаемыми
// (extractable: false) и хранятся прямо в IndexedDB структурным
// клонированием — приватный ключ никогда не появляется в памяти JS как
// байты. Сборка libsignal на WASM так не умеет: ей нужны сырые байты ключа
// в линейной памяти.
//
// Что сознательно НЕ реализовано:
//   - групповые sender keys (этап C; здесь только парные сессии)
//   - проверка отпечатков собеседника человеком (safety numbers)
//   - постквантовая часть (X3DH без PQXDH)

const subtle = globalThis.crypto.subtle;

// Разделение областей применения HKDF: один и тот же секрет никогда не
// должен давать два разных ключа без разного info.
const INFO_X3DH = new TextEncoder().encode('Nyxo-X3DH-v1');
const INFO_ROOT = new TextEncoder().encode('Nyxo-DR-Root-v1');
const INFO_MSG = new TextEncoder().encode('Nyxo-DR-Msg-v1');

const ZERO_SALT = new Uint8Array(32);
// 32 байта 0xFF перед DH-выходами в X3DH. Домен-разделитель из спецификации
// Signal: не даёт спутать вывод X3DH с выводом другого протокола, который
// использует те же кривые.
const X3DH_PREFIX = new Uint8Array(32).fill(0xff);

const ENVELOPE_PREKEY = 1;
const ENVELOPE_NORMAL = 2;

export const HEADER_VERSION = 1;
const HEADER_NORMAL_LEN = 42;
const HEADER_PREKEY_LEN = 146;

// Ограничения против исчерпания памяти: сообщение с N = 4 млрд заставило бы
// вывести 4 млрд ключей. Пропуск больше MAX_SKIP означает либо потерю
// огромного куска истории, либо атаку — в обоих случаях отказ честнее.
const MAX_SKIP = 1000;
const MAX_STORED_SKIPPED = 2000;

/* ========================================================================
   Утилиты
   ===================================================================== */

export function toB64(bytes) {
    let s = '';
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
}

export function fromB64(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

function concat(...parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

function equalBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    // Сравнение публичных ключей, не секретов, поэтому постоянное время
    // здесь не требуется.
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

async function hkdf(ikm, salt, info, lenBytes) {
    const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, lenBytes * 8);
    return new Uint8Array(bits);
}

async function hmac(keyBytes, data) {
    const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await subtle.sign('HMAC', key, data));
}

async function dh(privateKey, publicKeyBytes) {
    const pub = await subtle.importKey('raw', publicKeyBytes, { name: 'X25519' }, false, []);
    return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pub }, privateKey, 256));
}

async function rawPub(key) {
    return new Uint8Array(await subtle.exportKey('raw', key));
}

/* ========================================================================
   Ключи устройства
   ===================================================================== */

/**
 * Долговременная личность устройства: Ed25519 для подписей и X25519 для DH.
 * Два ключа, а не один, потому что одна кривая не может и подписывать, и
 * согласовывать секрет.
 *
 * extractable: false по умолчанию — ключ нельзя выгрузить в байты даже из
 * своего же кода. Хранить его надо структурным клонированием в IndexedDB.
 */
export async function generateIdentity({ extractable = false } = {}) {
    const [signing, dhKeys] = await Promise.all([
        subtle.generateKey({ name: 'Ed25519' }, extractable, ['sign', 'verify']),
        subtle.generateKey({ name: 'X25519' }, extractable, ['deriveBits']),
    ]);
    return { signing, dh: dhKeys };
}

/*
 * Два ключа личности связаны подписью: X25519-ключ подписан Ed25519-ключом
 * того же устройства, с контекстом — чтобы такую подпись нельзя было выдать
 * за подпись signed prekey. Без неё сервер мог бы отдать настоящий ключ
 * подписи вместе с чужим ключом для DH. Проверяет её и e2ee-key-server
 * (crypto::verify_identity_dh), и каждый получатель bundle.
 */
const IDENTITY_DH_CONTEXT = new TextEncoder().encode('nyxo/identity-dh/v1');

/** Публичная часть личности — то, что уходит на key-server. */
export async function exportIdentityPublic(identity) {
    const dhPub = await rawPub(identity.dh.publicKey);
    const signature = new Uint8Array(await subtle.sign({ name: 'Ed25519' }, identity.signing.privateKey,
        concat(IDENTITY_DH_CONTEXT, dhPub)));
    return {
        identity_signing_key: toB64(await rawPub(identity.signing.publicKey)),
        identity_dh_key: toB64(dhPub),
        identity_dh_signature: toB64(signature),
    };
}

/** Подписан ли X25519-ключ личности её же Ed25519-ключом. */
export async function verifyIdentityBinding(signingKeyB64, dhKeyB64, signatureB64) {
    try {
        const key = await subtle.importKey('raw', fromB64(signingKeyB64), { name: 'Ed25519' }, false, ['verify']);
        return await subtle.verify({ name: 'Ed25519' }, key, fromB64(signatureB64), concat(IDENTITY_DH_CONTEXT, fromB64(dhKeyB64)));
    } catch {
        return false;
    }
}

/**
 * Signed prekey: X25519-ключ, подписанный Ed25519-ключом личности. Подпись
 * идёт по СЫРЫМ 32 байтам публичного ключа — ровно это проверяет
 * e2ee-key-server (crypto::verify_signed_prekey).
 */
export async function generateSignedPrekey(identity, keyId) {
    const keyPair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const pub = await rawPub(keyPair.publicKey);
    const signature = new Uint8Array(await subtle.sign({ name: 'Ed25519' }, identity.signing.privateKey, pub));
    return {
        keyId,
        keyPair,
        publicKey: pub,
        upload: { key_id: keyId, public_key: toB64(pub), signature: toB64(signature) },
    };
}

/** Пул одноразовых prekeys. key_id нумеруются с 1: 0 в заголовке значит «нет OPK». */
export async function generateOneTimePrekeys(startKeyId, count) {
    const items = [];
    for (let i = 0; i < count; i++) {
        const keyId = startKeyId + i;
        const keyPair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
        items.push({ keyId, keyPair, publicKey: await rawPub(keyPair.publicKey) });
    }
    return {
        items,
        upload: { keys: items.map(k => ({ key_id: k.keyId, public_key: toB64(k.publicKey) })) },
    };
}

/* ========================================================================
   Заголовок
   ===================================================================== */

/**
 * Заголовок сериализуется в фиксированный бинарный формат, а не в JSON,
 * намеренно: он идёт как AAD в AES-GCM, то есть обязан быть байт в байт
 * одинаковым у отправителя и получателя. JSON.stringify такого не
 * гарантирует (порядок ключей, пробелы, экранирование), а JSONB в Postgres
 * его точно нормализует.
 */
function serializeHeader(h) {
    const len = h.type === ENVELOPE_PREKEY ? HEADER_PREKEY_LEN : HEADER_NORMAL_LEN;
    const out = new Uint8Array(len);
    const view = new DataView(out.buffer);
    out[0] = HEADER_VERSION;
    out[1] = h.type;
    out.set(h.dh, 2);
    view.setUint32(34, h.pn, false);
    view.setUint32(38, h.n, false);
    if (h.type === ENVELOPE_PREKEY) {
        out.set(h.identitySigningKey, 42);
        out.set(h.identityDhKey, 74);
        out.set(h.ephemeralKey, 106);
        view.setUint32(138, h.signedPrekeyId, false);
        view.setUint32(142, h.oneTimePrekeyId || 0, false);
    }
    return out;
}

function parseHeader(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('header: ожидается Uint8Array');
    if (bytes.length < HEADER_NORMAL_LEN) throw new Error('header: слишком короткий');
    if (bytes[0] !== HEADER_VERSION) throw new Error(`header: версия ${bytes[0]} не поддерживается`);
    const type = bytes[1];
    if (type !== ENVELOPE_PREKEY && type !== ENVELOPE_NORMAL) throw new Error(`header: тип ${type} неизвестен`);
    const expected = type === ENVELOPE_PREKEY ? HEADER_PREKEY_LEN : HEADER_NORMAL_LEN;
    if (bytes.length !== expected) throw new Error(`header: длина ${bytes.length}, ожидалось ${expected}`);

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const h = {
        type,
        dh: bytes.slice(2, 34),
        pn: view.getUint32(34, false),
        n: view.getUint32(38, false),
    };
    if (type === ENVELOPE_PREKEY) {
        h.identitySigningKey = bytes.slice(42, 74);
        h.identityDhKey = bytes.slice(74, 106);
        h.ephemeralKey = bytes.slice(106, 138);
        h.signedPrekeyId = view.getUint32(138, false);
        h.oneTimePrekeyId = view.getUint32(142, false) || null;
    }
    return h;
}

export { parseHeader, ENVELOPE_PREKEY, ENVELOPE_NORMAL };

/* ========================================================================
   X3DH
   ===================================================================== */

async function deriveSharedSecret(dhOutputs) {
    return hkdf(concat(X3DH_PREFIX, ...dhOutputs), ZERO_SALT, INFO_X3DH, 32);
}

/**
 * Инициатор: строит сессию по bundle устройства получателя.
 *
 * Подпись signed prekey проверяется ДО использования. Без этой проверки
 * сервер мог бы подменить prekey на свой и читать переписку — вся
 * аутентичность X3DH держится на ней.
 */
export async function initiateSession({ identity, bundle }) {
    const theirSigning = fromB64(bundle.identity_signing_key);
    const theirIdentityDh = fromB64(bundle.identity_dh_key);
    const spkPub = fromB64(bundle.signed_prekey.public_key);
    const spkSig = fromB64(bundle.signed_prekey.signature);

    const verifyKey = await subtle.importKey('raw', theirSigning, { name: 'Ed25519' }, false, ['verify']);
    const signatureOk = await subtle.verify({ name: 'Ed25519' }, verifyKey, spkSig, spkPub);
    if (!signatureOk) {
        throw new Error('signed prekey: подпись не сходится — bundle подменён');
    }

    const ephemeral = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);

    const dh1 = await dh(identity.dh.privateKey, spkPub);
    const dh2 = await dh(ephemeral.privateKey, theirIdentityDh);
    const dh3 = await dh(ephemeral.privateKey, spkPub);
    const outputs = [dh1, dh2, dh3];

    let opkId = null;
    if (bundle.one_time_prekey) {
        opkId = bundle.one_time_prekey.key_id;
        outputs.push(await dh(ephemeral.privateKey, fromB64(bundle.one_time_prekey.public_key)));
    }

    const sk = await deriveSharedSecret(outputs);
    const mySigning = await rawPub(identity.signing.publicKey);
    const myIdentityDh = await rawPub(identity.dh.publicKey);

    // AD привязывает сессию к личностям обеих сторон: он идёт в AAD каждого
    // сообщения, поэтому подмена одной из личностей ломает расшифровку.
    const ad = concat(mySigning, theirSigning);

    const session = await initRatchetAsSender(sk, spkPub, ad);
    // Пока получатель не ответил, каждое сообщение должно нести prekey-часть:
    // мы не знаем, дошло ли до него первое и построил ли он сессию.
    session.pendingPrekey = {
        identitySigningKey: mySigning,
        identityDhKey: myIdentityDh,
        ephemeralKey: await rawPub(ephemeral.publicKey),
        signedPrekeyId: bundle.signed_prekey.key_id,
        oneTimePrekeyId: opkId,
    };
    return session;
}

/**
 * Получатель: восстанавливает ту же сессию из prekey-заголовка.
 *
 * lookupSignedPrekey/lookupOneTimePrekey — функции поиска своих приватных
 * ключей по key_id. Использованный OPK получатель обязан удалить у себя:
 * на сервере он уже удалён при выдаче bundle, и повторное использование
 * убило бы forward secrecy первого сообщения.
 */
export async function acceptSession({ identity, header, lookupSignedPrekey, lookupOneTimePrekey }) {
    if (header.type !== ENVELOPE_PREKEY) {
        throw new Error('acceptSession: нужен prekey-заголовок');
    }
    const spk = await lookupSignedPrekey(header.signedPrekeyId);
    if (!spk) throw new Error(`signed prekey ${header.signedPrekeyId} не найден`);

    const dh1 = await dh(spk.keyPair.privateKey, header.identityDhKey);
    const dh2 = await dh(identity.dh.privateKey, header.ephemeralKey);
    const dh3 = await dh(spk.keyPair.privateKey, header.ephemeralKey);
    const outputs = [dh1, dh2, dh3];

    if (header.oneTimePrekeyId) {
        const opk = lookupOneTimePrekey ? await lookupOneTimePrekey(header.oneTimePrekeyId) : null;
        if (!opk) throw new Error(`one-time prekey ${header.oneTimePrekeyId} не найден или уже использован`);
        outputs.push(await dh(opk.keyPair.privateKey, header.ephemeralKey));
    }

    const sk = await deriveSharedSecret(outputs);
    const mySigning = await rawPub(identity.signing.publicKey);
    // Порядок в AD задаёт инициатор: сначала его ключ, потом наш.
    const ad = concat(header.identitySigningKey, mySigning);

    return initRatchetAsReceiver(sk, spk.keyPair, ad);
}

/* ========================================================================
   Double Ratchet
   ===================================================================== */

async function kdfRootKey(rootKey, dhOutput) {
    const out = await hkdf(dhOutput, rootKey, INFO_ROOT, 64);
    return { rootKey: out.slice(0, 32), chainKey: out.slice(32, 64) };
}

async function kdfChainKey(chainKey) {
    const messageKey = await hmac(chainKey, new Uint8Array([0x01]));
    const nextChainKey = await hmac(chainKey, new Uint8Array([0x02]));
    return { messageKey, nextChainKey };
}

async function messageKeyToAes(messageKey) {
    const out = await hkdf(messageKey, ZERO_SALT, INFO_MSG, 44);
    return {
        key: await subtle.importKey('raw', out.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
        iv: out.slice(32, 44),
    };
}

async function initRatchetAsSender(sharedSecret, theirRatchetPub, ad) {
    const ratchet = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const { rootKey, chainKey } = await kdfRootKey(sharedSecret, await dh(ratchet.privateKey, theirRatchetPub));
    return {
        ad,
        ratchet,
        theirRatchetPub,
        rootKey,
        sendingChain: chainKey,
        receivingChain: null,
        sendCount: 0,
        receiveCount: 0,
        previousSendCount: 0,
        skipped: new Map(),
        pendingPrekey: null,
    };
}

async function initRatchetAsReceiver(sharedSecret, signedPrekeyPair, ad) {
    // Получатель стартует со своим signed prekey как ratchet-ключом: именно
    // на него инициатор посчитал первый DH.
    return {
        ad,
        ratchet: signedPrekeyPair,
        theirRatchetPub: null,
        rootKey: sharedSecret,
        sendingChain: null,
        receivingChain: null,
        sendCount: 0,
        receiveCount: 0,
        previousSendCount: 0,
        skipped: new Map(),
        pendingPrekey: null,
    };
}

/** Шаг DH-рэтчета: смена ratchet-ключа собеседника меняет обе цепочки. */
async function dhRatchet(session, theirNewRatchetPub) {
    session.previousSendCount = session.sendCount;
    session.sendCount = 0;
    session.receiveCount = 0;
    session.theirRatchetPub = theirNewRatchetPub;

    let step = await kdfRootKey(session.rootKey, await dh(session.ratchet.privateKey, theirNewRatchetPub));
    session.rootKey = step.rootKey;
    session.receivingChain = step.chainKey;

    session.ratchet = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    step = await kdfRootKey(session.rootKey, await dh(session.ratchet.privateKey, theirNewRatchetPub));
    session.rootKey = step.rootKey;
    session.sendingChain = step.chainKey;
}

const skippedKeyId = (ratchetPub, n) => `${toB64(ratchetPub)}:${n}`;

/**
 * Сообщения могли прийти не по порядку. Ключи пропущенных сохраняются,
 * чтобы опоздавшее сообщение всё-таки расшифровалось.
 */
async function skipMessageKeys(session, until) {
    if (session.receivingChain === null) return;
    if (until - session.receiveCount > MAX_SKIP) {
        throw new Error(`пропуск ${until - session.receiveCount} сообщений превышает предел ${MAX_SKIP}`);
    }
    while (session.receiveCount < until) {
        const { messageKey, nextChainKey } = await kdfChainKey(session.receivingChain);
        session.skipped.set(skippedKeyId(session.theirRatchetPub, session.receiveCount), messageKey);
        session.receivingChain = nextChainKey;
        session.receiveCount++;
    }
    // Старые пропущенные вытесняются: иначе поток «дырявых» сообщений
    // раздувает состояние сессии без предела.
    while (session.skipped.size > MAX_STORED_SKIPPED) {
        session.skipped.delete(session.skipped.keys().next().value);
    }
}

async function aeadEncrypt(messageKey, ad, headerBytes, plaintext) {
    const { key, iv } = await messageKeyToAes(messageKey);
    const aad = concat(ad, headerBytes);
    return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext));
}

async function aeadDecrypt(messageKey, ad, headerBytes, ciphertext) {
    const { key, iv } = await messageKeyToAes(messageKey);
    const aad = concat(ad, headerBytes);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ciphertext));
}

/**
 * Зашифровать сообщение. Возвращает ровно то, что уходит в конверт:
 * тип, байты заголовка и шифротекст.
 */
export async function encryptMessage(session, plaintext) {
    if (session.sendingChain === null) {
        throw new Error('нельзя отправить первым: сессия ждёт сообщения от собеседника');
    }
    const data = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;

    const { messageKey, nextChainKey } = await kdfChainKey(session.sendingChain);
    session.sendingChain = nextChainKey;

    const header = {
        type: session.pendingPrekey ? ENVELOPE_PREKEY : ENVELOPE_NORMAL,
        dh: await rawPub(session.ratchet.publicKey),
        pn: session.previousSendCount,
        n: session.sendCount,
        ...(session.pendingPrekey || {}),
    };
    session.sendCount++;

    const headerBytes = serializeHeader(header);
    const ciphertext = await aeadEncrypt(messageKey, session.ad, headerBytes, data);
    return { type: header.type, header: headerBytes, ciphertext };
}

/**
 * Расшифровать сообщение. headerBytes должны быть ровно теми байтами, что
 * пришли по сети: они входят в AAD, и любое изменение — хоть на бит — даст
 * отказ расшифровки, а не тихо другой результат.
 */
export async function decryptMessage(session, headerBytes, ciphertext) {
    const header = parseHeader(headerBytes);

    // Сначала пропущенные: опоздавшее сообщение из старой цепочки.
    const skippedId = skippedKeyId(header.dh, header.n);
    if (session.skipped.has(skippedId)) {
        const messageKey = session.skipped.get(skippedId);
        const plaintext = await aeadDecrypt(messageKey, session.ad, headerBytes, ciphertext);
        session.skipped.delete(skippedId);
        return plaintext;
    }

    if (!equalBytes(header.dh, session.theirRatchetPub)) {
        await skipMessageKeys(session, header.pn);
        await dhRatchet(session, header.dh);
    }
    await skipMessageKeys(session, header.n);

    const { messageKey, nextChainKey } = await kdfChainKey(session.receivingChain);
    const plaintext = await aeadDecrypt(messageKey, session.ad, headerBytes, ciphertext);

    // Состояние двигается только после успешной расшифровки: иначе
    // подделанное сообщение сбивало бы счётчики и ломало сессию.
    session.receivingChain = nextChainKey;
    session.receiveCount++;
    // Собеседник ответил — значит сессию построил, prekey-часть больше не нужна.
    session.pendingPrekey = null;
    return plaintext;
}

export const decryptToText = async (session, headerBytes, ciphertext) =>
    new TextDecoder().decode(await decryptMessage(session, headerBytes, ciphertext));

/* ========================================================================
   Сохранение сессии
   ===================================================================== */

/**
 * Состояние сессии в виде, пригодном для IndexedDB и для JSON.
 *
 * Ratchet-ключи выгружаются в JWK, поэтому создаются extractable: true — их
 * приходится переживать перезагрузку страницы. Identity-ключи устройства
 * сюда НЕ попадают вовсе: после X3DH они в рэтчете не участвуют, и поэтому
 * могут остаться неизвлекаемыми.
 */
export async function exportSession(session) {
    return {
        v: 1,
        ad: toB64(session.ad),
        ratchetPrivate: await subtle.exportKey('jwk', session.ratchet.privateKey),
        ratchetPublic: toB64(await rawPub(session.ratchet.publicKey)),
        theirRatchetPub: session.theirRatchetPub ? toB64(session.theirRatchetPub) : null,
        rootKey: toB64(session.rootKey),
        sendingChain: session.sendingChain ? toB64(session.sendingChain) : null,
        receivingChain: session.receivingChain ? toB64(session.receivingChain) : null,
        sendCount: session.sendCount,
        receiveCount: session.receiveCount,
        previousSendCount: session.previousSendCount,
        skipped: [...session.skipped].map(([k, v]) => [k, toB64(v)]),
        pendingPrekey: session.pendingPrekey ? {
            identitySigningKey: toB64(session.pendingPrekey.identitySigningKey),
            identityDhKey: toB64(session.pendingPrekey.identityDhKey),
            ephemeralKey: toB64(session.pendingPrekey.ephemeralKey),
            signedPrekeyId: session.pendingPrekey.signedPrekeyId,
            oneTimePrekeyId: session.pendingPrekey.oneTimePrekeyId,
        } : null,
    };
}

export async function importSession(state) {
    if (!state || state.v !== 1) throw new Error('session: неподдерживаемая версия состояния');
    const privateKey = await subtle.importKey('jwk', state.ratchetPrivate, { name: 'X25519' }, true, ['deriveBits']);
    const publicKey = await subtle.importKey('raw', fromB64(state.ratchetPublic), { name: 'X25519' }, true, []);
    return {
        ad: fromB64(state.ad),
        ratchet: { privateKey, publicKey },
        theirRatchetPub: state.theirRatchetPub ? fromB64(state.theirRatchetPub) : null,
        rootKey: fromB64(state.rootKey),
        sendingChain: state.sendingChain ? fromB64(state.sendingChain) : null,
        receivingChain: state.receivingChain ? fromB64(state.receivingChain) : null,
        sendCount: state.sendCount,
        receiveCount: state.receiveCount,
        previousSendCount: state.previousSendCount,
        skipped: new Map((state.skipped || []).map(([k, v]) => [k, fromB64(v)])),
        pendingPrekey: state.pendingPrekey ? {
            identitySigningKey: fromB64(state.pendingPrekey.identitySigningKey),
            identityDhKey: fromB64(state.pendingPrekey.identityDhKey),
            ephemeralKey: fromB64(state.pendingPrekey.ephemeralKey),
            signedPrekeyId: state.pendingPrekey.signedPrekeyId,
            oneTimePrekeyId: state.pendingPrekey.oneTimePrekeyId,
        } : null,
    };
}
