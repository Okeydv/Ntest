// Сервер ключей недоступен.
//
//   - при старте основной сервер сам проверяет сервер ключей и громко пишет
//     в журнал: адрес из KEY_SERVER_URL и причину (ECONNREFUSED и т. п.);
//   - запросы к ключам отвечают 503 с кодом KEY_SERVER_UNAVAILABLE и
//     понятным сообщением, а в журнале у каждой такой ошибки — причина и
//     адрес;
//   - /healthz отвечает 503 и показывает, что именно не так.
//
// Тест сам запускает второй экземпляр server.js (порт 3008) с адресом
// сервера ключей, где никто не слушает. Требует поднятых Postgres и
// сервера на 3006 (схема уже создана).
// Запуск: TEST_DATABASE_URL=... node scripts/integration-test-keyserver-down.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://127.0.0.1:3008';
const DEAD = 'http://127.0.0.1:59998';
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        SESSION_SECRET: 'test-session-secret-at-least-32-chars-long',
        INTERNAL_KEY_SERVER_SECRET: 'test-secret-at-least-32-chars-long-xx',
        KEY_SERVER_URL: DEAD,
        NODE_ENV: 'development',
        PORT: '3008',
        HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', c => { log += c; });
child.stderr.on('data', c => { log += c; });
for (let i = 0; i < 60 && !log.includes('Nyxo запущен'); i++) await sleep(250);
await sleep(1500);

const entries = log.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const loud = entries.find(e => /СЕРВЕР КЛЮЧЕЙ НЕДОСТУПЕН/.test(e.msg || ''));
check('при старте — громкая запись в журнале', Boolean(loud) && loud.level === 'error', JSON.stringify(loud));
check('с адресом и причиной', loud?.keyServerUrl === DEAD && loud?.cause === 'ECONNREFUSED', JSON.stringify(loud));

// Запрос к ключам от вошедшего пользователя.
const cookies = new Map();
const header = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
const absorb = r => { for (const s of (r.headers.getSetCookie?.() ?? [])) { const [p] = s.split(';'); const i = p.indexOf('='); cookies.set(p.slice(0, i), p.slice(i + 1)); } };
async function req(method, url, body) {
    if (!cookies.has('csrf_token')) absorb(await fetch(BASE + '/', { headers: { 'X-Forwarded-For': '10.41.0.1' } }));
    const r = await fetch(BASE + url, { method, headers: { Cookie: header(), 'X-CSRF-Token': cookies.get('csrf_token'),
        'Content-Type': 'application/json', 'X-Forwarded-For': '10.41.0.1' }, body: body === undefined ? undefined : JSON.stringify(body) });
    absorb(r);
    return { status: r.status, json: await r.json().catch(() => null) };
}
const reg = await req('POST', '/api/register', { username: 'keyless', email: 'keyless@example.com', password: 'password123', confirmPassword: 'password123' });
const keys = await req('GET', `/api/keys/identities/${reg.json?.user?.id}`);
check('ключи: 503 с кодом KEY_SERVER_UNAVAILABLE', keys.status === 503 && keys.json?.code === 'KEY_SERVER_UNAVAILABLE', JSON.stringify(keys.json));
check('и понятным сообщением, плюс код ошибки', keys.json?.message === 'Шифрование на сервере временно недоступно' && Boolean(keys.json?.errorId),
    JSON.stringify(keys.json));
await sleep(300);
const perRequest = log.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && e.msg === '[E2EE] key-server недоступен');
check('в журнале у ошибки запроса — причина и адрес', perRequest.some(e => e.cause === 'ECONNREFUSED' && e.keyServerUrl === DEAD),
    JSON.stringify(perRequest.at(-1)));

const health = await fetch(BASE + '/healthz');
const healthBody = await health.json();
check('/healthz — 503: база жива, сервер ключей нет', health.status === 503 && healthBody.db === true && healthBody.keyServer === false,
    JSON.stringify(healthBody));

await new Promise(r => { child.once('exit', r); child.kill(); });
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
