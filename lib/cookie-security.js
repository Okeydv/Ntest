// Флаг Secure у кук: везде в production, кроме .onion.
//
// Tor пробрасывает запросы на 127.0.0.1 по HTTP (см. HiddenServicePort в
// lib/tor-support.js): транспорт шифрует сам Tor, но для сервера и браузера
// соединение незащищённое. Кука с Secure по нему не ставится —
// express-session её даже не отправляет, — и войти через .onion было нельзя.

function isOnionRequest(req) {
    return String(req.headers.host || '').split(':')[0].toLowerCase().endsWith('.onion');
}

function secureCookieFor(req, production = process.env.NODE_ENV === 'production') {
    return production && !isOnionRequest(req);
}

/**
 * Ставится сразу после express-session: флаг Secure сессионной куки
 * уточняется на каждом запросе. express-session читает его, когда решает,
 * выставлять ли куку, — уже после обработчика.
 */
function sessionCookieSecurity(production = process.env.NODE_ENV === 'production') {
    return (req, res, next) => {
        if (req.session) req.session.cookie.secure = secureCookieFor(req, production);
        next();
    };
}

module.exports = { isOnionRequest, secureCookieFor, sessionCookieSecurity };
