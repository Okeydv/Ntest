// Очистка метаданных вложений: MP4/MOV и PDF.
//
// Модуль общий для браузера и сервера. В зашифрованном чате сервер файл не
// видит, и чистить его может только отправитель — до шифрования. В открытом
// чате (бот, собеседника пока нет) тем же кодом чистит сервер.
//
// Ни одна функция не пропускает файл «как есть» при ошибке: не удалось
// разобрать — исключение, и файл не отправляется.

import { detectType } from './filetypes.js';

export { ISO_BMFF_TYPES } from './filetypes.js';

/* ========================================================================
   MP4 / MOV (ISO BMFF и QuickTime)
   ===================================================================== */

// Телефон пишет в видео то же, что в фото: координаты съёмки (©xyz в
// udta, com.apple.quicktime.location.ISO6709 в meta), модель камеры,
// версию прошивки, дату. Всё это лежит в блоках udta и meta внутри moov и
// trak, а даты — ещё и в заголовках mvhd, tkhd и mdhd.
//
// Блоки не вырезаются, а превращаются в free (тип стандартный, плееры его
// пропускают) с обнулённым содержимым. Размер файла и положение всех
// остальных блоков не меняются — а значит остаются верными таблицы
// смещений (stco/co64), указывающие в mdat. Вырезание блоков из moov их
// сдвинуло бы, и видео перестало бы воспроизводиться.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf']);
const METADATA_BOXES = new Set(['udta', 'meta']);
const DATED_HEADERS = new Set(['mvhd', 'tkhd', 'mdhd']);
// uuid-блок Adobe с XMP-пакетом внутри.
const XMP_UUID = [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac];

const boxType = (buf, at) => String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);

function wipeBox(buf, start, size, headerLen) {
    buf.set([0x66, 0x72, 0x65, 0x65], start + 4);   // 'free'
    buf.fill(0, start + headerLen, start + size);
}

// creation_time и modification_time: у версии 0 по 4 байта, у версии 1
// по 8, сразу после version/flags.
function zeroDates(buf, payload, payloadLen) {
    const wide = buf[payload] === 1;
    const need = 4 + (wide ? 16 : 8);
    if (payloadLen < need) throw new Error('MP4: заголовок с датой обрезан');
    buf.fill(0, payload + 4, payload + need);
}

function isXmpUuid(buf, at, end) {
    if (end - at < 16) return false;
    for (let i = 0; i < 16; i++) if (buf[at + i] !== XMP_UUID[i]) return false;
    return true;
}

function walk(buf, view, start, end, removed) {
    let pos = start;
    while (pos < end) {
        if (end - pos < 8) throw new Error('MP4: обрезанный заголовок блока');
        let size = view.getUint32(pos);
        const type = boxType(buf, pos + 4);
        let headerLen = 8;
        if (size === 1) {
            if (end - pos < 16) throw new Error('MP4: обрезанный заголовок блока');
            const big = view.getBigUint64(pos + 8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MP4: блок слишком велик');
            size = Number(big);
            headerLen = 16;
        } else if (size === 0) {
            size = end - pos;   // «до конца файла» — так бывает у последнего mdat
        }
        if (size < headerLen || pos + size > end) throw new Error(`MP4: блок ${type} выходит за границы`);

        if (METADATA_BOXES.has(type) || (type === 'uuid' && isXmpUuid(buf, pos + headerLen, pos + size))) {
            wipeBox(buf, pos, size, headerLen);
            removed.push(type);
        } else if (DATED_HEADERS.has(type)) {
            zeroDates(buf, pos + headerLen, size - headerLen);
        } else if (CONTAINERS.has(type)) {
            walk(buf, view, pos + headerLen, pos + size, removed);
        }
        pos += size;
    }
}

/**
 * Очистить MP4/MOV. Возвращает новый массив того же размера и список
 * обезвреженных блоков. Исходный массив не меняется.
 */
export function cleanIsoBmff(input) {
    const buf = new Uint8Array(input);
    if (buf.length < 8 || boxType(buf, 4) !== 'ftyp') throw new Error('MP4: файл не начинается с ftyp');
    // HEIC и AVIF — тоже ISO BMFF, но изображение там лежит в блоке meta:
    // «очистка» стёрла бы саму картинку.
    const kind = detectType(buf.subarray(0, 12));
    if (!kind || !kind.startsWith('video/')) throw new Error('MP4: это не видео');
    const removed = [];
    walk(buf, new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.length, removed);
    return { bytes: buf, removed };
}

/* ========================================================================
   PDF
   ===================================================================== */

/**
 * Удалить из PDF словарь Info (автор, программа, даты) и все XMP-потоки.
 *
 * Документ разбирается и сохраняется заново — так таблица xref строится с
 * нуля и файл остаётся целым. Объекты метаданных удаляются целиком, а не
 * только отвязываются: отвязанный словарь Info остался бы в файле вместе с
 * именем автора.
 *
 * pdfLib — модуль pdf-lib: на сервере его отдаёт require, в браузере —
 * import('/vendor/pdf-lib.esm.min.js'). Зашифрованный PDF разобрать
 * нельзя — исключение.
 */
export async function cleanPdf(bytes, pdfLib) {
    const { PDFDocument, PDFName, PDFDict, PDFRef } = pdfLib;
    // updateMetadata: false — иначе pdf-lib сам допишет Producer и даты.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const context = doc.context;

    const info = context.trailerInfo.Info;
    if (info instanceof PDFRef) context.delete(info);
    context.trailerInfo.Info = undefined;

    // XMP бывает не только у каталога, но и у страниц, шрифтов, картинок.
    const METADATA = PDFName.of('Metadata');
    const TYPE = PDFName.of('Type');
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
        const dict = obj instanceof PDFDict ? obj : (obj && obj.dict instanceof PDFDict ? obj.dict : null);
        if (!dict) continue;
        if (dict.get(TYPE) === METADATA) {
            context.delete(ref);
            continue;
        }
        dict.delete(METADATA);
    }
    return doc.save({ useObjectStreams: false });
}
