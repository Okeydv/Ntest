// Приватный режим в интерфейсе.
//
//   - «Войти в приватном режиме» сначала спрашивает срок: «Пока открыта
//     вкладка» (по умолчанию), 1 день, 7 дней;
//   - в списке чатов — «Приватный режим · удалится через 24 ч без
//     активности»;
//   - за 10 минут до потолка — предупреждение;
//   - срок вышел — сервер удалил аккаунт, страница возвращается ко входу и
//     говорит почему.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-anon-ui.mjs

import pg from 'pg';
import { launch, finish } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

const browser = await launch();
const errors = [];
const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, extraHTTPHeaders: { 'X-Forwarded-For': '10.0.21.10' } });
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });

await page.click('#anonymous-login-btn');
const modal = await page.evaluate(() => ({
    open: document.getElementById('anon-modal').open,
    options: [...document.querySelectorAll('input[name="anon-lifetime"]')].map(r => `${r.value}${r.checked ? '*' : ''}`).join(),
}));
check('сначала — выбор срока, по умолчанию «пока открыта вкладка»', modal.open && modal.options === 'tab*,day,week', JSON.stringify(modal));
await page.check('input[name="anon-lifetime"][value="day"]');
await page.click('#anon-confirm-btn');
await page.waitForFunction(() => !document.getElementById('app').classList.contains('hidden'), null, { timeout: 10000 });
await page.waitForTimeout(1000);
const note = await page.evaluate(() => ({ hidden: document.getElementById('anon-note').hidden, text: document.getElementById('anon-note-text').textContent }));
check('в списке чатов — когда удалится аккаунт', !note.hidden && note.text === 'Приватный режим · удалится через 24 ч без активности',
    JSON.stringify(note));
const userId = await page.evaluate(() => currentUser.id);
check('на сервере — выбранный срок',
    (await db.query('SELECT anon_lifetime FROM users WHERE id = $1', [userId])).rows[0]?.anon_lifetime === 'day');

// Потолок близко: предупреждение за 10 минут.
await page.evaluate(() => showAnonNote({ ...currentUser, anon: { ...currentUser.anon, deadline: new Date(Date.now() + 10 * 60 * 1000 + 500).toISOString() } }));
await page.waitForTimeout(1500);
check('за 10 минут до удаления — предупреждение', /удалится через 10 минут/.test(await page.textContent('#toast')), await page.textContent('#toast'));

// Срок вышел, пока вкладка была открыта: следующий запрос возвращает ко входу.
await db.query("UPDATE users SET created_at = now() - interval '8 days' WHERE id = $1", [userId]);
await page.click('#profile-btn');
await page.waitForTimeout(1500);
const after = await page.evaluate(() => ({
    auth: !document.getElementById('auth-screen').classList.contains('hidden'),
    toast: document.getElementById('toast').textContent,
    user: currentUser,
}));
check('срок вышел — экран входа и объяснение', after.auth && after.user === null && /Срок приватного аккаунта истёк/.test(after.toast),
    JSON.stringify(after));
check('аккаунт на сервере удалён', (await db.query('SELECT 1 FROM users WHERE id = $1', [userId])).rows.length === 0);

check('ошибок на странице нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
