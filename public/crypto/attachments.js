// Зашифрованные вложения и формат полезной нагрузки сообщения.
//
// Схема та же, что у Signal: у каждого файла свой случайный ключ AES-256-GCM,
// файл шифруется им целиком и уходит на сервер непрозрачными байтами, а ключ
// едет ВНУТРИ E2EE-сообщения вместе с именем и типом. Сервер видит только
// размер шифротекста.
//
// Этот модуль работает с DOM-API (createImageBitmap, OffscreenCanvas), поэтому
// он отдельно от e2ee.js — ядро крипты остаётся чистым и тестируемым в Node.

import { toB64, fromB64 } from './e2ee.js';
import { cleanIsoBmff, cleanPdf } from './metadata.js';
import { detectType, attachmentName, ATTACHMENT_TYPES, CONVERT_TO_JPEG, ISO_BMFF_TYPES } from './filetypes.js';

const subtle = globalThis.crypto.subtle;

/* ========================================================================
   Полезная нагрузка сообщения
   ===================================================================== */

// Каждое зашифрованное сообщение — это JSON с версией и типом, а не голая
// строка. Иначе вложение пришлось бы отличать от текста по содержимому, и
// собеседник мог бы набрать текст, который клиент примет за файл. Здесь
// набранный JSON просто окажется внутри body.
const PAYLOAD_VERSION = 1;
const BLOB_ID_RE = /^[0-9a-f]{32}$/;
const MAX_NAME = 255;

export function encodeText(body) {
    return JSON.stringify({ v: PAYLOAD_VERSION, t: 'text', body });
}

export function encodeFile(file) {
    return JSON.stringify({ v: PAYLOAD_VERSION, t: 'file', ...file });
}

function validFile(p) {
    try {
        return BLOB_ID_RE.test(p.blob)
            && fromB64(p.key).length === 32
            && fromB64(p.iv).length === 12
            && typeof p.mime === 'string' && p.mime.length < 128
            && typeof p.name === 'string' && p.name.length <= MAX_NAME
            && Number.isInteger(p.size) && p.size >= 0;
    } catch {
        return false;
    }
}

/**
 * Разобрать расшифрованную строку.
 *
 * Строка без обёртки считается текстом: так выглядят сообщения, отправленные
 * до появления вложений. Обёртка с битыми полями — не текст и не файл, а
 * повреждённое вложение: показывать её как текст значило бы вывалить
 * пользователю служебный JSON.
 */
export function decodePayload(str) {
    if (typeof str !== 'string') return null;
    if (str.startsWith('{')) {
        let parsed = null;
        try { parsed = JSON.parse(str); } catch { /* не JSON — обычный текст */ }
        if (parsed && parsed.v === PAYLOAD_VERSION) {
            if (parsed.t === 'text' && typeof parsed.body === 'string') return parsed;
            if (parsed.t === 'file') return validFile(parsed) ? parsed : { t: 'invalid' };
            return { t: 'invalid' };
        }
    }
    return { v: PAYLOAD_VERSION, t: 'text', body: str };
}

/** Короткая подпись для списка чатов. */
export function payloadPreview(p) {
    if (!p) return '';
    if (p.t === 'text') return p.body;
    if (p.t === 'file') {
        if (IMAGE_TYPES.has(p.mime)) return 'Фото';
        if (VIDEO_TYPES.has(p.mime)) return 'Видео';
        return `Файл: ${p.name}`;
    }
    return 'Вложение';
}

/* ========================================================================
   Подготовка вложения: тип, очистка, имя
   ===================================================================== */

// Под E2EE сервер файл не видит и снять метаданные не может, а собеседник
// видит всё. Поэтому файл готовит отправитель — до шифрования. В открытом
// чате (бот, собеседника пока нет) тот же путь проходится перед загрузкой,
// а сервер чистит ещё раз: ему клиент не указ.

// JPEG, PNG и WebP перерисовываются через canvas: createImageBitmap
// применяет EXIF-ориентацию к пикселям, а canvas при экспорте не пишет ни
// EXIF, ни XMP, ни IPTC.
const REENCODE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// GIF не перерисовывается: canvas сохранил бы только первый кадр.
export const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

const JPEG_QUALITY = 0.92;

// pdf-lib весит полмегабайта, поэтому грузится только когда прикладывают PDF.
let pdfLib = null;
const loadPdfLib = () => (pdfLib = pdfLib || import('/vendor/pdf-lib.esm.min.js'));

/**
 * Перерисовать картинку. targetType — в каком формате сохранить; если
 * браузер в него не кодирует (WebP в Safari), он молча вернёт PNG — тип
 * берётся из результата.
 */
async function redraw(blob, targetType) {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        return await canvas.convertToBlob({ type: targetType, quality: JPEG_QUALITY });
    } finally {
        bitmap.close();
    }
}

/**
 * Подготовить файл к отправке. Возвращает { blob, mime, name }.
 *
 * - тип определяется по содержимому (filetypes.js); всё, чего нет в
 *   списке, не уходит — в том числе TIFF, DNG, HEIC, который браузер не
 *   умеет открыть;
 * - HEIC и AVIF перерисовываются в JPEG, если браузер умеет их декодировать —
 *   это проверяется пробной расшифровкой, а не по названию браузера;
 * - фото перерисовываются, из MP4/MOV/3GP убираются координаты и даты, PDF
 *   пересохраняется без автора и XMP;
 * - имя фото и видео заменяется нейтральным, с расширением по итоговому типу.
 *
 * Не удалось — исключение, а не исходный файл: молча отправить фото с
 * координатами хуже, чем не отправить его вовсе.
 */
export async function prepareAttachment(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const detected = detectType(bytes);
    if (!detected || !(detected in ATTACHMENT_TYPES || CONVERT_TO_JPEG.has(detected))) {
        throw new Error('этот тип файла не поддерживается');
    }

    let blob = new Blob([bytes], { type: detected });
    if (CONVERT_TO_JPEG.has(detected)) {
        try {
            blob = await redraw(blob, 'image/jpeg');
        } catch {
            const format = detected === 'image/heic' ? 'HEIC' : 'AVIF';
            throw new Error(`этот браузер не умеет открывать ${format} — сохраните фото как JPEG`);
        }
    } else if (REENCODE_TYPES.has(detected)) {
        try {
            blob = await redraw(blob, detected);
        } catch {
            throw new Error('не удалось прочитать изображение для очистки метаданных');
        }
    } else if (ISO_BMFF_TYPES.has(detected)) {
        try {
            blob = new Blob([cleanIsoBmff(bytes).bytes], { type: detected });
        } catch {
            throw new Error('не удалось удалить метаданные из видео');
        }
    } else if (detected === 'application/pdf') {
        try {
            blob = new Blob([await cleanPdf(bytes, await loadPdfLib())], { type: detected });
        } catch {
            throw new Error('не удалось удалить метаданные из PDF (возможно, он защищён паролем)');
        }
    }

    const mime = blob.type || detected;
    return { blob, mime, name: attachmentName(mime, file.name) };
}

/* ========================================================================
   Шифрование файла
   ===================================================================== */

/**
 * Зашифровать файл собственным одноразовым ключом.
 *
 * Ключ уникален для каждого файла, поэтому случайный IV не рискует
 * повториться с тем же ключом. Подменить шифротекст на сервере нельзя:
 * GCM-тег проверяется ключом, который сервер не видит.
 */
export async function encryptAttachment(file) {
    const { blob, mime, name } = await prepareAttachment(file);
    const plain = new Uint8Array(await blob.arrayBuffer());

    const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const rawKey = new Uint8Array(await subtle.exportKey('raw', key));

    return {
        ciphertext,
        meta: {
            key: toB64(rawKey),
            iv: toB64(iv),
            name: name.slice(0, MAX_NAME),
            mime,
            size: plain.length,
        },
    };
}

/* ========================================================================
   Показ вложения
   ===================================================================== */

// Расшифрованные вложения держатся в памяти как object URL, пока открыт чат.
const urlCache = new Map();

/**
 * Скачать и расшифровать вложение. Возвращает { url, kind }.
 *
 * Тип Blob выставляется из белого списка, а не из того, что прислал
 * собеседник. Иначе он мог бы объявить файл text/html, и ссылка на
 * blob: исполнилась бы в нашем origin — рядом с ключами в IndexedDB. Всё,
 * что не картинка и не видео из списка, получает application/octet-stream
 * и может быть только скачано.
 */
export async function openAttachment(p) {
    if (urlCache.has(p.blob)) return urlCache.get(p.blob);

    const response = await fetch(`/api/blobs/${p.blob}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(response.status === 404 ? 'вложение удалено' : `ошибка ${response.status}`);
    const ciphertext = new Uint8Array(await response.arrayBuffer());

    const key = await subtle.importKey('raw', fromB64(p.key), { name: 'AES-GCM' }, false, ['decrypt']);
    let plain;
    try {
        plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(p.iv) }, key, ciphertext);
    } catch {
        throw new Error('вложение повреждено или подменено');
    }

    const kind = IMAGE_TYPES.has(p.mime) ? 'image' : VIDEO_TYPES.has(p.mime) ? 'video' : 'file';
    const type = kind === 'file' ? 'application/octet-stream' : p.mime;
    const result = { url: URL.createObjectURL(new Blob([plain], { type })), kind };
    urlCache.set(p.blob, result);
    return result;
}

/** Освободить память при смене чата. */
export function releaseAttachments() {
    for (const { url } of urlCache.values()) URL.revokeObjectURL(url);
    urlCache.clear();
}
