'use strict';

/*
 * Срок жизни анонимного аккаунта (приватный режим).
 *
 * При входе выбирается, сколько аккаунт живёт без активности: «пока открыта
 * вкладка» (30 минут после того, как её закрыли), 1 день или 7 дней.
 * Активность — любой запрос к API и открытый сокет: пока вкладка открыта,
 * аккаунт жив. Жёсткий потолок — 7 дней с создания, даже при активности.
 *
 * Срок проверяется в общем обработчике всех запросов и при подключении
 * сокета (server.js), а не только при входе, и уборкой по таймеру
 * (routes/auth.js). Истёкший аккаунт удаляется сразу.
 */

const HOUR = 60 * 60;

// Сколько секунд без активности аккаунт живёт.
const ANON_LIFETIMES = { tab: 30 * 60, day: 24 * HOUR, week: 7 * 24 * HOUR };
const DEFAULT_LIFETIME = 'tab';
// Жёсткий потолок от создания.
const ANON_MAX_AGE = 7 * 24 * HOUR;
// Аккаунты, созданные до выбора срока, жили 4 часа сессии.
const LEGACY_LIFETIME = 4 * HOUR;

const idleSeconds = user => ANON_LIFETIMES[user.anon_lifetime] || LEGACY_LIFETIME;
const lastActive = user => new Date(user.last_active_at || user.created_at);

// Когда аккаунт удалится, если активности больше не будет. online — открыт
// ли сейчас хоть один его сокет: тогда срок бездействия не идёт.
function anonDeadline(user, { online = false, now = Date.now() } = {}) {
    const cap = new Date(user.created_at).getTime() + ANON_MAX_AGE * 1000;
    const idle = (online ? now : lastActive(user).getTime()) + idleSeconds(user) * 1000;
    return new Date(Math.min(cap, idle));
}

const anonExpired = (user, options = {}) => anonDeadline(user, options).getTime() <= (options.now || Date.now());

// Кука сессии живёт столько же, сколько аккаунт без активности, но не
// дольше потолка.
function anonCookieMaxAge(user, now = Date.now()) {
    const cap = new Date(user.created_at).getTime() + ANON_MAX_AGE * 1000 - now;
    return Math.max(1000, Math.min(idleSeconds(user) * 1000, cap));
}

// Для интерфейса: вариант, сколько живёт без активности и потолок.
const anonInfo = user => ({
    lifetime: user.anon_lifetime || null,
    idleSeconds: idleSeconds(user),
    deadline: new Date(new Date(user.created_at).getTime() + ANON_MAX_AGE * 1000).toISOString(),
});

module.exports = {
    ANON_LIFETIMES, DEFAULT_LIFETIME, ANON_MAX_AGE,
    anonDeadline, anonExpired, anonCookieMaxAge, anonInfo, idleSeconds,
};
