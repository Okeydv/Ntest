// Интеграционный тест незашифрованных вложений (чат с ботом и чаты, где
// пока не для кого шифровать, идут этим путём).
//
// Проверяется:
//   - PDF после очистки цел (таблица xref указывает на объекты), без автора
//     и XMP; раньше очистка регулярками ломала файл и оставляла автора
//   - зашифрованный PDF не отправляется: очистить его нельзя (fail closed)
//   - фото уходит без EXIF, видео — без координат и модели камеры
//   - удалённое сообщение стирает файл с диска и текст из базы, файл больше
//     не скачивается, цитата ответа говорит «удалено»
//   - исчезающее сообщение делает то же самое
//   - уборщик uploads/ не трогает файлы живых сообщений, даже старые, и
//     удаляет только файлы без ссылок
//
// Требует поднятых Postgres, key-server и server.js на 3006, ЧИСТОЙ базы и
// TEST_DATABASE_URL той же базы. Запускать из корня репозитория.
//
// Запуск: TEST_DATABASE_URL=... node scripts/integration-test-uploads.mjs

import pg from 'pg';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { syntheticMp4, GPS, MODEL } from './lib/mp4-fixtures.mjs';

const require = createRequire(import.meta.url);
const { PDFDocument, PDFName, PDFString } = require('pdf-lib');
const { sweepOrphanUploads } = require('../lib/upload-sweeper.js');

const BASE = 'http://127.0.0.1:3006';
const UPLOADS = path.resolve('uploads');
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const dbAll = async (q, p) => (await db.query(q, p)).rows;

let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function jar() {
    const c = new Map();
    return {
        header: () => [...c].map(([k, v]) => `${k}=${v}`).join('; '),
        csrf: () => c.get('csrf_token') || '',
        absorb: r => { for (const s of (r.headers.getSetCookie?.() ?? [])) { const [p] = s.split(';'); const i = p.indexOf('='); c.set(p.slice(0, i), p.slice(i + 1)); } },
    };
}
async function req(j, method, url, body) {
    const headers = { Cookie: j.header() };
    if (j.csrf()) headers['X-CSRF-Token'] = j.csrf();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    j.absorb(r);
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, json };
}
async function user(name) {
    const j = jar();
    await req(j, 'GET', '/api/auth');
    await req(j, 'POST', '/api/register', { username: name, email: `${name}@example.com`, password: 'password123', confirmPassword: 'password123' });
    return j;
}
async function upload(j, chatId, name, type, bytes) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), name);
    form.append('chatId', String(chatId));
    const r = await fetch(`${BASE}/api/messages/file`, { method: 'POST', headers: { Cookie: j.header(), 'X-CSRF-Token': j.csrf() }, body: form });
    return { status: r.status, json: await r.json().catch(() => null) };
}
async function download(j, url) {
    const r = await fetch(BASE + url, { headers: { Cookie: j.header() } });
    return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
}
const uploadsCount = () => fs.readdirSync(UPLOADS).length;

// Целостность PDF: startxref указывает на xref, каждая запись xref — на
// «N G obj». Именно это ломала прежняя очистка.
function xrefProblems(buf) {
    const s = buf.toString('latin1');
    const m = s.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
    if (!m) return ['нет startxref'];
    const start = Number(m[1]);
    if (s.slice(start, start + 4) !== 'xref') return [`startxref=${start} указывает не на xref`];
    const problems = [];
    const lines = s.slice(start).split(/\r?\n/);
    let i = 1;
    while (i < lines.length && /^\d+ \d+$/.test(lines[i].trim())) {
        const [first, count] = lines[i].trim().split(' ').map(Number);
        i++;
        for (let k = 0; k < count; k++, i++) {
            const [off, gen, kind] = lines[i].trim().split(' ');
            if (kind !== 'n') continue;
            if (!s.startsWith(`${first + k} ${Number(gen)} obj`, Number(off))) problems.push(`объект ${first + k}`);
        }
    }
    return problems;
}

// PDF, как его пишут Word и Acrobat: автор обычной строкой в Info и
// несжатый XMP-пакет в каталоге.
async function pdfWithMetadata() {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([200, 200]).drawText('plan');
    doc.context.trailerInfo.Info = doc.context.register(
        doc.context.obj({ Author: PDFString.of('Ivan Petrov'), Creator: PDFString.of('Canon Scanner') }));
    const xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">'
        + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">'
        + '<dc:creator>Ivan Petrov</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
    return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/* ------------------------- участники ------------------------- */

const A = await user('alice');
const chat = await req(A, 'POST', '/api/chats', { name: 'Документы' });
const chatIdA = chat.json.chat.id;
const code = (await req(A, 'GET', `/api/chats/invite/${chatIdA}`)).json.code;
const B = await user('bob');
const chatIdB = (await req(B, 'POST', '/api/chats/join', { code })).json.chat.id;

/* ------------------------- PDF ------------------------- */

const pdf = await pdfWithMetadata();
check('исходный PDF цел и несёт автора', xrefProblems(pdf).length === 0 && pdf.toString('latin1').includes('Ivan Petrov'));
const up = await upload(A, chatIdA, 'plan.pdf', 'application/pdf', pdf);
check('PDF загружен', up.json?.success === true, JSON.stringify(up.json)?.slice(0, 100));
const pdfUrl = up.json.message.file_url;
const gotPdf = await download(B, pdfUrl);
const text = gotPdf.bytes.toString('latin1');
check('полученный PDF цел: xref указывает на объекты', xrefProblems(gotPdf.bytes).length === 0,
    xrefProblems(gotPdf.bytes).slice(0, 3).join(', '));
check('и открывается', (await PDFDocument.load(gotPdf.bytes)).getPageCount() === 1);
check('в нём нет ни автора, ни XMP, ни словаря Info',
    !text.includes('Ivan Petrov') && !text.includes('xmpmeta') && !text.includes('/Info'));

const before = uploadsCount();
const encrypted = Buffer.concat([pdf.subarray(0, pdf.lastIndexOf('trailer')),
    Buffer.from('trailer\n<< /Size 9 /Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -4 >> >>\nstartxref\n0\n%%EOF')]);
const encUp = await upload(A, chatIdA, 'locked.pdf', 'application/pdf', encrypted);
check('зашифрованный PDF не отправляется', encUp.status === 400 && /PDF/.test(encUp.json?.message), encUp.json?.message);
check('и не остаётся на диске', uploadsCount() === before);

/* ------------------------- фото ------------------------- */

const jpeg = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#3a7bd5' } })
    .jpeg().withExifMerge({ IFD0: { Copyright: 'Ivan Petrov', Make: 'Canon' } }).toBuffer();
const photo = await upload(A, chatIdA, 'IMG_0001.jpg', 'image/jpeg', jpeg);
const gotPhoto = await download(B, photo.json.message.file_url);
check('фото уходит без EXIF', !(await sharp(gotPhoto.bytes).metadata()).exif && !gotPhoto.bytes.includes('Ivan Petrov'));

const { bytes: mp4, payload, offset } = syntheticMp4();
const clip = await upload(A, chatIdA, 'IMG_0003.mp4', 'video/mp4', mp4);
check('видео загружено', clip.json?.success === true, JSON.stringify(clip.json)?.slice(0, 100));
const gotClip = (await download(B, clip.json.message.file_url)).bytes;
check('видео уходит без координат и модели камеры', !gotClip.includes(GPS) && !gotClip.includes(MODEL));
check('и без сдвигов: размер тот же, данные на месте',
    gotClip.length === mp4.length && gotClip.subarray(offset, offset + payload.length).equals(payload));
const brokenClip = await upload(A, chatIdA, 'broken.mp4', 'video/mp4', mp4.subarray(0, mp4.length - 30));
check('битое видео не отправляется «как есть»', brokenClip.status === 400, brokenClip.json?.message);

/* ------------------------- удаление ------------------------- */

const reply = await req(B, 'POST', '/api/messages', { chatId: chatIdB, text: 'посмотрю план', replyToId: up.json.message.id });
check('ответ на сообщение с PDF отправлен', reply.json?.success === true);
const pdfFile = path.join(UPLOADS, path.basename(pdfUrl));
check('до удаления файл на диске', fs.existsSync(pdfFile));
await req(A, 'DELETE', `/api/messages/${up.json.message.id}`);
check('удаление стирает файл с диска', !fs.existsSync(pdfFile));
check('и скачать его больше нельзя', (await download(B, pdfUrl)).status !== 200);
const [row] = await dbAll('SELECT text, file_url, file_name FROM messages WHERE id = $1', [up.json.message.id]);
check('в базе не осталось ни текста, ни ссылки на файл', row.text === null && row.file_url === null && row.file_name === null);
const hist = (await req(B, 'GET', `/api/messages/${chatIdB}`)).json.messages;
const quoted = hist.find(m => m.id === reply.json.message.id);
check('цитата ответа говорит, что сообщение удалено, и не несёт его текста',
    quoted?.reply_to?.deleted === true && quoted.reply_to.text === null);

/* ------------------------- исчезающее сообщение ------------------------- */

const vanishing = await upload(A, chatIdA, 'vanish.jpg', 'image/jpeg', jpeg);
const vanishFile = path.join(UPLOADS, path.basename(vanishing.json.message.file_url));
await req(A, 'POST', `/api/messages/${vanishing.json.message.id}/set-expiry`, { expirySeconds: 1 });
await sleep(2500);
const [vrow] = await dbAll('SELECT deleted, text, file_url FROM messages WHERE id = $1', [vanishing.json.message.id]);
check('исчезающее сообщение тоже стирает файл и текст',
    !fs.existsSync(vanishFile) && vrow.deleted === 1 && vrow.text === null && vrow.file_url === null);

/* ------------------------- уборщик ------------------------- */

const liveFile = path.join(UPLOADS, path.basename(photo.json.message.file_url));
const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
fs.utimesSync(liveFile, twoDaysAgo, twoDaysAgo);
const oldOrphan = path.join(UPLOADS, 'orphan-old-test.bin');
const newOrphan = path.join(UPLOADS, 'orphan-new-test.bin');
fs.writeFileSync(oldOrphan, 'x'); fs.utimesSync(oldOrphan, twoDaysAgo, twoDaysAgo);
fs.writeFileSync(newOrphan, 'x');
await sweepOrphanUploads(UPLOADS, { dbAll, ttlMs: 60 * 60 * 1000 });
check('старое вложение живого сообщения уборщик не трогает',
    fs.existsSync(liveFile) && (await download(B, photo.json.message.file_url)).status === 200);
check('файл без ссылки на него удаляется', !fs.existsSync(oldOrphan));
check('а свежий — нет: он может быть загрузкой на лету', fs.existsSync(newOrphan));
fs.unlinkSync(newOrphan);

await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
