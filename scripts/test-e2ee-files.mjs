// Сквозной тест зашифрованных вложений и индикатора шифрования (этап B).
//
// Фотография с GPS-координатами и именем автора в EXIF отправляется через
// поле выбора файла, как это делает человек. Проверяется:
//   - получатель видит картинку, расшифрованную у себя
//   - в том, что он видит, метаданных нет (очистка на клиенте), а
//     ориентация снимка при этом сохранена
//   - сервер хранит непрозрачные байты: ни JPEG-сигнатуры, ни строк из EXIF
//   - чужой скачать вложение не может
//   - файл, который не картинка, можно только скачать, но не открыть
//   - удаление сообщения удаляет вложение с диска по-настоящему
//   - шапка чата честно говорит, шифруется ли переписка
//
// Требует поднятых Postgres, key-server и server.js на 3006 (см.
// scripts/integration-test-devices.mjs) и ЧИСТОЙ базы. Для проверок на
// стороне сервера нужен TEST_DATABASE_URL той же базы.
//
// Запуск: TEST_DATABASE_URL=... node scripts/test-e2ee-files.mjs

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import sharp from 'sharp';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:3006';
const BLOBS_DIR = path.resolve('encrypted-blobs');
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

let fails = 0;
const check = (l, c, d = '') => {
    console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`);
    if (!c) fails++;
};

/* ------------------------- подопытные файлы ------------------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxo-files-'));
const AUTHOR = 'Ivan Petrov';
// Снято «боком»: пиксели 40x20, тег Orientation=6 велит повернуть на 90°.
// После честной очистки картинка должна стать 20x40 уже без тега.
const photoPath = path.join(tmp, 'IMG_0001.jpg');
fs.writeFileSync(photoPath, await sharp({ create: { width: 40, height: 20, channels: 3, background: '#3a7bd5' } })
    .jpeg()
    .withExifMerge({
        IFD0: { Copyright: AUTHOR, Make: 'Canon', Model: 'EOS R5', Orientation: '6' },
        GPS: { GPSLatitudeRef: 'N', GPSLatitude: '55/1 45/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '37/1 37/1 0/1' },
    })
    .withMetadata({ orientation: 6 })
    .toBuffer());
const docPath = path.join(tmp, 'plan.txt');
fs.writeFileSync(docPath, '<script>alert("xss")</script> секретный план');

const srcMeta = await sharp(photoPath).metadata();
check('исходное фото действительно несёт EXIF и ориентацию',
    !!srcMeta.exif && srcMeta.exif.toString('latin1').includes(AUTHOR) && srcMeta.orientation === 6);

/* ------------------------- участники и чат ------------------------- */

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
async function openApp(label) {
    const page = await (await browser.newContext()).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return { page, errors, label };
}
const register = (app, u, e) => app.page.evaluate(async ([u, e]) => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: u, email: e, password: 'password123', confirmPassword: 'password123' }) });
    if (!r.success) throw new Error(r.message);
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
    return { userId: r.user.id, deviceId: e2eeDeviceId };
}, [u, e]);

const ROOM_CHAT = '.chat-item[data-room-id]:not([data-room-id=""])';
const BOT_CHAT = '.chat-item[data-room-id=""]';
const openChatFromList = async (app, selector = ROOM_CHAT) => {
    await app.page.reload({ waitUntil: 'networkidle' });
    await app.page.waitForTimeout(1200);
    await app.page.locator(selector).first().click({ timeout: 8000 });
    await app.page.waitForTimeout(800);
};

const alice = await openApp('alice');
await register(alice, 'alice', 'alice@example.com');
const code = await alice.page.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Фотоархив' }) });
    return (await api(`/api/chats/invite/${c.chat.id}`)).code;
});
const bob = await openApp('bob');
await register(bob, 'bob', 'bob@example.com');
await bob.page.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);

/* ------------------------- индикатор ------------------------- */

await openChatFromList(alice, BOT_CHAT);
const botBadge = await alice.page.evaluate(() => {
    const b = document.getElementById('chat-encryption');
    return { cls: b.className, text: b.textContent.trim() };
});
check('чат с ботом честно помечен как незашифрованный',
    botBadge.cls.includes('is-off') && /бот/.test(botBadge.text), botBadge.text);

await openChatFromList(alice);
await openChatFromList(bob);
await alice.page.waitForTimeout(400);
const roomBadge = await alice.page.evaluate(() => {
    const b = document.getElementById('chat-encryption');
    return { cls: b.className, text: b.textContent.trim() };
});
check('общий чат помечен сквозным шифрованием',
    roomBadge.cls.includes('is-on') && /Сквозное/.test(roomBadge.text), roomBadge.text);

/* ------------------------- фото ------------------------- */

await alice.page.setInputFiles('#file-input', photoPath);
await bob.page.waitForSelector('#chat-messages img.message-image', { timeout: 10000 }).catch(() => {});
await bob.page.waitForTimeout(800);

// fetch() по blob:-адресу запрещён CSP (connect-src без blob:), и
// ослаблять политику ради теста нельзя. Поэтому байты, которые видит
// получатель, получаем тем же путём, что и приложение: ключ — из
// расшифрованной полезной нагрузки в локальном кэше, шифротекст — с сервера.
const seen = await bob.page.evaluate(async () => {
    const img = document.querySelector('#chat-messages img.message-image');
    if (!img) return null;
    await img.decode().catch(() => {});
    const client = await import('/crypto/client.js');
    const payload = JSON.parse(await client.recallPlaintext(img.closest('.message').dataset.messageId));
    const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const ct = await (await fetch(`/api/blobs/${payload.blob}`)).arrayBuffer();
    const key = await crypto.subtle.importKey('raw', b64(payload.key), { name: 'AES-GCM' }, false, ['decrypt']);
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(payload.iv) }, key, ct));
    const latin1 = Array.from(bytes, b => String.fromCharCode(b)).join('');
    return {
        src: img.src.slice(0, 5),
        width: img.naturalWidth,
        height: img.naturalHeight,
        isJpeg: bytes[0] === 0xFF && bytes[1] === 0xD8,
        hasExif: latin1.includes('Exif\0\0'),
        hasAuthor: latin1.includes('Ivan Petrov'),
        hasCanon: latin1.includes('Canon'),
        locked: !!document.querySelector('#chat-messages .message-encrypted'),
    };
});
check('получатель видит картинку, расшифрованную у себя (blob:)', seen && seen.src === 'blob:', JSON.stringify(seen));
check('в полученной картинке нет EXIF, имени автора и модели камеры',
    seen && seen.isJpeg && !seen.hasExif && !seen.hasAuthor && !seen.hasCanon);
check('ориентация снимка сохранена: 40x20 «боком» стал 20x40',
    seen && seen.width === 20 && seen.height === 40, seen && `${seen.width}x${seen.height}`);
check('сообщение помечено замком', seen && seen.locked);

const ownImg = await alice.page.$('#chat-messages img.message-image');
check('отправитель видит своё фото сразу', !!ownImg);

/* ------------------------- что лежит на сервере ------------------------- */

const { rows: blobs } = await db.query('SELECT id, message_id, size FROM encrypted_blobs ORDER BY created_at');
check('вложение записано и привязано к сообщению', blobs.length === 1 && blobs[0].message_id !== null);
const blobId = blobs[0] && blobs[0].id;
const onDisk = blobId ? fs.readFileSync(path.join(BLOBS_DIR, `${blobId}.bin`)) : Buffer.alloc(0);
check('на диске сервера не JPEG: нет сигнатуры FF D8 FF',
    onDisk.length > 0 && !(onDisk[0] === 0xFF && onDisk[1] === 0xD8 && onDisk[2] === 0xFF));
check('на диске сервера нет строк из EXIF', !onDisk.toString('latin1').includes(AUTHOR)
    && !onDisk.toString('latin1').includes('Canon'));
const { rows: msgRows } = await db.query('SELECT text, encrypted, file_url, file_name FROM messages WHERE id = $1', [blobs[0].message_id]);
check('у сообщения в базе нет ни текста, ни имени файла',
    msgRows[0].encrypted && msgRows[0].text === null && msgRows[0].file_url === null && msgRows[0].file_name === null);

const raw = await bob.page.evaluate(async id => {
    const r = await fetch(`/api/blobs/${id}`);
    return { status: r.status, type: r.headers.get('content-type') };
}, blobId);
check('сервер отдаёт вложение как непрозрачные байты', raw.status === 200 && raw.type === 'application/octet-stream');

const carol = await openApp('carol');
await register(carol, 'carol', 'carol@example.com');
const stranger = await carol.page.evaluate(async id => (await fetch(`/api/blobs/${id}`)).status, blobId);
check('посторонний скачать вложение не может', stranger === 404, `status ${stranger}`);

/* ------------------------- не картинка ------------------------- */

await alice.page.setInputFiles('#file-input', docPath);
await bob.page.waitForTimeout(2000);
const link = await bob.page.evaluate(() => {
    const a = document.querySelector('#chat-messages .file-attachment a[download]');
    return a ? { href: a.href.slice(0, 5), download: a.getAttribute('download'), target: a.getAttribute('target') } : null;
});
check('файл-не-картинку можно только скачать: blob-ссылка с download, без target',
    link && link.href === 'blob:' && link.download === 'plan.txt' && link.target === null, JSON.stringify(link));
// Файл с HTML внутри не должен исполняться, даже если открыть ссылку
// напрямую: blob отдаётся как octet-stream, и браузер его скачивает, а не
// рисует в нашем origin рядом с ключами.
const docHref = await bob.page.evaluate(() =>
    document.querySelector('#chat-messages .file-attachment a[download]').href);
const probe = await bob.page.context().newPage();
const downloaded = probe.waitForEvent('download', { timeout: 5000 }).then(() => true).catch(() => false);
await probe.goto(docHref).catch(() => {});
const wasDownloaded = await downloaded;
const rendered = await probe.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
check('ссылка на файл не рисует его в нашем origin, а только скачивает',
    wasDownloaded && !rendered.includes('секретный план'), `download=${wasDownloaded}`);
await probe.close();

/* ------------------------- история после перезагрузки ------------------------- */

await openChatFromList(bob);
await bob.page.waitForSelector('#chat-messages img.message-image', { timeout: 8000 }).catch(() => {});
check('после перезагрузки фото у получателя на месте',
    !!(await bob.page.$('#chat-messages img.message-image')));

/* ------------------------- удаление ------------------------- */

const photoMessageId = blobs[0].message_id;
const del = await alice.page.evaluate(id => api(`/api/messages/${id}`, { method: 'DELETE' }), photoMessageId);
const { rows: after } = await db.query('SELECT count(*)::int AS n FROM encrypted_blobs WHERE id = $1', [blobId]);
const { rows: env } = await db.query('SELECT count(*)::int AS n FROM message_envelopes WHERE message_id = $1', [photoMessageId]);
check('удаление сообщения удаляет вложение из базы и конверты',
    del.success && after[0].n === 0 && env[0].n === 0);
check('и файл с диска', !fs.existsSync(path.join(BLOBS_DIR, `${blobId}.bin`)));
const gone = await bob.page.evaluate(async id => (await fetch(`/api/blobs/${id}`)).status, blobId);
check('скачать удалённое вложение нельзя', gone === 404);

/* ------------------------- ошибок нет ------------------------- */

const errors = [...alice.errors, ...bob.errors, ...carol.errors];
check('ошибок на страницах нет', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
await db.end();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
