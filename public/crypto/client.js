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
import {
    createSenderKey, senderKeyDistribution, encryptGroup,
    importDistribution, distributionKey, decryptGroup, parseGroupHeader,
} from './group.js';

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

/* ------------------------------------------------------------------
   Ротация signed prekey
   ------------------------------------------------------------------ */

// Signed prekey меняется раз в неделю, как в Signal. Его приватная часть
// участвует в каждом первом контакте с устройством, а без одноразового
// prekey — только она и ключ личности. Утечка вечного SPK открыла бы все
// такие первые сообщения за всё время; меняющегося — только за неделю.
//
// Прежний хранится ещё 30 дней: сообщение, зашифрованное по старому
// bundle, может прийти с опозданием (собеседник был не в сети), и без
// этого ключа оно бы не открылось. Потом удаляется.
const SIGNED_PREKEY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SIGNED_PREKEY_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

async function pruneRetiredSignedPrekeys(now) {
    const retired = (await store.meta.get('retiredSignedPrekeys')) || [];
    const keep = [];
    for (const r of retired) {
        if (now - r.retiredAt > SIGNED_PREKEY_GRACE_MS) await store.signedPrekeys.drop(r.keyId);
        else keep.push(r);
    }
    if (keep.length !== retired.length) await store.meta.set('retiredSignedPrekeys', keep);
}

/**
 * Сменить signed prekey, если текущему больше недели. Новый сначала
 * публикуется и только потом становится текущим: не удалась публикация —
 * остаётся прежний, и собеседники продолжают получать рабочий bundle.
 */
export async function rotateSignedPrekeyIfDue(now = Date.now()) {
    if (!state.ready) return false;
    await pruneRetiredSignedPrekeys(now);
    // У устройств, заведённых до ротации, даты нет — их ключ меняем сразу.
    const createdAt = (await store.meta.get('signedPrekeyCreatedAt')) || 0;
    if (now - createdAt < SIGNED_PREKEY_MAX_AGE_MS) return false;

    const previous = state.signedPrekey;
    const fresh = await generateSignedPrekey(state.identity, previous.keyId + 1);
    await store.signedPrekeys.save(fresh);
    const published = await state.api('/api/keys/signed-prekey', { method: 'PUT', body: JSON.stringify(fresh.upload) });
    if (!published || published.success !== true) {
        await store.signedPrekeys.drop(fresh.keyId);
        throw new Error((published && published.message) || 'новый signed prekey не принят');
    }
    await store.meta.set('signedPrekeyId', fresh.keyId);
    await store.meta.set('signedPrekeyCreatedAt', now);
    const retired = (await store.meta.get('retiredSignedPrekeys')) || [];
    retired.push({ keyId: previous.keyId, retiredAt: now });
    await store.meta.set('retiredSignedPrekeys', retired);
    state.signedPrekey = fresh;
    return true;
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
    await store.meta.set('signedPrekeyCreatedAt', Date.now());

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
                rotateSignedPrekeyIfDue().catch(e => console.warn('[E2EE] signed prekey не обновлён:', e.message));
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

/* ------------------------------------------------------------------
   Очередь
   ------------------------------------------------------------------ */

// Шифрование и расшифровка двигают одно и то же состояние: сессии Double
// Ratchet и цепочки sender keys. Два параллельных вызова загрузили бы одну
// версию, и второй затёр бы сохранённое первым — сессия разошлась бы с
// собеседником. Поэтому всё, что меняет это состояние, идёт строго по
// одному, в порядке вызова.
let queue = Promise.resolve();
function serialized(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
}

/* ------------------------------------------------------------------
   Попарное шифрование
   ------------------------------------------------------------------ */

/**
 * Зашифровать одну и ту же строку попарно для каждого из targets.
 * Возвращает конверты и устройства, отвергнутые из-за подмены ключа.
 */
async function encryptPairwise(targets, plaintext) {
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

    return { envelopes, rejected };
}

/**
 * Открыть попарный конверт. Возвращает строку либо null — прочитать нечем.
 * В кэш ничего не кладёт: что это — содержимое или раздача ключа, решает
 * вызывающий.
 */
// Сколько прежних состояний сессии держать и сколько базовых ключей помнить.
const MAX_PREVIOUS_SESSIONS = 5;
const MAX_BASE_KEYS = 200;

async function openEnvelope(senderUserId, senderDeviceId, envelope) {
    if (!senderDeviceId || !senderUserId) return null;

    const headerBytes = fromB64(envelope.header);
    const ciphertext = fromB64(envelope.ciphertext);
    const isPrekey = Number(envelope.envelope_type) === ENVELOPE_PREKEY;

    const saved = await store.sessions.load(senderUserId, senderDeviceId);
    if (saved) {
        const session = await importSession(saved);
        try {
            const text = await decryptToText(session, headerBytes, ciphertext);
            await saveSession(senderUserId, senderDeviceId, session);
            return text;
        } catch {
            // Не подошла — пробуем прежние состояния, потом (для prekey-
            // сообщения) новую сессию.
        }
    }

    // Прежние состояния: сообщение могло уйти по сессии, которую у нас уже
    // сменила другая. Раз собеседник пишет по ней, она и становится
    // текущей — отвечать будем тоже по ней.
    const previous = await store.previousSessions.load(senderUserId, senderDeviceId);
    for (let i = 0; i < previous.length; i++) {
        const candidate = await importSession(previous[i]);
        try {
            const text = await decryptToText(candidate, headerBytes, ciphertext);
            const rest = previous.filter((_, j) => j !== i);
            if (saved) rest.unshift(saved);
            await store.previousSessions.save(senderUserId, senderDeviceId, rest.slice(0, MAX_PREVIOUS_SESSIONS));
            await saveSession(senderUserId, senderDeviceId, candidate);
            return text;
        } catch {
            // следующее
        }
    }

    if (!isPrekey) {
        console.warn('[E2EE] сообщение не расшифровано ни одной из сессий');
        return null;
    }

    try {
        const header = parseHeader(headerBytes);
        const signingKey = toB64(header.identitySigningKey);
        const dhKey = toB64(header.identityDhKey);
        // Сессия по этому prekey-сообщению уже строилась. Раз ни одна из
        // сохранённых его не открыла, это повтор старого сообщения (сервер
        // может прислать его ещё раз). Построенная по нему заново сессия
        // заменила бы рабочую — и переписка с собеседником сломалась бы:
        // без одноразового prekey такое сообщение открывается снова и снова.
        const baseKey = toB64(header.ephemeralKey);
        const seenBaseKeys = await store.baseKeys.load(senderUserId, senderDeviceId);
        if (seenBaseKeys.includes(baseKey)) {
            console.warn(`[E2EE] повтор prekey-сообщения от устройства ${senderDeviceId} — отвергнут`);
            return null;
        }
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
        // Прежняя сессия уходит в архив, а не стирается.
        if (saved) {
            await store.previousSessions.save(senderUserId, senderDeviceId,
                [saved, ...previous].slice(0, MAX_PREVIOUS_SESSIONS));
        }
        await store.baseKeys.save(senderUserId, senderDeviceId,
            [baseKey, ...seenBaseKeys].slice(0, MAX_BASE_KEYS));
        await saveSession(senderUserId, senderDeviceId, fresh);
        // Входящий первый контакт съел одноразовый prekey — пул мог
        // просесть, проверяем не дожидаясь следующего запуска.
        replenishOneTimePrekeys();
        return text;
    } catch (e) {
        console.warn('[E2EE] не удалось построить сессию:', e.message);
        return null;
    }
}

/* ------------------------------------------------------------------
   Шифрование для чата
   ------------------------------------------------------------------ */

// С какого числа участников комната шифруется sender keys. Разговор двоих
// остаётся попарным: у Double Ratchet есть DH-рэтчет, и утечка состояния
// «лечится» следующим же ответом собеседника, а у sender keys его нет.
const GROUP_MIN_USERS = 3;
// Свой sender key меняется не только при уходе участника, но и по числу
// сообщений и возрасту: так утёкшее состояние цепочки открывает
// ограниченный кусок переписки, а устройство, по какой-то причине не
// получившее ключ, со временем получит новый.
const SENDER_KEY_MAX_MESSAGES = 1000;
const SENDER_KEY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DISTRIBUTION_TYPE = 'skdm';

const noop = async () => {};

/**
 * Зашифровать сообщение для всех устройств чата, кроме своего.
 *
 * Возвращает { mode, envelopes, keyEnvelopes, group, targets, rejected,
 * undelivered, readers, commit }:
 *   - mode 'pairwise' — содержимое в envelopes, конверт на каждое устройство;
 *   - mode 'group' — содержимое в group (один шифротекст на всех), а в
 *     keyEnvelopes — sender key для устройств, у которых его ещё нет;
 *   - readers — сколько устройств смогут прочитать сообщение;
 *   - commit() надо вызвать, когда сервер принял сообщение: только тогда
 *     раздача ключа считается состоявшейся.
 */
export function encryptForChat(chatId, plaintext) {
    return serialized(() => encryptForChatNow(chatId, plaintext));
}

async function encryptForChatNow(chatId, plaintext) {
    if (!state.ready) throw new Error('E2EE не инициализирован');

    const info = await state.api(`/api/chats/${chatId}/devices`);
    if (!info || !info.success) throw new Error('не удалось получить список устройств чата');

    // Собственное устройство исключается: свой открытый текст кладётся в
    // локальное хранилище, и конверт себе не нужен.
    const targets = info.devices.filter(d => d.device_id !== state.deviceId);
    if (targets.length === 0) {
        return {
            mode: 'none', envelopes: [], keyEnvelopes: [], group: null, targets,
            rejected: [], undelivered: [], readers: 0, commit: noop,
        };
    }
    // До запроса bundle: он расходует одноразовые prekeys, а отправка всё
    // равно не состоится.
    await assertVerifiedTargets(targets);

    const users = new Set(info.devices.map(d => d.user_id));
    if (info.room_id && users.size >= GROUP_MIN_USERS) {
        return encryptForGroup(info.room_id, targets, plaintext);
    }

    const { envelopes, rejected } = await encryptPairwise(targets, plaintext);
    return {
        mode: 'pairwise', envelopes, keyEnvelopes: [], group: null, targets,
        rejected, undelivered: [], readers: envelopes.length, commit: noop,
    };
}

/**
 * Групповой режим. sentTo у своего sender key — устройства, которым он уже
 * роздан: им достаётся только шифротекст, остальным ещё и конверт с ключом.
 */
async function encryptForGroup(roomId, targets, plaintext) {
    const targetIds = new Set(targets.map(t => t.device_id));
    let senderKey = await store.senderKeys.load(roomId);
    const mustRotate = !senderKey
        || senderKey.iteration >= SENDER_KEY_MAX_MESSAGES
        || Date.now() - senderKey.createdAt > SENDER_KEY_MAX_AGE_MS
        // Кто-то из получивших ключ пропал из чата: ушёл сам или отозвал
        // устройство. Старым ключом он читал бы и всё, что будет дальше.
        || senderKey.sentTo.some(id => !targetIds.has(id));
    if (mustRotate) senderKey = { ...(await createSenderKey()), sentTo: [] };

    const needKey = targets.filter(t => !senderKey.sentTo.includes(t.device_id));
    let keyEnvelopes = [];
    let rejected = [];
    if (needKey.length > 0) {
        // Раздаётся состояние цепочки ДО этого сообщения: получатели должны
        // прочитать и его.
        const distribution = JSON.stringify({
            v: 1, t: DISTRIBUTION_TYPE, room: roomId, ...senderKeyDistribution(senderKey),
        });
        ({ envelopes: keyEnvelopes, rejected } = await encryptPairwise(needKey, distribution));
    }
    const delivered = keyEnvelopes.map(e => e.recipientDeviceId);
    const readers = targets.filter(t =>
        senderKey.sentTo.includes(t.device_id) || delivered.includes(t.device_id)).length;
    const undelivered = needKey.map(t => t.device_id)
        .filter(id => !delivered.includes(id) && !rejected.includes(id));

    // Прочитать не сможет никто — шифровать незачем. Номер в цепочке при
    // этом не тратится.
    if (readers === 0) {
        return {
            mode: 'group', envelopes: [], keyEnvelopes: [], group: null, targets,
            rejected, undelivered, readers: 0, commit: noop,
        };
    }

    const encrypted = await encryptGroup(senderKey, plaintext);
    // Цепочка сохраняется ДО отправки — см. encryptGroup: повтор номера с
    // другим текстом недопустим, даже если отправка не удастся.
    await store.senderKeys.save(roomId, senderKey);

    const distributionId = toB64(senderKey.distributionId);
    return {
        mode: 'group',
        envelopes: [],
        keyEnvelopes,
        group: {
            header: toB64(encrypted.header),
            ciphertext: toB64(encrypted.ciphertext),
            signature: toB64(encrypted.signature),
        },
        targets,
        rejected,
        undelivered,
        readers,
        commit: () => serialized(async () => {
            const current = await store.senderKeys.load(roomId);
            // Пока шла отправка, ключ мог смениться — тогда отметка не нужна.
            if (!current || toB64(current.distributionId) !== distributionId) return;
            current.sentTo = [...new Set([...current.sentTo, ...delivered])];
            await store.senderKeys.save(roomId, current);
        }),
    };
}

/* ------------------------------------------------------------------
   Приём sender keys
   ------------------------------------------------------------------ */

function parseDistribution(text) {
    if (typeof text !== 'string' || !text.startsWith('{')) return null;
    try {
        const d = JSON.parse(text);
        return d && d.v === 1 && d.t === DISTRIBUTION_TYPE ? d : null;
    } catch {
        return null;
    }
}

/**
 * Принять sender key. deliveredRoomId — комната, в которой пришёл конверт.
 * Комната внутри раздачи зашифрована и подписана отправителем, комнату
 * доставки называет сервер; они обязаны совпасть. Иначе участник одной
 * комнаты мог бы раздать ключ «для» другой, где его нет, и сообщения от
 * его устройства там расшифровывались бы как настоящие.
 */
async function importKeyDistribution(senderUserId, senderDeviceId, d, deliveredRoomId) {
    const roomId = Number(d.room);
    if (!Number.isInteger(roomId) || roomId <= 0) throw new Error('distribution: некорректная комната');
    if (roomId !== Number(deliveredRoomId)) throw new Error('distribution: ключ для другой комнаты');
    const session = importDistribution(d);
    const key = distributionKey(session.distributionId);
    // Уже известный ключ не перезаписываем: у сохранённого могут быть
    // пропущенные ключи сообщений, которых нет в повторной раздаче.
    if (await store.groupSessions.load(roomId, senderDeviceId, key)) return;
    // Устройство принадлежит одному пользователю. Запоминаем кому, чтобы
    // сервер не мог выдать сообщение этого устройства за чужое.
    session.senderUserId = senderUserId;
    await store.groupSessions.save(roomId, senderDeviceId, key, session);
}

// Конверт с ключом может прийти дважды: по сокету и в истории, пока
// подтверждение ещё не дошло до сервера. Второй раз его не расшифровать
// (ключ сообщения одноразовый), и пытаться незачем.
const processedKeyEnvelopes = new Set();

async function acceptKeyEnvelopes(list) {
    const done = [];
    for (const e of list) {
        if (processedKeyEnvelopes.has(e.id)) continue;
        processedKeyEnvelopes.add(e.id);
        try {
            const text = await openEnvelope(e.sender_user_id, e.sender_device_id, e);
            const d = parseDistribution(text);
            if (d) await importKeyDistribution(e.sender_user_id, e.sender_device_id, d, e.room_id);
            else if (text !== null) console.warn('[E2EE] в конверте ключа не раздача ключа — пропущен');
        } catch (err) {
            console.warn('[E2EE] sender key не принят:', err.message);
        }
        // Подтверждаем в любом случае: повторно этот конверт всё равно не
        // расшифровать.
        done.push(e.id);
    }
    if (done.length > 0) {
        try {
            await state.api('/api/sender-keys/ack', { method: 'POST', body: JSON.stringify({ ids: done }) });
        } catch (err) {
            console.warn('[E2EE] не удалось подтвердить получение ключей:', err.message);
        }
    }
}

/** Конверты с sender keys из истории чата — обработать до сообщений. */
export function processKeyEnvelopes(list) {
    if (!state.ready || !Array.isArray(list) || list.length === 0) return Promise.resolve();
    return serialized(() => acceptKeyEnvelopes(list));
}

async function openGroupMessage(message) {
    const senderDeviceId = message.sender_device_id;
    const roomId = message.room_id;
    if (!senderDeviceId || !roomId) return null;
    try {
        const header = fromB64(message.group.header);
        const key = distributionKey(parseGroupHeader(header).distributionId);
        const session = await store.groupSessions.load(roomId, senderDeviceId, key);
        // Ключа нет: сообщение отправлено до того, как это устройство
        // появилось в группе, — как и в попарной схеме, это заглушка.
        if (!session || session.senderUserId !== message.user_id) return null;
        const text = await decryptGroup(session, header,
            fromB64(message.group.ciphertext), fromB64(message.group.signature));
        await store.groupSessions.save(roomId, senderDeviceId, key, session);
        return text;
    } catch (e) {
        console.warn('[E2EE] групповое сообщение не расшифровано:', e.message);
        return null;
    }
}

/* ------------------------------------------------------------------
   Расшифровка
   ------------------------------------------------------------------ */

/**
 * Расшифровать входящее сообщение.
 *
 * Возвращает строку либо null — читать нечем. null не ошибка: так выглядит
 * сообщение, отправленное до того, как это устройство появилось, и клиент
 * обязан показать заглушку, а не пустой пузырь.
 */
export function decryptIncoming(message) {
    return serialized(() => decryptIncomingNow(message));
}

async function decryptIncomingNow(message) {
    if (!state.ready || !message) return null;
    const senderUserId = message.user_id;

    // По сокету конверт с ключом приходит вместе с сообщением. Он первым:
    // без ключа групповое сообщение не расшифровать.
    if (message.keyEnvelope) {
        await acceptKeyEnvelopes([{ ...message.keyEnvelope, sender_user_id: senderUserId, room_id: message.room_id }]);
    }

    if (message.group) {
        const text = await openGroupMessage(message);
        if (text !== null) await rememberPlaintext(message, text);
        return text;
    }

    if (!message.envelope) return null;
    const senderDeviceId = message.envelope.sender_device_id || message.sender_device_id;
    const text = await openEnvelope(senderUserId, senderDeviceId, message.envelope);
    if (text === null) return null;

    // Раздача ключа — служебное, а не содержимое. Если она пришла как
    // обычное сообщение (так её мог бы подсунуть сервер), ключ принимаем,
    // но показывать нечего.
    const d = parseDistribution(text);
    if (d) {
        try {
            await importKeyDistribution(senderUserId, senderDeviceId, d, message.room_id);
        } catch (err) {
            console.warn('[E2EE] sender key не принят:', err.message);
        }
        return null;
    }
    await rememberPlaintext(message, text);
    return text;
}

/* ------------------------------------------------------------------
   Локальный кэш расшифрованного — см. комментарий у store.plaintext.
   ------------------------------------------------------------------ */

// Переписка — комната, а чат без комнаты (бот) — сам по себе. У сообщения
// в комнате chat_id — чат отправителя, а не читающего, поэтому ключ по
// комнате: иначе превью полученных сообщений ложились не туда.
const conversationKey = message => (message.room_id ? `room:${message.room_id}` : `chat:${message.chat_id}`);
const conversationOfChat = chat => (chat.room_id ? `room:${chat.room_id}` : `chat:${chat.id}`);

async function rememberPlaintext(message, text) {
    await store.plaintext.save(message.id, text);
    const key = conversationKey(message);
    const ids = await store.conversations.load(key);
    if (!ids.includes(message.id)) {
        ids.push(message.id);
        await store.conversations.save(key, ids);
    }
}

async function forgetNow(message) {
    await store.plaintext.drop(message.id);
    const key = conversationKey(message);
    const ids = await store.conversations.load(key);
    if (ids.includes(message.id)) await store.conversations.save(key, ids.filter(id => id !== message.id));
    const preview = await store.previews.load(key);
    if (preview && preview.messageId === message.id) await store.previews.drop(key);
}

/** Своё отправленное: конверт себе не шлётся, текст кладём сами. */
export const rememberSent = (message, text) => serialized(() => rememberPlaintext(message, text));
export const recallPlaintext = messageId => store.plaintext.load(messageId);

/**
 * Сообщение удалено или исчезло по сроку — стереть его расшифрованный
 * текст (а вместе с ним и ключ вложения, он лежит там же) и превью, если
 * оно было про это сообщение.
 */
export const forgetMessage = message => serialized(() => forgetNow(message));

/**
 * Что из этой переписки у нас лежит расшифрованным. Берётся ДО запроса
 * истории, чтобы forgetMissing не тронул сообщение, пришедшее, пока
 * история загружалась.
 */
export const knownMessages = chat => store.conversations.load(conversationOfChat(chat));

/**
 * Стереть расшифрованное для сообщений, которых в истории больше нет:
 * удалены или исчезли, пока это устройство было не в сети.
 */
export function forgetMissing(chat, known, liveIds) {
    const live = new Set(liveIds.map(Number));
    const gone = known.filter(id => !live.has(Number(id)));
    if (gone.length === 0) return Promise.resolve();
    return serialized(async () => {
        for (const id of gone) await forgetNow({ id, room_id: chat.room_id, chat_id: chat.id });
    });
}

/** Из чата вышли — стереть всё, что от него осталось на устройстве. */
export function forgetConversation(chat) {
    return serialized(async () => {
        const key = conversationOfChat(chat);
        for (const id of await store.conversations.load(key)) await store.plaintext.drop(id);
        await store.conversations.drop(key);
        await store.previews.drop(key);
        if (chat.room_id) {
            await store.senderKeys.drop(chat.room_id);
            await store.groupSessions.dropRoom(chat.room_id);
        }
    });
}

/**
 * Выход из аккаунта: стереть всё — ключи, сессии, расшифрованную
 * переписку. Устройство при этом отзывается на сервере, иначе собеседники
 * продолжали бы шифровать для него.
 */
export function wipeDevice() {
    return serialized(async () => {
        const deviceId = state.deviceId;
        if (deviceId && state.api) {
            try {
                await state.api(`/api/devices/${deviceId}`, { method: 'DELETE' });
            } catch (e) {
                console.warn('[E2EE] устройство не отозвано:', e.message);
            }
        }
        await store.wipe();
        state.ready = false;
        state.deviceId = null;
        state.identity = null;
    });
}

/* Превью последнего сообщения: сервер шифротекст прочитать не может. */
export const rememberPreview = (message, text) =>
    store.previews.save(conversationKey(message), { text, messageId: message.id });
export const recallPreview = async chat => {
    const entry = await store.previews.load(conversationOfChat(chat));
    return entry && typeof entry.text === 'string' ? entry.text : null;
};

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
/**
 * Сверено ли устройство, с которого пришло сообщение. 'new' — собеседник
 * сверен, а этого устройства при сверке не было: писать на него мы не
 * дадим (assertVerifiedTargets), а читать его сообщения — читаем, но
 * человек должен видеть, что они с непроверенного устройства. Так выглядела
 * бы и подмена сервером. 'verified' — было при сверке; 'unverified' —
 * собеседника не сверяли вовсе, отмечать нечего.
 */
export async function senderDeviceTrust(userId, deviceId) {
    if (!userId || !deviceId || userId === state.userId) return 'unverified';
    const record = await store.verified.load(userId);
    if (!record) return 'unverified';
    return record.devices.some(d => d.deviceId === Number(deviceId)) ? 'verified' : 'new';
}

export async function verificationStatus(devices) {
    const result = new Map();
    for (const [userId, deviceIds] of groupByUser(devices)) {
        result.set(userId, verificationState(await store.verified.load(userId), deviceIds));
    }
    return result;
}
