// Очистка метаданных вложений: MP4/MOV и PDF вместе с картинками JPEG и
// JPEG 2000 внутри него.
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
// uuid — частные блоки производителей: XMP от Adobe, у Canon — миниатюра
// с EXIF и модель камеры (CNTH, CNCV). Для воспроизведения ни один не нужен.
const METADATA_BOXES = new Set(['udta', 'meta', 'uuid']);
const DATED_HEADERS = new Set(['mvhd', 'tkhd', 'mdhd']);
// Что может лежать на верхнем уровне. Остальное — pnot с превью у
// QuickTime, блоки, которые дописывают камеры и программы, — становится
// free: мы не знаем, что в нём.
const TOP_LEVEL_BOXES = new Set([
    'ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'moof', 'mfra', 'sidx', 'ssix', 'styp', 'prft', 'emsg',
    ...METADATA_BOXES,
]);

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

function walk(buf, view, start, end, removed, topLevel = false) {
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

        if (METADATA_BOXES.has(type) || (topLevel && !TOP_LEVEL_BOXES.has(type))) {
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
    walk(buf, new DataView(buf.buffer, buf.byteOffset, buf.byteLength), 0, buf.length, removed, true);
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
            if (scan + 1 >= b.length) {
                // Данные обрываются без EOI: файл обрезан, но просмотрщики
                // такие показывают. Сегментов в сжатых данных нет — хватит
                // дописать EOI.
                parts.push(b.subarray(pos), new Uint8Array([0xff, 0xd9]));
                return concatBytes(parts);
            }
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
   JPEG 2000
   ===================================================================== */

// JP2 устроен блоками, как MP4. Для отрисовки нужны сигнатура, ftyp,
// заголовки и кодовый поток; XMP, EXIF и координаты (GeoJP2, GMLJP2) лежат
// в блоках uuid, xml и asoc. Всё, чего нет в списке, становится free того
// же размера: смещения, на которые ссылаются таблицы фрагментов JPX, не
// сдвигаются.
const JP2_SIGNATURE = [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a];
const JP2_KEEP = new Set(['jP  ', 'ftyp', 'rreq', 'jp2h', 'jpch', 'jplh', 'cgrp', 'jp2c', 'ftbl', 'mdat', 'free']);

/** Очистить JPEG 2000. Возвращает новый массив того же размера. */
export function cleanJp2(input) {
    const buf = new Uint8Array(input);
    // Голый кодовый поток, без обёртки JP2: метаданных в нём нет, только
    // комментарий с именем кодировщика.
    if (buf[0] === 0xff && buf[1] === 0x4f) return buf;
    if (buf.length < JP2_SIGNATURE.length || JP2_SIGNATURE.some((v, i) => buf[i] !== v)) {
        throw new Error('JPEG 2000: нет сигнатуры');
    }
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let pos = 0;
    while (pos < buf.length) {
        if (buf.length - pos < 8) throw new Error('JPEG 2000: обрезанный заголовок блока');
        let size = view.getUint32(pos);
        const type = boxType(buf, pos + 4);
        let headerLen = 8;
        if (size === 1) {
            if (buf.length - pos < 16) throw new Error('JPEG 2000: обрезанный заголовок блока');
            const big = view.getBigUint64(pos + 8);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('JPEG 2000: блок слишком велик');
            size = Number(big);
            headerLen = 16;
        } else if (size === 0) {
            size = buf.length - pos;
        }
        if (size < headerLen || pos + size > buf.length) throw new Error(`JPEG 2000: блок ${type} выходит за границы`);
        if (!JP2_KEEP.has(type)) wipeBox(buf, pos, size, headerLen);
        pos += size;
    }
    return buf;
}

/* ========================================================================
   Ориентация из EXIF
   ===================================================================== */

// Телефон пишет пиксели как есть и ставит в EXIF «повернуть на 90°».
// Выбросив EXIF, мы выбросили бы и поворот — фото легло бы набок. Поэтому
// очистка сообщает ориентацию, и при значении не 1 картинка
// перерисовывается с поворотом, а не отправляется без EXIF как есть.

/** Ориентация из TIFF-структуры EXIF: 1–8, или 1, если её нет. */
function tiffOrientation(tiff) {
    if (tiff.length < 8) return 1;
    const little = tiff[0] === 0x49 && tiff[1] === 0x49;
    if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1;
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const ifd = view.getUint32(4, little);
    if (ifd + 2 > tiff.length) return 1;
    const count = view.getUint16(ifd, little);
    for (let i = 0; i < count; i++) {
        const at = ifd + 2 + i * 12;
        if (at + 12 > tiff.length) break;
        if (view.getUint16(at, little) === 0x0112) {
            const value = view.getUint16(at + 8, little);
            return value >= 1 && value <= 8 ? value : 1;
        }
    }
    return 1;
}

const withoutExifHeader = bytes =>
    (startsWithAscii(bytes, 'Exif\0\0') ? bytes.subarray(6) : bytes);

/* ========================================================================
   PNG и APNG без перекодирования
   ===================================================================== */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Нужное для отрисовки и анимации (acTL, fcTL, fdAT — APNG). Выбрасываются
// tEXt, zTXt, iTXt (там XMP, автор, программа, комментарии), eXIf (EXIF с
// координатами), tIME (время правки) и всё незнакомое вспомогательное.
const PNG_KEEP = new Set([
    'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs',
    'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCV', 'mDCv', 'cLLI', 'cLLi',
]);

/** Очистить PNG. Возвращает { bytes, orientation, animated }. */
export function cleanPng(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (b.length < 8 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) throw new Error('PNG: нет сигнатуры');
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const parts = [b.subarray(0, 8)];
    let orientation = 1;
    let animated = false;
    let pos = 8;
    while (pos + 12 <= b.length) {
        const len = view.getUint32(pos);
        const type = boxType(b, pos + 4);
        const end = pos + 12 + len;
        if (end > b.length) throw new Error(`PNG: блок ${type} выходит за границы`);
        if (type === 'eXIf') orientation = tiffOrientation(withoutExifHeader(b.subarray(pos + 8, pos + 8 + len)));
        if (type === 'acTL') animated = true;
        if (PNG_KEEP.has(type)) {
            parts.push(b.subarray(pos, end));
        } else if (type.charCodeAt(0) < 0x61) {
            // Заглавная первая буква — блок обязательный: без него картинку
            // не нарисовать, а мы его не знаем. Отправлять вслепую нельзя.
            throw new Error(`PNG: незнакомый обязательный блок ${type}`);
        }
        pos = end;
        if (type === 'IEND') return { bytes: concatBytes(parts), orientation, animated };   // хвост — прочь
    }
    throw new Error('PNG: нет IEND');
}

/* ========================================================================
   GIF без перекодирования
   ===================================================================== */

// Кадры, палитры и управление анимацией остаются. Выбрасываются
// комментарии и расширения приложений, кроме повтора анимации
// (NETSCAPE2.0, ANIMEXTS1.0) и цветового профиля (ICCRGBG1): в них кладут
// XMP и всё, что угодно программе. И всё после конца файла.
const GIF_KEEP_APPS = ['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012'];

/** Очистить GIF. Возвращает { bytes, orientation, animated }. */
export function cleanGif(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (b.length < 13 || !(startsWithAscii(b, 'GIF87a') || startsWithAscii(b, 'GIF89a'))) throw new Error('GIF: нет сигнатуры');
    const colorTable = packed => (packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0);
    // Цепочка подблоков: байт длины, данные, …, нулевой байт.
    const skipSubBlocks = at => {
        while (true) {
            if (at >= b.length) throw new Error('GIF: обрезан');
            const size = b[at];
            at += 1 + size;
            if (size === 0) return at;
        }
    };
    let pos = 13 + colorTable(b[10]);
    if (pos > b.length) throw new Error('GIF: обрезан');
    const parts = [b.subarray(0, pos)];
    let frames = 0;
    while (pos < b.length) {
        const marker = b[pos];
        if (marker === 0x3b) {   // конец файла; хвост отрезается
            parts.push(b.subarray(pos, pos + 1));
            return { bytes: concatBytes(parts), orientation: 1, animated: frames > 1 };
        }
        if (marker === 0x2c) {   // кадр
            if (pos + 10 > b.length) throw new Error('GIF: обрезан');
            const end = skipSubBlocks(pos + 10 + colorTable(b[pos + 9]) + 1);
            parts.push(b.subarray(pos, end));
            frames++;
            pos = end;
            continue;
        }
        if (marker === 0x21) {   // расширение
            const label = b[pos + 1];
            const end = skipSubBlocks(pos + 2);
            let keep = label === 0xf9 || label === 0x01;   // управление кадром, текст кадра
            if (label === 0xff) {
                const id = String.fromCharCode(...b.subarray(pos + 3, pos + 14));
                keep = b[pos + 2] === 11 && GIF_KEEP_APPS.includes(id);
            }
            if (keep) parts.push(b.subarray(pos, end));
            pos = end;
            continue;
        }
        throw new Error('GIF: незнакомый блок');
    }
    throw new Error('GIF: нет конца файла');
}

/* ========================================================================
   WebP без перекодирования (и анимированный)
   ===================================================================== */

// Остаются изображение, прозрачность, анимация и цветовой профиль;
// EXIF и XMP выбрасываются, а в заголовке VP8X снимаются их флаги.
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ANIM', 'ANMF', 'ALPH', 'ICCP']);
const WEBP_FLAG_EXIF = 0x08;
const WEBP_FLAG_XMP = 0x04;
const WEBP_FLAG_ANIMATION = 0x02;

/** Очистить WebP. Возвращает { bytes, orientation, animated }. */
export function cleanWebp(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (b.length < 12 || !startsWithAscii(b, 'RIFF') || boxType(b, 8) !== 'WEBP') throw new Error('WebP: нет сигнатуры');
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const riffEnd = 8 + view.getUint32(4, true);
    if (riffEnd > b.length) throw new Error('WebP: обрезан');
    const parts = [];
    let orientation = 1;
    let animated = false;
    let pos = 12;
    while (pos < riffEnd) {
        if (pos + 8 > riffEnd) throw new Error('WebP: обрезанный заголовок блока');
        const type = boxType(b, pos);
        const size = view.getUint32(pos + 4, true);
        const end = pos + 8 + size + (size & 1);
        if (pos + 8 + size > riffEnd) throw new Error(`WebP: блок ${type} выходит за границы`);
        if (type === 'EXIF') orientation = tiffOrientation(withoutExifHeader(b.subarray(pos + 8, pos + 8 + size)));
        if (WEBP_KEEP.has(type)) {
            const chunk = b.slice(pos, Math.min(end, riffEnd));
            if (type === 'VP8X') {
                animated = Boolean(chunk[8] & WEBP_FLAG_ANIMATION);
                chunk[8] &= ~(WEBP_FLAG_EXIF | WEBP_FLAG_XMP);
            }
            parts.push(chunk);
        }
        pos = end;
    }
    const body = concatBytes(parts);
    const header = new Uint8Array(12);
    header.set(b.subarray(0, 12));
    new DataView(header.buffer).setUint32(4, body.length + 4, true);
    return { bytes: concatBytes([header, body]), orientation, animated };   // хвост за RIFF — прочь
}

/* ========================================================================
   WebM (Matroska) без перекодирования
   ===================================================================== */

// ffmpeg переносит в WebM теги исходника: LOCATION (координаты), MAKE,
// MODEL, дату съёмки; программы кладут название и дату в Info. Всё это
// заменяется элементами Void того же размера — их плеер пропускает, а
// смещения в SeekHead и Cues остаются верными. Сами кадры не трогаются.
const EBML_ID = {
    EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, Tracks: 0x1654ae6b, TrackEntry: 0xae,
    Tags: 0x1254c367, Attachments: 0x1941a469, Cluster: 0x1f43b675, Void: 0xec,
};
// Что стирается внутри Info и у дорожек. CRC-32 — тоже: он считался по
// прежнему содержимому и после очистки не сойдётся.
const EBML_CRC32 = 0xbf;
const EBML_INFO_PRIVATE = new Set([0x7ba9 /* Title */, 0x4461 /* DateUTC */, 0x4d80 /* MuxingApp */, 0x5741 /* WritingApp */, EBML_CRC32]);
const EBML_TRACK_PRIVATE = new Set([0x536e /* Name */, EBML_CRC32]);
// Элементы первого уровня внутри Segment: по ним видно, где кончается
// кластер неизвестной длины (так пишет MediaRecorder).
const EBML_LEVEL1 = new Set([0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1043a770, 0x1f43b675, 0x1c53bb6b, 0x1941a469, 0x1254c367]);

function readVint(b, pos, keepMarker) {
    const first = b[pos];
    if (first === undefined || first === 0) throw new Error('WebM: некорректное число');
    let length = 1;
    while (!(first & (0x80 >> (length - 1)))) length++;
    if (pos + length > b.length) throw new Error('WebM: обрезан');
    let value = keepMarker ? first : first & (0xff >> length);
    let allOnes = value === (0xff >> length);
    for (let i = 1; i < length; i++) {
        value = value * 256 + b[pos + i];
        if (b[pos + i] !== 0xff) allOnes = false;
    }
    return { length, value, unknown: !keepMarker && allOnes };
}

function readElement(b, pos) {
    const id = readVint(b, pos, true);
    const size = readVint(b, pos + id.length, false);
    const dataStart = pos + id.length + size.length;
    return { id: id.value, dataStart, size: size.unknown ? null : size.value };
}

/** Заменить элемент [start, end) на Void того же размера. */
function voidElement(b, start, end) {
    const total = end - start;
    b.fill(0, start, end);
    b[start] = EBML_ID.Void;
    if (total >= 9) {
        b[start + 1] = 0x01;   // 8-байтовая длина
        let rest = total - 9;
        for (let i = 8; i >= 2; i--) {
            b[start + i] = rest % 256;
            rest = Math.floor(rest / 256);
        }
    } else {
        b[start + 1] = 0x80 | (total - 2);
    }
}

function voidChildren(b, start, end, ids) {
    let pos = start;
    while (pos < end) {
        const el = readElement(b, pos);
        if (el.size === null) throw new Error('WebM: неизвестная длина внутри заголовка');
        const elEnd = el.dataStart + el.size;
        if (elEnd > end) throw new Error('WebM: элемент выходит за границы');
        if (ids.has(el.id)) voidElement(b, pos, elEnd);
        pos = elEnd;
    }
}

/** Конец кластера неизвестной длины: первый элемент первого уровня. */
function clusterEnd(b, start, limit) {
    let pos = start;
    while (pos < limit) {
        const el = readElement(b, pos);
        if (EBML_LEVEL1.has(el.id)) return pos;
        if (el.size === null) throw new Error('WebM: неизвестная длина внутри кластера');
        pos = el.dataStart + el.size;
    }
    return limit;
}

/** Очистить WebM. Возвращает новый массив (хвост за Segment отрезан). */
export function cleanWebm(input) {
    const b = new Uint8Array(input);
    const header = readElement(b, 0);
    if (header.id !== EBML_ID.EBML || header.size === null) throw new Error('WebM: нет заголовка EBML');
    const segmentStart = header.dataStart + header.size;
    const segment = readElement(b, segmentStart);
    if (segment.id !== EBML_ID.Segment) throw new Error('WebM: нет Segment');
    const segmentEnd = segment.size === null ? b.length : segment.dataStart + segment.size;
    if (segmentEnd > b.length) throw new Error('WebM: обрезан');

    let pos = segment.dataStart;
    while (pos < segmentEnd) {
        const el = readElement(b, pos);
        let end;
        if (el.size === null) {
            if (el.id !== EBML_ID.Cluster) throw new Error('WebM: неизвестная длина не у кластера');
            end = clusterEnd(b, el.dataStart, segmentEnd);
        } else {
            end = el.dataStart + el.size;
        }
        if (end > segmentEnd) throw new Error('WebM: элемент выходит за границы');
        if (el.id === EBML_ID.Info) {
            voidChildren(b, el.dataStart, end, EBML_INFO_PRIVATE);
        } else if (el.id === EBML_ID.Tracks) {
            let t = el.dataStart;
            while (t < end) {
                const entry = readElement(b, t);
                if (entry.size === null) throw new Error('WebM: неизвестная длина дорожки');
                const entryEnd = entry.dataStart + entry.size;
                if (entry.id === EBML_ID.TrackEntry) voidChildren(b, entry.dataStart, entryEnd, EBML_TRACK_PRIVATE);
                else if (entry.id === EBML_CRC32) voidElement(b, t, entryEnd);
                t = entryEnd;
            }
        } else if (el.id === EBML_ID.Tags || el.id === EBML_ID.Attachments) {
            voidElement(b, pos, end);
        }
        pos = end;
    }
    return b.slice(0, segmentEnd);
}

/* ========================================================================
   Картинки: общий вход
   ===================================================================== */

/**
 * Очистить картинку без перекодирования. Возвращает { bytes, orientation,
 * animated }. orientation не 1 — пиксели лежат повёрнутыми, и без EXIF
 * картинка ляжет набок: такую надо перерисовать (кто вызывает, тот решает
 * как — canvas в браузере, sharp на сервере).
 */
export function cleanImage(bytes, mime) {
    if (mime === 'image/jpeg') {
        const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        return { bytes: cleanJpeg(b), orientation: jpegOrientation(b), animated: false };
    }
    if (mime === 'image/png') return cleanPng(bytes);
    if (mime === 'image/gif') return cleanGif(bytes);
    if (mime === 'image/webp') return cleanWebp(bytes);
    throw new Error(`нечем очистить ${mime}`);
}

function jpegOrientation(b) {
    let pos = 2;
    while (pos + 4 <= b.length && b[pos] === 0xff) {
        const marker = b[pos + 1];
        if (marker === 0xda || marker === 0xd9) break;
        const len = (b[pos + 2] << 8) | b[pos + 3];
        if (marker === 0xe1 && startsWithAscii(b.subarray(pos + 4, pos + 2 + len), 'Exif\0\0')) {
            return tiffOrientation(b.subarray(pos + 10, pos + 2 + len));
        }
        pos += 2 + len;
    }
    return 1;
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
        this.name = 'PdfCleanError';
        this.kind = kind;
        this.cause = cause;
    }
}

// Ключи, в которых PDF хранит не сам документ, а сведения о нём: XMP,
// приватные данные программ (Illustrator и Photoshop кладут в PieceInfo хоть
// весь исходный файл), дату изменения, прикреплённые файлы, адреса
// сохранённых веб-страниц. И миниатюры страниц: их рисуют один раз, и после
// правок в миниатюре остаётся страница такой, какой она была до них.
const METADATA_KEYS = ['Metadata', 'PieceInfo', 'LastModified', 'AF', 'SpiderInfo', 'Thumb'];

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

const PRE_IMAGE_DECODERS = {
    FlateDecode: inflate,
    Fl: inflate,
    ASCIIHexDecode: asciiHexDecode,
    AHx: asciiHexDecode,
    ASCII85Decode: ascii85Decode,
    A85: ascii85Decode,
};

// Картинки, которые PDF хранит в формате файла, а не пикселями: такие
// сканер или программа вставляют байт в байт, со всем EXIF, XMP и GPS.
const IMAGE_CLEANERS = {
    DCTDecode: cleanJpeg,
    DCT: cleanJpeg,
    JPXDecode: cleanJp2,
};

/**
 * Встроенная картинка JPEG или JPEG 2000: снять с неё предшествующие
 * фильтры (Flate и подобные), очистить и записать обратно с одним
 * фильтром — её собственным.
 */
async function cleanEmbeddedImage(stream, lib) {
    const { PDFName, PDFArray } = lib;
    const nameOf = f => f instanceof PDFName ? f.decodeText() : '';
    const filter = stream.dict.lookup(PDFName.of('Filter'));
    const names = filter instanceof PDFArray
        ? filter.asArray().map((_, i) => nameOf(filter.lookup(i)))
        : filter ? [nameOf(filter)] : [];
    const at = names.findIndex(n => Object.hasOwn(IMAGE_CLEANERS, n));
    if (at === -1) return;
    if (at !== names.length - 1) throw new Error(`PDF: фильтр после ${names[at]} не поддерживается`);

    let bytes = stream.contents;
    for (const name of names.slice(0, at)) {
        const decode = PRE_IMAGE_DECODERS[name];
        if (!decode) throw new Error(`PDF: фильтр ${name} перед ${names[at]} не поддерживается`);
        bytes = await decode(bytes);
    }
    stream.contents = IMAGE_CLEANERS[names[at]](bytes);
    stream.dict.set(PDFName.of('Filter'), PDFName.of(names[at]));
    // Параметры декодирования шли парой к фильтрам; у последнего свои —
    // оставляем только их.
    const parms = stream.dict.lookup(PDFName.of('DecodeParms'));
    if (parms instanceof PDFArray) {
        const own = parms.get(at);
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
 * PieceInfo, миниатюры, прикреплённые файлы, автора и даты у комментариев,
 * EXIF и XMP во встроенных JPEG и JPEG 2000. Файл пересохраняется только из
 * объектов, достижимых от каталога.
 *
 * Последнее — главное. После инкрементального обновления (так сохраняют
 * Acrobat и многие редакторы) в файле лежат ВСЕ прежние версии объектов, в
 * том числе старый словарь Info с именем автора. В просмотрщике их не
 * видно, но из файла они никуда не деваются, и pdf-lib выписывает их
 * обратно, если не выбросить недостижимое.
 *
 * Не удалось — PdfCleanError: «защищён паролем» или «повреждён».
 *
 * pdfLib — модуль pdf-lib: на сервере его отдаёт require, в браузере —
 * import('/vendor/pdf-lib.esm.min.js').
 */
export async function cleanPdf(bytes, pdfLib) {
    const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream } = pdfLib;
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
    const dictOf = obj => obj instanceof PDFDict ? obj : (obj && obj.dict instanceof PDFDict ? obj.dict : null);

    context.trailerInfo.Info = undefined;
    context.trailerInfo.ID = undefined;

    const catalog = doc.catalog;
    const names = catalog.lookup(name('Names'));
    if (names instanceof PDFDict) names.delete(name('EmbeddedFiles'));
    // У «статей» (связанных блоков текста) свой словарь сведений, такой же,
    // как Info: автор, название, даты.
    const threads = catalog.lookup(name('Threads'));
    if (threads instanceof PDFArray) {
        for (let i = 0; i < threads.size(); i++) {
            const thread = threads.lookup(i);
            if (thread instanceof PDFDict) thread.delete(name('I'));
        }
    }

    for (const [ref, obj] of context.enumerateIndirectObjects()) {
        const dict = dictOf(obj);
        if (!dict) continue;
        if (dict.get(name('Type')) === name('Metadata')) {
            context.delete(ref);
            continue;
        }
        for (const key of METADATA_KEYS) dict.delete(name(key));

        const annots = dict.lookup(name('Annots'));
        if (annots instanceof PDFArray) {
            // Прикреплённые к странице файлы — вон вместе с аннотацией.
            for (let i = annots.size() - 1; i >= 0; i--) {
                const annot = annots.lookup(i);
                if (annot instanceof PDFDict && annot.get(name('Subtype')) === name('FileAttachment')) annots.remove(i);
            }
        }
        const subtype = dict.get(name('Subtype'));
        if (dict.has(name('Rect')) && subtype instanceof PDFName) {
            // Аннотация. Даты создания и правки бывают у любой, автор (/T) —
            // у комментариев. У полей формы (Widget) /T — имя поля, без него
            // форма сломается.
            dict.delete(name('M'));
            dict.delete(name('CreationDate'));
            if (subtype !== name('Widget')) dict.delete(name('T'));
        }
    }

    // Недостижимое — вон. Картинки чистятся уже после: в мусоре могут
    // лежать и такие, которые не разобрать, а отказывать из-за них незачем.
    const reachable = reachableRefs(context, pdfLib);
    let largest = 0;
    for (const [ref] of context.enumerateIndirectObjects()) {
        if (!reachable.has(ref.toString())) context.delete(ref);
        else largest = Math.max(largest, ref.objectNumber);
    }
    // /Size в трейлере pdf-lib считает от наибольшего номера объекта.
    context.largestObjectNumber = largest;

    for (const [, obj] of context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFRawStream) || obj.dict.lookup(name('Subtype')) !== name('Image')) continue;
        try {
            await cleanEmbeddedImage(obj, pdfLib);
        } catch (error) {
            throw new PdfCleanError('broken', error);
        }
    }

    return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}
