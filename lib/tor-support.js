const http = require('http');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { log } = require('./log');

// Tor/SOCKS5 прокси конфигурация
const TOR_PROXY_HOST = process.env.TOR_PROXY_HOST || '127.0.0.1';
const TOR_PROXY_PORT = process.env.TOR_PROXY_PORT || 9050;
const ENABLE_TOR_ROUTING = process.env.ENABLE_TOR_ROUTING === 'true';

// Создание SOCKS5 агента для Tor
function createTorAgent() {
    if (!ENABLE_TOR_ROUTING) {
        return null;
    }

    const proxyUrl = `socks5://${TOR_PROXY_HOST}:${TOR_PROXY_PORT}`;
    return new SocksProxyAgent(proxyUrl);
}

/*
 * Запрос через Tor. Встроенный fetch параметр agent молча игнорирует —
 * раньше и проверка Tor, и fetchViaTor ходили напрямую, мимо него. Здесь
 * http(s).request, который SOCKS-агент понимает. Ответ — как у fetch, в
 * том объёме, что нужен: ok, status, text(), json().
 */
function requestViaAgent(url, { agent, method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = transport.request(target, { method, headers, agent, timeout: timeoutMs }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    text: async () => text,
                    json: async () => JSON.parse(text),
                });
            });
        });
        req.on('timeout', () => req.destroy(new Error('Tor не ответил вовремя')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// Проверка доступности Tor: check.torproject.org отвечает, пришёл ли
// запрос из сети Tor.
async function checkTorConnection() {
    if (!ENABLE_TOR_ROUTING) {
        return { available: false, message: 'Tor routing disabled' };
    }

    try {
        const response = await requestViaAgent('https://check.torproject.org/api/ip',
            { agent: createTorAgent(), timeoutMs: 15000 });
        const data = await response.json();
        return {
            available: true,
            isTor: data.IsTor || false,
            ip: data.IP
        };
    } catch (error) {
        log.error({ err: error }, '[Tor] Connection check failed');
        return {
            available: false,
            message: error.message
        };
    }
}

// Запрос наружу через Tor (или напрямую, если Tor выключен).
async function fetchViaTor(url, options = {}) {
    if (!ENABLE_TOR_ROUTING) {
        return fetch(url, options);
    }
    return requestViaAgent(url, { ...options, agent: createTorAgent() });
}

// Генерация .onion адреса для hidden service (информационная функция)
function generateOnionAddress() {
    const crypto = require('crypto');

    // Это упрощенная версия для демонстрации
    // Реальный .onion адрес генерируется через Tor
    const randomBytes = crypto.randomBytes(35);
    const base32 = randomBytes.toString('base64')
        .replace(/\+/g, '')
        .replace(/\//g, '')
        .replace(/=/g, '')
        .toLowerCase()
        .slice(0, 56);

    return `${base32}.onion`;
}

// Настройка Tor Hidden Service
function getTorHiddenServiceConfig() {
    return {
        enabled: ENABLE_TOR_ROUTING,
        socksPort: TOR_PROXY_PORT,
        socksHost: TOR_PROXY_HOST,
        // Конфигурация для torrc файла
        hiddenServiceConfig: `
# Hidden Service Configuration for Nyxo Messenger
HiddenServiceDir /var/lib/tor/nyxo/
HiddenServicePort 80 127.0.0.1:${process.env.PORT || 3000}
HiddenServiceVersion 3
        `.trim()
    };
}

// Middleware для логирования анонимных подключений
function torConnectionLogger(req, res, next) {
    if (ENABLE_TOR_ROUTING) {
        const forwardedFor = req.headers['x-forwarded-for'];
        if (forwardedFor && forwardedFor.includes('.onion')) {
            log.info('[Tor] Onion service connection detected');
            req.isTorConnection = true;
        }
    }
    next();
}

module.exports = {
    createTorAgent,
    requestViaAgent,
    checkTorConnection,
    fetchViaTor,
    generateOnionAddress,
    getTorHiddenServiceConfig,
    torConnectionLogger,
    ENABLE_TOR_ROUTING
};
