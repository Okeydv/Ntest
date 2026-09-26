// Очистка PDF на файлах от настоящих генераторов, а не от pdf-lib, которым
// же и чистим (такой тест сам себя подтверждал бы).
//
//   - LibreOffice: Info и XMP с автором, названием, ключевыми словами;
//   - Ghostscript, как сканер: JPEG лежит в PDF байт в байт, с EXIF и GPS;
//   - то же, но JPEG дополнительно сжат: /Filter [/FlateDecode /DCTDecode];
//   - JPEG 2000 от OpenJPEG с EXIF и XMP, которые дописал exiftool: так
//     картинку кладут в PDF сканеры и img2pdf;
//   - как сохраняет Acrobat: инкрементальное обновление поверх файла
//     LibreOffice — новый Info, комментарий с автором и датой, PieceInfo,
//     миниатюра страницы, «статья» со своим словарём сведений, вложенный
//     файл, поле формы. Старый Info с именем автора остаётся в файле
//     недостижимым — именно его раньше выписывал обратно pdf-lib;
//   - вложенный файл, добавленный qpdf, и потоки объектов;
//   - защищённые паролем (владельца и пользователя) и битый.
//
// Проверка результата — сторонними инструментами: qpdf --check, exiftool,
// поиск по распакованному qpdf файлу, отрисовка Ghostscript.
//
// Требует qpdf, exiftool, Ghostscript, LibreOffice (soffice) и OpenJPEG
// (opj_compress) в PATH.
// Запуск: node scripts/test-pdf-cleaning.mjs — сервер и база не нужны.

import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { cleanPdf, PdfCleanError } from '../public/crypto/metadata.js';

const require = createRequire(import.meta.url);
const pdfLib = require('pdf-lib');
const { PDFDocument, PDFName, PDFArray, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = pdfLib;

for (const tool of ['qpdf', 'exiftool', 'gs', 'soffice', 'opj_compress']) {
    if (spawnSync('which', [tool]).status !== 0) {
        console.error(`нужен ${tool} в PATH`);
        process.exit(2);
    }
}

let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxo-pdf-'));
const file = (name, bytes) => { const p = path.join(tmp, name); if (bytes) fs.writeFileSync(p, bytes); return p; };

const AUTHOR = 'Ivan Petrov';
const SECRETS = [AUTHOR, 'EOS R5', 'Exif', 'confidential', 'xmpmeta', 'D:20260925'];
// Текстовая строка PDF не в ASCII — UTF-16BE с BOM, записанная в hex.
const pdfText = text => `<FEFF${Buffer.from(text, 'utf16le').swap16().toString('hex')}>`;

/* ------------------------- инструменты проверки ------------------------- */

// Распакованный qpdf файл: потоки раскрыты, потоки объектов разобраны.
// Искать строки в сжатом PDF бессмысленно — поэтому только так.
function expanded(bytes) {
    const src = file('expand-in.pdf', bytes);
    const out = file('expand-out.pdf');
    spawnSync('qpdf', ['--qdf', '--object-streams=disable', src, out]);
    return fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
}
const utf16 = text => Buffer.from(text, 'utf16le').swap16();
// Строка в PDF бывает литеральной, (Ivan Petrov), и шестнадцатеричной,
// <FEFF0049...>, — так пишет, например, LibreOffice. Ищем все формы.
function forms(secret) {
    const raw = [Buffer.from(secret, 'latin1'), utf16(secret)];
    const hex = raw.map(b => b.toString('hex')).flatMap(h => [h, h.toUpperCase()]);
    return [...raw, ...hex];
}
function leaks(bytes) {
    const text = expanded(bytes);
    return SECRETS.filter(s => forms(s).some(f => text.includes(f)));
}
function qpdfCheck(bytes) {
    const r = spawnSync('qpdf', ['--check', file('check.pdf', bytes)], { encoding: 'utf8' });
    return { ok: r.status === 0 && /No syntax or stream encoding errors/.test(r.stdout), out: (r.stdout + r.stderr).trim().split('\n').slice(-2).join(' / ') };
}
function exif(bytes) {
    const r = spawnSync('exiftool', ['-j', '-a', file('exif.pdf', bytes)], { encoding: 'utf8' });
    const data = JSON.parse(r.stdout)[0];
    return ['Author', 'Creator', 'Producer', 'Title', 'Keywords', 'CreateDate', 'ModifyDate', 'XMPToolkit', 'Subject']
        .filter(k => data[k] !== undefined);
}
// Отрисовка Ghostscript в маленький растр — и файл цел, и картинка на месте.
function render(bytes) {
    const out = file('render.ppm');
    const r = spawnSync('gs', ['-q', '-dSAFER', '-sDEVICE=ppmraw', '-r20', '-o', out, file('render.pdf', bytes)], { encoding: 'utf8' });
    return { ok: r.status === 0 && !/Error/.test(r.stdout + r.stderr), pixels: fs.existsSync(out) ? fs.readFileSync(out) : null };
}

async function cleanedAndChecked(label, bytes, { samePixels = false } = {}) {
    const before = leaks(bytes);
    const cleaned = Buffer.from(await cleanPdf(bytes, pdfLib));
    const after = leaks(cleaned);
    check(`${label}: до очистки было что выдать`, before.length > 0, before.join(', '));
    check(`${label}: после — ничего`, after.length === 0, after.join(', '));
    const meta = exif(cleaned);
    check(`${label}: exiftool не видит метаданных документа`, meta.length === 0, meta.join(', '));
    const qc = qpdfCheck(cleaned);
    check(`${label}: qpdf --check без ошибок`, qc.ok, qc.out);
    const r = render(cleaned);
    check(`${label}: Ghostscript отрисовывает`, r.ok);
    if (samePixels) {
        check(`${label}: картинка та же, пиксель в пиксель`, r.pixels && r.pixels.equals(render(bytes).pixels));
    }
    return cleaned;
}

/* ------------------------- LibreOffice ------------------------- */

const fodt = file('report.fodt', `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
 <office:meta><meta:initial-creator>${AUTHOR}</meta:initial-creator><dc:creator>${AUTHOR}</dc:creator>
  <dc:title>Секретный план</dc:title><meta:keyword>confidential</meta:keyword></office:meta>
 <office:body><office:text><text:p>Отчёт за квартал.</text:p></office:text></office:body>
</office:document>`);
execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', tmp, fodt], { stdio: 'ignore', timeout: 120000 });
const libre = fs.readFileSync(file('report.pdf'));
await cleanedAndChecked('LibreOffice', libre);

/* ------------------------- Ghostscript, как сканер ------------------------- */

const photo = file('photo.jpg', await sharp({ create: { width: 60, height: 40, channels: 3, background: '#3a7bd5' } }).jpeg().toBuffer());
execFileSync('exiftool', ['-q', '-overwrite_original', '-GPSLatitude=55.7558', '-GPSLatitudeRef=N',
    '-GPSLongitude=37.6173', '-GPSLongitudeRef=E', `-Artist=${AUTHOR}`, '-Model=EOS R5', photo]);
const viewjpeg = execFileSync('bash', ['-c', 'ls /usr/share/ghostscript/*/lib/viewjpeg.ps']).toString().trim();
execFileSync('gs', ['-q', `--permit-file-read=${tmp}/`, '-sDEVICE=pdfwrite', '-o', file('scan.pdf'),
    '-c', `[ /Author (${AUTHOR}) /DOCINFO pdfmark`, '-f', viewjpeg, '-c', `(${photo}) viewJPEG`]);
const scan = fs.readFileSync(file('scan.pdf'));
check('в «скане» JPEG лежит с EXIF и GPS', expanded(scan).includes('EOS R5') && expanded(scan).includes('Exif'));
await cleanedAndChecked('Ghostscript (скан)', scan, { samePixels: true });

// Тот же JPEG, дополнительно сжатый Flate: /Filter [/FlateDecode /DCTDecode].
const wrappedDoc = await PDFDocument.load(scan, { updateMetadata: false });
for (const [, obj] of wrappedDoc.context.enumerateIndirectObjects()) {
    if (obj.dict && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
        obj.contents = zlib.deflateSync(obj.contents);
        obj.dict.set(PDFName.of('Filter'), wrappedDoc.context.obj([PDFName.of('FlateDecode'), PDFName.of('DCTDecode')]));
    }
}
const wrapped = Buffer.from(await wrappedDoc.save({ useObjectStreams: false, updateFieldAppearances: false }));
await cleanedAndChecked('JPEG под Flate (фильтр-массив)', wrapped, { samePixels: true });

/* ------------------------- JPEG 2000 ------------------------- */

// Картинку кодирует OpenJPEG, EXIF и XMP дописывает exiftool — в блоки uuid.
// В PDF она ложится байт в байт, как это делают сканеры и img2pdf.
await sharp({ create: { width: 60, height: 40, channels: 3, background: '#d5733a' } }).png().toFile(file('photo2.png'));
execFileSync('opj_compress', ['-i', file('photo2.png'), '-o', file('photo2.jp2')], { stdio: 'ignore' });
execFileSync('exiftool', ['-q', '-overwrite_original', '-GPSLatitude=55.7558', '-GPSLatitudeRef=N',
    '-GPSLongitude=37.6173', '-GPSLongitudeRef=E', `-Artist=${AUTHOR}`, '-Model=EOS R5',
    `-XMP-dc:Creator=${AUTHOR}`, file('photo2.jp2')]);
const jp2 = fs.readFileSync(file('photo2.jp2'));
check('в JPEG 2000 лежат EXIF и XMP', jp2.includes('EOS R5') && jp2.includes('xmpmeta'));
const jpxDoc = await PDFDocument.create({ updateMetadata: false });
const jpxPage = jpxDoc.addPage([60, 40]);
const jpxRef = jpxDoc.context.register(jpxDoc.context.stream(jp2,
    { Type: 'XObject', Subtype: 'Image', Width: 60, Height: 40, Filter: 'JPXDecode' }));
jpxPage.node.setXObject(PDFName.of('Im0'), jpxRef);
jpxPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(60, 0, 0, 40, 0, 0), drawObject('Im0'), popGraphicsState());
const jpx = Buffer.from(await jpxDoc.save({ useObjectStreams: false }));
await cleanedAndChecked('JPEG 2000 (JPXDecode)', jpx, { samePixels: true });

/* ------------------------- как сохраняет Acrobat ------------------------- */

// Инкрементальное обновление: новые версии объектов дописываются в конец,
// старые остаются в файле. Собирается руками, по спецификации.
async function incrementalUpdate(base) {
    const doc = await PDFDocument.load(base, { updateMetadata: false });
    const page = doc.getPage(0);
    const pageRef = page.ref;
    let next = doc.context.largestObjectNumber + 1;
    const infoNum = next++, annotNum = next++, widgetNum = next++, efNum = next++, fsNum = next++, attachNum = next++;
    const thumbNum = next++, threadNum = next++, beadNum = next++;
    const pageDict = page.node.toString().replace(/>>\s*$/, '')
        .replace(/\/Annots\s*\[[^\]]*\]/, '')
        + `/Annots [${annotNum} 0 R ${widgetNum} 0 R ${attachNum} 0 R]\n`
        + `/Thumb ${thumbNum} 0 R\n/B [${beadNum} 0 R]\n`
        + `/PieceInfo << /Illustrator << /LastModified (D:20260925120000) /Private << /Author (${AUTHOR}) >> >> >>\n>>`;
    const catalogDict = doc.catalog.toString().replace(/>>\s*$/, '') + `/Threads [${threadNum} 0 R]\n>>`;
    const objects = [
        [doc.context.trailerInfo.Root.objectNumber, catalogDict],
        [pageRef.objectNumber, pageDict],
        [infoNum, `<< /Author ${pdfText('Редакция')} /Producer (Adobe Acrobat Pro 2026) /ModDate (D:20260925120000) >>`],
        [annotNum, `<< /Type /Annot /Subtype /Text /Rect [20 20 40 40] /Contents ${pdfText('Проверь цифры')} /T (${AUTHOR}) /M (D:20260925120000) /CreationDate (D:20260925115900) >>`],
        [widgetNum, `<< /Type /Annot /Subtype /Widget /FT /Tx /Rect [60 20 160 40] /T (client_name) /V ${pdfText('ООО Ромашка')} /M (D:20260925120100) >>`],
        [efNum, `<< /Type /EmbeddedFile /Length 30 >>\nstream\n${AUTHOR} private attachment \nendstream`],
        [fsNum, `<< /Type /Filespec /F (notes.txt) /EF << /F ${efNum} 0 R >> >>`],
        [attachNum, `<< /Type /Annot /Subtype /FileAttachment /Rect [200 20 220 40] /FS ${fsNum} 0 R /T (${AUTHOR}) >>`],
        // Миниатюра 2×2 RGB: 12 байт, и это имя автора — если миниатюра
        // переживёт очистку, его найдёт проверка на утечки.
        [thumbNum, `<< /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 12 >>\nstream\n${AUTHOR} \nendstream`],
        [threadNum, `<< /Type /Thread /F ${beadNum} 0 R /I << /Title (Plan) /Author (${AUTHOR}) /CreationDate (D:20260925110000) >> >>`],
        [beadNum, `<< /Type /Bead /T ${threadNum} 0 R /N ${beadNum} 0 R /V ${beadNum} 0 R /P ${pageRef} /R [0 0 100 100] >>`],
    ];
    const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(base.toString('latin1'))[1]);
    let body = Buffer.from('\n');
    const offsets = [];
    for (const [num, text] of objects) {
        offsets.push([num, base.length + body.length]);
        body = Buffer.concat([body, Buffer.from(`${num} 0 obj\n${text}\nendobj\n`, 'utf8')]);
    }
    const xrefAt = base.length + body.length;
    let xref = 'xref\n';
    for (const [num, off] of offsets.sort((a, b) => a[0] - b[0])) xref += `${num} 1\n${String(off).padStart(10, '0')} 00000 n\r\n`;
    const trailer = `trailer\n<< /Size ${next} /Root ${doc.context.trailerInfo.Root} /Info ${infoNum} 0 R /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return Buffer.concat([base, body, Buffer.from(xref + trailer, 'latin1')]);
}
const acrobat = await incrementalUpdate(libre);
check('инкрементальное обновление — корректный PDF', qpdfCheck(acrobat).ok, qpdfCheck(acrobat).out);
check('старый Info с автором остаётся в файле, хотя просмотрщик его не видит',
    acrobat.includes(AUTHOR) && exif(acrobat).includes('Author'));
const cleanedAcrobat = await cleanedAndChecked('Acrobat (инкрементальное обновление)', acrobat);
const after = await PDFDocument.load(cleanedAcrobat, { updateMetadata: false });
const annots = after.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
const kinds = annots.asArray().map((_, i) => String(annots.lookup(i).get(PDFName.of('Subtype'))));
check('комментарий остался, вложенный файл — нет', kinds.includes('/Text') && !kinds.includes('/FileAttachment'), kinds.join(','));
const comment = annots.asArray().map((_, i) => annots.lookup(i)).find(a => String(a.get(PDFName.of('Subtype'))) === '/Text');
check('у комментария нет автора и дат, текст на месте',
    !comment.get(PDFName.of('T')) && !comment.get(PDFName.of('M')) && !comment.get(PDFName.of('CreationDate'))
    && comment.get(PDFName.of('Contents')).decodeText() === 'Проверь цифры');
const widget = annots.asArray().map((_, i) => annots.lookup(i)).find(a => String(a.get(PDFName.of('Subtype'))) === '/Widget');
check('у поля формы /T — имя поля — сохранено, дата правки — нет',
    widget && widget.get(PDFName.of('T')).decodeText() === 'client_name' && !widget.get(PDFName.of('M')));
check('миниатюры страницы нет', !after.getPage(0).node.get(PDFName.of('Thumb')));
const thread = after.catalog.lookup(PDFName.of('Threads'), PDFArray).lookup(0);
check('«статья» на месте, её словаря сведений нет', thread.get(PDFName.of('F')) && !thread.get(PDFName.of('I')));

/* ------------------------- вложения qpdf и потоки объектов ------------------------- */

file('secret.txt', `${AUTHOR}: пароль от сейфа`);
execFileSync('qpdf', [file('report.pdf'), '--add-attachment', file('secret.txt'), '--', file('attached.pdf')]);
execFileSync('qpdf', ['--object-streams=generate', file('attached.pdf'), file('objstm.pdf')]);
const objstm = fs.readFileSync(file('objstm.pdf'));
check('вложение и потоки объектов на месте', /ObjStm/.test(objstm.toString('latin1'))
    && execFileSync('qpdf', ['--list-attachments', file('objstm.pdf')]).toString().includes('secret.txt'));
const cleanedObjstm = await cleanedAndChecked('Потоки объектов + вложение qpdf', objstm);
check('вложенных файлов не осталось',
    !execFileSync('qpdf', ['--list-attachments', file('clean-list.pdf', cleanedObjstm)]).toString().includes('secret.txt'));

/* ------------------------- защищённые и битые ------------------------- */

async function failure(bytes) {
    try { await cleanPdf(bytes, pdfLib); return null; } catch (e) { return e; }
}
execFileSync('qpdf', ['--encrypt', '', 'owner-secret', '256', '--print=none', '--', file('report.pdf'), file('owner.pdf')]);
const owner = await failure(fs.readFileSync(file('owner.pdf')));
check('PDF с паролем владельца (открывается без пароля) — «защищён», с подсказкой',
    owner instanceof PdfCleanError && owner.kind === 'encrypted' && /Сохранить как PDF/.test(owner.message), owner && owner.message);
execFileSync('qpdf', ['--encrypt', 'user-secret', 'owner-secret', '256', '--', file('report.pdf'), file('user.pdf')]);
const user = await failure(fs.readFileSync(file('user.pdf')));
check('PDF с паролем на открытие — тоже «защищён»', user instanceof PdfCleanError && user.kind === 'encrypted');
const broken = await failure(Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R\n%%EOF'));
check('битый PDF — «повреждён», а не «защищён»', broken instanceof PdfCleanError && broken.kind === 'broken', broken && broken.message);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
