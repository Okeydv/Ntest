// Сквозной тест сверки ключей по QR-коду.
//
//   - в окне сверки есть QR-код; сторонний декодер (jsQR в Node) читает в
//     нём «NYXO1:» и те же 60 цифр, что показаны числом;
//   - распознанный с фото код собеседника отмечает его сверенным;
//   - чужой код (другие цифры) не отмечает и предупреждает;
//   - сканирование камерой: Chromium с поддельной камерой, которая
//     показывает QR собеседника, — сверка проходит;
//   - Permissions-Policy пускает камеру только своей странице.
//
// Требует поднятых Postgres, key-server и server.js на 3006, ЧИСТОЙ базы и
// ffmpeg в PATH. Запуск: node scripts/test-e2ee-qr.mjs

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import jsQR from 'jsqr';

const require = createRequire(import.meta.url);
const qrcode = require('qrcode-generator');

const BASE = 'http://127.0.0.1:3006';
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxo-qr-'));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const errors = [];
let nextIp = 10;
async function openApp(label) {
    const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': `10.0.9.${nextIp++}` } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return { context, page };
}
const register = (page, u) => page.evaluate(async u => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'password123', confirmPassword: 'password123' }) });
    if (!r.success) throw new Error(r.message);
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
}, u);
const pairUp = async (a, b, name) => {
    const code = await a.evaluate(async name => {
        const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name }) });
        return (await api(`/api/chats/invite/${c.chat.id}`)).code;
    }, name);
    await b.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
};
async function openSafety(page, chatName) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator('.chat-item', { hasText: chatName }).first().click();
    await page.waitForTimeout(900);
    await page.click('#chat-encryption');
    await page.waitForSelector('#safety-list .safety-entry .safety-number', { timeout: 8000 });
    await page.waitForTimeout(500);   // QR рисуется после загрузки библиотеки
}
const shownNumber = page => page.evaluate(() =>
    [...document.querySelectorAll('#safety-list .safety-number span')].map(s => s.textContent).join(''));
const qrPng = page => page.evaluate(() => document.querySelector('#safety-list .safety-qr-code').toDataURL('image/png'))
    .then(url => Buffer.from(url.split(',')[1], 'base64'));
async function decodeInNode(png) {
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const code = jsQR(new Uint8ClampedArray(data), info.width, info.height);
    return code ? code.data : null;
}
const state = page => page.evaluate(() => document.querySelector('#safety-list .safety-state')?.textContent);
const toast = page => page.evaluate(() => document.getElementById('toast').textContent);

/* ------------------------- код в окне ------------------------- */

const carol = await openApp('carol');
await register(carol.page, 'carol');
const dave = await openApp('dave');
await register(dave.page, 'dave');
await pairUp(carol.page, dave.page, 'Кэрол и Дейв');

const headers = (await fetch(BASE + '/')).headers.get('permissions-policy');
check('камера разрешена только своей странице', /camera=\(self\)/.test(headers), headers);

await openSafety(dave.page, 'Чат с carol');   // у вошедшего по коду чат назван по собеседнику
const daveNumber = await shownNumber(dave.page);
const davePng = await qrPng(dave.page);
fs.writeFileSync(path.join(tmp, 'dave.png'), davePng);
const decoded = await decodeInNode(davePng);
check('в окне сверки есть QR с тем же кодом', decoded === `NYXO1:${daveNumber}` && daveNumber.length === 60, decoded);

/* ------------------------- с фото ------------------------- */

await openSafety(carol.page, 'Кэрол и Дейв');
check('до сверки — «Не сверено»', await state(carol.page) === 'Не сверено');

// Чужой код: те же 60 знаков, но другие цифры.
const fake = qrcode(0, 'M');
fake.addData('NYXO1:', 'Alphanumeric');
fake.addData('1'.repeat(60), 'Numeric');
fake.make();
const n = fake.getModuleCount();
const cell = 8;
const size = (n + 8) * cell;
const pixels = Buffer.alloc(size * size, 255);
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!fake.isDark(r, c)) continue;
    for (let y = 0; y < cell; y++) pixels.fill(0, ((r + 4) * cell + y) * size + (c + 4) * cell, ((r + 4) * cell + y) * size + (c + 5) * cell);
}
const fakePath = path.join(tmp, 'fake.png');
await sharp(pixels, { raw: { width: size, height: size, channels: 1 } }).png().toFile(fakePath);
await carol.page.setInputFiles('#safety-list .safety-qr-photo', fakePath);
await carol.page.waitForTimeout(800);
check('чужой код не отмечает сверенным и предупреждает',
    await state(carol.page) === 'Не сверено' && /не совпал/.test(await toast(carol.page)), await toast(carol.page));

// Снимок экрана Дейва, как если бы его сфотографировали: код поменьше, с полями.
const photoPath = path.join(tmp, 'photo-of-screen.jpg');
await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#d9d4c8' } })
    .composite([{ input: await sharp(davePng).resize(700).toBuffer(), left: 450, top: 250 }]).jpeg().toFile(photoPath);
await carol.page.setInputFiles('#safety-list .safety-qr-photo', photoPath);
await carol.page.waitForTimeout(1200);
check('код с фото совпал — собеседник сверен', await state(carol.page) === 'Сверено', await toast(carol.page));

/* ------------------------- камерой ------------------------- */

// Эрин в отдельном профиле браузера: он переживает перезапуск, а вместе с
// ним и ключи устройства — иначе после перезапуска код был бы другим.
const erinDir = path.join(tmp, 'erin-profile');
const launchErin = args => chromium.launchPersistentContext(erinDir, {
    executablePath: process.env.CHROMIUM_PATH,
    extraHTTPHeaders: { 'X-Forwarded-For': '10.0.9.200' },
    args,
});
let erinContext = await launchErin([]);
let erinPage = erinContext.pages()[0] || await erinContext.newPage();
await erinPage.goto(BASE, { waitUntil: 'networkidle' });
await register(erinPage, 'erin');
await pairUp(erinPage, dave.page, 'Эрин и Дейв');
await erinPage.waitForTimeout(500);
await erinContext.close();

await openSafety(dave.page, 'Чат с erin');
const forErin = await qrPng(dave.page);
fs.writeFileSync(path.join(tmp, 'for-erin.png'), forErin);
const video = path.join(tmp, 'camera.y4m');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', path.join(tmp, 'for-erin.png'),
    '-vf', 'scale=480:480,pad=640:480:80:0:white,format=yuv420p', '-t', '3', '-r', '10', video]);

erinContext = await launchErin(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${video}`]);
erinPage = erinContext.pages()[0] || await erinContext.newPage();
erinPage.on('pageerror', e => errors.push(`erin: ${e.message}`));
await erinPage.goto(BASE, { waitUntil: 'networkidle' });
await openSafety(erinPage, 'Эрин и Дейв');
check('кнопка сканирования камерой есть', await erinPage.isVisible('#safety-list .safety-qr-actions button:has-text("камерой")'));
await erinPage.click('#safety-list .safety-qr-actions button:has-text("камерой")');
await erinPage.waitForFunction(() => document.querySelector('#safety-list .safety-state')?.textContent === 'Сверено',
    null, { timeout: 15000 }).catch(() => {});
check('камерой: код собеседника распознан, собеседник сверен', await state(erinPage) === 'Сверено', await toast(erinPage));
check('камера после распознавания выключена', await erinPage.evaluate(() => !document.querySelector('.safety-scan-video')));
await erinContext.close();

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
