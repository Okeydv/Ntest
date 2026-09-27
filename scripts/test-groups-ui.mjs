// Группы в интерфейсе.
//
//   - «Новый чат»: выбор пути карточками, «Назад», шаг группы;
//   - создатель — администратор: у него кнопка ссылки, в меню — «Участники
//     и название» и «Выйти из группы»;
//   - ссылка /join#код, открытая в браузере: после входа в аккаунт окно
//     само показывает, куда ведёт ссылка, а код из адреса убирается;
//   - «Попросить войти» → «Запрос отправлен», запрос виден над списком
//     чатов и отменяется там или в окне;
//   - у администратора — полоса «Ждут одобрения» и значок в списке, в окне
//     группы — «Впустить» и «Отклонить»; впущенному — тост и чат в списке;
//   - строка о входе: «впустили вы» у того, кто впустил;
//   - переименование любым участником, назначение администратором через
//     меню участника, удаление участника (ему — тост, чат исчезает).
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-groups-ui.mjs

import { launch, finish } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label, url = BASE) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, extraHTTPHeaders: { 'X-Forwarded-For': `10.0.19.${nextIp++}` } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    page.on('dialog', d => d.accept());
    await page.goto(url, { waitUntil: 'networkidle' });
    return page;
}
const register = (page, u) => page.evaluate(async u => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'password123', confirmPassword: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
}, u);
const ROOM = '.chat-item[data-room-id]:not([data-room-id=""])';
const isOpen = (page, id) => page.evaluate(id => document.getElementById(id).open, id);
const shown = (page, selector) => page.evaluate(s => {
    const el = document.querySelector(s);
    return Boolean(el) && !el.closest('[hidden]') && el.getClientRects().length > 0;
}, selector);
const toastText = page => page.evaluate(() => document.getElementById('toast').textContent);
const lines = page => page.evaluate(() => [...document.querySelectorAll('#chat-messages .message-system')].map(el => el.textContent));

/* ------------------------- «Новый чат» ------------------------- */

const alice = await openApp('alice');
await register(alice, 'alice');
await alice.click('#new-chat-btn');
const choice = await alice.evaluate(() => ({
    cards: [...document.querySelectorAll('#new-chat-modal .choice-card')].filter(c => !c.hidden).map(c => c.dataset.path),
    back: document.getElementById('new-chat-back').hidden,
    focus: document.activeElement.dataset.path,
}));
check('«Новый чат» начинается с выбора пути, фокус на первой карточке',
    choice.cards.join() === 'direct,group,join' && choice.back && choice.focus === 'direct', JSON.stringify(choice));
await alice.click('.choice-card[data-path="group"]');
check('шаг группы: заголовок, «Назад», фокус в поле названия', await alice.evaluate(() =>
    document.getElementById('new-chat-modal-title').textContent === 'Новая группа'
    && !document.getElementById('new-chat-back').hidden && document.activeElement.id === 'new-chat-name'));
await alice.click('#new-chat-back');
check('«Назад» возвращает к выбору', await shown(alice, '#new-chat-choice') && !(await shown(alice, '#new-chat-name')));
await alice.click('.choice-card[data-path="group"]');
await alice.fill('#new-chat-name', 'Книжный клуб');
await alice.press('#new-chat-name', 'Enter');
await alice.waitForTimeout(1500);
const created = await alice.evaluate(() => ({
    name: document.getElementById('chat-name').textContent,
    link: !document.getElementById('get-chat-code-btn').hidden,
    members: !document.getElementById('chat-menu-members-btn').hidden,
    leave: document.getElementById('delete-chat-label').textContent,
    empty: !document.getElementById('room-empty').hidden,
}));
check('группа создана и открыта: администратору — ссылка, «Участники», «Выйти из группы»',
    created.name === 'Книжный клуб' && created.link && created.members && created.leave === 'Выйти из группы' && created.empty,
    JSON.stringify(created));

// Ссылка с одобрением — по умолчанию.
await alice.click('#get-chat-code-btn');
await alice.waitForFunction(() => document.getElementById('invite-modal').open && !document.getElementById('reset-invite-btn').disabled);
check('одобрение включено по умолчанию', await alice.isChecked('#invite-approval'));
await alice.click('#reset-invite-btn');
await alice.waitForFunction(() => !document.getElementById('invite-code-box').hidden);
const link = (await alice.textContent('#invite-code-display')).trim();
check('ссылка вида …/join#код', link.startsWith(`${BASE}/join#`), link);
await alice.keyboard.press('Escape');

/* ------------------------- по ссылке из браузера ------------------------- */

const bob = await openApp('bob', link);
check('код из адресной строки убран', await bob.evaluate(() => location.pathname === '/' && location.hash === ''),
    await bob.evaluate(() => location.href));
await register(bob, 'bob');
await bob.waitForFunction(() => !document.getElementById('join-preview').hidden, null, { timeout: 5000 }).catch(() => {});
const preview = await bob.evaluate(() => ({
    open: document.getElementById('new-chat-modal').open,
    name: document.getElementById('join-preview-name').textContent,
    meta: document.getElementById('join-preview-meta').textContent,
    button: document.getElementById('join-chat-btn').textContent,
}));
check('после входа окно само показывает, куда ведёт ссылка',
    preview.open && preview.name === 'Книжный клуб' && preview.meta === '1 участник · вход после одобрения администратора'
    && preview.button === 'Попросить войти', JSON.stringify(preview));
await bob.click('#join-chat-btn');
await bob.waitForTimeout(800);
check('«Запрос отправлен»', await shown(bob, '#join-sent-text')
    && /«Книжный клуб»/.test(await bob.textContent('#join-sent-text')));
await bob.click('#join-sent-close');
check('запрос виден над списком чатов', await shown(bob, '#my-requests')
    && (await bob.textContent('#my-requests')).includes('Книжный клуб'));

/* ------------------------- администратор впускает ------------------------- */

await alice.waitForTimeout(800);
const bar = await alice.evaluate(() => ({
    bar: !document.getElementById('join-requests-bar').hidden && document.getElementById('join-requests-bar-text').textContent,
    badge: document.querySelector('.chat-item.active .chat-badge.is-requests')?.textContent,
}));
check('у администратора — полоса «Ждут одобрения» и значок в списке', bar.bar === 'Ждут одобрения: 1 человек' && bar.badge === '1',
    JSON.stringify(bar));
check('строка «просится в группу» в переписке', (await lines(alice)).includes('bob просится в группу'), JSON.stringify(await lines(alice)));
await alice.click('#join-requests-bar');
await alice.waitForFunction(() => !document.getElementById('requests-section').hidden);
check('в окне группы — кто ждёт', (await alice.textContent('#requests-list')).includes('bob'));
await alice.click('#requests-list button:has-text("Впустить")');
await alice.waitForTimeout(1200);
check('впущенный — в списке участников, запросов больше нет', await alice.evaluate(() =>
    document.getElementById('requests-section').hidden && document.querySelectorAll('#members-list .member-row').length === 2
    && document.getElementById('members-title').textContent === 'Участники · 2'));
await alice.keyboard.press('Escape');
await alice.waitForTimeout(500);
check('строка о входе: «впустили вы»', (await lines(alice)).includes('bob в группе · по ссылке, впустили вы'), JSON.stringify(await lines(alice)));
check('полоса и значок пропали', await alice.evaluate(() => document.getElementById('join-requests-bar').hidden
    && !document.querySelector('.chat-badge.is-requests')));

await bob.waitForTimeout(500);
check('впущенному — тост, группа в списке, запрос над списком исчез',
    /Вас впустили в «Книжный клуб»/.test(await toastText(bob)) && !(await shown(bob, '#my-requests'))
    && await bob.locator(ROOM).count() === 1, await toastText(bob));
await bob.locator(ROOM).first().click();
await bob.waitForTimeout(1200);
check('участник не видит кнопки ссылки, но видит «Участники»', await bob.evaluate(() =>
    document.getElementById('get-chat-code-btn').hidden && !document.getElementById('chat-menu-members-btn').hidden));
check('у самого впущенного строка — кто одобрил', (await lines(bob)).includes('Вы в группе · по ссылке · одобрено: alice'),
    JSON.stringify(await lines(bob)));

/* ------------------------- название и роли ------------------------- */

await bob.click('#chat-menu-btn');
await bob.click('#chat-menu-members-btn');
await bob.waitForFunction(() => document.getElementById('members-modal').open);
await bob.waitForTimeout(500);
check('у участника в окне группы нет «Ссылки-приглашения» и меню ролей', await bob.evaluate(() =>
    document.getElementById('members-invite-btn').hidden
    && [...document.querySelectorAll('#members-list .member-actions button')].every(b => b.textContent === 'Сверить ключи')));
await bob.fill('#group-name-input', 'Клуб по средам');
await bob.click('#group-name-save');
await bob.waitForTimeout(1200);
await bob.keyboard.press('Escape');
check('переименовал участник — у администратора новое название в шапке и строка',
    await alice.textContent('#chat-name') === 'Клуб по средам'
    && (await lines(alice)).includes('Группа переименована: «Клуб по средам» · bob'), await alice.textContent('#chat-name'));

await alice.click('#chat-menu-btn');
await alice.click('#chat-menu-members-btn');
await alice.waitForFunction(() => document.querySelectorAll('#members-list .member-row').length === 2);
const bobRow = alice.locator('#members-list .member-row', { hasText: 'bob' });
await bobRow.locator('.member-menu-btn').click();
check('меню участника: сверить, назначить, удалить', (await bobRow.locator('.member-actions button').allTextContents()).join('|')
    === 'Сверить ключи|Сделать администратором|Удалить из группы');
await bobRow.locator('button:has-text("Сделать администратором")').click();
await alice.waitForTimeout(1000);
check('bob — администратор', (await alice.locator('#members-list .member-row', { hasText: 'bob' }).textContent()).includes('администратор'));
await alice.keyboard.press('Escape');
await bob.waitForTimeout(800);
check('у нового администратора появилась кнопка ссылки, в переписке — «Вы теперь администратор»',
    await bob.evaluate(() => !document.getElementById('get-chat-code-btn').hidden)
    && (await lines(bob)).includes('Вы теперь администратор · назначение: alice'), JSON.stringify(await lines(bob)));

/* ------------------------- вставленная ссылка и отмена ------------------------- */

const carol = await openApp('carol');
await register(carol, 'carol');
await carol.click('#new-chat-btn');
await carol.click('.choice-card[data-path="join"]');
await carol.fill('#join-chat-code', link.replace(/#.*/, `#${link.split('#')[1].toLowerCase()}`));
await carol.press('#join-chat-code', 'Enter');
await carol.waitForTimeout(800);
check('вставленная ссылка: предпросмотр с новым названием и двумя участниками',
    await carol.textContent('#join-preview-name') === 'Клуб по средам'
    && (await carol.textContent('#join-preview-meta')).startsWith('2 участника'), await carol.textContent('#join-preview-meta'));
await carol.click('#join-chat-btn');
await carol.waitForTimeout(800);
await carol.click('#join-sent-cancel');
await carol.waitForTimeout(800);
check('«Отменить запрос» закрывает окно, запроса над списком нет',
    !(await isOpen(carol, 'new-chat-modal')) && !(await shown(carol, '#my-requests')));
await alice.waitForTimeout(500);
check('у администратора отменённый запрос не висит', await alice.evaluate(() => document.getElementById('join-requests-bar').hidden));

/* ------------------------- отказ и удаление ------------------------- */

const askFrom = page => page.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), link);
await askFrom(carol);
await carol.evaluate(() => loadMyRequests());
await alice.waitForTimeout(600);
await alice.click('#join-requests-bar');
await alice.waitForFunction(() => !document.getElementById('requests-section').hidden);
await alice.click('#requests-list button:has-text("Отклонить")');
await carol.waitForTimeout(1000);
check('отказ: запросившему — тост, запрос над списком исчез',
    /Запрос в «Клуб по средам» отклонён/.test(await toastText(carol)) && !(await shown(carol, '#my-requests')), await toastText(carol));
await alice.keyboard.press('Escape');

await askFrom(carol);
await alice.waitForTimeout(600);
await alice.click('#join-requests-bar');
await alice.waitForFunction(() => !document.getElementById('requests-section').hidden);
await alice.click('#requests-list button:has-text("Впустить")');
await alice.waitForTimeout(1200);
await carol.locator(ROOM).first().click();
await carol.waitForTimeout(1000);
const carolRow = alice.locator('#members-list .member-row', { hasText: 'carol' });
await carolRow.locator('.member-menu-btn').click();
await carolRow.locator('button:has-text("Удалить из группы")').click();
await alice.waitForTimeout(1200);
check('удалённого нет в списке участников', await alice.locator('#members-list .member-row', { hasText: 'carol' }).count() === 0);
await carol.waitForTimeout(500);
check('удалённому — тост, открытая группа закрылась и пропала из списка',
    /Вас удалили из группы «Клуб по средам»/.test(await toastText(carol)) && await carol.locator(ROOM).count() === 0
    && await carol.evaluate(() => currentChatId === null && !document.getElementById('empty-state').classList.contains('hidden')),
    await toastText(carol));
await alice.keyboard.press('Escape');
await alice.waitForTimeout(400);
check('у остальных — строка об удалении', (await lines(alice)).includes('Вы удалили из группы: carol')
    && (await lines(bob)).includes('carol больше не в группе · удаление: alice'), JSON.stringify(await lines(bob)));

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
