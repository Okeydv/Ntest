// Группы: ссылки-приглашения, запросы на вход, роли и участники
// (routes/chats.js, migrations/012).
//
//   - создатель группы — администратор; кода у новой комнаты нет;
//   - ссылка: 12 знаков, по умолчанию «впускать после одобрения», срок и
//     лимит участников; истёкшая, отключённая и выдуманная отвечают одинаково;
//   - запрос на вход: строка «просится», событие администраторам, повторный
//     переход не множит запрос; «Впустить», «Отклонить», «Отменить запрос»;
//     решает первый из администраторов;
//   - только администратор меняет ссылку, впускает, удаляет и назначает;
//     последнего администратора не снять; ушёл последний — назначается
//     самый давний участник (и когда удаляется анонимный аккаунт);
//   - удалённый участник теряет доступ и узнаёт об этом событием;
//   - группу переименовывает любой участник, название одно на всех;
//   - миграция: старые комнаты — группы, первый участник — администратор,
//     шестизначные коды отключены, у всех одно название.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/integration-test-groups.mjs

import { io as ioClient } from 'socket.io-client';
import pg from 'pg';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

let nextIp = 1;
function client() {
    const cookies = new Map();
    const ip = `10.32.0.${nextIp++}`;
    const c = {
        header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        absorb(r) {
            for (const s of (r.headers.getSetCookie?.() ?? [])) {
                const [pair] = s.split(';');
                const i = pair.indexOf('=');
                cookies.set(pair.slice(0, i), pair.slice(i + 1));
            }
        },
        async req(method, url, body) {
            if (!cookies.has('csrf_token')) c.absorb(await fetch(BASE + '/', { headers: { 'X-Forwarded-For': ip } }));
            const r = await fetch(BASE + url, { method,
                headers: { Cookie: c.header(), 'X-CSRF-Token': cookies.get('csrf_token'), 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
                body: body === undefined ? undefined : JSON.stringify(body) });
            c.absorb(r);
            let json = null;
            try { json = await r.json(); } catch { /* не JSON */ }
            return { status: r.status, json };
        },
        // События сокета копятся здесь: { имя: [данные…] }.
        events: {},
        async listen() {
            c.sock = ioClient(BASE, { extraHeaders: { Cookie: c.header() }, transports: ['websocket'], reconnection: false });
            c.sock.onAny((name, data) => (c.events[name] ||= []).push(data));
            await new Promise(r => c.sock.once('connect', r));
        },
        async chatFor(roomId) {
            return (await c.req('GET', '/api/chats')).json.chats.find(ch => ch.room_id === roomId);
        },
    };
    return c;
}
async function register(name) {
    const c = client();
    const r = await c.req('POST', '/api/register', { username: name, email: `${name}@example.com`, password: 'password123', confirmPassword: 'password123' });
    c.userId = r.json.user.id;
    await c.listen();
    return c;
}

const alice = await register('alice');
const bob = await register('bob');
const carol = await register('carol');
const dave = await register('dave');
const eve = await register('eve');

/* ------------------------- создание ------------------------- */

const created = (await alice.req('POST', '/api/chats', { name: '  Клуб  ' })).json;
const chatId = created.chat.id;
const roomId = created.chat.room_id;
alice.sock.emit('joinChat', `room:${roomId}`);
const lines = async () => (await db.query(
    "SELECT text FROM messages WHERE room_id = $1 AND message_type = 'system' ORDER BY id", [roomId])).rows.map(r => r.text);
const listed = await alice.chatFor(roomId);
check('создатель — администратор группы, название без пробелов по краям',
    created.chat.my_role === 'admin' && listed.kind === 'group' && listed.my_role === 'admin' && listed.name === 'Клуб',
    JSON.stringify(listed));
check('кода у новой комнаты нет, в списке его тоже нет',
    (await db.query('SELECT code FROM rooms WHERE id = $1', [roomId])).rows[0].code === null && !('invite_code' in listed));
check('ссылки поначалу нет', (await alice.req('GET', `/api/chats/${chatId}/link`)).json.link === null);

/* ------------------------- ссылка ------------------------- */

const bad = [
    await alice.req('POST', `/api/chats/${chatId}/link`, { expiresIn: 42 }),
    await alice.req('POST', `/api/chats/${chatId}/link`, { memberLimit: 1 }),
    await alice.req('POST', `/api/chats/${chatId}/link`, { memberLimit: 2.5 }),
    await alice.req('POST', `/api/chats/${chatId}/link`, { requireApproval: 'нет' }),
];
check('срок не из списка, лимит меньше двух или дробный, одобрение не булево — 400', bad.every(r => r.status === 400),
    bad.map(r => r.status).join(' '));
const link = (await alice.req('POST', `/api/chats/${chatId}/link`, {})).json;
check('ссылка: 12 знаков, по умолчанию — с одобрением и бессрочная',
    /^[A-HJKMNP-Z2-9]{12}$/.test(link.code) && link.link.require_approval === true && link.link.expires_at === null,
    JSON.stringify(link));
check('создание ссылки видно в переписке', (await lines()).includes('alice создал(а) ссылку-приглашение'));

/* ------------------------- запрос на вход ------------------------- */

const preview = (await bob.req('POST', '/api/chats/join', { code: `/join#${link.code}`, preview: true })).json;
check('предпросмотр: название, сколько участников, нужно ли одобрение',
    preview.success && preview.preview.name === 'Клуб' && preview.preview.members === 1
    && preview.preview.require_approval === true && preview.preview.member === false, JSON.stringify(preview));
check('предпросмотр ничего не меняет', !(await bob.chatFor(roomId))
    && (await db.query('SELECT count(*)::int AS n FROM join_requests')).rows[0].n === 0);

const asked = (await bob.req('POST', '/api/chats/join', { code: link.code })).json;
check('по ссылке с одобрением — запрос, а не вход', asked.success && asked.pending === true && asked.request.room_name === 'Клуб'
    && !(await bob.chatFor(roomId)), JSON.stringify(asked));
await sleep(300);
check('участники видят строку «просится в группу»', (await lines()).includes('bob просится в группу по ссылке'));
check('администратору — событие и счётчик в списке',
    alice.events.joinRequestsChanged?.at(-1)?.pending === 1 && (await alice.chatFor(roomId)).pending_requests === 1,
    JSON.stringify(alice.events.joinRequestsChanged));
const again = (await bob.req('POST', '/api/chats/join', { code: link.code })).json;
check('повторный переход не множит запрос и строку', again.request.id === asked.request.id
    && (await lines()).filter(t => t.startsWith('bob просится')).length === 1);
const own = (await bob.req('GET', '/api/join-requests')).json.requests;
check('свои ждущие запросы видны (экран «Запрос отправлен»)', own.length === 1 && own[0].room_name === 'Клуб', JSON.stringify(own));
check('в переписку до одобрения не попасть',
    (await bob.req('GET', `/api/messages/${chatId}`)).json?.success !== true);

const queue = (await alice.req('GET', `/api/chats/${chatId}/requests`)).json.requests;
check('администратор видит, кто ждёт', queue.length === 1 && queue[0].username === 'bob', JSON.stringify(queue));
check('посторонний список запросов не видит', (await carol.req('GET', `/api/chats/${chatId}/requests`)).status === 404);

const approved = await alice.req('POST', `/api/chats/${chatId}/requests/${asked.request.id}`, { action: 'approve' });
await sleep(300);
const decided = bob.events.joinRequestDecided?.at(-1);
check('«Впустить»: запросившему — событие с чатом', approved.json?.success && decided?.status === 'approved' && decided.chat?.id > 0,
    JSON.stringify(decided));
const bobChat = await bob.chatFor(roomId);
check('он в группе: то же название, роль «участник»', bobChat?.name === 'Клуб' && bobChat.my_role === 'member', JSON.stringify(bobChat));
check('строка о входе называет, кто впустил', (await lines()).includes('bob вошёл(ла) в группу по ссылке, впустил(а) alice'));
check('решённый запрос второй раз не решить',
    (await alice.req('POST', `/api/chats/${chatId}/requests/${asked.request.id}`, { action: 'approve' })).status === 409);
check('счётчик у администратора обнулился', alice.events.joinRequestsChanged.at(-1).pending === 0);
bob.sock.emit('joinChat', `room:${roomId}`);

/* ------------------------- только администратор ------------------------- */

const denied = [
    await bob.req('GET', `/api/chats/${bobChat.id}/link`),
    await bob.req('POST', `/api/chats/${bobChat.id}/link`, {}),
    await bob.req('DELETE', `/api/chats/${bobChat.id}/link`),
    await bob.req('GET', `/api/chats/${bobChat.id}/requests`),
    await bob.req('POST', `/api/chats/${bobChat.id}/members/${alice.userId}/role`, { role: 'member' }),
    await bob.req('DELETE', `/api/chats/${bobChat.id}/members/${alice.userId}`),
];
check('участник не меняет ссылку, не впускает, не назначает и не удаляет — 403 ADMIN_ONLY',
    denied.every(r => r.status === 403 && r.json.code === 'ADMIN_ONLY'), denied.map(r => r.status).join(' '));
check('чужой чат — 404', (await carol.req('POST', `/api/chats/${chatId}/link`, {})).status === 404);

/* ------------------------- отмена и отказ ------------------------- */

const carolAsk = (await carol.req('POST', '/api/chats/join', { code: link.code })).json.request;
const cancelled = await carol.req('DELETE', `/api/join-requests/${carolAsk.id}`);
check('«Отменить запрос»', cancelled.json?.success === true && (await carol.req('GET', '/api/join-requests')).json.requests.length === 0);
check('чужой запрос не отменить', (await dave.req('DELETE', `/api/join-requests/${carolAsk.id}`)).status === 404);
check('отменённый не впустить',
    (await alice.req('POST', `/api/chats/${chatId}/requests/${carolAsk.id}`, { action: 'approve' })).status === 409);

const daveAsk = (await dave.req('POST', '/api/chats/join', { code: link.code })).json.request;
await alice.req('POST', `/api/chats/${chatId}/requests/${daveAsk.id}`, { action: 'decline' });
await sleep(300);
check('«Отклонить»: запросившему — отказ, в группу он не попал',
    dave.events.joinRequestDecided?.at(-1)?.status === 'declined' && !(await dave.chatFor(roomId)));

/* ------------------------- срок и лимит ------------------------- */

const limited = (await alice.req('POST', `/api/chats/${chatId}/link`, { requireApproval: false, memberLimit: 2 })).json;
check('смена ссылки: прежняя перестала действовать',
    (await carol.req('POST', '/api/chats/join', { code: link.code })).json.code === 'LINK_INVALID');
const full = (await eve.req('POST', '/api/chats/join', { code: limited.code })).json;
check('лимит участников: мест нет — не войти', full.code === 'ROOM_FULL', JSON.stringify(full));

const timed = (await alice.req('POST', `/api/chats/${chatId}/link`, { requireApproval: false, expiresIn: 3600 })).json;
check('срок ссылки — час', Math.abs(new Date(timed.link.expires_at) - Date.now() - 3600e3) < 60e3, timed.link.expires_at);
await db.query("UPDATE invite_links SET expires_at = now() - interval '1 second' WHERE token = $1", [timed.code]);
const expired = (await eve.req('POST', '/api/chats/join', { code: timed.code })).json;
const made = (await eve.req('POST', '/api/chats/join', { code: 'ABCDEFGHJKMN' })).json;
check('истёкшая и выдуманная ссылки — один и тот же ответ',
    expired.code === 'LINK_INVALID' && JSON.stringify(expired) === JSON.stringify(made), JSON.stringify(expired));
check('истёкшую администратор видит как отсутствие ссылки', (await alice.req('GET', `/api/chats/${chatId}/link`)).json.link === null);

const open = (await alice.req('POST', `/api/chats/${chatId}/link`, { requireApproval: false })).json;
const eveJoin = (await eve.req('POST', '/api/chats/join', { code: open.code })).json;
check('без одобрения — сразу в группе, строка «вошёл(ла) по ссылке»',
    eveJoin.chat?.id > 0 && (await lines()).includes('eve вошёл(ла) в группу по ссылке'), JSON.stringify(eveJoin));
eve.sock.emit('joinChat', `room:${roomId}`);

/* ------------------------- роли ------------------------- */

const members = (await bob.req('GET', `/api/chats/${bobChat.id}/members`)).json;
check('участники видят список с ролями, администраторы сверху',
    members.my_role === 'member' && members.members.map(m => `${m.username}:${m.role}`).join(' ') === 'alice:admin bob:member eve:member',
    JSON.stringify(members.members));
const promote = await alice.req('POST', `/api/chats/${chatId}/members/${bob.userId}/role`, { role: 'admin' });
check('назначить администратором', promote.json?.success && (await lines()).includes('alice назначил(а) администратором: bob'));
check('новый администратор видит запросы', (await bob.req('GET', `/api/chats/${bobChat.id}/requests`)).json?.success === true);
await alice.req('POST', `/api/chats/${chatId}/members/${alice.userId}/role`, { role: 'member' });
const lastAdmin = await bob.req('POST', `/api/chats/${bobChat.id}/members/${bob.userId}/role`, { role: 'member' });
check('последнего администратора не снять', lastAdmin.status === 409 && lastAdmin.json.code === 'LAST_ADMIN', JSON.stringify(lastAdmin.json));
await bob.req('POST', `/api/chats/${bobChat.id}/members/${alice.userId}/role`, { role: 'admin' });
check('снятие и возврат прав видны в переписке', (await lines()).includes('alice снял(а) права администратора: alice')
    && (await lines()).includes('bob назначил(а) администратором: alice'));

/* ------------------------- удаление участника ------------------------- */

const eveChat = await eve.chatFor(roomId);
check('себя не удалить — только выйти',
    (await alice.req('DELETE', `/api/chats/${chatId}/members/${alice.userId}`)).status === 400);
const removed = await alice.req('DELETE', `/api/chats/${chatId}/members/${eve.userId}`);
await sleep(300);
check('администратор удаляет участника', removed.json?.success && !(await eve.chatFor(roomId))
    && (await db.query('SELECT count(*)::int AS n FROM room_participants WHERE room_id = $1 AND user_id = $2', [roomId, eve.userId])).rows[0].n === 0);
check('удалённому — событие', eve.events.removedFromChat?.at(-1)?.chat_id === eveChat.id, JSON.stringify(eve.events.removedFromChat));
check('его сокет больше не получает сообщений группы',
    !(eve.events.newMessage || []).some(m => /удалил\(а\) из группы/.test(m.text || '')));
check('переписка ему больше не отдаётся', (await eve.req('GET', `/api/messages/${eveChat.id}`)).json?.success !== true);
check('остальные видят строку об удалении', (await lines()).includes('alice удалил(а) из группы: eve'));
check('и событие о смене состава', (bob.events.membersChanged || []).some(e => e.room_id === roomId));

/* ------------------------- название ------------------------- */

const renamed = await bob.req('POST', `/api/chats/${bobChat.id}/name`, { name: 'Клуб по средам' });
await sleep(300);
const names = (await db.query('SELECT DISTINCT name FROM chats WHERE room_id = $1', [roomId])).rows.map(r => r.name);
check('переименовать может и не администратор; название одно на всех',
    renamed.json?.success && names.length === 1 && names[0] === 'Клуб по средам', JSON.stringify(names));
check('событие и строка о переименовании',
    alice.events.chatRenamed?.at(-1)?.name === 'Клуб по средам' && (await lines()).includes('bob переименовал(а) группу: Клуб по средам'));
check('пустое название — 400', (await bob.req('POST', `/api/chats/${bobChat.id}/name`, { name: '   ' })).status === 400);
const botChat = (await bob.req('GET', '/api/chats')).json.chats.find(c => c.is_bot).id;
check('у чата с ботом нет ни названия группы, ни ссылки',
    (await bob.req('POST', `/api/chats/${botChat}/name`, { name: 'x' })).status === 404
    && (await bob.req('POST', `/api/chats/${botChat}/link`, {})).status === 404);

/* ------------------------- ушёл последний администратор ------------------------- */

await alice.req('POST', `/api/chats/${chatId}/members/${bob.userId}/role`, { role: 'member' });
await alice.req('DELETE', `/api/chats/${chatId}`);
check('ушёл последний администратор — им стал самый давний участник',
    (await bob.chatFor(roomId)).my_role === 'admin' && (await lines()).includes('bob теперь администратор'));

const anon = client();
await anon.req('POST', '/api/register/anonymous', {});
const anonRoom = (await anon.req('POST', '/api/chats', { name: 'Анонимный' })).json.chat;
const anonLink = (await anon.req('POST', `/api/chats/${anonRoom.id}/link`, { requireApproval: false })).json.code;
await carol.req('POST', '/api/chats/join', { code: anonLink });
await dave.req('POST', '/api/chats/join', { code: anonLink });
await anon.req('POST', '/api/logout');
check('удалился анонимный администратор — администратор есть',
    (await carol.chatFor(anonRoom.room_id)).my_role === 'admin' && (await dave.chatFor(anonRoom.room_id)).my_role === 'member');

/* ------------------------- миграция старых комнат ------------------------- */

const oldRoom = (await db.query("INSERT INTO rooms (name, code) VALUES ('Старая', 'K7Q2MX') RETURNING id")).rows[0].id;
for (const [user, name] of [[dave, 'Чат с carol'], [carol, 'Старая'], [eve, 'Чат с dave']]) {
    await db.query("INSERT INTO room_participants (room_id, user_id, role) VALUES ($1, $2, 'member')", [oldRoom, user.userId]);
    await db.query("INSERT INTO chats (user_id, room_id, name, avatar) VALUES ($1, $2, $3, 'Ч')", [user.userId, oldRoom, name]);
}
const sql = fs.readFileSync('migrations/012_groups_links_roles.sql', 'utf8');
await db.query(sql);
await db.query(sql);
const migrated = (await db.query(
    `SELECT r.kind, r.code, array_agg(rp.role ORDER BY rp.id) AS roles,
            (SELECT array_agg(DISTINCT c.name) FROM chats c WHERE c.room_id = r.id) AS names
     FROM rooms r JOIN room_participants rp ON rp.room_id = r.id WHERE r.id = $1 GROUP BY r.id`, [oldRoom])).rows[0];
check('старая комната стала группой, первый участник — администратор (и только он, даже после повторного запуска)',
    migrated.kind === 'group' && migrated.roles.join(' ') === 'admin member member', JSON.stringify(migrated));
check('старый шестизначный код отключён', migrated.code === null);
check('у всех участников одно название — название комнаты', migrated.names.join() === 'Старая', JSON.stringify(migrated.names));
check('у групп, где администратор уже есть, роли не тронуты',
    (await db.query("SELECT count(*)::int AS n FROM room_participants WHERE room_id = $1 AND role = 'admin'", [roomId])).rows[0].n === 1);

for (const c of [alice, bob, carol, dave, eve]) c.sock.close();
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
