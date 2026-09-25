// Локальное хранилище ключей и сессий (IndexedDB).
//
// Здесь лежит всё, чего сервер не видит и увидеть не должен: приватные
// ключи устройства, состояния Double Ratchet и открытый текст собственных
// отправленных сообщений.
//
// Identity-ключи хранятся как объекты CryptoKey, а не как байты: они
// созданы неизвлекаемыми (extractable: false), и структурное клонирование
// IndexedDB переносит их без выгрузки в JS. То есть приватный ключ
// устройства нельзя прочитать даже из собственного кода страницы.
//
// Потеря этого хранилища = потеря истории и личности устройства. Так и
// задумано: расшифровать переписку больше нечем, а восстановление истории
// на новом устройстве в этап A не входит.

const DB_NAME = 'nyxo-e2ee';
const DB_VERSION = 4;

const STORE_META = 'meta';
const STORE_IDENTITY = 'identity';
const STORE_SIGNED_PREKEYS = 'signedPrekeys';
const STORE_ONE_TIME_PREKEYS = 'oneTimePrekeys';
const STORE_SESSIONS = 'sessions';
const STORE_PLAINTEXT = 'plaintext';
const STORE_IDENTITIES = 'identities';
const STORE_VERIFIED = 'verified';
const STORE_SENDER_KEYS = 'senderKeys';
const STORE_GROUP_SESSIONS = 'groupSessions';

const ALL_STORES = [STORE_META, STORE_IDENTITY, STORE_SIGNED_PREKEYS,
    STORE_ONE_TIME_PREKEYS, STORE_SESSIONS, STORE_PLAINTEXT, STORE_IDENTITIES, STORE_VERIFIED,
    STORE_SENDER_KEYS, STORE_GROUP_SESSIONS];

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            for (const name of ALL_STORES) {
                if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return dbPromise;
}

function tx(db, storeName, mode, fn) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let result;
        try {
            result = fn(store);
        } catch (e) {
            reject(e);
            return;
        }
        // Именно instanceof, а не проверка result.result на undefined:
        // отсутствующий ключ даёт request.result === undefined, и проверка
        // «на undefined» возвращала бы вместо него сам объект IDBRequest.
        // Тот затем уходил дальше как ключ — и IndexedDB отвечал
        // «The parameter is not a valid key».
        transaction.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

async function get(storeName, key) {
    const db = await openDb();
    return tx(db, storeName, 'readonly', store => store.get(key));
}

async function put(storeName, key, value) {
    const db = await openDb();
    return tx(db, storeName, 'readwrite', store => store.put(value, key));
}

async function del(storeName, key) {
    const db = await openDb();
    return tx(db, storeName, 'readwrite', store => store.delete(key));
}

async function getAll(storeName) {
    const db = await openDb();
    return tx(db, storeName, 'readonly', store => store.getAll());
}

/* ------------------------------------------------------------------ */

export const meta = {
    get: key => get(STORE_META, key),
    set: (key, value) => put(STORE_META, key, value),
};

export const identity = {
    load: () => get(STORE_IDENTITY, 'self'),
    save: value => put(STORE_IDENTITY, 'self', value),
};

export const signedPrekeys = {
    load: keyId => get(STORE_SIGNED_PREKEYS, keyId),
    save: entry => put(STORE_SIGNED_PREKEYS, entry.keyId, entry),
};

export const oneTimePrekeys = {
    load: keyId => get(STORE_ONE_TIME_PREKEYS, keyId),
    save: entry => put(STORE_ONE_TIME_PREKEYS, entry.keyId, entry),
    /**
     * Использованный OPK удаляется сразу. Повторное использование убило бы
     * forward secrecy первого сообщения: сервер удаляет его при выдаче
     * bundle, и локальная копия обязана исчезнуть тогда же.
     */
    consume: async keyId => {
        const entry = await get(STORE_ONE_TIME_PREKEYS, keyId);
        if (entry) await del(STORE_ONE_TIME_PREKEYS, keyId);
        return entry || null;
    },
    count: async () => (await getAll(STORE_ONE_TIME_PREKEYS)).length,
};

const sessionKey = (userId, deviceId) => `${userId}:${deviceId}`;

export const sessions = {
    load: (userId, deviceId) => get(STORE_SESSIONS, sessionKey(userId, deviceId)),
    save: (userId, deviceId, state) => put(STORE_SESSIONS, sessionKey(userId, deviceId), state),
    drop: (userId, deviceId) => del(STORE_SESSIONS, sessionKey(userId, deviceId)),
};

/**
 * Расшифрованный текст сообщений — и своих, и чужих.
 *
 * Кэш здесь обязателен, а не оптимизация. Ключ сообщения в Double Ratchet
 * одноразовый: цепочка проворачивается при первой расшифровке, и второй
 * раз тот же конверт расшифровать нельзя — это защита от повторов, а не
 * дефект. Значит после перезагрузки страницы историю восстановить нечем,
 * если открытый текст не сохранён локально при первом прочтении.
 *
 * Для СВОИХ отправленных он попадает сюда сразу при отправке: конверт себе
 * не шлётся вовсе, и расшифровывать было бы нечего.
 *
 * Плата — история живёт только в этом браузере: очистка данных сайта её
 * теряет, ровно как и новое устройство. Это согласуется с принятым
 * решением «на новом устройстве истории нет».
 */
export const plaintext = {
    load: messageId => get(STORE_PLAINTEXT, String(messageId)),
    save: (messageId, text) => put(STORE_PLAINTEXT, String(messageId), text),
};

/**
 * Превью последнего сообщения для списка чатов.
 *
 * Сервер его больше не знает: у зашифрованного сообщения в базе нет текста.
 * Поэтому превью запоминает клиент — по мере того, как расшифровывает.
 */
export const previews = {
    load: chatId => get(STORE_META, `preview:${chatId}`),
    save: (chatId, text) => put(STORE_META, `preview:${chatId}`, text),
};

/**
 * Identity-ключи чужих устройств в том виде, в каком мы увидели их впервые
 * (trust on first use).
 *
 * Ключ устройства в этой системе не меняется никогда: новая личность —
 * всегда новое устройство с новым id, а key-server перезапись запрещает.
 * Поэтому другой ключ у знакомого устройства — это подмена, и шифровать
 * под него нельзя.
 */
export const identities = {
    load: (userId, deviceId) => get(STORE_IDENTITIES, sessionKey(userId, deviceId)),
    save: (userId, deviceId, entry) => put(STORE_IDENTITIES, sessionKey(userId, deviceId), entry),
};

/**
 * Отметки о сверке кода безопасности: по пользователю — набор его
 * устройств с ключами на момент сверки.
 */
export const verified = {
    load: userId => get(STORE_VERIFIED, String(userId)),
    save: (userId, entry) => put(STORE_VERIFIED, String(userId), entry),
    drop: userId => del(STORE_VERIFIED, String(userId)),
};

/**
 * Свои sender keys — по одному на комнату. Хранятся объектом как есть:
 * приватная часть подписи — неизвлекаемый CryptoKey, и в IndexedDB он
 * попадает структурным клонированием, как identity-ключ.
 */
export const senderKeys = {
    load: roomId => get(STORE_SENDER_KEYS, String(roomId)),
    save: (roomId, entry) => put(STORE_SENDER_KEYS, String(roomId), entry),
};

/**
 * Чужие sender keys: состояние цепочки каждого отправителя в каждой
 * комнате. Старые распространения не удаляются: ими зашифрована история,
 * отправленная до смены ключа.
 */
const groupSessionKey = (roomId, senderDeviceId, distribution) => `${roomId}:${senderDeviceId}:${distribution}`;

export const groupSessions = {
    load: (roomId, senderDeviceId, distribution) =>
        get(STORE_GROUP_SESSIONS, groupSessionKey(roomId, senderDeviceId, distribution)),
    save: (roomId, senderDeviceId, distribution, entry) =>
        put(STORE_GROUP_SESSIONS, groupSessionKey(roomId, senderDeviceId, distribution), entry),
};

/** Полная очистка — при смене устройства или несовпадении с сервером. */
export async function wipe() {
    const db = await openDb();
    for (const name of ALL_STORES) {
        await tx(db, name, 'readwrite', store => store.clear());
    }
}
