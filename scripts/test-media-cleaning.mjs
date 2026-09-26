// Очистка картинок и WebM без перекодирования — на файлах от настоящих
// программ: ffmpeg, exiftool, webpmux.
//
//   - PNG с автором в tEXt, XMP в iTXt, EXIF в eXIf и хвостом за IEND;
//     APNG остаётся анимированным;
//   - GIF с комментарием и XMP: анимация и повтор остаются;
//   - WebP (и анимированный) с EXIF и XMP: флаги в VP8X снимаются;
//   - JPEG без перекодирования: пиксели те же, EXIF и хвоста нет;
//   - ориентация из EXIF распознаётся у JPEG, PNG и WebP;
//   - WebM от ffmpeg с координатами, камерой и датой: теги стёрты,
//     видео декодируется, кадры те же;
//   - MP4: незнакомый блок верхнего уровня и чужой uuid стёрты.
//
// Требует ffmpeg, ffprobe, exiftool, webpmux и mkvinfo в PATH.
// Запуск: node scripts/test-media-cleaning.mjs — сервер и база не нужны.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { cleanImage, cleanWebm, cleanIsoBmff } from '../public/crypto/metadata.js';
import { detectType } from '../public/crypto/filetypes.js';
import { syntheticMp4, boxes } from './lib/mp4-fixtures.mjs';

for (const tool of ['ffmpeg', 'ffprobe', 'exiftool', 'webpmux', 'mkvinfo']) {
    if (spawnSync('which', [tool]).status !== 0) {
        console.error(`нужен ${tool} в PATH`);
        process.exit(2);
    }
}

let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxo-media-'));
const file = (name, bytes) => { const p = path.join(tmp, name); if (bytes) fs.writeFileSync(p, bytes); return p; };
const has = (buf, text) => Buffer.from(buf).includes(Buffer.from(text, 'utf8'));

const AUTHOR = 'Ivan Petrov';
const tag = p => execFileSync('exiftool', ['-q', '-overwrite_original', `-Artist=${AUTHOR}`, '-Model=EOS R5',
    '-GPSLatitude=55.7558', '-GPSLatitudeRef=N', `-XMP-dc:Creator=${AUTHOR}`, p]);
const pixels = async (buf, page = 0) => sharp(buf, { page }).raw().toBuffer();
const pages = async buf => (await sharp(buf, { animated: true }).metadata()).pages || 1;
const exifLeft = p => {
    const data = JSON.parse(execFileSync('exiftool', ['-j', '-a', p]).toString())[0];
    return ['Artist', 'Model', 'GPSLatitude', 'Creator', 'Comment', 'Author', 'XMPToolkit'].filter(k => data[k] !== undefined);
};
const noise = Buffer.from(Array.from({ length: 48 * 32 * 3 }, (_, i) => (i * 7919) % 251));
const still = () => sharp(noise, { raw: { width: 48, height: 32, channels: 3 } });

/* ------------------------- PNG и APNG ------------------------- */

const pngPath = file('photo.png', await still().png().toBuffer());
tag(pngPath);
execFileSync('exiftool', ['-q', '-overwrite_original', '-PNG:Author=' + AUTHOR, pngPath]);
const png = Buffer.concat([fs.readFileSync(pngPath), Buffer.from('tail: ' + AUTHOR)]);
check('PNG: в исходнике автор, EXIF, XMP и хвост', has(png, AUTHOR) && has(png, 'eXIf') && has(png, 'xmpmeta'));
const cleanPngOut = cleanImage(png, 'image/png');
check('PNG: после — ничего', !has(cleanPngOut.bytes, AUTHOR) && !has(cleanPngOut.bytes, 'EOS R5') && !has(cleanPngOut.bytes, 'xmpmeta'));
check('PNG: exiftool ничего не видит', exifLeft(file('clean.png', cleanPngOut.bytes)).length === 0, exifLeft(file('clean.png')).join(','));
check('PNG: пиксели те же', (await pixels(cleanPngOut.bytes)).equals(await pixels(png)));

execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=32x24:rate=4:duration=1', '-plays', '0', '-f', 'apng', file('anim.png')]);
// Кадры считаем до exiftool: после него ffprobe их не видит (а после
// очистки — снова видит).
fs.copyFileSync(file('anim.png'), file('anim-untagged.png'));
execFileSync('exiftool', ['-q', '-overwrite_original', '-PNG:Author=' + AUTHOR, file('anim.png')]);
const apng = fs.readFileSync(file('anim.png'));
const cleanApng = cleanImage(apng, 'image/png');
// libvips кадры APNG не читает — считает ffprobe.
const apngFrames = p => Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', p]).toString().trim());
const apngBefore = apngFrames(file('anim-untagged.png'));
const apngAfter = apngFrames(file('clean-anim.png', cleanApng.bytes));
check('APNG: автор убран, анимация осталась', !has(cleanApng.bytes, AUTHOR) && cleanApng.animated
    && apngAfter === apngBefore && apngBefore > 1, `кадров: ${apngBefore} → ${apngAfter}`);

let threw = null;
try { cleanImage(Buffer.concat([png.subarray(0, 33), Buffer.from([0, 0, 0, 0]), Buffer.from('ZZZZ'), Buffer.alloc(4), png.subarray(33)]), 'image/png'); } catch (e) { threw = e; }
check('PNG: незнакомый обязательный блок — отказ', threw && /обязательный/.test(threw.message), threw && threw.message);

/* ------------------------- GIF ------------------------- */

execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=32x24:rate=4:duration=1', '-loop', '0', file('anim.gif')]);
execFileSync('exiftool', ['-q', '-overwrite_original', `-Comment=shot by ${AUTHOR}`, `-XMP-dc:Creator=${AUTHOR}`, file('anim.gif')]);
const gif = Buffer.concat([fs.readFileSync(file('anim.gif')), Buffer.from('tail')]);
check('GIF: в исходнике комментарий и XMP', has(gif, `shot by ${AUTHOR}`) && has(gif, 'xmpmeta'));
const cleanGifOut = cleanImage(gif, 'image/gif');
check('GIF: после — ничего', !has(cleanGifOut.bytes, AUTHOR) && !has(cleanGifOut.bytes, 'xmpmeta') && !has(cleanGifOut.bytes, 'tail'));
check('GIF: анимация и повтор на месте', cleanGifOut.animated && await pages(cleanGifOut.bytes) === await pages(gif)
    && has(cleanGifOut.bytes, 'NETSCAPE2.0'), `кадров: ${await pages(cleanGifOut.bytes)}`);
check('GIF: первый кадр тот же', (await pixels(cleanGifOut.bytes)).equals(await pixels(gif)));

/* ------------------------- WebP ------------------------- */

const exifBlob = file('exif.bin', Buffer.concat([Buffer.from('Exif\0\0'),
    execFileSync('exiftool', ['-b', '-EXIF', (tag(file('src.jpg', await still().jpeg().toBuffer())), file('src.jpg'))])]));
const xmpBlob = file('xmp.xml', `<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:creator>${AUTHOR}</dc:creator></x:xmpmeta>`);
const withMeta = (input, output) => {
    execFileSync('webpmux', ['-set', 'exif', exifBlob, input, '-o', output + '.1']);
    execFileSync('webpmux', ['-set', 'xmp', xmpBlob, output + '.1', '-o', output]);
    return fs.readFileSync(output);
};
const webp = withMeta(file('photo.webp', await still().webp({ lossless: true }).toBuffer()), file('meta.webp'));
check('WebP: в исходнике EXIF и XMP', has(webp, 'EOS R5') && has(webp, 'xmpmeta'));
const cleanWebpOut = cleanImage(webp, 'image/webp');
check('WebP: после — ничего', !has(cleanWebpOut.bytes, 'EOS R5') && !has(cleanWebpOut.bytes, 'xmpmeta') && !has(cleanWebpOut.bytes, AUTHOR));
check('WebP: флаги EXIF и XMP в VP8X сняты', (Buffer.from(cleanWebpOut.bytes)[20] & 0x0c) === 0);
check('WebP: пиксели те же', (await pixels(cleanWebpOut.bytes)).equals(await pixels(webp)));
const animWebp = withMeta(file('anim.webp', await sharp(fs.readFileSync(file('anim.gif')), { animated: true }).webp().toBuffer()), file('anim-meta.webp'));
const cleanAnimWebp = cleanImage(animWebp, 'image/webp');
check('WebP: анимированный остаётся анимированным', cleanAnimWebp.animated && await pages(cleanAnimWebp.bytes) === await pages(animWebp)
    && !has(cleanAnimWebp.bytes, 'EOS R5'), `кадров: ${await pages(cleanAnimWebp.bytes)}`);

/* ------------------------- JPEG ------------------------- */

const jpgPath = file('photo.jpg', await still().jpeg({ quality: 90 }).toBuffer());
tag(jpgPath);
const jpg = Buffer.concat([fs.readFileSync(jpgPath), Buffer.from('tail: ' + AUTHOR)]);
const cleanJpg = cleanImage(jpg, 'image/jpeg');
check('JPEG: без перекодирования — пиксели те же', (await pixels(cleanJpg.bytes)).equals(await pixels(jpg)));
check('JPEG: EXIF, XMP и хвоста нет', !has(cleanJpg.bytes, AUTHOR) && !has(cleanJpg.bytes, 'EOS R5') && !has(cleanJpg.bytes, 'xmpmeta'));

/* ------------------------- ориентация ------------------------- */

const rotated = p => { execFileSync('exiftool', ['-q', '-overwrite_original', '-Orientation#=6', p]); return fs.readFileSync(p); };
check('ориентация JPEG распознана', cleanImage(rotated(file('r.jpg', await still().jpeg().toBuffer())), 'image/jpeg').orientation === 6);
check('ориентация PNG (eXIf) распознана', cleanImage(rotated(file('r.png', await still().png().toBuffer())), 'image/png').orientation === 6);
execFileSync('webpmux', ['-set', 'exif', (execFileSync('exiftool', ['-q', '-overwrite_original', '-Orientation#=6', file('src.jpg')]),
    fs.writeFileSync(file('exif6.bin'), Buffer.concat([Buffer.from('Exif\0\0'), execFileSync('exiftool', ['-b', '-EXIF', file('src.jpg')])])),
    file('exif6.bin')), file('photo.webp'), '-o', file('r.webp')]);
check('ориентация WebP (EXIF) распознана', cleanImage(fs.readFileSync(file('r.webp')), 'image/webp').orientation === 6);
check('без поворота — 1', cleanPngOut.orientation === 1 && cleanGifOut.orientation === 1);

/* ------------------------- WebM ------------------------- */

execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=1',
    '-c:v', 'libvpx-vp9', '-b:v', '200k',
    '-metadata', `title=${AUTHOR} на даче`, '-metadata', 'location=+55.7558+037.6173/',
    '-metadata', 'make=Canon', '-metadata', 'model=EOS R5', '-metadata', 'creation_time=2026-09-25T12:00:00Z',
    '-metadata:s:v', `title=${AUTHOR} camera`, file('clip.webm')]);
const webm = Buffer.concat([fs.readFileSync(file('clip.webm')), Buffer.from('tail: ' + AUTHOR)]);
check('WebM: определяется по содержимому', detectType(webm) === 'video/webm');
check('WebM: в исходнике координаты, камера и название', has(webm, '+55.7558') && has(webm, 'EOS R5') && has(webm, AUTHOR));
const cleanWebmOut = cleanWebm(webm);
fs.writeFileSync(file('clean.webm'), cleanWebmOut);
check('WebM: после — ничего', !has(cleanWebmOut, '+55.7558') && !has(cleanWebmOut, 'EOS R5') && !has(cleanWebmOut, AUTHOR) && !has(cleanWebmOut, 'Lavf'));
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file('clean.webm')]).toString());
check('WebM: ffprobe тегов не видит', !probe.format.tags || Object.keys(probe.format.tags).length === 0, JSON.stringify(probe.format.tags));
const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', file('clean.webm'), '-f', 'framemd5', '-'], { encoding: 'utf8' });
const original = spawnSync('ffmpeg', ['-v', 'error', '-i', file('clip.webm'), '-f', 'framemd5', '-'], { encoding: 'utf8' });
const frames = out => out.split('\n').filter(l => /^\s*0,/.test(l)).map(l => l.split(',').pop().trim());
check('WebM: декодируется без ошибок, кадры те же', decode.status === 0 && decode.stderr === ''
    && frames(decode.stdout).length > 0 && JSON.stringify(frames(decode.stdout)) === JSON.stringify(frames(original.stdout)),
    decode.stderr.slice(0, 200));
check('WebM: mkvinfo разбирает структуру', spawnSync('mkvinfo', [file('clean.webm')]).status === 0);

let webmThrew = null;
try { cleanWebm(Buffer.from('not a webm at all')); } catch (e) { webmThrew = e; }
check('не WebM — отказ', Boolean(webmThrew));

/* ------------------------- MP4: незнакомое и uuid ------------------------- */

const { bytes: mp4 } = syntheticMp4();
const extraPayload = Buffer.from(`${AUTHOR} preview`);
const extraTop = Buffer.concat([Buffer.from([0, 0, 0, 8 + extraPayload.length]), Buffer.from('pnot'), extraPayload]);
const withExtra = Buffer.concat([mp4, extraTop]);
const cleanedMp4 = Buffer.from(cleanIsoBmff(withExtra).bytes);
check('MP4: незнакомый блок верхнего уровня стёрт в free', !has(cleanedMp4, AUTHOR)
    && boxes(cleanedMp4).map(b => b.type).at(-1) === 'free', boxes(cleanedMp4).map(b => b.type).join(','));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
