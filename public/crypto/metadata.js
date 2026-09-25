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
   JPEG без перекодирования
   ===================================================================== */

// Оставляется только то, что нужно для отрисовки: JFIF (APP0), цветовой
// профиль ICC (APP2), Adobe (APP14 — от него зависит, как понимать цвета
// CMYK) и сами данные картинки. Всё прочее — EXIF и XMP (APP1), IPTC и
// Photoshop (APP13), комментарии, остальные APPn — выбрасывается, как и
// всё после конца картинки (EOI): туда приклеивают миниатюры и чужие данные.

const JPEG_KEEP_APP = {
    0xe0: seg => startsWithAscii(seg, 'JFIF\0'),
    0xe2: seg => startsWithAscii(seg, 'ICC_PROFILE\0'),
    0xee: seg => startsWithAscii(seg, 'Adobe'),
};

function startsWithAscii(bytes, text) {
    if (bytes.length < text.length) return false;
    for (let i = 0; i < text.length; i++) if (bytes[i] !== text.charCodeAt(i)) return false;
    return true;
}

/** Очистить JPEG по сегментам. Битый — исключение. */
export function cleanJpeg(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('JPEG: нет SOI');
    const parts = [b.subarray(0, 2)];
    let pos = 2;
    while (pos < b.length) {
        if (b[pos] !== 0xff) throw new Error('JPEG: ожидался маркер');
        while (b[pos + 1] === 0xff) pos++;   // заполняющие 0xFF
        const marker = b[pos + 1];
        if (marker === 0xd9) {                // EOI — всё, что дальше, отрезается
            parts.push(b.subarray(pos, pos + 2));
            return concatBytes(parts);
        }
        if (pos + 4 > b.length) throw new Error('JPEG: обрезан');
        const len = (b[pos + 2] << 8) | b[pos + 3];
        const end = pos + 2 + len;
        if (len < 2 || end > b.length) throw new Error('JPEG: сегмент выходит за границы');

        if (marker === 0xda) {
            // SOS: за заголовком — сжатые данные до следующего маркера (не
            // 0xFF00 и не RSTn: они часть данных).
            let scan = end;
            while (scan + 1 < b.length && !(b[scan] === 0xff && b[scan + 1] !== 0 && (b[scan + 1] < 0xd0 || b[scan + 1] > 0xd7))) scan++;
            if (scan + 1 >= b.length) throw new Error('JPEG: нет EOI');
            parts.push(b.subarray(pos, scan));
            pos = scan;
            continue;
        }
        const isApp = marker >= 0xe0 && marker <= 0xef;
        const keep = isApp
            ? Boolean(JPEG_KEEP_APP[marker] && JPEG_KEEP_APP[marker](b.subarray(pos + 4, end)))
            : marker !== 0xfe;                // COM — комментарий
        if (keep) parts.push(b.subarray(pos, end));
        pos = end;
    }
    throw new Error('JPEG: нет EOI');
}

function concatBytes(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

/* ========================================================================
   PDF
   ===================================================================== */

/**
 * Почему PDF не удалось очистить: зашифрован (открывается только с паролем
 * или защищён паролем владельца) или повреждён. Пользователю нужно разное:
 * в первом случае — снять защиту, во втором — прислать другой файл.
 */
export class PdfCleanError extends Error {
    constructor(kind, cause) {
        super(kind === 'encrypted'
            ? 'PDF защищён паролем, метаданные из него не снять. Снимите защиту: откройте файл и выберите «Печать → Сохранить как PDF»'
            : 'PDF повреждён — его не удалось разобрать');
        this.kind = kind;
        this.cause = cause;
    }
}

// Ключи, в которых PDF хранит сведения о создании документа, а не сам
// документ: XMP, приватные данные программ (Illustrator и Photoshop кладут в
// PieceInfo хоть весь исходный файл), дату изменения, прикреплённые файлы.
const METADATA_KEYS = ['Metadata', 'PieceInfo', 'LastModified', 'AF'];
// У комментариев: автор, даты изменения и создания. У полей формы (Widget)
// /T — это имя поля, его трогать нельзя.
const ANNOT_PRIVATE_KEYS = ['T', 'M', 'CreationDate'];

async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function asciiHexDecode(bytes) {
    const text = new TextDecoder().decode(bytes).replace(/\s+/g, '').replace(/>.*$/s, '');
    const even = text.length % 2 ? text + '0' : text;
    const out = new Uint8Array(even.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(even.substr(i * 2, 2), 16);
    return out;
}

function ascii85Decode(bytes) {
    const text = new TextDecoder().decode(bytes).replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/s, '');
    const out = [];
    let group = [];
    for (const ch of text) {
        if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
        group.push(ch.charCodeAt(0) - 33);
        if (group.length === 5) {
            let value = 0;
            for (const d of group) value = value * 85 + d;
            out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
            group = [];
        }
    }
    if (group.length) {
        const n = group.length;
        while (group.length < 5) group.push(84);
        let value = 0;
        for (const d of group) value = value * 85 + d;
        const tail = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
        out.push(...tail.slice(0, n - 1));
    }
    return new Uint8Array(out);
}

const PRE_DCT_DECODERS = {
    FlateDecode: inflate,
    Fl: inflate,
    ASCIIHexDecode: asciiHexDecode,
    AHx: asciiHexDecode,
    ASCII85Decode: ascii85Decode,
    A85: ascii85Decode,
};

/**
 * Встроенный JPEG: снять с него фильтры до DCTDecode, очистить сегменты и
 * записать обратно как чистый DCTDecode. Картинки в PDF лежат байт в байт
 * как в исходном файле — со всем EXIF и GPS, если так их вставил сканер
 * или программа.
 */
async function cleanEmbeddedJpeg(stream, lib) {
    const { PDFName, PDFArray } = lib;
    const filter = stream.dict.get(PDFName.of('Filter'));
    const names = filter instanceof PDFArray
        ? filter.asArray().map(f => f.decodeText ? f.decodeText() : String(f).replace(/^\//, ''))
        : filter ? [String(filter).replace(/^\//, '')] : [];
    const dctAt = names.findIndex(n => n === 'DCTDecode' || n === 'DCT');
    if (dctAt === -1) return;
    if (dctAt !== names.length - 1) throw new Error('PDF: фильтр после DCTDecode не поддерживается');

    let bytes = stream.contents;
    for (const name of names.slice(0, dctAt)) {
        const decode = PRE_DCT_DECODERS[name];
        if (!decode) throw new Error(`PDF: фильтр ${name} перед DCTDecode не поддерживается`);
        bytes = await decode(bytes);
    }
    stream.contents = cleanJpeg(bytes);
    stream.dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    // Параметры декодирования шли парой к фильтрам; у DCTDecode свои —
    // оставляем только их.
    const parms = stream.dict.get(PDFName.of('DecodeParms'));
    if (parms instanceof PDFArray) {
        const own = parms.get(dctAt);
        if (own) stream.dict.set(PDFName.of('DecodeParms'), own);
        else stream.dict.delete(PDFName.of('DecodeParms'));
    }
}

function valuesOf(obj, lib) {
    const { PDFDict, PDFArray } = lib;
    const dict = obj instanceof PDFDict ? obj : (obj && obj.dict instanceof PDFDict ? obj.dict : null);
    if (dict) return [...dict.entries()].map(([, v]) => v);
    if (obj instanceof PDFArray) return obj.asArray();
    return [];
}

/** Объекты, достижимые от каталога: всё остальное в файле — мусор. */
function reachableRefs(context, lib) {
    const { PDFRef } = lib;
    const seen = new Set();
    const stack = [context.trailerInfo.Root];
    while (stack.length) {
        const item = stack.pop();
        if (item instanceof PDFRef) {
            const key = item.toString();
            if (seen.has(key)) continue;
            seen.add(key);
            stack.push(context.lookup(item));
            continue;
        }
        for (const v of valuesOf(item, lib)) stack.push(v);
    }
    return seen;
}

/**
 * Очистить PDF: словарь Info (автор, программа, даты), /ID, XMP-потоки,
 * PieceInfo, прикреплённые файлы, автора и даты у комментариев, EXIF во
 * встроенных JPEG. Файл пересохраняется только из объектов, достижимых от
 * каталога.
 *
 * Последнее — главное. После инкрементального обновления (так сохраняют
 * Acrobat и многие редакторы) в файле лежат ВСЕ прежние версии объектов, в
 * том числе старый словарь Info с именем автора. В просмотрщике их не
 * видно, но из файла они никуда не деваются, и pdf-lib выписывает их
 * обратно, если не выбросить недостижимое.
 *
 * pdfLib — модуль pdf-lib: на сервере его отдаёт require, в браузере —
 * import('/vendor/pdf-lib.esm.min.js').
 */
export async function cleanPdf(bytes, pdfLib) {
    const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream } = pdfLib;
    let doc;
    try {
        // updateMetadata: false — иначе pdf-lib сам допишет Producer и даты.
        doc = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (error) {
        const text = new TextDecoder('latin1').decode(bytes.subarray ? bytes.subarray(0, Math.min(bytes.length, 4 << 20)) : bytes);
        const encrypted = /encrypted/i.test(String(error && error.message)) || /\/Encrypt\b/.test(text);
        throw new PdfCleanError(encrypted ? 'encrypted' : 'broken', error);
    }
    const context = doc.context;
    const name = n => PDFName.of(n);

    context.trailerInfo.Info = undefined;
    context.trailerInfo.ID = undefined;

    const catalog = doc.catalog;
    const names = catalog.lookup(name('Names'));
    if (names instanceof PDFDict) names.delete(name('EmbeddedFiles'));

    for (const [ref, obj] of context.enumerateIndirectObjects()) {
        const dict = obj instanceof PDFDict ? obj : (obj && obj.dict instanceof PDFDict ? obj.dict : null);
        if (!dict) continue;
        if (dict.get(name('Type')) === name('Metadata')) {
            context.delete(ref);
            continue;
        }
        for (const key of METADATA_KEYS) dict.delete(name(key));

        const subtype = dict.get(name('Subtype'));
        const annots = dict.lookup(name('Annots'));
        if (annots instanceof PDFArray) {
            // Прикреплённые к странице файлы — вон вместе с аннотацией.
            for (let i = annots.size() - 1; i >= 0; i--) {
                const annot = annots.lookup(i);
                if (annot instanceof PDFDict && annot.get(name('Subtype')) === name('FileAttachment')) annots.remove(i);
            }
        }
        if (dict.get(name('Rect')) && subtype && subtype !== name('Widget')
            && (dict.get(name('Type')) === name('Annot') || dict.has(name('Contents')) || dict.has(name('T')))) {
            for (const key of ANNOT_PRIVATE_KEYS) dict.delete(name(key));
        }
        if (obj instanceof PDFRawStream && subtype === name('Image')) {
            await cleanEmbeddedJpeg(obj, pdfLib);
        }
    }

    const reachable = reachableRefs(context, pdfLib);
    for (const [ref] of context.enumerateIndirectObjects()) {
        if (!reachable.has(ref.toString())) context.delete(ref);
    }

    return doc.save({ useObjectStreams: false });
}
