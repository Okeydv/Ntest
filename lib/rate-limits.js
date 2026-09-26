'use strict';

// Ограничения частоты запросов: вход, регистрация, смена пароля, коды
// приглашений и всё API.
//
// Кого считать одним клиентом: обычно — по IP. Через Tor у всех один адрес
// (lib/client-ip.js, viaTor), и там — по аккаунту, а до входа — по куке
// браузера. Куку можно выбросить, поэтому у регистраций через Tor есть ещё
// общий потолок на всех, а подбор пароля к аккаунту тормозит замедление по
// email, которому адрес не важен.

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { viaTor } = require('./client-ip');

const ipKey = req => ipKeyGenerator(req.realIp || req.ip);

// Браузер: адрес, а через Tor — кука. Для входа, регистрации и начала
// привязки: там аккаунт либо ещё не известен, либо каждый раз новый.
function clientKey(req) {
    if (!viaTor(req)) return ipKey(req);
    return `tor-browser:${(req.cookies && req.cookies.csrf_token) || 'none'}`;
}

// Для запросов после входа — аккаунт: и за NAT, и через Tor это точнее адреса.
const userOrClientKey = req => (req.session && req.session.userId ? `user:${req.session.userId}` : clientKey(req));

const limiter = (windowMs, max, message, keyGenerator = clientKey, extra = {}) => rateLimit({
    windowMs, max, standardHeaders: true, legacyHeaders: false, keyGenerator,
    message: { success: false, message }, ...extra,
});

const loginLimiter = limiter(15 * 60 * 1000, 5, 'Слишком много попыток входа. Попробуйте позже.');

const registerLimiter = [
    // Все регистрации через Tor вместе — не больше сотни в час: куку браузера
    // можно выбросить, а этот потолок — нет.
    limiter(60 * 60 * 1000, 100, 'Слишком много регистраций через Tor. Попробуйте позже.',
        () => 'tor', { skip: req => !viaTor(req) }),
    limiter(60 * 60 * 1000, 3, 'Слишком много регистраций. Попробуйте позже.'),
];

const passwordLimiter = limiter(15 * 60 * 1000, 3, 'Слишком много попыток смены пароля. Попробуйте позже.', userOrClientKey);

// Код приглашения — 6 знаков из 32: перебором его не подобрать, только если
// попыток мало. Считаются только неудачные: вошедший по верному коду в
// лимит не упирается.
const joinLimiter = limiter(15 * 60 * 1000, 10, 'Слишком много попыток ввести код. Попробуйте позже.',
    req => `${(req.session && req.session.userId) || 'guest'}:${clientKey(req)}`,
    { skipSuccessfulRequests: true, requestWasSuccessful: (req, res) => res.locals.joined === true });

const apiLimiter = limiter(15 * 60 * 1000, 300, 'Слишком много запросов. Попробуйте позже.', userOrClientKey);

// Привязка устройства по QR: код живёт 5 минут, начинать чаще незачем.
const linkStartLimiter = limiter(15 * 60 * 1000, 30, 'Слишком много попыток. Попробуйте позже.');

/*
 * Подбор пароля к одному аккаунту с множества адресов лимит по IP не
 * останавливает. Раньше после 20 неудач на email вход закрывался на час —
 * и тот, кто подбирал с чужих адресов, запирал владельца. Теперь после
 * SLOW_AFTER неудач за час каждая следующая попытка на этот email ждёт
 * дольше (до 10 секунд), но верный пароль по-прежнему пускает. Удачный вход
 * счётчик сбрасывает.
 */
const SLOW_AFTER = 10;
const SLOW_WINDOW_MS = 60 * 60 * 1000;
const SLOW_STEP_MS = 1000;
const SLOW_MAX_MS = 10000;
const emailFailures = new Map();

const recentFailures = email => (emailFailures.get(email) || []).filter(t => Date.now() - t < SLOW_WINDOW_MS);

setInterval(() => {
    for (const email of emailFailures.keys()) {
        const recent = recentFailures(email);
        if (recent.length) emailFailures.set(email, recent);
        else emailFailures.delete(email);
    }
}, 10 * 60 * 1000).unref();

function loginEmailSlowdown(req, res, next) {
    const email = typeof (req.body && req.body.email) === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) return next();
    res.on('finish', () => {
        if (res.locals.loggedIn) return emailFailures.delete(email);
        if (res.statusCode >= 500 || res.statusCode === 429) return;
        emailFailures.set(email, [...recentFailures(email), Date.now()].slice(-200));
    });
    const over = recentFailures(email).length - SLOW_AFTER;
    if (over < 0) return next();
    setTimeout(next, Math.min((over + 1) * SLOW_STEP_MS, SLOW_MAX_MS));
}

module.exports = {
    clientKey, loginLimiter, loginEmailSlowdown, registerLimiter, passwordLimiter, joinLimiter, apiLimiter, linkStartLimiter,
};
