'use strict';

/*
 * Журнал сервера: одна строка JSON на событие (pino). Читать глазами —
 * через `npx pino-pretty`.
 *
 * Что в журнал не попадает:
 *   - куки, CSRF-токен, пароли, почта, тексты сообщений — пути в redact
 *     ниже, на случай если такой объект окажется в записи целиком;
 *   - id пользователей и устройств, имена анонимов: их просто не пишем
 *     (см. вызовы log.* в server.js и lib/).
 *
 * К каждой записи, сделанной во время HTTP-запроса, сама добавляется reqId
 * — тот же, что уходит клиенту в заголовке X-Request-Id и в коде ошибки.
 * Так по коду из «Отчёта об ошибке» находится нужная строка журнала.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const pino = require('pino');

const requestContext = new AsyncLocalStorage();

// Ошибка без лишнего: у ошибок pg в detail бывают значения из запроса
// («Key (email)=(…) already exists»), их в журнал не берём.
function serializeError(err) {
    if (!(err instanceof Error)) return { message: String(err) };
    return { type: err.name, message: err.message, code: err.code, stack: err.stack };
}

const log = pino({
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'warn' : 'info'),
    base: undefined,                       // без pid и hostname
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: label => ({ level: label }) },
    serializers: { err: serializeError },
    redact: {
        paths: [
            'password', '*.password', 'email', '*.email', 'text', '*.text',
            'cookie', '*.cookie', 'headers.cookie', '*.headers.cookie',
            'headers["x-csrf-token"]', '*.headers["x-csrf-token"]',
            'headers.authorization', '*.headers.authorization',
        ],
        censor: '[скрыто]',
    },
    mixin() {
        const store = requestContext.getStore();
        return store ? { reqId: store.reqId } : {};
    },
});

module.exports = { log, requestContext };
