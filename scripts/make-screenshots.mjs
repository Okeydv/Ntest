// Снимки экрана для манифеста (screenshots — окно установки на Android):
// public/screenshots/phone.png (390×844) и wide.png (1280×800).
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы
// (как у тестов). Запуск после смены оформления:
//   node scripts/make-screenshots.mjs

import { launch } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
const OUT = new URL('../public/screenshots/', import.meta.url).pathname;
const browser = await launch();
let ip = 10;

async function app(name, viewport) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: 'dark',
        extraHTTPHeaders: { 'X-Forwarded-For': `10.0.99.${ip++}` } });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(async u => {
        const r = await api('/api/register', { method: 'POST',
            body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'password123', confirmPassword: 'password123' }) });
        currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
    }, name);
    return page;
}

const anna = await app('Анна', { width: 1280, height: 800 });
const boris = await app('Борис', { width: 390, height: 844 });
const code = await anna.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Выходные' }) });
    for (const n of ['Работа', 'Книжный клуб']) await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: n }) });
    return (await api(`/api/chats/${c.chat.id}/link`, { method: 'POST', body: JSON.stringify({ requireApproval: false }) })).code;
});
await boris.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
for (const p of [anna, boris]) {
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
}
const say = async (page, text) => {
    await page.fill('#message-input', text);
    await page.press('#message-input', 'Enter');
    await page.waitForTimeout(700);
};
await anna.locator('.chat-item', { hasText: 'Выходные' }).click();
await boris.locator('.chat-item', { hasText: 'Выходные' }).click();
await anna.waitForTimeout(800);
await say(anna, 'Едем в субботу на озеро?');
await say(boris, 'Да! Возьму палатку 🏕');
await say(anna, 'Отлично, выезжаем в 9 утра');
await say(boris, '👍');
await anna.waitForTimeout(800);
await anna.screenshot({ path: `${OUT}wide.png` });
await boris.goBack().catch(() => {});
await boris.evaluate(() => typeof backToChatList === 'function' && backToChatList());
await boris.waitForTimeout(800);
await boris.screenshot({ path: `${OUT}phone.png` });
await browser.close();
console.log('снимки:', OUT);
