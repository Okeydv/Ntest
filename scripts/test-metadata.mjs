// Тесты очистки метаданных (public/crypto/metadata.js).
// Запуск: node scripts/test-metadata.mjs — ни сервера, ни базы не нужно.
//
// Тот же модуль работает в браузере (зашифрованные чаты) и на сервере
// (открытые), поэтому проверяется здесь один раз, на уровне байтов.

import { createRequire } from 'node:module';
import { cleanIsoBmff, cleanPdf } from '../public/crypto/metadata.js';
import { syntheticMp4, boxes, GPS, MODEL, SHOT_AT } from './lib/mp4-fixtures.mjs';

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

console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
