'use strict';

// Ограничения частоты запросов: вход, регистрация, смена пароля, коды
// приглашений и всё API.

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

const rateLimitKeyGenerator = (req) => ipKeyGenerator(req.realIp || req.ip);

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
    message: { success: false, message: 'Слишком много попыток входа. Попробуйте позже.' }
});

// Подбор пароля к одному аккаунту с множества адресов лимит по IP не
// останавливает. Этот считает неудачные попытки на email, откуда бы они ни
// шли. Удачный вход в него не засчитывается.
const loginEmailLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => `email:${String((req.body && req.body.email) || '').trim().toLowerCase()}`,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.locals.loggedIn === true,
    message: { success: false, message: 'Слишком много попыток входа в этот аккаунт. Попробуйте позже.' }
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
    message: { success: false, message: 'Слишком много регистраций. Попробуйте позже.' }
});

const passwordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
    message: { success: false, message: 'Слишком много попыток смены пароля. Попробуйте позже.' }
});

// Код приглашения — 6 знаков из 32: перебором его не подобрать, только если
// попыток мало. Считаются только неудачные: вошедший по верному коду в
// лимит не упирается.
const joinLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => `${req.session?.userId || 'guest'}:${rateLimitKeyGenerator(req)}`,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.locals.joined === true,
    message: { success: false, message: 'Слишком много попыток ввести код. Попробуйте позже.' }
});

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
    message: { success: false, message: 'Слишком много запросов. Попробуйте позже.' }
});

// Привязка устройства по QR: начать можно не чаще раз в полминуты с адреса
// (код живёт 5 минут), подтверждать — как и входить по коду приглашения.
const linkStartLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
    message: { success: false, message: 'Слишком много попыток. Попробуйте позже.' }
});

module.exports = { linkStartLimiter, loginLimiter, loginEmailLimiter, registerLimiter, passwordLimiter, joinLimiter, apiLimiter };
