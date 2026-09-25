// Фикстуры MP4 для тестов очистки метаданных.
//
// Метаданные записываются так, как их пишет iPhone: координаты в ©xyz
// (udta) и в com.apple.quicktime.location.ISO6709 (meta), производитель,
// модель, дата съёмки в заголовках mvhd/tkhd/mdhd.

export const GPS = '+55.7558+037.6173+150.000/';
export const MODEL = 'iPhone 15 Pro';

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
export const box = (type, ...parts) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};
const fullBox = (type, version, ...parts) => box(type, Buffer.from([version, 0, 0, 0]), ...parts);

// Строка QuickTime в udta: длина, язык, текст.
const qtString = (type, text) => box(type, u16(Buffer.byteLength(text)), u16(0x15c7), Buffer.from(text));

// 2024-06-01 в секундах от 1904 года — так QuickTime хранит даты.
export const SHOT_AT = Math.floor(Date.UTC(2024, 5, 1) / 1000) + 2082844800;

export function iphoneUdta() {
    return box('udta',
        qtString('\xa9xyz', GPS),
        qtString('\xa9mak', 'Apple'),
        qtString('\xa9mod', MODEL));
}

export function iphoneMeta() {
    const key = name => Buffer.concat([u32(8 + name.length), Buffer.from('mdta'), Buffer.from(name)]);
    const keys = fullBox('keys', 0, u32(2),
        key('com.apple.quicktime.location.ISO6709'), key('com.apple.quicktime.model'));
    const value = text => box('data', u32(1), u32(0), Buffer.from(text));
    const item = (index, text) => Buffer.concat([u32(8 + 8 + 8 + Buffer.byteLength(text)), u32(index), value(text)]);
    return box('meta',
        fullBox('hdlr', 0, u32(0), Buffer.from('mdta'), Buffer.alloc(12), Buffer.from([0])),
        keys,
        box('ilst', item(1, GPS), item(2, MODEL)));
}

// Adobe XMP в uuid-блоке.
export function xmpUuid() {
    const id = Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex');
    return box('uuid', id, Buffer.from(`<x:xmpmeta><exif:GPSLatitude>55,45.3N</exif:GPSLatitude><tiff:Model>${MODEL}</tiff:Model></x:xmpmeta>`));
}

/** Разобрать блоки верхнего уровня (или внутри контейнера). */
export function boxes(buf, start = 0, end = buf.length) {
    const out = [];
    let pos = start;
    while (pos + 8 <= end) {
        let size = buf.readUInt32BE(pos);
        let header = 8;
        if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); header = 16; } else if (size === 0) size = end - pos;
        out.push({ type: buf.toString('latin1', pos + 4, pos + 8), start: pos, size, header });
        pos += size;
    }
    return out;
}

/** Даты creation/modification в заголовке mvhd/tkhd/mdhd (версия 0). */
function stampDates(buf, headerBox) {
    const payload = headerBox.start + headerBox.header;
    if (buf[payload] === 0) { buf.writeUInt32BE(SHOT_AT, payload + 4); buf.writeUInt32BE(SHOT_AT, payload + 8); }
}

/**
 * Вставить «айфонные» метаданные в настоящий MP4 (например, записанный
 * MediaRecorder). udta, meta и XMP дописываются в конец moov; mfra, если
 * есть, выбрасывается — в нём абсолютные смещения фрагментов, которые
 * вставка сдвинула бы.
 */
export function withIphoneMetadata(mp4) {
    const top = boxes(mp4).filter(b => b.type !== 'mfra');
    const parts = [];
    for (const b of top) {
        let chunk = Buffer.from(mp4.subarray(b.start, b.start + b.size));
        if (b.type === 'moov') {
            for (const inner of boxes(chunk, 8, chunk.length)) {
                if (inner.type === 'mvhd') stampDates(chunk, inner);
                if (inner.type === 'trak') {
                    for (const t of boxes(chunk, inner.start + 8, inner.start + inner.size)) {
                        if (t.type === 'tkhd') stampDates(chunk, t);
                        if (t.type === 'mdia') {
                            for (const m of boxes(chunk, t.start + 8, t.start + t.size)) if (m.type === 'mdhd') stampDates(chunk, m);
                        }
                    }
                }
            }
            const extra = Buffer.concat([iphoneUdta(), iphoneMeta(), xmpUuid()]);
            chunk = Buffer.concat([u32(chunk.length + extra.length), chunk.subarray(4), extra]);
        }
        parts.push(chunk);
    }
    return Buffer.concat(parts);
}

/**
 * Синтетический MP4 с неподвижными смещениями: stco указывает в mdat, и
 * по нему видно, что очистка ничего не сдвинула.
 */
export function syntheticMp4({ largeMdat = false, brand = 'isom' } = {}) {
    const ftyp = box('ftyp', Buffer.from(brand), u32(512), Buffer.from('isomiso2mp41'));
    const mvhd = fullBox('mvhd', 0, u32(SHOT_AT), u32(SHOT_AT), u32(1000), u32(1000), Buffer.alloc(80));
    const tkhd = fullBox('tkhd', 1, Buffer.alloc(8), Buffer.alloc(8), u32(1), Buffer.alloc(64));
    tkhd.writeBigUInt64BE(BigInt(SHOT_AT), 12);
    tkhd.writeBigUInt64BE(BigInt(SHOT_AT), 20);
    const mdhd = fullBox('mdhd', 0, u32(SHOT_AT), u32(SHOT_AT), u32(1000), u32(1000), Buffer.alloc(4));
    const payload = Buffer.from('MDAT-PAYLOAD-START sample data that must not move');
    // Смещение в stco считается ниже, когда известен размер moov.
    const build = offset => {
        const stco = fullBox('stco', 0, u32(1), u32(offset));
        const trak = box('trak', tkhd, box('mdia', mdhd, box('minf', box('stbl', stco)), iphoneMeta()));
        return box('moov', mvhd, trak, iphoneUdta(), iphoneMeta());
    };
    const moovLen = build(0).length;
    const mdatHeader = largeMdat ? 16 : 8;
    const offset = ftyp.length + moovLen + xmpUuid().length + mdatHeader;
    let mdat;
    if (largeMdat) {
        const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(16 + payload.length));
        mdat = Buffer.concat([u32(1), Buffer.from('mdat'), size, payload]);
    } else {
        mdat = box('mdat', payload);
    }
    return { bytes: Buffer.concat([ftyp, build(offset), xmpUuid(), mdat]), payload, offset };
}
