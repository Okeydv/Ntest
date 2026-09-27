// Сквозной тест входа на новом устройстве по QR-коду со старого.
//
//   - новое устройство показывает QR, старое сканирует его камерой (с фото
//     нельзя), видит, какой браузер подключается (по мнению сервера, а не
//     клиента) и когда показан код, фокус на «Отмене»; после подтверждения
//     новое входит без пароля, поднимает шифрование, старое узнаёт о нём;
//   - забрать вход может только браузер, который показал код: у чужой
//     сессии тот же код не срабатывает;
//   - код одноразовый и через 5 минут устаревает;
//   - в базе лежит только хеш кода;
//   - из приватного режима подтверждать нельзя.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-device-link.mjs

import { launch, finish } from './lib/browser.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import jsQR from 'jsqr';
import pg from 'pg';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxo-link-'));

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label) {
    const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': `10.0.11.${nextIp++}` } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return page;
}
const toast = page => page.evaluate(() => document.getElementById('toast').textContent);
const startLink = page => page.evaluate(async () =>
    (await api('/api/link/start', { method: 'POST', body: JSON.stringify({ label: 'Проверочный' }) })).token);
const status = page => page.evaluate(async () => (await api('/api/link/status')).status);

/* ------------------------- через интерфейс ------------------------- */

const tablet = await openApp('tablet');
await tablet.click('#link-login-btn');
await tablet.waitForFunction(() => !document.getElementById('link-qr').hidden, null, { timeout: 8000 });
const qrPng = Buffer.from((await tablet.evaluate(() => document.getElementById('link-qr').toDataURL('image/png'))).split(',')[1], 'base64');
const { data, info } = await sharp(qrPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const qrText = jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data || '';
check('новое устройство показывает QR с кодом подключения', /^NYXOLINK1:[A-Z2-7]{26}$/.test(qrText), qrText);
const token = qrText.slice('NYXOLINK1:'.length);
const stored = (await db.query('SELECT token_hash, label FROM device_links')).rows;
check('в базе только хеш кода', stored.length === 1 && stored[0].token_hash === crypto.createHash('sha256').update(token).digest('hex')
    && !JSON.stringify(stored).includes(token), JSON.stringify(stored));

// Чужой браузер с этим же кодом ничего не получает.
const stranger = await openApp('stranger');
check('чужая сессия по коду не входит', await status(stranger) === 'expired'
    && await stranger.evaluate(() => api('/api/auth').then(r => !r.authenticated)));

// Старое устройство сканирует код камерой: поддельная камера показывает
// экран планшета.
const png = path.join(tmp, 'link.png');
fs.writeFileSync(png, qrPng);
const video = path.join(tmp, 'camera.y4m');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', png,
    '-vf', 'scale=480:480,pad=640:480:80:0:white,format=yuv420p', '-t', '3', '-r', '10', video]);
const camBrowser = await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${video}`] });
const laptopContext = await camBrowser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '10.0.11.200' } });
const laptop = await laptopContext.newPage();
laptop.on('pageerror', e => errors.push(`laptop: ${e.message}`));
await laptop.goto(BASE, { waitUntil: 'networkidle' });
await laptop.evaluate(async () => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: 'hank', email: 'hank@example.com', password: 'password123', confirmPassword: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
});
await laptop.click('#profile-btn');
await laptop.click('#link-device-btn');
await laptop.waitForFunction(() => document.getElementById('link-scan-modal').open);
check('распознать код с фото нельзя — только камерой',
    await laptop.evaluate(() => !document.querySelector('#link-scan-modal input[type=file]')
        && ![...document.querySelectorAll('#link-scan-modal button')].some(b => /фото/i.test(b.textContent))));
await laptop.click('#link-scan-camera');
await laptop.waitForFunction(() => !document.getElementById('link-confirm-step').hidden, null, { timeout: 15000 }).catch(() => {});
const confirmText = await laptop.textContent('#link-confirm-step');
check('старое устройство видит, какой браузер подключается, когда показан код, и предупреждение',
    /«Chrome, Linux»/.test(confirmText) && /Код показан \d+ с назад/.test(confirmText)
    && /получит доступ к вашему аккаунту/.test(confirmText), confirmText.replace(/\s+/g, ' ').slice(0, 200));
check('фокус — на «Отмене», а не на «Подключить»', await laptop.evaluate(() => document.activeElement.id) === 'link-cancel-btn');
await laptop.click('#link-approve-btn');

await tablet.waitForFunction(() => currentUser && currentUser.username === 'hank' && e2eeDeviceId, null, { timeout: 10000 }).catch(() => {});
const tabletState = await tablet.evaluate(() => ({ user: currentUser && currentUser.username, device: e2eeDeviceId,
    modal: document.getElementById('link-login-modal').open }));
check('новое устройство вошло без пароля и подняло шифрование', tabletState.user === 'hank' && tabletState.device > 0 && !tabletState.modal,
    JSON.stringify(tabletState));
check('и сказано, под каким аккаунтом', /Вы вошли как hank/.test(await toast(tablet)), await toast(tablet));
await sleep(800);
check('старое устройство узнаёт о новом', /подключено новое устройство/.test(await toast(laptop)), await toast(laptop));
check('код одноразовый', await laptop.evaluate(t => api('/api/link/approve', { method: 'POST', body: JSON.stringify({ token: t }) })
    .then(r => r.success === false), token));

const linkEvents = await laptop.evaluate(async () => (await api('/api/security-events')).events.map(e => e.kind));
check('в журнале безопасности — подтверждение и вход по QR', linkEvents.includes('link_approved') && linkEvents.includes('link_login'),
    linkEvents.join(', '));

/* ------------------------- только тот, кто показал код ------------------------- */

const other = await openApp('other');
const otherToken = await startLink(other);
await laptop.evaluate(t => api('/api/link/approve', { method: 'POST', body: JSON.stringify({ token: t }) }), otherToken);
check('подтверждённый код не забрать из чужой сессии', await status(stranger) === 'expired');
check('а показавший его — входит', await status(other) === 'approved'
    && await other.evaluate(() => api('/api/auth').then(r => r.authenticated === true)));

const spoofer = await openApp('spoofer');
const spoofToken = await spoofer.evaluate(async () =>
    (await api('/api/link/start', { method: 'POST', body: JSON.stringify({ label: 'iPhone Ивана' }) })).token);
const spoofInfo = await laptop.evaluate(t => api('/api/link/inspect', { method: 'POST', body: JSON.stringify({ token: t }) }), spoofToken);
check('название браузера определяет сервер, прислать своё нельзя', spoofInfo.label === 'Chrome, Linux', spoofInfo.label);

/* ------------------------- срок и приватный режим ------------------------- */

const late = await openApp('late');
const lateToken = await startLink(late);
await db.query("UPDATE device_links SET expires_at = now() - interval '1 second'");
const lateInspect = await laptop.evaluate(t => api('/api/link/inspect', { method: 'POST', body: JSON.stringify({ token: t }) }), lateToken);
check('через 5 минут код устаревает', lateInspect.success === false && await status(late) === 'expired', lateInspect.message);

const anon = await openApp('anon');
const freshToken = await startLink(await openApp('fresh'));
const anonTry = await anon.evaluate(async t => {
    await api('/api/register/anonymous', { method: 'POST', body: '{}' });
    return api('/api/link/approve', { method: 'POST', body: JSON.stringify({ token: t }) });
}, freshToken);
check('из приватного режима подтверждать нельзя', anonTry.success === false && /приватном режиме/.test(anonTry.message), anonTry.message);

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(camBrowser, fails);
await finish(browser, fails);
await db.end();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
