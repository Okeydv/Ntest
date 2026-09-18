// Оркестрация E2EE на клиенте: регистрация устройства, публикация ключей,
// пополнение пула prekeys, шифрование для всех устройств чата и
// расшифровка входящих.
//
// Ядро крипты (e2ee.js) ничего не знает ни про сеть, ни про хранилище;
// хранилище (store.js) ничего не знает про крипту. Этот модуль их
// связывает и больше ничего не делает — именно поэтому его можно
// прогнать в тестах, подменив api().

import {
    generateIdentity, exportIdentityPublic, generateSignedPrekey, generateOneTimePrekeys,
    initiateSession, acceptSession, encryptMessage, decryptToText,
    exportSession, importSession, parseHeader, toB64, fromB64,
    ENVELOPE_PREKEY,
} from './e2ee.js';
import * as store from './store.js';

// Пул одноразовых prekeys. Каждый входящий первый контакт съедает один,
// поэтому пул пополняется заранее: пустой пул не ломает связь, но первое
// сообщение теряет часть forward secrecy.
const OPK_POOL_SIZE = 50;
const OPK_REFILL_THRESHOLD = 15;

let state = {
    ready: false,
    deviceId: null,
    identity: null,
    signedPrekey: null,
    api: null,
};

/* ================================================================== */

async function publishKeys() {
    const identityPublic = await exportIdentityPublic(state.identity);
    await state.api('/api/keys/identity', { method: 'PUT', body: JSON.stringify(identityPublic) });
    await state.api('/api/keys/signed-prekey', {
        method: 'PUT',
        body: JSON.stringify(state.signedPrekey.upload),
    });
}

async function createOneTimePrekeys(count) {
    const nextId = (await store.meta.get('nextOpkId')) || 1;
    const batch = await generateOneTimePrekeys(nextId, count);
    for (const item of batch.items) await store.oneTimePrekeys.save(item);
    await store.meta.set('nextOpkId', nextId + count);
    await state.api('/api/keys/one-time-prekeys', { method: 'POST', body: JSON.stringify(batch.upload) });
    return count;
}

/**
 * Пополнение пула. Считать надо по данным СЕРВЕРА, а не по локальному
 * хранилищу: сервер раздаёт prekeys при каждом входящем первом контакте и
 * знает, сколько осталось, а локально они лежат до фактического
 * использования.
 */
export async function replenishOneTimePrekeys() {
    if (!state.ready) return null;
    try {
        const info = await state.api('/api/keys/one-time-prekeys/count');
        const remaining = Number(info && info.count);
        if (!Number.isFinite(remaining) || remaining > OPK_REFILL_THRESHOLD) return remaining;
        await createOneTimePrekeys(OPK_POOL_SIZE - Math.max(remaining, 0));
        return remaining;
    } catch (e) {
        console.warn('[E2EE] не удалось пополнить пул prekeys:', e.message);
        return null;
    }
}

async function registerFreshDevice(deviceName) {
    const created = await state.api('/api/devices', {
        method: 'POST',
        body: JSON.stringify({ name: deviceName }),
    });
    if (!created || !created.success) {
        throw new Error((created && created.message) || 'не удалось зарегистрировать устройство');
    }

    state.deviceId = created.device.id;
    // extractable: false — приватный ключ устройства не может быть выгружен
    // в байты даже этим кодом; в IndexedDB он попадает структурным
    // клонированием.
    state.identity = await generateIdentity({ extractable: false });
    state.signedPrekey = await generateSignedPrekey(state.identity, 1);

    await store.identity.save(state.identity);
    await store.signedPrekeys.save(state.signedPrekey);
    await store.meta.set('deviceId', state.deviceId);
    await store.meta.set('signedPrekeyId', state.signedPrekey.keyId);

    await publishKeys();
    await createOneTimePrekeys(OPK_POOL_SIZE);
    return state.deviceId;
}

/**
 * Поднять E2EE для текущей сессии.
 *
 * Возвращает { deviceId, fresh } либо null, если шифрование недоступно
 * (например, в приватном режиме уже занято единственное разрешённое
 * устройство). Отсутствие E2EE не должно ломать приложение — вызывающий
 * просто остаётся на открытом пути.
 */
export async function bootstrap({ api, deviceName = 'Браузер' }) {
    state.api = api;
    state.ready = false;

    try {
        const storedDeviceId = await store.meta.get('deviceId');
        const storedIdentity = storedDeviceId ? await store.identity.load() : null;
        const storedSpkId = await store.meta.get('signedPrekeyId');
        const storedSpk = storedSpkId ? await store.signedPrekeys.load(storedSpkId) : null;

        if (storedDeviceId && storedIdentity && storedSpk) {
            const bound = await api(`/api/devices/${storedDeviceId}/bind`, { method: 'POST' });
            if (bound && bound.success) {
                state.deviceId = storedDeviceId;
                state.identity = storedIdentity;
                state.signedPrekey = storedSpk;
                state.ready = true;
                replenishOneTimePrekeys();
                return { deviceId: state.deviceId, fresh: false };
            }
            // Устройство отозвано или удалено на сервере. Держаться за
            // локальные ключи бессмысленно: расшифровать ими всё равно
            // нечего — сервер больше не адресует нам конверты.
            console.warn('[E2EE] устройство больше не признаётся сервером, создаём новое');
            await store.wipe();
        }

        await registerFreshDevice(deviceName);
        state.ready = true;
        return { deviceId: state.deviceId, fresh: true };
    } catch (e) {
        console.warn('[E2EE] шифрование недоступно:', e.message);
        state.ready = false;
        return null;
    }
}

export const isReady = () => state.ready;
export const currentDeviceId = () => state.deviceId;

/* ================================================================== */

const lookupSignedPrekey = async keyId => store.signedPrekeys.load(keyId);
const lookupOneTimePrekey = async keyId => store.oneTimePrekeys.consume(keyId);

async function loadSession(userId, deviceId) {
    const saved = await store.sessions.load(userId, deviceId);
    return saved ? importSession(saved) : null;
}

const saveSession = async (userId, deviceId, session) =>
    store.sessions.save(userId, deviceId, await exportSession(session));

/**
 * Собрать конверты для всех устройств чата.
 *
 * Собственное устройство исключается: свой открытый текст кладётся в
 * локальное хранилище (store.sentPlaintext), и конверт себе не нужен.
 */
export async function encryptForChat(chatId, plaintext) {
    if (!state.ready) throw new Error('E2EE не инициализирован');

    const info = await state.api(`/api/chats/${chatId}/devices`);
    if (!info || !info.success) throw new Error('не удалось получить список устройств чата');

    const targets = info.devices.filter(d => d.device_id !== state.deviceId);
    if (targets.length === 0) return { envelopes: [], targets: [] };

    const live = new Map();
    const needBundle = [];
    for (const target of targets) {
        const session = await loadSession(target.user_id, target.device_id);
        if (session) live.set(target.device_id, { target, session });
        else needBundle.push(target);
    }

    // Bundle выдаётся сразу на все устройства пользователя и при этом
    // расходует по одному одноразовому prekey на каждое. Поэтому запрос
    // делается только когда хоть с одним устройством сессии нет, и только
    // по одному разу на пользователя.
    const usersToFetch = [...new Set(needBundle.map(t => t.user_id))];
    for (const userId of usersToFetch) {
        const response = await state.api(`/api/keys/bundle/${userId}`);
        if (!response || !Array.isArray(response.bundles)) {
            console.warn(`[E2EE] нет ключей для пользователя ${userId}, его устройства пропущены`);
            continue;
        }
        for (const bundle of response.bundles) {
            const target = needBundle.find(t => t.user_id === userId && t.device_id === bundle.device_id);
            if (!target) continue;
            try {
                live.set(target.device_id, {
                    target,
                    session: await initiateSession({ identity: state.identity, bundle }),
                });
            } catch (e) {
                // Подменённый bundle — единственный случай, когда молчать
                // нельзя: это либо атака, либо испорченные ключи.
                console.error(`[E2EE] устройство ${bundle.device_id} пропущено: ${e.message}`);
            }
        }
    }

    const envelopes = [];
    for (const { target, session } of live.values()) {
        const encrypted = await encryptMessage(session, plaintext);
        envelopes.push({
            recipientDeviceId: target.device_id,
            envelopeType: encrypted.type,
            header: toB64(encrypted.header),
            ciphertext: toB64(encrypted.ciphertext),
        });
        await saveSession(target.user_id, target.device_id, session);
    }

    return { envelopes, targets };
}

/**
 * Расшифровать входящий конверт.
 *
 * Возвращает строку либо null — читать нечем. null не ошибка: так выглядит
 * сообщение, отправленное до того, как это устройство появилось, и клиент
 * обязан показать заглушку, а не пустой пузырь.
 */
export async function decryptIncoming(message) {
    if (!state.ready || !message || !message.envelope) return null;

    const senderDeviceId = message.envelope.sender_device_id || message.sender_device_id;
    const senderUserId = message.user_id;
    if (!senderDeviceId || !senderUserId) return null;

    const headerBytes = fromB64(message.envelope.header);
    const ciphertext = fromB64(message.envelope.ciphertext);
    const isPrekey = Number(message.envelope.envelope_type) === ENVELOPE_PREKEY;

    let session = await loadSession(senderUserId, senderDeviceId);

    if (session) {
        try {
            const text = await decryptToText(session, headerBytes, ciphertext);
            await saveSession(senderUserId, senderDeviceId, session);
            await store.plaintext.save(message.id, text);
            return text;
        } catch (e) {
            // Существующая сессия не подошла. Для prekey-сообщения это
            // нормально: собеседник мог начать заново, потеряв своё
            // состояние. Для обычного — сообщение потеряно.
            if (!isPrekey) {
                console.warn('[E2EE] сообщение не расшифровано:', e.message);
                return null;
            }
            session = null;
        }
    }

    if (!isPrekey) return null;

    try {
        const fresh = await acceptSession({
            identity: state.identity,
            header: parseHeader(headerBytes),
            lookupSignedPrekey,
            lookupOneTimePrekey,
        });
        const text = await decryptToText(fresh, headerBytes, ciphertext);
        await saveSession(senderUserId, senderDeviceId, fresh);
        await store.plaintext.save(message.id, text);
        // Входящий первый контакт съел одноразовый prekey — пул мог
        // просесть, проверяем не дожидаясь следующего запуска.
        replenishOneTimePrekeys();
        return text;
    } catch (e) {
        console.warn('[E2EE] не удалось построить сессию:', e.message);
        return null;
    }
}

/* Локальный кэш расшифрованного — см. комментарий у store.plaintext. */
export const rememberSent = (messageId, text) => store.plaintext.save(messageId, text);
export const recallPlaintext = messageId => store.plaintext.load(messageId);

/* Превью последнего сообщения: сервер шифротекст прочитать не может. */
export const rememberPreview = (chatId, text) => store.previews.save(chatId, text);
export const recallPreview = chatId => store.previews.load(chatId);
