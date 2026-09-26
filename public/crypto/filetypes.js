// Какие вложения принимаются и как они называются. Общий для браузера и
// сервера модуль: список разрешённых типов один на оба пути.
//
// Тип определяется по СОДЕРЖИМОМУ, а не по расширению и не по тому, что
// объявил браузер. Иначе JPEG с координатами, переименованный в .txt, ушёл
// бы «текстом» мимо очистки, а HEIC с GPS — как «незнакомый файл».

export const ATTACHMENT_TYPES = {
    'image/jpeg': { ext: '.jpg', neutral: 'photo' },
    'image/png': { ext: '.png', neutral: 'photo' },
    'image/webp': { ext: '.webp', neutral: 'photo' },
    'image/gif': { ext: '.gif', neutral: 'animation' },
    'video/mp4': { ext: '.mp4', neutral: 'video' },
    'video/quicktime': { ext: '.mov', neutral: 'video' },
    'video/3gpp': { ext: '.3gp', neutral: 'video' },
    'video/webm': { ext: '.webm', neutral: 'video' },
    'application/pdf': { ext: '.pdf' },
    'text/plain': { ext: '.txt' },
};

// Эти форматы в исходном виде не отправляются: браузер декодирует их и
// перерисовывает в JPEG (метаданные при этом не переносятся). Не умеет
// декодировать — файл не уходит. Через cleanIsoBmff их пускать нельзя:
// HEIF и AVIF — тоже ISO BMFF, но картинка там лежит в блоке meta, и
// «очистка» стёрла бы само изображение.
export const CONVERT_TO_JPEG = new Set(['image/heic', 'image/avif']);

// Видео в контейнере ISO BMFF — чистятся cleanIsoBmff.
export const ISO_BMFF_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/3gpp']);

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
// Видео — только известные бренды. Раньше видео считалось всё, что
// начинается с ftyp: и RAW-снимок Canon CR3 (бренд «crx », внутри EXIF с
// координатами), и аудио M4A уходили «видео» мимо нужной очистки.
const MP4_BRANDS = new Set([
    'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso8', 'iso9',
    'mp41', 'mp42', 'avc1', 'dash', 'mmp4', 'MSNV', 'XAVC', 'f4v ',
    'M4V ', 'M4VH', 'M4VP',
]);

const ascii = (b, from, len) => String.fromCharCode(...b.subarray(from, from + len));
const startsWith = (b, sig) => b.length >= sig.length && sig.every((x, i) => x === b[i]);

/**
 * Файл — обычный текст: корректный UTF-8 без нулевых байтов. Нулевой байт
 * в тексте не встречается, зато есть в любом бинарном формате.
 */
export function isPlainText(bytes) {
    if (bytes.includes(0)) return false;
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return true;
    } catch {
        return false;
    }
}

/** Тип файла по содержимому или null, если формат не поддерживается. */
export function detectType(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'image/gif';
    if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
    if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return 'application/pdf';
    if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
    if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
        const brand = ascii(b, 8, 4);
        if (HEIF_BRANDS.has(brand)) return 'image/heic';
        if (AVIF_BRANDS.has(brand)) return 'image/avif';
        if (brand === 'qt  ') return 'video/quicktime';
        if (brand.startsWith('3g')) return 'video/3gpp';
        if (MP4_BRANDS.has(brand)) return 'video/mp4';
        return null;
    }
    if (isPlainText(b)) return 'text/plain';
    return null;
}

// Невидимые символы направления текста. С ними «report‮fdp.exe» выглядит
// как «reportexe.pdf»: U+202E разворачивает хвост имени задом наперёд.
const BIDI_CONTROLS = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g;

/**
 * Имя, под которым файл уходит собеседнику.
 *
 * Имя фото и видео выдаёт дату, время и приложение
 * (IMG_20260925_185512.jpg, Screenshot_…_com.whatsapp.jpg), поэтому оно
 * заменяется нейтральным, с расширением по фактическому типу. Имя документа
 * человек выбирал сам, и получателю оно нужно — оно остаётся, но
 * расширение и у него по фактическому типу: текст, названный run.bat,
 * update.hta или install.ps1, уходит как run.txt и двойным щелчком не
 * выполнится. Тип вне списка — .bin.
 */
export function attachmentName(mime, originalName) {
    const spec = ATTACHMENT_TYPES[mime];
    if (spec && spec.neutral) return spec.neutral + spec.ext;
    const ext = spec ? spec.ext : '.bin';
    const clean = String(originalName || '')
        .replace(BIDI_CONTROLS, '')
        .replace(/[\\/\u0000-\u001f\u007f]/g, '')
        .trim();
    const dot = clean.lastIndexOf('.');
    const base = (dot > 0 ? clean.slice(0, dot) : clean).replace(/[.\s]+$/, '').slice(0, 255 - ext.length);
    return (base || 'file') + ext;
}
