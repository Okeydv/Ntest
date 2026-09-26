// Тесты очистки метаданных (public/crypto/metadata.js).
// Запуск: node scripts/test-metadata.mjs — ни сервера, ни базы не нужно.
//
// Тот же модуль работает в браузере (зашифрованные чаты) и на сервере
// (открытые), поэтому проверяется здесь один раз, на уровне байтов.

import { createRequire } from 'node:module';
import sharp from 'sharp';
import { cleanIsoBmff, cleanJpeg, cleanPdf } from '../public/crypto/metadata.js';
import { syntheticMp4, boxes, GPS, MODEL, SHOT_AT } from './lib/mp4-fixtures.mjs';
import { detectType, attachmentName } from '../public/crypto/filetypes.js';

const require = createRequire(import.meta.url);
const pdfLib = require('pdf-lib');
const { PDFDocument, PDFName, PDFString } = pdfLib;

let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
async function throws(label, fn, re) {
    try { await fn(); check(label, false, 'не бросило'); } catch (e) { check(label, !re || re.test(e.message), e.message); }
}
const has = (buf, text) => Buffer.from(buf).includes(Buffer.from(text, 'latin1'));

/* ------------------------- MP4 ------------------------- */

for (const largeMdat of [false, true]) {
    const label = largeMdat ? ' (mdat с 64-битным размером)' : '';
    const { bytes, payload, offset } = syntheticMp4({ largeMdat });
    check(`исходник несёт координаты, модель и XMP${label}`, has(bytes, GPS) && has(bytes, MODEL) && has(bytes, 'xmpmeta'));

    const { bytes: out, removed } = cleanIsoBmff(bytes);
    const clean = Buffer.from(out);
    check(`размер файла не изменился${label}`, clean.length === bytes.length);
    check(`координат, модели и XMP не осталось${label}`, !has(clean, GPS) && !has(clean, MODEL) && !has(clean, 'xmpmeta'));
    check(`обезврежены udta, meta (в moov и в trak) и XMP${label}`,
        removed.filter(t => t === 'meta').length === 2 && removed.includes('udta') && removed.includes('uuid'), removed.join(','));
    check(`данные на месте: stco по-прежнему указывает на начало mdat${label}`,
        clean.subarray(offset, offset + payload.length).equals(payload));

    const top = boxes(clean);
    check(`структура разбирается, типы верхнего уровня прежние${label}`,
        top.map(b => b.type).join(',') === 'ftyp,moov,free,mdat', top.map(b => b.type).join(','));
    const moov = top.find(b => b.type === 'moov');
    const inner = boxes(clean, moov.start + 8, moov.start + moov.size);
    const mvhd = inner.find(b => b.type === 'mvhd');
    check(`дата съёмки в mvhd обнулена${label}`,
        clean.readUInt32BE(mvhd.start + 12) === 0 && clean.readUInt32BE(mvhd.start + 16) === 0);
    const trak = inner.find(b => b.type === 'trak');
    const tkhd = boxes(clean, trak.start + 8, trak.start + trak.size).find(b => b.type === 'tkhd');
    check(`и в tkhd версии 1 (64-битные даты)${label}`,
        clean.readBigUInt64BE(tkhd.start + 12) === 0n && clean.readBigUInt64BE(tkhd.start + 20) === 0n);
    check(`исходный массив не тронут${label}`, has(bytes, GPS) && bytes.readUInt32BE(bytes.indexOf('mvhd') + 8) === SHOT_AT);
}

const { bytes: sample } = syntheticMp4();
await throws('не MP4 (нет ftyp) — отказ', () => cleanIsoBmff(Buffer.from('not a video at all')), /ftyp/);
await throws('обрезанный файл — отказ, а не «как есть»', () => cleanIsoBmff(sample.subarray(0, sample.length - 20)), /границы|обрезан/);
const lying = Buffer.from(sample);
lying.writeUInt32BE(0x7fffffff, boxes(lying).find(b => b.type === 'moov').start);
await throws('блок с размером больше файла — отказ', () => cleanIsoBmff(lying), /границы/);

// Последний блок с размером 0 — «до конца файла».
const zeroSized = Buffer.from(sample);
zeroSized.writeUInt32BE(0, boxes(zeroSized).find(b => b.type === 'mdat').start);
check('блок с размером 0 (до конца файла) разбирается', !has(Buffer.from(cleanIsoBmff(zeroSized).bytes), GPS));

/* ------------------------- JPEG без перекодирования ------------------------- */

const segment = (marker, body) => {
    const data = Buffer.from(body, 'latin1');
    const head = Buffer.alloc(4);
    head.writeUInt16BE(0xff00 | marker, 0);
    head.writeUInt16BE(data.length + 2, 2);
    return Buffer.concat([head, data]);
};
const markers = buf => {
    const out = [];
    for (let pos = 2; pos + 4 <= buf.length && buf[pos] === 0xff && buf[pos + 1] !== 0xda;) {
        out.push(buf[pos + 1]);
        pos += 2 + buf.readUInt16BE(pos + 2);
    }
    return out;
};
// Фото с профилем Display P3 и EXIF (автор, камера), к которому дописаны
// XMP, комментарий и хвост после EOI — туда приклеивают миниатюры.
// Шум, а не заливка: у заливки сжатых данных пара байт, и обрезать нечего.
const noise = Buffer.from(Array.from({ length: 32 * 24 * 3 }, (_, i) => (i * 7919) % 251));
const withExif = await sharp(noise, { raw: { width: 32, height: 24, channels: 3 } })
    .withIccProfile('p3').withExif({ IFD0: { Artist: 'Ivan Petrov', Model: 'EOS R5' } }).jpeg().toBuffer();
const photo = Buffer.concat([
    withExif.subarray(0, 2),
    segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><dc:creator>Ivan Petrov</dc:creator></x:xmpmeta>'),
    segment(0xfe, 'shot by Ivan Petrov'),
    withExif.subarray(2),
    Buffer.from('tail: Ivan Petrov'),
]);
check('исходное фото несёт EXIF, XMP, комментарий, профиль и хвост',
    has(photo, 'Exif') && has(photo, 'xmpmeta') && has(photo, 'shot by') && has(photo, 'ICC_PROFILE') && has(photo, 'tail:'));
const cleanPhoto = Buffer.from(cleanJpeg(photo));
check('после очистки нет ни автора, ни камеры, ни XMP, ни хвоста',
    !has(cleanPhoto, 'Ivan Petrov') && !has(cleanPhoto, 'EOS R5') && !has(cleanPhoto, 'xmpmeta') && !has(cleanPhoto, 'tail:'));
check('цветовой профиль остался', markers(cleanPhoto).includes(0xe2) && has(cleanPhoto, 'ICC_PROFILE'));
check('файл кончается на EOI', cleanPhoto.subarray(-2).equals(Buffer.from([0xff, 0xd9])));
const pixels = buf => sharp(buf).raw().toBuffer();
check('пиксели те же', (await pixels(cleanPhoto)).equals(await pixels(photo)));

// Обрезанный файл: данные кончаются без EOI. Просмотрщики такие
// показывают, и отказывать незачем — в сжатых данных сегментов нет.
const cut = photo.subarray(0, photo.lastIndexOf(Buffer.from([0xff, 0xd9])) - 10);
const cleanCut = Buffer.from(cleanJpeg(cut));
check('обрезанный JPEG: EOI дописан, EXIF убран',
    cleanCut.subarray(-2).equals(Buffer.from([0xff, 0xd9])) && !has(cleanCut, 'Ivan Petrov'));
await throws('не JPEG — отказ', () => cleanJpeg(Buffer.from('GIF89a')), /SOI/);
await throws('обрезанный заголовок — отказ', () => cleanJpeg(photo.subarray(0, 30)), /JPEG/);

/* ------------------------- PDF ------------------------- */

const doc = await PDFDocument.create({ updateMetadata: false });
doc.addPage([200, 200]).drawText('plan');
doc.context.trailerInfo.Info = doc.context.register(doc.context.obj({ Author: PDFString.of('Ivan Petrov') }));
const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:creator>Ivan Petrov</dc:creator></x:xmpmeta>';
const page = doc.getPage(0).node;
page.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
doc.catalog.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
check('исходный PDF несёт автора в Info и XMP у каталога и у страницы', has(pdf, 'Ivan Petrov') && has(pdf, 'xmpmeta'));

const cleaned = Buffer.from(await cleanPdf(pdf, pdfLib));
check('после очистки нет ни автора, ни XMP, ни Info', !has(cleaned, 'Ivan Petrov') && !has(cleaned, 'xmpmeta') && !has(cleaned, '/Info'));
const reopened = await PDFDocument.load(cleaned, { updateMetadata: false });
check('документ открывается, страница на месте', reopened.getPageCount() === 1);
check('ссылки на удалённый XMP со страницы не осталось', !reopened.getPage(0).node.get(PDFName.of('Metadata')));
await throws('не PDF — отказ', () => cleanPdf(Buffer.from('%PDF garbage'), pdfLib));

/* ------------------------- типы и имена ------------------------- */

const ftyp = brand => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp' + brand), Buffer.alloc(12)]);
check('MP4 с известным брендом — видео', detectType(ftyp('isom')) === 'video/mp4' && detectType(ftyp('mp42')) === 'video/mp4');
check('RAW Canon CR3 (бренд «crx ») — не видео, не уходит', detectType(ftyp('crx ')) === null);
check('аудио M4A — тоже', detectType(ftyp('M4A ')) === null);
check('незнакомый бренд — отказ, а не «видео»', detectType(ftyp('abcd')) === null);
check('3GP и QuickTime узнаются', detectType(ftyp('3gp4')) === 'video/3gpp' && detectType(ftyp('qt  ')) === 'video/quicktime');

check('текст под именем .bat уходит как .txt', attachmentName('text/plain', 'run.bat') === 'run.txt');
check('и .hta, .ps1, .js — тоже', ['update.hta', 'install.ps1', 'x.js'].every(n => attachmentName('text/plain', n).endsWith('.txt')));
check('PDF с чужим расширением — .pdf', attachmentName('application/pdf', 'invoice.exe') === 'invoice.pdf');
check('символы направления текста вычищены', attachmentName('application/pdf', 'report\u202efdp.exe') === 'reportfdp.pdf'
    && !/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(attachmentName('text/plain', '\u2066a\u2069b\u200f.txt')));
check('тип вне списка — .bin', attachmentName('application/x-msdownload', 'setup.exe') === 'setup.bin');
check('имя фото — нейтральное', attachmentName('image/jpeg', 'IMG_20260925_185512.jpg') === 'photo.jpg');

console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
