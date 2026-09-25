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
import { userFingerprint, combineFingerprints } from './safety.js';

// Пул одноразовых prekeys. Каждый входящий первый контакт съедает один,
// поэтому пул пополняется заранее: пустой пул не ломает связь, но первое
// сообщение теряет часть forward secrecy.
const OPK_POOL_SIZE = 50;
const OPK_REFILL_THRESHOLD = 15;

let state = {
    ready: false,
    userId: null,
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
export async function bootstrap({ api, userId, deviceName = 'Браузер' }) {
    state.api = api;
    state.userId = userId;
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

/* ------------------------------------------------------------------
   Доверие к ключам устройств
   ------------------------------------------------------------------ */

/**
 * Сравнить ключ устройства с тем, что мы видели при первом контакте.
 *
 * 'new' — устройство незнакомо; 'known' — ключ совпал; 'changed' — ключ
 * другой. Легитимно ключ устройства не меняется (новая личность = новое
 * устройство, key-server перезапись запрещает), поэтому 'changed' —
 * это подмена, и шифровать под такой ключ нельзя.
 */
async function identityStatus(userId, deviceId, signingKey, dhKey) {
    const known = await store.identities.load(userId, deviceId);
    if (!known) return 'new';
    return known.signingKey === signingKey && known.dhKey === dhKey ? 'known' : 'changed';
}

/**
 * Запомнить ключ незнакомого устройства. Вызывается только после того,
 * как ключ себя оправдал (подпись prekey сошлась, сообщение расшифровалось):
 * иначе мусорный конверт от имени устройства успел бы занять его место и
 * настоящий ключ потом выглядел бы подменой.
 */
async function rememberIdentity(userId, deviceId, signingKey, dhKey) {
    if (await store.identities.load(userId, deviceId)) return;
    await store.identities.save(userId, deviceId, { signingKey, dhKey, firstSeen: Date.now() });
}

function verificationState(record, deviceIds) {
    if (!record) return 'unverified';
    const known = new Set(record.devices.map(d => d.deviceId));
    // Пропавшее устройство (отозвали) сверку не портит: писать ему мы
    // больше не будем. Портит только новое.
    return deviceIds.every(id => known.has(id)) ? 'verified' : 'changed';
}

function groupByUser(devices) {
    const byUser = new Map();
    for (const d of devices) {
        if (d.user_id === state.userId) continue;
        if (!byUser.has(d.user_id)) byUser.set(d.user_id, []);
        byUser.get(d.user_id).push(d.device_id);
    }
    return byUser;
}

/**
 * Если собеседник сверен, а у него появилось устройство, которого при
 * сверке не было, — не шифруем, пока пользователь не сверит код заново.
 * Так делает и Signal: новое «устройство» у проверенного контакта —
 * ровно то, как выглядела бы атака сервера.
 */
async function assertVerifiedTargets(targets) {
    const changed = [];
    for (const [userId, deviceIds] of groupByUser(targets)) {
        const record = await store.verified.load(userId);
        if (verificationState(record, deviceIds) === 'changed') changed.push(userId);
    }
    if (changed.length > 0) {
        const error = new Error('ключи собеседника изменились после сверки — сверьте код заново');
        error.code = 'verification-changed';
        error.userIds = changed;
        throw error;
    }
}

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
    if (targets.length === 0) return { envelopes: [], targets: [], rejected: [] };
    // До запроса bundle: он расходует одноразовые prekeys, а отправка всё
    // равно не состоится.
    await assertVerifiedTargets(targets);

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
    const rejected = [];
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
            const seen = await identityStatus(userId, bundle.device_id,
                bundle.identity_signing_key, bundle.identity_dh_key);
            if (seen === 'changed') {
                console.error(`[E2EE] ключ устройства ${bundle.device_id} не совпадает с известным — подмена, устройство пропущено`);
                rejected.push(bundle.device_id);
                continue;
            }
            try {
                const session = await initiateSession({ identity: state.identity, bundle });
                await rememberIdentity(userId, bundle.device_id,
                    bundle.identity_signing_key, bundle.identity_dh_key);
                live.set(target.device_id, { target, session });
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

    return { envelopes, targets, rejected };
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
        const header = parseHeader(headerBytes);
        const signingKey = toB64(header.identitySigningKey);
        const dhKey = toB64(header.identityDhKey);
        // Проверка до acceptSession: тот съел бы одноразовый prekey.
        if (await identityStatus(senderUserId, senderDeviceId, signingKey, dhKey) === 'changed') {
            console.error(`[E2EE] сообщение от устройства ${senderDeviceId} подписано чужим ключом — отвергнуто`);
            return null;
        }
        const fresh = await acceptSession({
            identity: state.identity,
            header,
            lookupSignedPrekey,
            lookupOneTimePrekey,
        });
        const text = await decryptToText(fresh, headerBytes, ciphertext);
        await rememberIdentity(senderUserId, senderDeviceId, signingKey, dhKey);
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

/* ------------------------------------------------------------------
   Код безопасности
   ------------------------------------------------------------------ */

/**
 * Устройства пользователя с теми ключами, которыми мы реально пользуемся.
 *
 * Список устройств приходит с сервера, но ключ знакомого устройства
 * берётся из локальной памяти, а не из ответа: если сервер начал отдавать
 * другой, это конфликт, и в отпечаток он не попадает. Своё текущее
 * устройство — всегда по локальному ключу: серверу здесь верить не в чем.
 */
async function trustedDevices(userId) {
    const response = await state.api(`/api/keys/identities/${userId}`);
    if (!response || !Array.isArray(response.devices)) {
        throw new Error('не удалось получить ключи устройств');
    }

    const devices = [];
    const conflicts = [];
    for (const d of response.devices) {
        if (userId === state.userId && d.device_id === state.deviceId) {
            const own = await exportIdentityPublic(state.identity);
            // Сервер раздаёт от имени этого устройства чужой ключ — это
            // подмена в сторону собеседников, и о ней надо сказать.
            if (own.identity_signing_key !== d.identity_signing_key || own.identity_dh_key !== d.identity_dh_key) {
                conflicts.push(d.device_id);
            }
            continue;
        }
        const status = await identityStatus(userId, d.device_id, d.identity_signing_key, d.identity_dh_key);
        if (status === 'changed') {
            conflicts.push(d.device_id);
            const known = await store.identities.load(userId, d.device_id);
            devices.push({ deviceId: d.device_id, signingKey: known.signingKey, dhKey: known.dhKey });
            continue;
        }
        if (status === 'new') {
            await rememberIdentity(userId, d.device_id, d.identity_signing_key, d.identity_dh_key);
        }
        devices.push({ deviceId: d.device_id, signingKey: d.identity_signing_key, dhKey: d.identity_dh_key });
    }

    if (userId === state.userId) {
        const own = await exportIdentityPublic(state.identity);
        devices.push({ deviceId: state.deviceId, signingKey: own.identity_signing_key, dhKey: own.identity_dh_key });
    }
    return { devices, conflicts };
}

/**
 * Всё для окна сверки с одним собеседником.
 *
 * conflicts — его устройства, чей ключ на сервере не совпадает с
 * известным нам; ownConflicts — то же про наши устройства.
 */
export async function safetyInfo(otherUserId) {
    if (!state.ready) throw new Error('E2EE не инициализирован');
    const [mine, theirs] = await Promise.all([trustedDevices(state.userId), trustedDevices(otherUserId)]);
    if (theirs.devices.length === 0) return { available: false };

    const [myFingerprint, theirFingerprint] = await Promise.all([
        userFingerprint(state.userId, mine.devices),
        userFingerprint(otherUserId, theirs.devices),
    ]);
    const record = await store.verified.load(otherUserId);
    return {
        available: true,
        safetyNumber: combineFingerprints(myFingerprint, theirFingerprint),
        devices: theirs.devices,
        conflicts: theirs.conflicts,
        ownConflicts: mine.conflicts,
        state: verificationState(record, theirs.devices.map(d => d.deviceId)),
    };
}

/**
 * Отметить собеседника сверенным. devices — ровно тот набор, по которому
 * был посчитан показанный код: если за время сверки появилось ещё одно
 * устройство, оно в отметку не попадёт и отправка остановится снова.
 */
export async function markVerified(userId, devices) {
    await store.verified.save(userId, {
        devices: devices.map(d => ({ deviceId: d.deviceId, signingKey: d.signingKey, dhKey: d.dhKey })),
        verifiedAt: Date.now(),
    });
}

export const clearVerified = userId => store.verified.drop(userId);

/**
 * Состояние сверки по участникам чата — для шапки. Без сети и без
 * хэширования: только сравнение списка устройств с отметкой.
 *
 * devices — ответ /api/chats/:id/devices. Возвращает Map userId → state.
 */
export async function verificationStatus(devices) {
    const result = new Map();
    for (const [userId, deviceIds] of groupByUser(devices)) {
        result.set(userId, verificationState(await store.verified.load(userId), deviceIds));
    }
    return result;
}
