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
//   - видео (MP4) и PDF уходят без метаданных: координат, модели, автора —
//     и после очистки видео воспроизводится, а PDF открывается
//   - тип определяется по содержимому: AVIF перерисовывается в JPEG, HEIC,
//     который браузер не открывает, и TIFF не уходят, JPEG под видом .txt
//     чистится как фото; имена фото и видео заменяются нейтральными
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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { withIphoneMetadata, syntheticMp4, boxes, GPS, MODEL } from './lib/mp4-fixtures.mjs';

const require = createRequire(import.meta.url);
const { PDFDocument, PDFName, PDFString } = require('pdf-lib');

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

/* ------------------------- видео и PDF ------------------------- */

// Байты, которые видит получатель: ключ — из расшифрованной полезной
// нагрузки в его локальном кэше, шифротекст — с сервера (fetch по blob:
// запрещён CSP, см. выше).
const receivedBytes = (page, selector) => page.evaluate(async selector => {
    const nodes = document.querySelectorAll(selector);
    const node = nodes[nodes.length - 1];
    if (!node) return null;
    const client = await import('/crypto/client.js');
    const payload = JSON.parse(await client.recallPlaintext(node.closest('.message').dataset.messageId));
    const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const ct = await (await fetch(`/api/blobs/${payload.blob}`)).arrayBuffer();
    const key = await crypto.subtle.importKey('raw', b64(payload.key), { name: 'AES-GCM' }, false, ['decrypt']);
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(payload.iv) }, key, ct));
    let s = ''; for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
}, selector).then(b64 => (b64 ? Buffer.from(b64, 'base64') : null));

// Воспроизводится ли MP4 в браузере: грузятся ли метаданные потока.
const playable = (page, bytes) => page.evaluate(async b64 => {
    const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
    return new Promise(resolve => {
        v.onloadedmetadata = () => resolve({ ok: true, width: v.videoWidth });
        v.onerror = () => resolve({ ok: false, error: v.error && v.error.message });
        setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5000);
    });
}, bytes.toString('base64'));

// Настоящее видео: записано MediaRecorder в самом браузере. В него
// дописаны метаданные так, как их пишет iPhone.
const recorded = Buffer.from(await alice.page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 48;
    const ctx = c.getContext('2d'); let f = 0;
    const t = setInterval(() => { ctx.fillStyle = `hsl(${f++ * 20},80%,50%)`; ctx.fillRect(0, 0, 64, 48); }, 40);
    const rec = new MediaRecorder(c.captureStream(25), { mimeType: 'video/mp4' });
    const chunks = []; rec.ondataavailable = e => chunks.push(e.data);
    rec.start(); await new Promise(r => setTimeout(r, 1200)); rec.stop();
    await new Promise(r => { rec.onstop = r; }); clearInterval(t);
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = ''; for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
}), 'base64');
const video = withIphoneMetadata(recorded);
const videoPath = path.join(tmp, 'IMG_0002.mp4');
fs.writeFileSync(videoPath, video);
check('исходное видео несёт координаты и модель и воспроизводится',
    video.includes(GPS) && video.includes(MODEL) && (await playable(bob.page, video)).ok);

await alice.page.setInputFiles('#file-input', videoPath);
await bob.page.waitForSelector('#chat-messages video', { timeout: 10000 }).catch(() => {});
await bob.page.waitForTimeout(500);
const gotVideo = await receivedBytes(bob.page, '#chat-messages video');
check('получатель видит видео', !!gotVideo);
check('в полученном видео нет ни координат, ни модели, ни XMP',
    gotVideo && !gotVideo.includes(GPS) && !gotVideo.includes(MODEL) && !gotVideo.includes('xmpmeta'));
const moov = gotVideo && boxes(gotVideo).find(b => b.type === 'moov');
const mvhd = moov && boxes(gotVideo, moov.start + 8, moov.start + moov.size).find(b => b.type === 'mvhd');
check('дата съёмки обнулена, размер тот же',
    mvhd && gotVideo.readUInt32BE(mvhd.start + 12) === 0 && gotVideo.length === video.length);
const inApp = await bob.page.evaluate(async () => {
    const list = document.querySelectorAll('#chat-messages video');
    const v = list[list.length - 1];
    if (v.readyState < 1) await new Promise(r => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
    return { ready: v.readyState, error: v.error && v.error.message };
});
check('после очистки видео воспроизводится у получателя', inApp.ready >= 1 && !inApp.error, JSON.stringify(inApp));

const pdfDoc = await PDFDocument.create({ updateMetadata: false });
pdfDoc.addPage([200, 200]).drawText('plan');
pdfDoc.context.trailerInfo.Info = pdfDoc.context.register(pdfDoc.context.obj({ Author: PDFString.of(AUTHOR) }));
pdfDoc.catalog.set(PDFName.of('Metadata'), pdfDoc.context.register(pdfDoc.context.stream(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:creator>${AUTHOR}</dc:creator></x:xmpmeta>`, { Type: 'Metadata', Subtype: 'XML' })));
const pdfPath = path.join(tmp, 'contract.pdf');
fs.writeFileSync(pdfPath, await pdfDoc.save({ useObjectStreams: false }));
check('исходный PDF несёт автора', fs.readFileSync(pdfPath).includes(AUTHOR));

await alice.page.setInputFiles('#file-input', pdfPath);
await bob.page.waitForSelector('#chat-messages a[download="contract.pdf"]', { timeout: 10000 }).catch(() => {});
const gotPdf = await receivedBytes(bob.page, '#chat-messages a[download="contract.pdf"]');
check('получатель видит PDF', !!gotPdf);
check('в полученном PDF нет ни автора, ни XMP', gotPdf && !gotPdf.includes(AUTHOR) && !gotPdf.includes('xmpmeta'));
check('и он открывается', gotPdf && (await PDFDocument.load(gotPdf)).getPageCount() === 1);

/* ------------------------- тип по содержимому и имена ------------------------- */

// Расшифрованная полезная нагрузка последнего вложения у получателя.
const payloadOf = (page, selector) => page.evaluate(async selector => {
    const nodes = document.querySelectorAll(selector);
    const node = nodes[nodes.length - 1];
    if (!node) return null;
    const client = await import('/crypto/client.js');
    const p = JSON.parse(await client.recallPlaintext(node.closest('.message').dataset.messageId));
    return { mime: p.mime, name: p.name };
}, selector);
const messageCount = page => page.evaluate(() => document.querySelectorAll('#chat-messages .message').length);
const lastToast = page => page.evaluate(() => document.getElementById('toast').textContent);
async function sendFile(filePath) {
    await alice.page.setInputFiles('#file-input', filePath);
    await alice.page.waitForTimeout(1500);
}

const photoPayload = await payloadOf(bob.page, '#chat-messages img.message-image');
check('имя фото нейтральное: IMG_0001.jpg ушло как photo.jpg', photoPayload?.name === 'photo.jpg', JSON.stringify(photoPayload));
const videoPayload = await payloadOf(bob.page, '#chat-messages video');
check('и видео: IMG_0002.mp4 ушло как video.mp4', videoPayload?.name === 'video.mp4', JSON.stringify(videoPayload));

const avifPath = path.join(tmp, 'IMG_0003.avif');
fs.writeFileSync(avifPath, await sharp({ create: { width: 32, height: 24, channels: 3, background: '#d5733a' } })
    .avif().withExifMerge({ IFD0: { Copyright: AUTHOR, Make: 'Canon' } }).toBuffer());
const avifHadExif = fs.readFileSync(avifPath).includes(AUTHOR);
const imagesBefore = await bob.page.evaluate(() => document.querySelectorAll('#chat-messages img.message-image').length);
await sendFile(avifPath);
await bob.page.waitForFunction(n => document.querySelectorAll('#chat-messages img.message-image').length > n,
    imagesBefore, { timeout: 8000 }).catch(() => {});
const avifPayload = await payloadOf(bob.page, '#chat-messages img.message-image');
const avifBytes = await receivedBytes(bob.page, '#chat-messages img.message-image');
check('AVIF перерисован в JPEG и назван photo.jpg',
    avifPayload?.mime === 'image/jpeg' && avifPayload.name === 'photo.jpg' && avifBytes?.[0] === 0xff && avifBytes[1] === 0xd8,
    JSON.stringify(avifPayload));
check('и метаданных в нём нет', avifHadExif && avifBytes && !avifBytes.includes(AUTHOR) && !avifBytes.includes('Canon'),
    `в исходнике EXIF: ${avifHadExif}`);

// HEIC, который этот браузер (Chromium) декодировать не умеет.
const heicPath = path.join(tmp, 'IMG_0004.HEIC');
fs.writeFileSync(heicPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(12), Buffer.from('GPS 55.7558')]));
let count = await messageCount(alice.page);
await sendFile(heicPath);
check('HEIC, который браузер не открывает, не уходит, и сказано, что делать',
    await messageCount(alice.page) === count && /HEIC.*JPEG/.test(await lastToast(alice.page)), await lastToast(alice.page));

const tiffPath = path.join(tmp, 'scan.tiff');
fs.writeFileSync(tiffPath, await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).tiff().toBuffer());
count = await messageCount(alice.page);
await sendFile(tiffPath);
check('TIFF не уходит: такого типа нет в списке', await messageCount(alice.page) === count
    && /не поддерживается/.test(await lastToast(alice.page)), await lastToast(alice.page));

// PDF под паролем владельца: открывается без пароля, но очистить его нельзя.
const lockedPath = path.join(tmp, 'locked.pdf');
execFileSync('qpdf', ['--encrypt', '', 'owner-secret', '256', '--', pdfPath, lockedPath]);
count = await messageCount(alice.page);
await sendFile(lockedPath);
check('PDF с паролем не уходит, и сказано, как снять защиту', await messageCount(alice.page) === count
    && /защищён паролем.*Сохранить как PDF/.test(await lastToast(alice.page)), await lastToast(alice.page));

const disguisedPath = path.join(tmp, 'notes.txt');
fs.writeFileSync(disguisedPath, fs.readFileSync(photoPath));
const imgs = await bob.page.evaluate(() => document.querySelectorAll('#chat-messages img.message-image').length);
await sendFile(disguisedPath);
await bob.page.waitForFunction(n => document.querySelectorAll('#chat-messages img.message-image').length > n,
    imgs, { timeout: 8000 }).catch(() => {});
const disguisedPayload = await payloadOf(bob.page, '#chat-messages img.message-image');
const disguisedBytes = await receivedBytes(bob.page, '#chat-messages img.message-image');
check('JPEG под видом .txt распознан по содержимому и очищен как фото',
    disguisedPayload?.mime === 'image/jpeg' && disguisedPayload.name === 'photo.jpg'
    && disguisedBytes && !disguisedBytes.includes(AUTHOR), JSON.stringify(disguisedPayload));

const gpPath = path.join(tmp, 'VID_0005.3gp');
fs.writeFileSync(gpPath, syntheticMp4({ brand: '3gp4' }).bytes);
const videosBefore = await bob.page.evaluate(() => document.querySelectorAll('#chat-messages video').length);
await sendFile(gpPath);
// 3GP теперь в списке видео клиента: показывается плеером, а не ссылкой.
await bob.page.waitForFunction(n => document.querySelectorAll('#chat-messages video').length > n,
    videosBefore, { timeout: 8000 }).catch(() => {});
const gpBytes = await receivedBytes(bob.page, '#chat-messages video');
const gpPayload = await payloadOf(bob.page, '#chat-messages video');
check('3GP уходит без координат и модели, под нейтральным именем',
    gpBytes && !gpBytes.includes(GPS) && !gpBytes.includes(MODEL) && gpPayload?.name === 'video.3gp', JSON.stringify(gpPayload));
check('и показывается как видео', gpPayload?.mime === 'video/3gpp');

/* ------------------------- без перекодирования ------------------------- */

const imageCount = page => page.evaluate(() => document.querySelectorAll('#chat-messages img.message-image').length);
async function sendAndReceive(filePath) {
    const before = await imageCount(bob.page);
    await alice.page.setInputFiles('#file-input', filePath);
    await bob.page.waitForFunction(n => document.querySelectorAll('#chat-messages img.message-image').length > n,
        before, { timeout: 8000 }).catch(() => {});
    await bob.page.waitForTimeout(500);
    return receivedBytes(bob.page, '#chat-messages img.message-image');
}

// Фото без поворота уходит теми же пикселями: без EXIF, но и без потери
// качества на перекодировании.
const grain = Buffer.from(Array.from({ length: 64 * 48 * 3 }, (_, i) => (i * 7919) % 251));
const straightPath = path.join(tmp, 'IMG_0005.jpg');
fs.writeFileSync(straightPath, await sharp(grain, { raw: { width: 64, height: 48, channels: 3 } }).jpeg({ quality: 80 })
    .withExifMerge({ IFD0: { Copyright: AUTHOR, Model: 'EOS R5' } }).toBuffer());
const straight = await sendAndReceive(straightPath);
check('фото без поворота не перекодировано: пиксели те же', straight
    && (await sharp(straight).raw().toBuffer()).equals(await sharp(straightPath).raw().toBuffer()));
check('и EXIF в нём нет', straight && !straight.includes(AUTHOR) && !straight.includes('EOS R5'));

// GIF из двух кадров с комментарием: анимация доходит, комментарий — нет.
const frame = color => sharp({ create: { width: 24, height: 16, channels: 3, background: color } }).png().toBuffer();
let gifBytes = await sharp([await frame('#ff0000'), await frame('#0000ff')], { join: { animated: true } })
    .gif({ loop: 0 }).toBuffer();
const comment = Buffer.from(`shot by ${AUTHOR}`);
gifBytes = Buffer.concat([gifBytes.subarray(0, -1), Buffer.from([0x21, 0xfe, comment.length]), comment, Buffer.from([0, 0x3b])]);
const gifPath = path.join(tmp, 'funny.gif');
fs.writeFileSync(gifPath, gifBytes);
check('GIF-исходник: два кадра и комментарий', (await sharp(gifBytes, { animated: true }).metadata()).pages === 2 && gifBytes.includes(comment));
const gotGif = await sendAndReceive(gifPath);
check('GIF доходит анимированным', gotGif && (await sharp(gotGif, { animated: true }).metadata()).pages === 2);
check('а комментарий — нет', gotGif && !gotGif.includes(AUTHOR));

// WebM, как его пишет браузер (MediaRecorder): программа-автор в заголовке
// вычищается тем же путём, что и перед отправкой.
const webmCheck = await alice.page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 24;
    const ctx = canvas.getContext('2d');
    const recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    const done = new Promise(r => { recorder.onstop = r; });
    recorder.start();
    for (let i = 0; i < 6; i++) {
        ctx.fillStyle = i % 2 ? '#f00' : '#00f';
        ctx.fillRect(0, 0, 32, 24);
        await new Promise(r => setTimeout(r, 100));
    }
    recorder.stop();
    await done;
    const original = new Uint8Array(await new Blob(chunks).arrayBuffer());
    const prepared = await window.NyxoCrypto.prepareAttachment(new File([original], 'screen-2026-09-25.webm'));
    const cleaned = new Uint8Array(await prepared.blob.arrayBuffer());
    const text = bytes => Array.from(bytes, b => String.fromCharCode(b)).join('');
    return { had: text(original).includes('Chrome'), left: text(cleaned).includes('Chrome'), mime: prepared.mime, name: prepared.name };
});
check('WebM из браузера: имя программы-автора вычищено', webmCheck.had && !webmCheck.left
    && webmCheck.mime === 'video/webm' && webmCheck.name === 'video.webm', JSON.stringify(webmCheck));

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
