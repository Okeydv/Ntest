// Тесты ядра E2EE (этап A2). Запуск: node scripts/test-e2ee-crypto.mjs
//
// Node выведет предупреждение MODULE_TYPELESS_PACKAGE_JSON: в package.json
// нет "type": "module", потому что server.js — CommonJS, и добавить его
// нельзя. Node распознаёт ES-модуль по синтаксису и работает, предупреждение
// косметическое. Браузеру package.json не важен вовсе.
//
// Ни сервера, ни базы, ни браузера здесь не нужно: public/crypto/e2ee.js
// написан на чистом WebCrypto, поэтому тот же файл исполняется в Node.
//
// Проверяется и то, что должно работать (переписка, смена ratchet-ключа,
// доставка не по порядку), и то, что работать НЕ должно: подмена
// шифротекста, подмена заголовка, битая подпись signed prekey, повторное
// использование one-time prekey, отправка первым без сессии.

import {
    generateIdentity, exportIdentityPublic, generateSignedPrekey, generateOneTimePrekeys,
    initiateSession, acceptSession, encryptMessage, decryptMessage, decryptToText,
    exportSession, importSession, parseHeader, toB64, fromB64,
    ENVELOPE_PREKEY, ENVELOPE_NORMAL,
} from '../public/crypto/e2ee.js';
import { userFingerprint, combineFingerprints, formatSafetyNumber } from '../public/crypto/safety.js';
import {
    createSenderKey, senderKeyDistribution, encryptGroup, importDistribution, decryptGroup, parseGroupHeader,
} from '../public/crypto/group.js';

let fails = 0;
const check = (label, cond, detail = '') => {
    console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!cond) fails++;
};
async function throws(label, fn, expectMatch) {
    try {
        await fn();
        check(label, false, 'исключения не было');
    } catch (e) {
        const matched = !expectMatch || new RegExp(expectMatch, 'i').test(e.message);
        check(label, matched, matched ? '' : `другое сообщение: ${e.message}`);
    }
}

/** Устройство: личность, signed prekey и пул OPK, как это будет на клиенте. */
async function makeDevice(opkCount = 3) {
    // extractable: true только для теста — в браузере identity-ключи
    // создаются неизвлекаемыми и живут в IndexedDB.
    const identity = await generateIdentity({ extractable: true });
    const spk = await generateSignedPrekey(identity, 1);
    const opks = await generateOneTimePrekeys(1, opkCount);
    const pool = new Map(opks.items.map(o => [o.keyId, o]));
    return {
        identity, spk, pool,
        lookupSignedPrekey: async id => (id === spk.keyId ? spk : null),
        // Использованный OPK удаляется: повтор убил бы forward secrecy
        // первого сообщения, ровно как и на сервере, где он удаляется при
        // выдаче bundle.
        lookupOneTimePrekey: async id => {
            const o = pool.get(id);
            if (o) pool.delete(id);
            return o || null;
        },
        async bundle({ withOpk = true } = {}) {
            const pub = await exportIdentityPublic(identity);
            const opk = withOpk ? [...pool.values()][0] : null;
            return {
                ...pub,
                signed_prekey: spk.upload,
                one_time_prekey: opk ? { key_id: opk.keyId, public_key: toB64(opk.publicKey) } : null,
            };
        },
    };
}

const send = async (session, text) => {
    const m = await encryptMessage(session, text);
    // Имитируем путь через сервер: по сети едут base64-строки, и обратно
    // должны прийти те же байты — иначе развалится AAD.
    return {
        type: m.type,
        header: fromB64(toB64(m.header)),
        ciphertext: fromB64(toB64(m.ciphertext)),
    };
};
const recv = (session, m) => decryptToText(session, m.header, m.ciphertext);

/* ===================== ключи устройства ===================== */

{
    const d = await makeDevice();
    const pub = await exportIdentityPublic(d.identity);
    check('identity: два ключа по 32 байта',
        fromB64(pub.identity_signing_key).length === 32 && fromB64(pub.identity_dh_key).length === 32);
    check('signed prekey: подпись 64 байта над сырым публичным ключом',
        fromB64(d.spk.upload.signature).length === 64 && fromB64(d.spk.upload.public_key).length === 32);

    // Ровно та проверка, что делает e2ee-key-server (crypto::verify_signed_prekey)
    const vk = await crypto.subtle.importKey('raw', fromB64(pub.identity_signing_key), { name: 'Ed25519' }, false, ['verify']);
    check('подпись проходит проверку тем же способом, что на key-server',
        await crypto.subtle.verify({ name: 'Ed25519' }, vk, fromB64(d.spk.upload.signature), fromB64(d.spk.upload.public_key)));

    const opks = await generateOneTimePrekeys(5, 4);
    check('one-time prekeys нумеруются с заданного id',
        opks.upload.keys.map(k => k.key_id).join(',') === '5,6,7,8');
}

/* ===================== переписка ===================== */

const alice = await makeDevice();
const bob = await makeDevice();

let aliceSession = await initiateSession({ identity: alice.identity, bundle: await bob.bundle() });
const first = await send(aliceSession, 'Привет, это первое сообщение');
check('первое сообщение — prekey-тип', first.type === ENVELOPE_PREKEY);
check('prekey-заголовок 146 байт, обычный 42', first.header.length === 146);

let bobSession = await acceptSession({
    identity: bob.identity,
    header: parseHeader(first.header),
    lookupSignedPrekey: bob.lookupSignedPrekey,
    lookupOneTimePrekey: bob.lookupOneTimePrekey,
});
check('получатель расшифровал первое сообщение', await recv(bobSession, first) === 'Привет, это первое сообщение');

const reply = await send(bobSession, 'И тебе привет');
check('ответ — обычный тип, заголовок 42 байта',
    reply.type === ENVELOPE_NORMAL && reply.header.length === 42);
check('инициатор расшифровал ответ (сработал DH-рэтчет)', await recv(aliceSession, reply) === 'И тебе привет');

const second = await send(aliceSession, 'Теперь без prekey');
check('после ответа prekey-часть больше не отправляется', second.type === ENVELOPE_NORMAL);
check('второе сообщение расшифровано', await recv(bobSession, second) === 'Теперь без prekey');

/* ===================== несколько подряд и ключи меняются ===================== */

{
    const msgs = [];
    for (let i = 0; i < 5; i++) msgs.push(await send(aliceSession, `подряд ${i}`));
    const cts = msgs.map(m => toB64(m.ciphertext));
    check('ключ каждого сообщения свой: шифротексты не повторяются',
        new Set(cts).size === 5);
    let allOk = true;
    for (let i = 0; i < 5; i++) if (await recv(bobSession, msgs[i]) !== `подряд ${i}`) allOk = false;
    check('цепочка из 5 сообщений расшифрована по порядку', allOk);

    const same1 = await send(aliceSession, 'одинаковый текст');
    const same2 = await send(aliceSession, 'одинаковый текст');
    check('одинаковый текст даёт разные шифротексты',
        toB64(same1.ciphertext) !== toB64(same2.ciphertext));
    await recv(bobSession, same1); await recv(bobSession, same2);
}

/* ===================== доставка не по порядку ===================== */

{
    const m1 = await send(aliceSession, 'первое');
    const m2 = await send(aliceSession, 'второе');
    const m3 = await send(aliceSession, 'третье');
    check('сообщение из середины расшифровано вне очереди', await recv(bobSession, m2) === 'второе');
    check('опоздавшее первое расшифровано из сохранённых ключей', await recv(bobSession, m1) === 'первое');
    check('следующее по порядку по-прежнему расшифровывается', await recv(bobSession, m3) === 'третье');

    await throws('повторная доставка того же сообщения отвергается',
        () => recv(bobSession, m1));
}

/* ===================== смена направления несколько раз ===================== */

{
    let ok = true;
    for (let round = 0; round < 3; round++) {
        const a = await send(aliceSession, `A${round}`);
        if (await recv(bobSession, a) !== `A${round}`) ok = false;
        const b = await send(bobSession, `B${round}`);
        if (await recv(aliceSession, b) !== `B${round}`) ok = false;
    }
    check('три полных обмена с рэтчетом в обе стороны', ok);
}

/* ===================== целостность ===================== */

{
    const m = await send(aliceSession, 'секрет');

    const badCt = { ...m, ciphertext: new Uint8Array(m.ciphertext) };
    badCt.ciphertext[0] ^= 0x01;
    await throws('подмена одного бита шифротекста отвергается', () => recv(bobSession, badCt));

    // Заголовок входит в AAD: менять его нельзя даже в части, которую
    // расшифровка формально не использует.
    const badHeader = { ...m, header: new Uint8Array(m.header) };
    badHeader.header[34] ^= 0x01; // поле pn
    await throws('подмена заголовка отвергается (он в AAD)', () => recv(bobSession, badHeader));

    check('после отказов исходное сообщение всё ещё читается', await recv(bobSession, m) === 'секрет');
}

/* ===================== аутентичность bundle ===================== */

{
    const victim = await makeDevice();
    const attacker = await makeDevice();
    const bundle = await victim.bundle();
    // Сервер подменяет prekey на свой, подпись остаётся от жертвы
    bundle.signed_prekey = { ...bundle.signed_prekey, public_key: attacker.spk.upload.public_key };
    await throws('подменённый signed prekey отвергается по подписи',
        () => initiateSession({ identity: alice.identity, bundle }), 'подпись');

    const bundle2 = await victim.bundle();
    bundle2.identity_signing_key = attacker.bundle ? (await attacker.bundle()).identity_signing_key : bundle2.identity_signing_key;
    await throws('подменённый identity-ключ отвергается по подписи',
        () => initiateSession({ identity: alice.identity, bundle: bundle2 }), 'подпись');
}

/* ===================== X3DH без one-time prekey ===================== */

{
    const carol = await makeDevice();
    const s = await initiateSession({ identity: alice.identity, bundle: await carol.bundle({ withOpk: false }) });
    const m = await send(s, 'без OPK');
    const h = parseHeader(m.header);
    check('без OPK в заголовке стоит 0', h.oneTimePrekeyId === null);
    const carolSession = await acceptSession({
        identity: carol.identity, header: h,
        lookupSignedPrekey: carol.lookupSignedPrekey, lookupOneTimePrekey: carol.lookupOneTimePrekey,
    });
    check('сессия без OPK работает (деградация X3DH)', await recv(carolSession, m) === 'без OPK');
}

/* ===================== one-time prekey одноразовый ===================== */

{
    const dave = await makeDevice();
    const b = await dave.bundle();
    const s = await initiateSession({ identity: alice.identity, bundle: b });
    const m = await send(s, 'раз');
    const h = parseHeader(m.header);
    await acceptSession({
        identity: dave.identity, header: h,
        lookupSignedPrekey: dave.lookupSignedPrekey, lookupOneTimePrekey: dave.lookupOneTimePrekey,
    });
    await throws('повторное использование того же OPK отвергается',
        () => acceptSession({
            identity: dave.identity, header: h,
            lookupSignedPrekey: dave.lookupSignedPrekey, lookupOneTimePrekey: dave.lookupOneTimePrekey,
        }), 'one-time prekey');
}

/* ===================== сохранение сессии ===================== */

{
    const eve = await makeDevice();
    let s1 = await initiateSession({ identity: alice.identity, bundle: await eve.bundle() });
    const m0 = await send(s1, 'до перезагрузки');
    let s2 = await acceptSession({
        identity: eve.identity, header: parseHeader(m0.header),
        lookupSignedPrekey: eve.lookupSignedPrekey, lookupOneTimePrekey: eve.lookupOneTimePrekey,
    });
    await recv(s2, m0);

    // Перезагрузка страницы: состояние выгружено, прошло через JSON и
    // загружено обратно.
    const dumped = JSON.parse(JSON.stringify(await exportSession(s1)));
    const dumped2 = JSON.parse(JSON.stringify(await exportSession(s2)));
    check('состояние сессии сериализуется в JSON', typeof dumped.rootKey === 'string');
    s1 = await importSession(dumped);
    s2 = await importSession(dumped2);

    const m1 = await send(s1, 'после перезагрузки');
    check('переписка продолжается после восстановления состояния',
        await recv(s2, m1) === 'после перезагрузки');
    const m2 = await send(s2, 'ответ после перезагрузки');
    check('и в обратную сторону', await recv(s1, m2) === 'ответ после перезагрузки');
}

/* ===================== порядок и пределы ===================== */

{
    const frank = await makeDevice();
    const s = await acceptSession({
        identity: frank.identity,
        header: parseHeader((await send(
            await initiateSession({ identity: alice.identity, bundle: await frank.bundle() }), 'x')).header),
        lookupSignedPrekey: frank.lookupSignedPrekey, lookupOneTimePrekey: frank.lookupOneTimePrekey,
    });
    await throws('получатель не может отправить первым, пока не расшифровал',
        () => encryptMessage(s, 'нельзя'), 'первым');
}

{
    const grace = await makeDevice();
    const s = await initiateSession({ identity: alice.identity, bundle: await grace.bundle() });
    const m = await send(s, 'первое');
    const gs = await acceptSession({
        identity: grace.identity, header: parseHeader(m.header),
        lookupSignedPrekey: grace.lookupSignedPrekey, lookupOneTimePrekey: grace.lookupOneTimePrekey,
    });
    await recv(gs, m);
    // Заголовок с гигантским n: без предела это заставило бы вывести
    // миллионы ключей и съесть память.
    const big = await send(s, 'далёкое');
    const view = new DataView(big.header.buffer, big.header.byteOffset, big.header.byteLength);
    view.setUint32(38, 5000, false);
    await throws('слишком большой пропуск сообщений отвергается', () => recv(gs, big), 'предел');
}

/* ===================== разные устройства — разные сессии ===================== */

{
    const phone = await makeDevice();
    const laptop = await makeDevice();
    const sPhone = await initiateSession({ identity: alice.identity, bundle: await phone.bundle() });
    const sLaptop = await initiateSession({ identity: alice.identity, bundle: await laptop.bundle() });

    const mPhone = await send(sPhone, 'одно и то же');
    const mLaptop = await send(sLaptop, 'одно и то же');
    check('один текст двум устройствам даёт разные конверты',
        toB64(mPhone.ciphertext) !== toB64(mLaptop.ciphertext));

    const phoneSession = await acceptSession({
        identity: phone.identity, header: parseHeader(mPhone.header),
        lookupSignedPrekey: phone.lookupSignedPrekey, lookupOneTimePrekey: phone.lookupOneTimePrekey,
    });
    check('устройство читает свой конверт', await recv(phoneSession, mPhone) === 'одно и то же');
    await throws('чужой конверт тем же устройством не читается',
        () => recv(phoneSession, mLaptop));
}

// --- код безопасности ------------------------------------------------------
{
    const dev = async deviceId => {
        const pub = await exportIdentityPublic(await generateIdentity({ extractable: false }));
        return { deviceId, signingKey: pub.identity_signing_key, dhKey: pub.identity_dh_key };
    };
    const a1 = await dev(1), b1 = await dev(2), b2 = await dev(3);

    const fa = await userFingerprint(10, [a1]);
    const fb = await userFingerprint(20, [b1, b2]);
    check('отпечаток пользователя — 30 цифр', /^\d{30}$/.test(fa));
    check('порядок устройств на отпечаток не влияет', fb === await userFingerprint(20, [b2, b1]));
    check('код одинаков у обеих сторон', combineFingerprints(fa, fb) === combineFingerprints(fb, fa));
    check('код — 12 групп по 5 цифр', formatSafetyNumber(combineFingerprints(fa, fb)).length === 12);
    check('новое устройство меняет отпечаток', fb !== await userFingerprint(20, [b1]));
    check('отпечаток привязан к пользователю', fb !== await userFingerprint(21, [b1, b2]));
    const forged = { ...b2, dhKey: (await dev(3)).dhKey };
    check('подмена одного лишь DH-ключа меняет отпечаток', fb !== await userFingerprint(20, [b1, forged]));
    await throws('без устройств отпечатка нет', () => userFingerprint(20, []));
}

// --- sender keys -----------------------------------------------------------
{
    const alice = await createSenderKey();
    const dist = senderKeyDistribution(alice);
    const bob = importDistribution(dist);
    const carol = importDistribution(dist);

    const m1 = await encryptGroup(alice, 'всем привет');
    check('один шифротекст читают все получатели',
        await decryptGroup(bob, m1.header, m1.ciphertext, m1.signature) === 'всем привет' &&
        await decryptGroup(carol, m1.header, m1.ciphertext, m1.signature) === 'всем привет');
    check('заголовок — 21 байт, номер растёт', m1.header.length === 21 && parseGroupHeader(m1.header).iteration === 0);

    await throws('повтор того же сообщения не проходит',
        () => decryptGroup(bob, m1.header, m1.ciphertext, m1.signature));

    const m2 = await encryptGroup(alice, 'второе');
    const m3 = await encryptGroup(alice, 'третье');
    check('доставка не по порядку: сначала третье',
        await decryptGroup(bob, m3.header, m3.ciphertext, m3.signature) === 'третье');
    check('потом второе — ключ из пропущенных',
        await decryptGroup(bob, m2.header, m2.ciphertext, m2.signature) === 'второе');

    const m4 = await encryptGroup(alice, 'подпись');
    const flipped = m4.ciphertext.slice(); flipped[0] ^= 1;
    await throws('подменённый шифротекст не проходит проверку подписи',
        () => decryptGroup(carol, m4.header, flipped, m4.signature), /подпись/);

    // Участник знает цепочку, но не ключ подписи отправителя — подделать
    // сообщение от его имени не может.
    const forger = await createSenderKey();
    Object.assign(forger, { distributionId: alice.distributionId, chainKey: alice.chainKey, iteration: alice.iteration });
    const forged = await encryptGroup(forger, 'от имени Алисы');
    await throws('участник не может писать от чужого имени',
        () => decryptGroup(carol, forged.header, forged.ciphertext, forged.signature), /подпись/);
    check('после подделки сессия не сдвинулась', carol.iteration === 1);
    check('и настоящее сообщение читается',
        await decryptGroup(carol, m4.header, m4.ciphertext, m4.signature) === 'подпись');

    // Новый участник получает ТЕКУЩЕЕ состояние цепочки.
    const dave = importDistribution(senderKeyDistribution(alice));
    await throws('новый участник не читает то, что было до него',
        () => decryptGroup(dave, m1.header, m1.ciphertext, m1.signature));
    const m5 = await encryptGroup(alice, 'для всех, включая новенького');
    check('а новое — читает', await decryptGroup(dave, m5.header, m5.ciphertext, m5.signature) === 'для всех, включая новенького');

    const other = await createSenderKey();
    const foreign = await encryptGroup(other, 'чужой ключ');
    await throws('сообщение под другим sender key отвергается',
        () => decryptGroup(bob, foreign.header, foreign.ciphertext, foreign.signature), /другим sender key/);

    const far = await createSenderKey();
    const farSession = importDistribution(senderKeyDistribution(far));
    far.iteration = 5000;
    const jump = await encryptGroup(far, 'далеко');
    await throws('пропуск больше предела отвергается',
        () => decryptGroup(farSession, jump.header, jump.ciphertext, jump.signature), /предел/);

    await throws('битая distribution отвергается', () => importDistribution({ ...dist, chain: 'AAAA' }));
}

console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
