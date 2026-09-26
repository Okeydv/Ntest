// Разбор файлов в отдельном процессе (lib/limited-process.js).
//
//   - обычная очистка в отдельном процессе работает: метаданные из фото
//     уходят;
//   - процесс, съевший память, останавливается, а сервер (этот процесс)
//     живёт;
//   - процесс, который завис, убивается по таймеру, а сервер всё это
//     время отвечает;
//   - одновременно работает не больше двух процессов;
//   - имя ошибки доходит из процесса: «PDF повреждён» не превращается в
//     безликую ошибку.
//
// Без сервера и без базы. Запуск: node scripts/test-file-sandbox.mjs

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const { runLimited, WorkerLimitError } = require('../lib/limited-process.js');
const { stripMetadataInWorker } = require('../lib/metadata-stripper.js');

let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxo-sandbox-'));
const task = (name, body) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, `process.once('message', () => {\n${body}\n});`);
    return file;
};

/* ------------------------- обычная очистка ------------------------- */

const photo = path.join(tmp, 'photo.jpg');
await sharp({ create: { width: 64, height: 64, channels: 3, background: '#88aacc' } })
    .withExif({ IFD0: { Artist: 'Ivan Petrov', Make: 'Canon' } }).jpeg().toFile(photo);
check('в исходном фото есть автор', fs.readFileSync(photo).includes('Ivan Petrov'));
await stripMetadataInWorker(photo, 'image/jpeg');
const cleaned = fs.readFileSync(photo);
check('очистка в отдельном процессе: автора и камеры больше нет, картинка цела',
    !cleaned.includes('Ivan Petrov') && !cleaned.includes('Canon') && (await sharp(cleaned).metadata()).width === 64);

const brokenPdf = path.join(tmp, 'broken.pdf');
fs.writeFileSync(brokenPdf, '%PDF-1.7\nэто не PDF\n');
const pdfError = await stripMetadataInWorker(brokenPdf, 'application/pdf').then(() => null, e => e);
check('имя ошибки доходит из процесса', pdfError && pdfError.name === 'PdfCleanError', pdfError && `${pdfError.name}: ${pdfError.message}`);

/* ------------------------- память ------------------------- */

const hog = task('hog.js', `const keep = []; for (let i = 0; ; i++) keep.push({ i, s: String(i).repeat(64), a: [i, i + 1, i + 2] });`);
const memError = await runLimited(hog, {}, { maxHeapMb: 32, timeoutMs: 20000 }).then(() => null, e => e);
check('процесс, съевший память, остановлен, сервер жив', memError instanceof WorkerLimitError && /памяти/.test(memError.message),
    memError && memError.message);

/* ------------------------- зависание ------------------------- */

const spin = task('spin.js', 'for (;;) {}');
let ticks = 0;
const ticker = setInterval(() => ticks++, 50);
const started = Date.now();
const timeError = await runLimited(spin, {}, { timeoutMs: 700 }).then(() => null, e => e);
clearInterval(ticker);
const took = Date.now() - started;
check('зависший процесс убит по таймеру', timeError instanceof WorkerLimitError && took < 3000, `${took} мс: ${timeError && timeError.message}`);
check('а сервер всё это время отвечал', ticks >= 8, `тиков: ${ticks}`);

/* ------------------------- параллельность ------------------------- */

const nap = task('nap.js', `const t = Date.now(); setTimeout(() => process.send({ ok: true, result: [t, Date.now()] }), 400);`);
const spans = await Promise.all(Array.from({ length: 5 }, () => runLimited(nap, {})));
let peak = 0;
for (const [start] of spans) peak = Math.max(peak, spans.filter(([s, e]) => s <= start && start < e).length);
check('одновременно не больше двух процессов', peak === 2, `пик ${peak}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
