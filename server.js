require('dotenv').config();

// 1. IMPORTS
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const pgSession = require('connect-pg-simple')(session);
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

// Импорт новых модулей безопасности и приватности
const { stripMetadataFromFile } = require('./lib/metadata-stripper');
const { shared } = require('./lib/shared');
const { secureCookieFor, sessionCookieSecurity } = require('./lib/cookie-security');
const { sweepOrphanUploads } = require('./lib/upload-sweeper');
const DisappearingMessagesManager = require('./lib/disappearing-messages');
const { normalizeExpiry } = DisappearingMessagesManager;
const {
    addRandomDelay,
    padMessage,
    unpadMessage,
    addTimingNoise,
    sanitizeText,
    getPrivacyHeaders,
    anonymizeIP,
    generateSecureToken
} = require('./lib/privacy');

// Импорт E2EE прокси
const e2eeProxy = require('./lib/e2ee-proxy');
const { createDevicesRouter } = require('./lib/devices');

// Импорт Tor support
const {
    checkTorConnection,
    getTorHiddenServiceConfig,
    torConnectionLogger,
    ENABLE_TOR_ROUTING
} = require('./lib/tor-support');

// === RUST ANON SERVICE INTEGRATION ===
const ANON_SERVICE_URL = process.env.ANON_SERVICE_URL || 'http://127.0.0.1:8080';

async function fetchAnonymousIdentity() {
    try {
        const res = await fetch(`${ANON_SERVICE_URL}/generate`, {
            method: 'POST',
            signal: AbortSignal.timeout(2000)
        });
        if (res.ok) {
            const data = await res.json();
            if (data.unique_code && data.username) return data;
        }
    } catch (e) {
        console.warn('[Anon] Rust service unavailable, using fallback:', e.message);
    }
    return null;
}

// Какие вложения принимаются — общий с браузером список
// (public/crypto/filetypes.js): один на оба пути, открытый и
// зашифрованный. Тип определяется по содержимому файла, а не по тому, что
// объявил клиент. Расширение на диске берётся из этого же списка по уже
// проверенному типу и НИКОГДА из file.originalname (см. п.2 аудита): имя,
// присланное клиентом, — просто строка, и path.extname() от неё может
// вернуть что угодно вплоть до '.png"><svg onload=alert(1)>'.
let fileTypes = null;
const fileTypesReady = shared('filetypes.js').then(m => { fileTypes = m; return m; });

// '.svg' явно в блок-листе как доп. защита (defense-in-depth, п.7 аудита):
// image/svg+xml и так не входит в список типов, но SVG может нести
// <script>, поэтому расширение блокируется отдельно на случай, если формат
// когда-либо попадёт в разрешённый список по ошибке.
const BLOCKED_EXTENSIONS = new Set(['.html', '.htm', '.php', '.exe', '.js', '.sh', '.py', '.rb', '.pl', '.bat', '.cmd', '.ps1', '.vbs', '.jar', '.msi', '.svg']);

// Итоговое имя файла на диске должно состоять только из "безопасных" для
// файловой системы символов — доп. страховка на случай, если список типов
// когда-нибудь получит некорректное значение (п.2 аудита, "валидировать
// итоговое имя файла регуляркой").
const SAFE_FILENAME_RE = /^[\w.-]+$/;

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(__dirname, 'uploads');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            // Расширение — только из общего списка типов (по уже
            // проверенному в fileFilter mimetype), никогда из
            // file.originalname — см. комментарий у fileTypes выше.
            const ext = fileTypes.ATTACHMENT_TYPES[file.mimetype].ext;
            const safeName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
            if (!SAFE_FILENAME_RE.test(safeName)) {
                return cb(new Error('Не удалось сформировать безопасное имя файла'));
            }
            cb(null, safeName);
        }
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        fileTypesReady.then(types => {
            const ext = path.extname(file.originalname).toLowerCase();
            if (BLOCKED_EXTENSIONS.has(ext) || !types.ATTACHMENT_TYPES[file.mimetype]) {
                return cb(new Error('Неподдерживаемый тип файла'), false);
            }
            cb(null, true);
        }, cb);
    }
});

// === Верификация CF-Connecting-IP (см. https://www.cloudflare.com/ips/) ===
// Список подтверждён на 2026-08-10. CF-Connecting-IP — это просто HTTP-заголовок,
// который любой клиент может подставить сам. Доверять ему можно только если сам
// запрос физически пришёл с IP-адреса Cloudflare — иначе, обращаясь напрямую на
// публичный *.up.railway.app домен, атакующий получает "новый IP" на каждый
// запрос и обнуляет все rate-limit'ы (login/register/change-password).
// Список можно переопределить через переменную окружения CF_IP_RANGES
// (через запятую), если Cloudflare обновит диапазоны.
const DEFAULT_CLOUDFLARE_IP_RANGES = [
    // IPv4
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
    '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
    '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
    '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
    // IPv6
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
    '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

const cloudflareBlockList = new net.BlockList();
(function loadCloudflareRanges() {
    const ranges = process.env.CF_IP_RANGES
        ? process.env.CF_IP_RANGES.split(',').map(s => s.trim()).filter(Boolean)
        : DEFAULT_CLOUDFLARE_IP_RANGES;
    for (const cidr of ranges) {
        const [addr, prefixStr] = cidr.split('/');
        const type = net.isIP(addr);
        if (!type || !prefixStr) {
            console.warn('[CF] Пропущен некорректный диапазон:', cidr);
            continue;
        }
        cloudflareBlockList.addSubnet(addr, Number(prefixStr), type === 6 ? 'ipv6' : 'ipv4');
    }
})();

function isFromCloudflare(ip) {
    if (!ip) return false;
    const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    const type = net.isIP(clean);
    if (!type) return false;
    try {
        return cloudflareBlockList.check(clean, type === 6 ? 'ipv6' : 'ipv4');
    } catch (e) {
        return false;
    }
}

// connectingIp — адрес, с которого запрос физически пришёл на наш доверенный
// прокси (Railway), а не значение из легко подделываемых заголовков.
function resolveRealIp(headers, connectingIp) {
    const cfIp = headers['cf-connecting-ip'];
    if (cfIp && isFromCloudflare(connectingIp)) {
        return cfIp.split(',')[0].trim();
    }
    return connectingIp;
}

const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
    // req.ip уже учитывает 1 доверенный хоп (trust proxy = 1), то есть это IP,
    // который реально подключился к Railway — Cloudflare edge, если трафик шёл
    // через CF, либо настоящий IP клиента, если Railway-домен открыт напрямую.
    req.realIp = resolveRealIp(req.headers, req.ip);
    next();
});

const rateLimitKeyGenerator = (req) => ipKeyGenerator(req.realIp || req.ip);

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyGenerator,
    message: { success: false, message: 'Слишком много попыток входа. Попробуйте позже.' }
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

let server;
if (process.env.NODE_ENV === 'production') {
    server = http.createServer(app);
} else {
    const sslOptions = {
        key: fs.existsSync('./localhost+1-key.pem') ? fs.readFileSync('./localhost+1-key.pem') : null,
        cert: fs.existsSync('./localhost+1.pem') ? fs.readFileSync('./localhost+1.pem') : null,
    };
    if (sslOptions.key && sslOptions.cert) {
        server = https.createServer(sslOptions, app);
    } else {
        console.warn('SSL сертификаты не найдены. Запуск HTTP сервера.');
        server = http.createServer(app);
    }
}

/**
 * Проверка Origin у сокета.
 *
 * Сессионная кука уходит и с чужих страниц, а socket.io на рукопожатии
 * смотрит только на неё. Без этой проверки любой сайт, который открыл
 * вошедший пользователь, мог подключиться от его имени и получать события
 * его чатов: метаданные переписки и открытый текст чатов без шифрования.
 * SameSite=Lax закрывает это частично, проверка Origin — полностью.
 *
 * Разрешён Origin того же хоста, что и запрос, плюс список из
 * ALLOWED_ORIGINS — для случаев, когда прокси переписывает Host (добавьте
 * туда и .onion-адрес). Запрос без Origin пропускается: браузер всегда
 * ставит его на межсайтовом WebSocket и XHR, а без него приходят не
 * браузерные клиенты — у них нет чужой куки.
 */
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean));

function isAllowedOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (ALLOWED_ORIGINS.has(origin)) return true;
    try {
        return new URL(origin).host === req.headers.host;
    } catch {
        return false;
    }
}

const io = new Server(server, {
    allowRequest: (req, callback) => callback(null, isAllowedOrigin(req)),
});
const ipConnectionCount = new Map();

setInterval(() => {
    for (const [ip, count] of ipConnectionCount.entries()) {
        if (count <= 0) ipConnectionCount.delete(ip);
    }
}, 10 * 60 * 1000);

function getClientIp(handshake) {
    const headers = handshake.headers || {};
    // Тот же принцип, что и в HTTP-мидлваре: сначала находим адрес, который
    // реально подключился к нашему прокси (последний хоп X-Forwarded-For —
    // соответствует "доверяем 1 прокси" из app.set('trust proxy', 1)), и только
    // если ЭТОТ адрес принадлежит Cloudflare — доверяем CF-Connecting-IP.
    const xff = headers['x-forwarded-for'];
    const connectingIp = xff
        ? xff.split(',').map(s => s.trim()).filter(Boolean).pop()
        : handshake.address;
    return resolveRealIp(headers, connectingIp);
}
io.use((socket, next) => {
    const ip = getClientIp(socket.handshake);
    const count = ipConnectionCount.get(ip) || 0;
    if (count >= 5) {
        return next(new Error('Слишком много подключений с вашего IP'));
    }
    ipConnectionCount.set(ip, count + 1);
    socket.on('disconnect', () => {
        const current = ipConnectionCount.get(ip) || 1;
        if (current <= 1) {
            ipConnectionCount.delete(ip);
        } else {
            ipConnectionCount.set(ip, current - 1);
        }
    });
    next();
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function maybeDumpCa() {
    if (process.env.DUMP_CA !== 'true') return;
    const tls = require('tls');
    const net = require('net');
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) { console.error('DATABASE_URL не задан'); process.exit(1); }
    const parsed = new URL(dbUrl);
    const host = parsed.hostname;
    const port = parseInt(parsed.port) || 5432;
    console.log(`[DUMP_CA] Подключаемся к ${host}:${port}...`);
    await new Promise((resolve, reject) => {
        const socket = net.createConnection(port, host, () => {
            socket.write(Buffer.from([0x00,0x00,0x00,0x08,0x04,0xd2,0x16,0x2f]));
        });
        socket.once('data', (data) => {
            if (data[0] !== 0x53) { reject(new Error('Сервер не поддерживает SSL')); return; }
            const tlsSocket = tls.connect({ socket, host, rejectUnauthorized: false }, () => {
                const chain = [];
                let current = tlsSocket.getPeerCertificate(true);
                const seen = new Set();
                while (current && !seen.has(current.fingerprint)) {
                    seen.add(current.fingerprint);
                    chain.push(current);
                    if (!current.issuerCertificate || current.issuerCertificate === current) break;
                    current = current.issuerCertificate;
                }
                const pemChain = chain.map(c => [
                    '-----BEGIN CERTIFICATE-----',
                    c.raw.toString('base64').match(/.{1,64}/g).join('\n'),
                    '-----END CERTIFICATE-----'
                ].join('\n')).join('\n');
                console.log('\n[DUMP_CA] Найдено сертификатов в цепочке: ' + chain.length);
                chain.forEach((c, i) => {
                    console.log('[DUMP_CA] [' + i + '] subject:', JSON.stringify(c.subject));
                    console.log('[DUMP_CA] [' + i + '] issuer:', JSON.stringify(c.issuer));
                });
                console.log('\n[DUMP_CA] ========= СКОПИРУЙ ВСЁ ЭТО В ПЕРЕМЕННУЮ DB_CA_CERT =========');
                console.log(pemChain);
                console.log('[DUMP_CA] ===================== КОНЕЦ =====================\n');
                tlsSocket.destroy();
                resolve();
            });
            tlsSocket.on('error', reject);
        });
        socket.on('error', reject);
        socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('Таймаут')); });
    });
    process.exit(0);
}

const sslConfig = (() => {
    if (process.env.NODE_ENV !== 'production') return false;
    if (process.env.DB_CA_CERT) {
        console.log('[SSL] production: rejectUnauthorized=true, CA закреплён через DB_CA_CERT');
        return { ca: process.env.DB_CA_CERT, rejectUnauthorized: true };
    }
    console.warn('[SSL] production: DB_CA_CERT не задан — используется rejectUnauthorized=false ' +
        '(осознанный компромисс под Railway internal network). Чтобы включить полную проверку ' +
        'сертификата, запустите сервер один раз с DUMP_CA=true, скопируйте цепочку сертификатов ' +
        'в переменную DB_CA_CERT и перезапустите.');
    return { rejectUnauthorized: false };
})();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslConfig,
});

async function dbGet(query, params = []) {
    const result = await pool.query(query, params);
    return result.rows[0] || null;
}

async function dbAll(query, params = []) {
    const result = await pool.query(query, params);
    return result.rows;
}

async function dbRun(query, params = []) {
    const result = await pool.query(query, params);
    return result;
}
// Инициализация менеджера исчезающих сообщений
let disappearingMessagesManager;

async function initDatabase() {
    await maybeDumpCa().catch(err => { console.error('[DUMP_CA] Ошибка:', err.message); process.exit(1); });

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            unique_code TEXT UNIQUE NOT NULL,
            username TEXT UNIQUE NOT NULL,
            email TEXT,
            password TEXT,
            avatar TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS rooms (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            code TEXT UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS chats (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            room_id INTEGER REFERENCES rooms(id),
            name TEXT NOT NULL,
            avatar TEXT NOT NULL,
            online INTEGER DEFAULT 0,
            is_bot INTEGER DEFAULT 0
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            chat_id INTEGER NOT NULL REFERENCES chats(id),
            room_id INTEGER REFERENCES rooms(id),
            user_id INTEGER NOT NULL REFERENCES users(id),
            text TEXT NOT NULL,
            file_url TEXT,
            file_name TEXT,
            file_type TEXT,
            message_type TEXT DEFAULT 'text',
            sent INTEGER DEFAULT 1,
            time TEXT NOT NULL,
            status TEXT DEFAULT 'sent',
            edited_at TEXT,
            deleted INTEGER DEFAULT 0,
            reply_to_id INTEGER REFERENCES messages(id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS unread (
            id SERIAL PRIMARY KEY,
            chat_id INTEGER NOT NULL REFERENCES chats(id),
            user_id INTEGER NOT NULL REFERENCES users(id),
            count INTEGER DEFAULT 0
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS room_participants (
            id SERIAL PRIMARY KEY,
            room_id INTEGER NOT NULL REFERENCES rooms(id),
            user_id INTEGER NOT NULL REFERENCES users(id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS reactions (
            id SERIAL PRIMARY KEY,
            message_id INTEGER NOT NULL REFERENCES messages(id),
            user_id INTEGER NOT NULL REFERENCES users(id),
            emoji TEXT NOT NULL,
            UNIQUE(message_id, user_id, emoji)
        )
    `);


    // Реестр устройств. Ключи E2EE привязаны к устройству, а не к аккаунту
    // (см. e2ee-key-server/migrations/0002_device_scoped_keys.sql), поэтому
    // серверу нужен список: без него неизвестно, кому раздавать ключи и что
    // отзывать. revoked_at, а не DELETE: id устройства встречается в
    // ключевом материале, переиспользовать его нельзя.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS devices (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_seen_at TIMESTAMPTZ,
            revoked_at TIMESTAMPTZ
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id) WHERE revoked_at IS NULL;`);

    // Конверты сообщений: под E2EE одно сообщение превращается в N
    // шифротекстов, по одному на каждое устройство каждого получателя.
    //
    // Строка messages при этом остаётся и хранит только метаданные (кто, в
    // каком чате, когда, на что отвечает) — на messages(id) висят внешние
    // ключи из message_expiry, reactions и messages.reply_to_id, и делать
    // конверт единственной записью означало бы переделать все три без
    // выигрыша в приватности: метаданные всё равно видны серверу.
    //
    // header лежит BYTEA, а не JSONB, намеренно: он используется как AAD
    // при AES-GCM, то есть должен вернуться байт в байт. JSONB нормализует
    // ключи и порядок полей, после чего проверка AAD развалилась бы.
    // Сервер внутрь не смотрит, он только переносит.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS message_envelopes (
            id BIGSERIAL PRIMARY KEY,
            message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            recipient_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            sender_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            envelope_type SMALLINT NOT NULL,
            header BYTEA NOT NULL,
            ciphertext BYTEA NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (message_id, recipient_device_id)
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_envelopes_recipient ON message_envelopes(recipient_device_id, message_id);`);

    // Зашифрованные вложения. Сервер хранит непрозрачные байты: файл
    // шифруется на клиенте своим ключом, а ключ едет внутри E2EE-сообщения.
    // Ни имени, ни типа, ни содержимого сервер не знает — только размер.
    //
    // message_id заполняется при отправке сообщения; до этого вложение
    // принадлежит только загрузившему, и если сообщение так и не ушло,
    // уборщик удалит его через час.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS encrypted_blobs (
            id TEXT PRIMARY KEY,
            uploader_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
            room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
            message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
            size INTEGER NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_blobs_message ON encrypted_blobs(message_id);`);

    // Групповые сообщения (sender keys): один шифротекст на всех получателей
    // вместо конверта на каждое устройство. header — BYTEA по той же
    // причине, что у конвертов: он идёт в AAD и возвращается байт в байт.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS message_group_payloads (
            message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            header BYTEA NOT NULL,
            ciphertext BYTEA NOT NULL,
            signature BYTEA NOT NULL
        )
    `);

    // Раздача sender key: попарно зашифрованное состояние цепочки
    // отправителя, по конверту на каждое устройство группы.
    //
    // Отдельная таблица, а не конверт при сообщении, намеренно. Если бы ключ
    // ехал внутри сообщения, удаление этого сообщения (или таймер исчезающих)
    // забирало бы ключ с собой, и устройство, которое было офлайн, не
    // прочитало бы уже ничего из дальнейшей переписки. Здесь конверт живёт,
    // пока его не заберёт получатель (подтверждение), не уйдёт он из группы
    // или не будет отозвано его устройство.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS sender_key_envelopes (
            id BIGSERIAL PRIMARY KEY,
            room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            sender_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            sender_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            recipient_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            envelope_type SMALLINT NOT NULL,
            header BYTEA NOT NULL,
            ciphertext BYTEA NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sender_key_envelopes_recipient
        ON sender_key_envelopes(recipient_device_id, room_id, id);`);

    // Текст больше не обязателен: у зашифрованного сообщения его нет вовсе,
    // содержимое живёт в конвертах.
    await pool.query(`ALTER TABLE messages ALTER COLUMN text DROP NOT NULL;`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL;`);
    // Момент отправки с часовым поясом. Колонка time — строка «ЧЧ:ММ» в поясе
    // СЕРВЕРА: у собеседника в другом поясе время было неверным, а дня не
    // было вовсе. Форматирует теперь клиент, в своём поясе.
    //
    // Колонка добавляется БЕЗ значения по умолчанию, и только потом ей
    // ставится DEFAULT now(): ADD COLUMN ... DEFAULT now() записал бы всем
    // старым сообщениям время самой миграции — вся прежняя история
    // оказалась бы отправленной «сегодня в 14:03». Настоящей даты у старых
    // сообщений нет (была только строка «ЧЧ:ММ»), поэтому у них NULL, и
    // клиент показывает прежнюю строку без дня.
    // Приглашение можно отключить — тогда кода нет вовсе (UNIQUE допускает
    // сколько угодно NULL).
    await pool.query(`ALTER TABLE rooms ALTER COLUMN code DROP NOT NULL;`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE messages ALTER COLUMN created_at DROP NOT NULL;`);
    await pool.query(`ALTER TABLE messages ALTER COLUMN created_at SET DEFAULT now();`);
    // Базам, где прежняя миграция уже прошла, возвращаем NULL тем, кому она
    // проставила своё время. Их легко узнать: now() в одной команде одно на
    // все строки, так что у них одинаковое и самое раннее значение, а
    // обычные сообщения вставляются по одному и так не совпадают. Один раз.
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_flags (
        name TEXT PRIMARY KEY,
        done_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
    const repair = await pool.query(
        `INSERT INTO schema_flags (name) VALUES ('messages_created_at_backfill_undone')
         ON CONFLICT DO NOTHING RETURNING name`);
    if (repair.rowCount) {
        const undone = await pool.query(
            `WITH first AS (SELECT min(created_at) AS t FROM messages)
             UPDATE messages SET created_at = NULL
             WHERE created_at = (SELECT t FROM first)
               AND (SELECT count(*) FROM messages WHERE created_at = (SELECT t FROM first)) > 1`);
        if (undone.rowCount) console.log(`[migrate] created_at: снято время миграции у ${undone.rowCount} старых сообщений`);
    }

    // Миграция: если таблицы chats/messages были созданы ДО появления комнат,
    // CREATE TABLE IF NOT EXISTS их не тронет и колонки room_id не будет.
    // Добавляем её вручную, иначе следующий CREATE INDEX ON messages(room_id) упадёт с 42703.
    await pool.query(`ALTER TABLE chats ADD COLUMN IF NOT EXISTS room_id INTEGER REFERENCES rooms(id);`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS room_id INTEGER REFERENCES rooms(id);`);

    // Миграция: удаление чата/выход из комнаты падало с нарушением FK —
    // messages.chat_id (NOT NULL, без ON DELETE) не давал снести свою же
    // запись в chats, если пользователь уже что-то написал, а chats.room_id
    // не давал снести саму комнату, пока на неё ссылалась хоть одна запись в
    // chats. Разрешаем chat_id уходить в NULL (история комнаты остаётся
    // видна остальным по room_id) и каскадно чистим осиротевшие chats при
    // удалении room.
    await pool.query(`ALTER TABLE messages ALTER COLUMN chat_id DROP NOT NULL;`);
    await pool.query(`ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_chat_id_fkey;`);
    await pool.query(`ALTER TABLE messages ADD CONSTRAINT messages_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL;`);
    await pool.query(`ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_room_id_fkey;`);
    await pool.query(`ALTER TABLE chats ADD CONSTRAINT chats_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;`);

    // Реакции должны исчезать вместе со своим сообщением (иначе снос всех
    // сообщений комнаты падает с reactions_message_id_fkey, как только у
    // любого из них есть хоть одна реакция).
    await pool.query(`ALTER TABLE reactions DROP CONSTRAINT IF EXISTS reactions_message_id_fkey;`);
    await pool.query(`ALTER TABLE reactions ADD CONSTRAINT reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;`);
    // Ответ на удалённое сообщение просто теряет связь с оригиналом, а не
    // блокирует его удаление и не удаляется сам.
    await pool.query(`ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_reply_to_id_fkey;`);
    await pool.query(`ALTER TABLE messages ADD CONSTRAINT messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON DELETE SET NULL;`);
    // Остальное уже удаляется в правильном порядке на уровне приложения
    // (см. DELETE /api/chats/:chatId), но каскад добавлен как страховка на
    // случай, если порядок операций там в будущем изменят по ошибке.
    await pool.query(`ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_room_id_fkey;`);
    await pool.query(`ALTER TABLE messages ADD CONSTRAINT messages_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;`);
    await pool.query(`ALTER TABLE unread DROP CONSTRAINT IF EXISTS unread_chat_id_fkey;`);
    await pool.query(`ALTER TABLE unread ADD CONSTRAINT unread_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE;`);
    await pool.query(`ALTER TABLE room_participants DROP CONSTRAINT IF EXISTS room_participants_room_id_fkey;`);
    await pool.query(`ALTER TABLE room_participants ADD CONSTRAINT room_participants_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;`);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_reactions_msg_user ON reactions(message_id, user_id);`);

    const cols = await dbAll(`
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'users' AND column_name IN ('email', 'password')
    `);
    const colMap = {};
    cols.forEach(c => { colMap[c.column_name] = c.is_nullable; });
    if (colMap.email === 'NO') {
        await pool.query('ALTER TABLE users ALTER COLUMN email DROP NOT NULL');
    }
    if (colMap.password === 'NO') {
        await pool.query('ALTER TABLE users ALTER COLUMN password DROP NOT NULL');
    }

    // Disappearing messages инициализируются ПОСЛЕ создания таблиц.
    //
    // Раньше вызов стоял в самом начале initDatabase(), а initialize()
    // создаёт message_expiry с REFERENCES messages(id) — на пустой базе это
    // падало с `relation "messages" does not exist`, и сервер не поднимался
    // вообще. Незаметным это было потому, что на уже существующей базе всё
    // работает: ошибка возникает только при первом запуске с нуля.
    disappearingMessagesManager = new DisappearingMessagesManager(pool, {
        // Исчезнувшее по сроку — как удалённое: содержимое стирается, а
        // клиенты узнают об этом сразу и чистят свою расшифрованную копию.
        onDelete: async messageId => {
            await purgeMessageContent(messageId);
            const message = await dbGet('SELECT chat_id, room_id FROM messages WHERE id = $1', [messageId]);
            if (message) {
                io.to(getSocketRoomKey(message.chat_id, message.room_id)).emit('messageDeleted', {
                    id: Number(messageId), chat_id: message.chat_id, room_id: message.room_id,
                });
            }
        },
    });
    await disappearingMessagesManager.initialize();

    console.log('База данных инициализирована');
}

initDatabase().catch(err => {
    console.error('Ошибка инициализации БД:', err);
    process.exit(1);
});
function getSocketRoomKey(chatId, roomId) {
    return roomId ? `room:${roomId}` : `chat:${chatId}`;
}

function getLocalAddresses() {
    const nets = os.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                addresses.push(net.address);
            }
        }
    }
    return addresses;
}

function normalizeAvatarColor(value) {
    const color = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : '#667EEA';
}

function getCurrentTime() {
    const now = new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
}

async function generateUniqueCodeAsync() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let attempts = 0; attempts < 100; attempts++) {
        const bytes = crypto.randomBytes(8);
        const code = Array.from(bytes).map(b => chars[b % chars.length]).join('');
        const row = await dbGet('SELECT id FROM users WHERE unique_code = $1', [code]);
        if (!row) return code;
    }
    throw new Error('Could not generate unique code');
}

async function generateAnonymousUsernameAsync() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempts = 0; attempts < 100; attempts++) {
        const bytes = crypto.randomBytes(4);
        const suffix = Array.from(bytes).map(b => chars[b % chars.length]).join('');
        const username = `Гость-${suffix}`;
        const row = await dbGet('SELECT id FROM users WHERE username = $1', [username]);
        if (!row) return username;
    }
    throw new Error('Could not generate anonymous username');
}

function generateInviteCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(6);
    return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

async function generateInviteCodeAsync() {
    for (let attempts = 0; attempts < 100; attempts++) {
        const code = generateInviteCode();
        const row = await dbGet('SELECT id FROM rooms WHERE code = $1', [code]);
        if (!row) return code;
    }
    throw new Error('Could not generate invite code');
}

// Фиктивный bcrypt-хэш без известного пароля. Используется в /api/login, чтобы
// bcrypt.compare выполнялся ВСЕГДА — и когда юзер найден, и когда нет — с
// одинаковой стоимостью (~100мс), иначе разница во времени ответа позволяет
// перебором узнавать зарегистрированные email.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) throw new Error('SESSION_SECRET не задан в переменных окружения');

const sessionMiddleware = session({
    store: new pgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: true
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        // Уточняется на каждом запросе — см. lib/cookie-security.js.
        secure: process.env.NODE_ENV === 'production',
        // Было 'none' в production: кука уходила и с чужих сайтов. Фронтенд
        // отдаёт этот же сервер, так что межсайтовая кука не нужна.
        sameSite: 'lax'
    }
});



io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

io.on('connection', (socket) => {
    const userId = socket.request.session?.userId;
    if (!userId) {
        socket.disconnect(true);
        return;
    }
    // Персональная комната устройства: конверты у устройств разные, и
    // общий broadcast для них не годится. deviceId читается из сессии на
    // момент подключения, поэтому после регистрации или привязки
    // устройства клиент обязан переподключить сокет.
    const socketDeviceId = socket.request.session?.deviceId;
    if (socketDeviceId) socket.join(`device:${socketDeviceId}`);
    // По этим комнатам сокеты находятся, когда доступ отзывается: выход из
    // чата, выход из аккаунта, смена пароля. Сессия с сервера удаляется, но
    // уже открытый сокет о ней не знает и продолжал бы получать сообщения.
    socket.join(`user:${userId}`);
    socket.join(`session:${socket.request.sessionID}`);

    console.log('Пользователь подключился через WebSocket, userId:', userId, 'deviceId:', socketDeviceId || '—');

    socket.on('joinChat', async (roomKey) => {
        if (typeof roomKey !== 'string' || roomKey.length === 0) return;
        try {
            if (roomKey.startsWith('room:')) {
                const roomId = parseInt(roomKey.slice(5), 10);
                if (!Number.isFinite(roomId)) return;
                const participant = await dbGet(
                    'SELECT id FROM room_participants WHERE room_id = $1 AND user_id = $2',
                    [roomId, userId]
                );
                if (!participant) return;
            } else if (roomKey.startsWith('chat:')) {
                const chatId = parseInt(roomKey.slice(5), 10);
                if (!Number.isFinite(chatId)) return;
                const chat = await dbGet(
                    'SELECT id FROM chats WHERE id = $1 AND user_id = $2',
                    [chatId, userId]
                );
                if (!chat) return;
            } else {
                return;
            }
            socket.join(roomKey);
        } catch (err) {
            console.error('joinChat error:', err);
        }
    });

    socket.on('disconnect', () => {
        console.log('Пользователь отключился, userId:', userId);
    });
});
app.use(express.json());
app.use(cookieParser());

// Tor connection logger
app.use(torConnectionLogger);

app.use((req, res, next) => {
    if (req.path.startsWith('/socket.io')) return next();

    // Раньше кука csrf_token выставлялась только на небезопасных методах, а
    // безопасные (GET) сразу пропускались без неё — значит самая первая
    // загрузка страницы (GET /) никогда не сеяла куку, и когда фронт слал
    // первый POST (обычно /api/login или /api/register), проверка ниже
    // видела отсутствие куки и просто выставляла её "на лету", пропуская
    // САМ этот запрос без проверки (см. п.11 аудита). Теперь кука сеется на
    // любом запросе, включая GET — к моменту первого POST от SPA (после
    // того как браузер уже загрузил index.html/script.js через GET) она уже
    // гарантированно на месте.
    const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
    const cookieToken = req.cookies['csrf_token'];
    const cookieWasMissing = !cookieToken;
    const issuedToken = cookieWasMissing ? crypto.randomBytes(32).toString('hex') : cookieToken;

    if (cookieWasMissing) {
        res.cookie('csrf_token', issuedToken, {
            httpOnly: false,
            sameSite: 'lax',
            secure: secureCookieFor(req),
            maxAge: 24 * 60 * 60 * 1000
        });
    }

    if (safeMethods.includes(req.method)) return next();

    // Небезопасный метод: токен обязателен и должен совпадать с уже
    // существовавшей (не только что выставленной в этом же запросе) кукой —
    // иначе это тот самый bootstrap-обход, который раньше пропускал первый
    // POST без проверки.
    const headerToken = req.headers['x-csrf-token'];
    if (cookieWasMissing || !headerToken || issuedToken !== headerToken) {
        return res.status(403).json({ success: false, message: 'Запрещено: неверный CSRF-токен' });
    }
    next();
});

app.use((req, res, next) => {
    // Усиленные заголовки приватности
    const privacyHeaders = getPrivacyHeaders();
    Object.entries(privacyHeaders).forEach(([key, value]) => {
        res.set(key, value);
    });

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;
    // base-uri и object-src не наследуются из default-src, поэтому заданы
    // явно (п.8 аудита): без base-uri инъекция тега <base> (если когда-либо
    // станет достижима) не блокируется текущей политикой; object-src явно
    // запрещён, хотя и так по умолчанию блокируется отсутствием в списке.
    //
    // connect-src — только свой origin: 'self' покрывает и ws/wss того же
    // хоста. Было 'self' ws: wss: — то есть сокет на любой адрес, и
    // внедрённый скрипт мог бы вынести переписку через WebSocket.
    res.set('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`);
    // HSTS — только по HTTPS (по HTTP браузер заголовок игнорирует). Без
    // includeSubDomains: на соседних поддоменах может жить то, что по HTTPS
    // не открывается. У .onion HTTPS нет, и там запрос сюда не попадёт.
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    // Referrer-Policy здесь не ставится: её задаёт getPrivacyHeaders()
    // (no-referrer). Раньше эта строка её перезаписывала на
    // strict-origin-when-cross-origin, и адрес мессенджера уходил сайтам
    // по ссылкам из переписки.
    next();
});

app.use(sessionMiddleware);
app.use(sessionCookieSecurity());
app.use(express.static(path.join(__dirname, 'public')));

// pdf-lib для браузера: в зашифрованном чате метаданные PDF снимает
// отправитель, до шифрования. Сборка самодостаточная (без импортов), а
// отдаётся со своего origin, потому что CSP разрешает скрипты только
// отсюда. Клиент подгружает её лишь тогда, когда прикладывают PDF.
const PDF_LIB_BROWSER = path.join(__dirname, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.esm.min.js');
app.get('/vendor/pdf-lib.esm.min.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('application/javascript').sendFile(PDF_LIB_BROWSER);
});

app.get('/uploads/:filename', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
    const filename = path.basename(req.params.filename);
    const filePath = path.join(__dirname, 'uploads', filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'Файл не найден' });
    try {
        const allowed = await userCanAccessFile(req.session.userId, filename);
        if (!allowed) return res.status(403).json({ success: false, message: 'Доступ запрещён' });
    } catch (err) {
        console.error('Uploads access check error:', err);
        return res.status(500).json({ success: false, message: 'Ошибка проверки доступа' });
    }
    res.sendFile(filePath);
});

app.get('/link.my', (req, res) => {
    serveIndexWithNonce(req, res);
});

function serveIndexWithNonce(req, res) {
    const nonce = res.locals.cspNonce || '';
    const indexPath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(indexPath, 'utf8', (err, html) => {
        if (err) return res.status(500).send('Server error');
        const injected = html
            .replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)
            .replace(/<style(?![^>]*\bnonce=)/g, `<style nonce="${nonce}"`)
            .replace(/<link([^>]*rel=["']stylesheet["'][^>]*)(?![^>]*\bnonce=)>/g, `<link$1 nonce="${nonce}">`);
        res.setHeader('Content-Type', 'text/html');
        res.send(injected);
    });
}

app.use('/api/', apiLimiter);

// Реестр устройств и прокси к e2ee-key-server.
//
// Прокси до сих пор не был смонтирован: модуль подключался через require, но
// app.use для него не вызывался, поэтому все /api/keys/* отдавали 404 —
// притом что README документирует их как рабочие. Монтируется здесь, после
// сессии, CSRF и apiLimiter, чтобы операции с ключами проходили те же
// проверки, что остальное API.
app.use(createDevicesRouter({
    pool,
    dbGet,
    dbAll,
    dbRun,
    revokeDeviceKeys: e2eeProxy.revokeDeviceKeys,
}));
// Ключи собеседника — только при общем чате (см. requirePeer в e2ee-proxy).
e2eeProxy.setPeerCheck(async (userId, otherUserId) => Boolean(await dbGet(
    `SELECT 1 FROM room_participants mine
     JOIN room_participants theirs ON theirs.room_id = mine.room_id
     WHERE mine.user_id = $1 AND theirs.user_id = $2 LIMIT 1`,
    [userId, otherUserId])));
app.use(e2eeProxy.router);

/**
 * Начать сессию с новым id — при регистрации так же, как при входе. Иначе
 * id сессии, известный до входа (подброшенный в куку или подсмотренный),
 * после входа давал бы доступ к аккаунту.
 */
function startSession(req, values) {
    return new Promise((resolve, reject) => req.session.regenerate(err => {
        if (err) return reject(err);
        // regenerate создаёт куку заново, с настройками по умолчанию, — а
        // Secure зависит от адреса (у .onion его нет).
        req.session.cookie.secure = secureCookieFor(req);
        Object.assign(req.session, values);
        resolve();
    }));
}

/** Отключить открытые сокеты: сессия уже удалена, а они об этом не знают. */
function disconnectSockets(room) {
    io.in(room).disconnectSockets(true);
}

app.post('/api/register', registerLimiter, async (req, res) => {
    const { username, email, password, confirmPassword } = req.body;
    if (!username || !email || !password || !confirmPassword)
        return res.json({ success: false, message: 'Заполните все поля' });
    if (username.length > 32)
        return res.json({ success: false, message: 'Имя не может быть длиннее 32 символов' });
    if (email.length > 254)
        return res.json({ success: false, message: 'Email слишком длинный' });
    if (password.length > 128)
        return res.json({ success: false, message: 'Пароль не может быть длиннее 128 символов' });
    if (password !== confirmPassword)
        return res.json({ success: false, message: 'Пароли не совпадают' });
    if (password.length < 8)
        return res.json({ success: false, message: 'Пароль должен быть не менее 8 символов' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.json({ success: false, message: 'Введите корректный email' });

    try {
        const existing = await dbGet('SELECT id FROM users WHERE email = $1 OR username = $2', [email, username]);
        if (existing) return res.json({ success: false, message: 'Ошибка регистрации. Проверьте введённые данные.' });

        const uniqueCode = await generateUniqueCodeAsync();
        const hashedPassword = await bcrypt.hash(password, 12);

        const client = await pool.connect();
        let userId;
        try {
            await client.query('BEGIN');
            const userResult = await client.query(
                'INSERT INTO users (unique_code, username, email, password, avatar) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [uniqueCode, username, email, hashedPassword, '#667EEA']
            );
            userId = userResult.rows[0].id;

            const botResult = await client.query(
                'INSERT INTO chats (user_id, name, avatar, online, is_bot) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [userId, 'Бот Помощник', 'Б', 1, 1]
            );
            const botChatId = botResult.rows[0].id;
            await client.query(
                'INSERT INTO messages (chat_id, user_id, text, sent, time, status) VALUES ($1, $2, $3, $4, $5, $6)',
                [botChatId, userId, 'Привет! Я бот-помощник. Чем могу помочь?', 0, getCurrentTime(), 'read']
            );
            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }

        await startSession(req, { userId, username, uniqueCode, avatar: '#667EEA' });

        res.json({ success: true, message: 'Регистрация успешна!', user: { id: userId, username, uniqueCode, avatar: '#667EEA' } });
    } catch (error) {
        console.error('Register error:', error);
        res.json({ success: false, message: 'Ошибка сервера' });
    }
});

app.post('/api/register/anonymous', registerLimiter, async (req, res) => {
    try {
        let uniqueCode, username;
        const rustIdentity = await fetchAnonymousIdentity();
        if (rustIdentity) {
            uniqueCode = rustIdentity.unique_code;
            username = rustIdentity.username;
            const existingCode = await dbGet('SELECT id FROM users WHERE unique_code = $1', [uniqueCode]);
            const existingName = await dbGet('SELECT id FROM users WHERE username = $1', [username]);
            if (existingCode || existingName) {
                console.warn('[Anon] Rust-generated identity collision, using fallback');
                uniqueCode = await generateUniqueCodeAsync();
                username = await generateAnonymousUsernameAsync();
            }
        } else {
            uniqueCode = await generateUniqueCodeAsync();
            username = await generateAnonymousUsernameAsync();
        }

        // Генерация уникального session fingerprint для анонимного пользователя
        const sessionFingerprint = generateSecureToken(32);

        const client = await pool.connect();
        let userId;
        try {
            await client.query('BEGIN');
            const userResult = await client.query(
                'INSERT INTO users (unique_code, username, email, password, avatar) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [uniqueCode, username, null, null, '#667EEA']
            );
            userId = userResult.rows[0].id;

            const botResult = await client.query(
                'INSERT INTO chats (user_id, name, avatar, online, is_bot) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [userId, 'Бот Помощник', 'Б', 1, 1]
            );
            const botChatId = botResult.rows[0].id;
            await client.query(
                'INSERT INTO messages (chat_id, user_id, text, sent, time, status) VALUES ($1, $2, $3, $4, $5, $6)',
                [botChatId, userId, '🔒 Приватный режим активирован!\n\nВаши данные:\n• Хранятся только в этой сессии\n• Будут удалены при выходе\n• Не связаны с email или телефоном\n\nДля максимальной анонимности:\n• Используйте Tor Browser\n• Не делитесь личной информацией\n• Включите disappearing messages', 0, getCurrentTime(), 'read']
            );
            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }

        await startSession(req, {
            userId, username, uniqueCode, avatar: '#667EEA',
            isAnonymous: true, sessionFingerprint, createdAt: Date.now(),
        });

        // Устанавливаем короткий срок жизни сессии для анонимных пользователей
        req.session.cookie.maxAge = 4 * 60 * 60 * 1000; // 4 часа

        console.log(`[Anon] New anonymous user created: ${username} (ID: ${userId})`);

        res.json({
            success: true,
            message: 'Приватный режим активирован!',
            user: {
                id: userId,
                username,
                uniqueCode,
                avatar: '#667EEA',
                isAnonymous: true,
                sessionExpiresIn: 4 * 60 * 60 // секунды
            }
        });
    } catch (error) {
        console.error('Anonymous register error:', error);
        res.json({ success: false, message: 'Ошибка сервера' });
    }
});

app.post('/api/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.json({ success: false, message: 'Введите email и пароль' });
    if (email.length > 254 || password.length > 128) return res.json({ success: false, message: 'Неверный email или пароль' });

    try {
        // Добавляем случайную задержку для защиты от timing attacks
        await addRandomDelay(50, 150);

        const user = await dbGet('SELECT * FROM users WHERE email = $1', [email]);
        // bcrypt.compare выполняется независимо от того, найден ли юзер —
        // это убирает разницу во времени ответа между "нет такого email"
        // и "неверный пароль" (см. п.4 аудита).
        const hashToCheck = (user && user.password) ? user.password : DUMMY_PASSWORD_HASH;
        const validPassword = await bcrypt.compare(password, hashToCheck);

        // Дополнительная случайная задержка
        await addRandomDelay(20, 80);

        if (!user || !user.password || !validPassword) {
            return res.json({ success: false, message: 'Неверный email или пароль' });
        }

        try {
            await startSession(req, {
                userId: user.id, username: user.username, uniqueCode: user.unique_code, avatar: user.avatar || '',
            });
        } catch {
            return res.json({ success: false, message: 'Ошибка инициализации сессии' });
        }
        res.json({ success: true, message: 'Вход выполнен!', user: { id: user.id, username: user.username, uniqueCode: user.unique_code, avatar: user.avatar || '' } });
    } catch (error) {
        console.error('Login error:', error);
        res.json({ success: false, message: 'Ошибка базы данных' });
    }
});

/**
 * Удалить анонимный аккаунт со всем содержимым. Ключи — первыми: после
 * удаления пользователя строки devices уйдут по ON DELETE CASCADE, и
 * отзывать станет нечего, а ключи останутся висеть в схеме key-server,
 * у которой нет внешнего ключа на users.
 */
async function deleteAnonymousAccount(userId) {
    await e2eeProxy.revokeAllKeys(userId);
    await dbRun('DELETE FROM devices WHERE user_id = $1', [userId]);
    await dbRun('DELETE FROM messages WHERE user_id = $1', [userId]);
    await dbRun('DELETE FROM chats WHERE user_id = $1', [userId]);
    await dbRun('DELETE FROM room_participants WHERE user_id = $1', [userId]);
    await dbRun('DELETE FROM reactions WHERE user_id = $1', [userId]);
    await dbRun('DELETE FROM users WHERE id = $1', [userId]);
}

// Анонимный аккаунт живёт, пока жива его сессия (4 часа). Кнопкой «Выйти»
// он удаляется сразу; раньше только ею — и если вкладку просто закрывали,
// аккаунт с перепиской оставался на сервере навсегда. Теперь его находит
// уборка: пароля и почты нет, живой сессии тоже. Десять минут форы — чтобы
// не удалить аккаунт, сессия которого ещё не успела записаться.
// Переменная окружения — для тестов: ждать десять минут там незачем.
const ANON_SWEEP_INTERVAL_MS = Number(process.env.ANON_SWEEP_INTERVAL_MS) || 10 * 60 * 1000;
async function sweepAnonymousAccounts() {
    try {
        const stale = await dbAll(
            `SELECT u.id FROM users u
             WHERE u.email IS NULL AND u.password IS NULL
               AND u.created_at < NOW() - INTERVAL '10 minutes'
               AND NOT EXISTS (SELECT 1 FROM "session" s
                               WHERE s.sess->>'userId' = u.id::text AND s.expire > NOW())`
        );
        for (const { id } of stale) {
            await deleteAnonymousAccount(id);
            disconnectSockets(`user:${id}`);
        }
        if (stale.length) console.log(`[Anon] Удалено брошенных анонимных аккаунтов: ${stale.length}`);
    } catch (error) {
        console.error('[Anon] Sweep error:', error.message);
    }
}
setInterval(sweepAnonymousAccounts, ANON_SWEEP_INTERVAL_MS).unref();

app.post('/api/logout', async (req, res) => {
    const isAnonymous = req.session?.isAnonymous;
    const userId = req.session?.userId;

    if (isAnonymous && userId) {
        try {
            await deleteAnonymousAccount(userId);
            console.log(`[Anon] Successfully cleaned up anonymous user ${userId}`);
        } catch (error) {
            console.error('[Anon] Cleanup error:', error);
        }
    }

    // Анонимный аккаунт удалён целиком — отключаем все его сокеты, обычный —
    // только сокеты этой сессии: на других устройствах вход остаётся.
    disconnectSockets(isAnonymous && userId ? `user:${userId}` : `session:${req.sessionID}`);
    req.session.destroy((err) => {
        res.clearCookie('connect.sid');
        res.clearCookie('csrf_token');
        if (err) console.error('Logout session destroy error:', err);
        res.json({ success: true, message: isAnonymous ? 'Данные удалены' : 'Выход выполнен' });
    });
});

app.get('/api/auth', async (req, res) => {
    if (!req.session.userId) return res.json({ authenticated: false });
    try {
        const row = await dbGet('SELECT avatar FROM users WHERE id = $1', [req.session.userId]);
        if (!row && req.session.isAnonymous) {
            // Анонимный пользователь был удален, очищаем сессию
            req.session.destroy(() => {});
            return res.json({ authenticated: false, expired: true });
        }
        if (!row) return res.json({ authenticated: false });

        const avatar = row ? (row.avatar || '') : (req.session.avatar || '');
        req.session.avatar = avatar;

        // Проверка времени жизни анонимной сессии
        if (req.session.isAnonymous && req.session.createdAt) {
            const sessionAge = Date.now() - req.session.createdAt;
            const maxAge = 4 * 60 * 60 * 1000; // 4 часа
            if (sessionAge > maxAge) {
                return res.json({
                    authenticated: false,
                    expired: true,
                    message: 'Анонимная сессия истекла'
                });
            }
        }

        res.json({
            authenticated: true,
            user: {
                id: req.session.userId,
                username: req.session.username,
                uniqueCode: req.session.uniqueCode,
                avatar,
                isAnonymous: req.session.isAnonymous || false
            }
        });
    } catch (error) {
        res.json({ authenticated: false });
    }
});

app.get('/api/user', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    try {
        const user = await dbGet('SELECT id, unique_code, username, email, avatar, created_at FROM users WHERE id = $1', [req.session.userId]);
        if (!user) return res.json({ success: false });
        res.json({ success: true, user: { id: user.id, uniqueCode: user.unique_code, username: user.username, avatar: user.avatar || '', email: user.email, createdAt: user.created_at } });
    } catch (error) {
        res.json({ success: false });
    }
});

app.post('/api/user/avatar-color', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const avatarColor = normalizeAvatarColor(req.body && req.body.avatarColor);
    try {
        await dbRun('UPDATE users SET avatar = $1 WHERE id = $2', [avatarColor, req.session.userId]);
        req.session.avatar = avatarColor;
        res.json({ success: true, avatar: avatarColor });
    } catch (error) {
        res.json({ success: false, message: 'Ошибка обновления цвета аватара' });
    }
});
app.get('/api/chats', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    try {
        const chats = await dbAll(`
            SELECT c.id, c.name, c.avatar, c.online, c.is_bot, c.room_id, r.code as invite_code,
                   (SELECT text FROM messages WHERE ((c.room_id IS NOT NULL AND room_id = c.room_id) OR (c.room_id IS NULL AND chat_id = c.id)) AND deleted = 0 ORDER BY id DESC LIMIT 1) as last_message,
                   (SELECT created_at FROM messages WHERE ((c.room_id IS NOT NULL AND room_id = c.room_id) OR (c.room_id IS NULL AND chat_id = c.id)) AND deleted = 0 ORDER BY id DESC LIMIT 1) as last_at,
                   (SELECT COUNT(*) FROM messages m WHERE ((c.room_id IS NOT NULL AND m.room_id = c.room_id) OR (c.room_id IS NULL AND m.chat_id = c.id)) AND m.sent = 0 AND m.status != 'read') as unread
            FROM chats c
            LEFT JOIN rooms r ON c.room_id = r.id
            WHERE c.user_id = $1
            ORDER BY (SELECT MAX(id) FROM messages WHERE ((c.room_id IS NOT NULL AND room_id = c.room_id) OR (c.room_id IS NULL AND chat_id = c.id))) DESC NULLS LAST
        `, [req.session.userId]);
        res.json({ success: true, chats: chats.map(c => ({ ...c, unread: Number(c.unread) })) });
    } catch (error) {
        console.error('Get chats error:', error);
        res.json({ success: false, message: 'Ошибка загрузки чатов' });
    }
});

/**
 * Устройства, которым нужен конверт этого сообщения.
 *
 * Включает ВСЕ устройства участников, в том числе устройство отправителя.
 * Клиент сам себе конверт не шлёт (своё он хранит локально), но запрещать
 * это серверу незачем: это всё ещё устройство участника.
 *
 * Для комнаты это все участники, для обычного чата — только владелец: у
 * групповых чатов участники лежат в room_participants, а одиночная запись
 * chats без room_id принадлежит одному человеку.
 *
 * Чат с ботом не шифруется вовсе: бот отвечает на открытый текст. Если бы
 * здесь вернулись устройства владельца, то при двух устройствах сообщения
 * боту уходили бы зашифрованными — бот бы молчал, а индикатор в шапке
 * говорил бы «без шифрования».
 */
async function resolveEnvelopeRecipients(chat) {
    if (chat.is_bot) return [];
    const rows = chat.room_id
        ? await dbAll(
            `SELECT d.id, d.user_id FROM devices d
             JOIN room_participants rp ON rp.user_id = d.user_id
             WHERE rp.room_id = $1 AND d.revoked_at IS NULL
             ORDER BY d.id ASC`,
            [chat.room_id]
        )
        : await dbAll(
            'SELECT id, user_id FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id ASC',
            [chat.user_id]
        );
    return rows;
}

/**
 * GET /api/chats/:chatId/devices
 *
 * Отправителю нужно знать, для скольких устройств шифровать. Сам он этого
 * знать не может: состав чата и список устройств живут на сервере.
 *
 * Отдаются только id — ключей здесь нет, за ними клиент идёт в
 * /api/keys/bundle/:userId. Разделение не косметическое: bundle расходует
 * одноразовый prekey, и запрашивать его ради простого пересчёта устройств
 * было бы расточительно.
 */
app.get('/api/chats/:chatId/devices', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
    try {
        const chat = await dbGet('SELECT * FROM chats WHERE id = $1 AND user_id = $2',
            [req.params.chatId, req.session.userId]);
        if (!chat) return res.status(404).json({ success: false, message: 'Чат не найден' });
        const devices = await resolveEnvelopeRecipients(chat);
        // Имена участников — для окна сверки ключей: код безопасности
        // строится на каждого собеседника, и подписать его нужно по-человечески.
        const userIds = [...new Set(devices.map(d => d.user_id))];
        const users = userIds.length
            ? await dbAll('SELECT id, username FROM users WHERE id = ANY($1::int[])', [userIds])
            : [];
        res.json({
            success: true,
            // room_id нужен клиенту для sender keys: у каждого участника своя
            // запись chats с другим id, а групповой ключ один на комнату.
            room_id: chat.room_id || null,
            devices: devices.map(d => ({ device_id: d.id, user_id: d.user_id })),
            users: users.map(u => ({ user_id: u.id, username: u.username })),
        });
    } catch (error) {
        console.error('Chat devices error:', error);
        res.status(500).json({ success: false, message: 'Не удалось получить устройства чата' });
    }
});

/* ------------------------------------------------------------------
   Зашифрованные вложения
   ------------------------------------------------------------------ */

// Отдельный каталог, а не uploads/: фоновый уборщик раз в час удаляет из
// uploads/ ВСЕ файлы старше суток, не сверяясь с базой, — вложения
// зашифрованных сообщений он уничтожал бы вместе с остальными. Здесь
// время жизни файла совпадает со временем жизни сообщения.
const BLOBS_DIR = path.join(__dirname, 'encrypted-blobs');
if (!fs.existsSync(BLOBS_DIR)) fs.mkdirSync(BLOBS_DIR, { recursive: true });

const BLOB_ID_RE = /^[0-9a-f]{32}$/;
const MAX_BLOB_BYTES = 50 * 1024 * 1024;   // как у открытых вложений
// Пустой файл после AES-GCM — это 16 байт тега. Меньше быть не может.
const MIN_BLOB_BYTES = 16;
const MAX_BLOBS_PER_MESSAGE = 10;
// Сколько живёт загруженное, но так и не отправленное вложение.
const ORPHAN_BLOB_TTL_MS = 60 * 60 * 1000;

const blobPath = id => path.join(BLOBS_DIR, `${id}.bin`);

/**
 * Удалить всё зашифрованное содержимое сообщения: конверты и вложения.
 *
 * Удаление сообщения в приложении мягкое (deleted = 1), и для открытого
 * текста это частично работает — исчезающие сообщения затирают text. Но у
 * зашифрованного сообщения содержимое живёт в конвертах и файлах, и мягкое
 * удаление оставляло бы их на сервере навсегда. Здесь они удаляются
 * по-настоящему.
 */
async function purgeEncryptedContent(messageId) {
    const blobs = await dbAll('SELECT id FROM encrypted_blobs WHERE message_id = $1', [messageId]);
    for (const b of blobs) {
        await fs.promises.unlink(blobPath(b.id)).catch(() => {});
    }
    await dbRun('DELETE FROM encrypted_blobs WHERE message_id = $1', [messageId]);
    await dbRun('DELETE FROM message_envelopes WHERE message_id = $1', [messageId]);
    await dbRun('DELETE FROM message_group_payloads WHERE message_id = $1', [messageId]);
}

const UPLOADS_DIR = path.join(__dirname, 'uploads');
// Сколько живёт файл в uploads/, на который не ссылается ни одно
// сообщение: загрузка, оборвавшаяся между записью файла и строки в базе.
const ORPHAN_UPLOAD_TTL_MS = 60 * 60 * 1000;

/**
 * Удалить содержимое удалённого сообщения по-настоящему.
 *
 * Удаление в приложении мягкое (deleted = 1): строка нужна, на неё ссылаются
 * ответы и реакции. Но содержимому на сервере после удаления делать нечего:
 * раньше текст оставался в базе (и всплывал в цитате ответа), а файл —
 * на диске и по-прежнему скачивался по прямой ссылке.
 */
async function purgeMessageContent(messageId) {
    const message = await dbGet('SELECT file_url, encrypted FROM messages WHERE id = $1', [messageId]);
    if (!message) return;
    if (message.file_url) {
        const filename = path.basename(message.file_url);
        await fs.promises.unlink(path.join(UPLOADS_DIR, filename)).catch(() => {});
    }
    await dbRun('UPDATE messages SET text = NULL, file_url = NULL, file_name = NULL WHERE id = $1', [messageId]);
    if (message.encrypted) await purgeEncryptedContent(messageId);
}

/**
 * POST /api/blobs?chatId=N — загрузить зашифрованное вложение.
 *
 * Тело — сырые байты шифротекста (application/octet-stream). Проверить
 * их содержимое сервер не может и не должен: magic bytes, EXIF, тип файла —
 * всё это теперь забота отправителя. Проверяется только, что чат свой и
 * размер в пределах.
 */
app.post('/api/blobs',
    express.raw({ type: 'application/octet-stream', limit: MAX_BLOB_BYTES }),
    async (req, res) => {
        if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
        const chatId = Number(req.query.chatId);
        if (!Number.isInteger(chatId) || chatId <= 0) {
            return res.status(400).json({ success: false, message: 'Не указан чат' });
        }
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length < MIN_BLOB_BYTES) {
            return res.status(400).json({ success: false, message: 'Пустое или некорректное вложение' });
        }
        try {
            const chat = await dbGet('SELECT id, room_id FROM chats WHERE id = $1 AND user_id = $2',
                [chatId, req.session.userId]);
            if (!chat) return res.status(404).json({ success: false, message: 'Чат не найден' });

            const id = crypto.randomBytes(16).toString('hex');
            await fs.promises.writeFile(blobPath(id), body, { flag: 'wx' });
            await pool.query(
                `INSERT INTO encrypted_blobs (id, uploader_user_id, chat_id, room_id, size)
                 VALUES ($1, $2, $3, $4, $5)`,
                [id, req.session.userId, chat.id, chat.room_id || null, body.length]
            );
            res.json({ success: true, blobId: id });
        } catch (error) {
            console.error('Blob upload error:', error);
            res.status(500).json({ success: false, message: 'Не удалось сохранить вложение' });
        }
    }
);

/**
 * GET /api/blobs/:id — скачать зашифрованное вложение.
 *
 * Доступ — как к самому сообщению: участникам чата. Пока вложение не
 * привязано к сообщению, скачать его может только загрузивший. Отдаётся
 * всегда как octet-stream: это шифротекст, и браузер не должен пытаться
 * его интерпретировать.
 */
app.get('/api/blobs/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
    const id = req.params.id;
    // Один ответ 404 на всё: и на кривой id, и на чужое, и на удалённое —
    // иначе по кодам ответа можно перебором узнавать, какие id существуют.
    const notFound = () => res.status(404).json({ success: false, message: 'Вложение не найдено' });
    if (!BLOB_ID_RE.test(id)) return notFound();
    try {
        const blob = await dbGet(
            `SELECT b.id, b.uploader_user_id, b.message_id, m.deleted
             FROM encrypted_blobs b LEFT JOIN messages m ON m.id = b.message_id
             WHERE b.id = $1`,
            [id]
        );
        if (!blob) return notFound();
        const allowed = blob.message_id
            ? !blob.deleted && await userCanAccessMessage(req.session.userId, blob.message_id)
            : blob.uploader_user_id === req.session.userId;
        if (!allowed) return notFound();

        res.set('Content-Type', 'application/octet-stream');
        res.set('Cache-Control', 'private, no-store');
        res.set('Content-Disposition', 'attachment');
        res.sendFile(blobPath(id), err => {
            if (err && !res.headersSent) notFound();
        });
    } catch (error) {
        console.error('Blob download error:', error);
        res.status(500).json({ success: false, message: 'Ошибка загрузки вложения' });
    }
});

/**
 * Уборка вложений, которые никому не принадлежат: загружены, но сообщение
 * так и не отправлено, либо строка ушла каскадом вместе с сообщением,
 * чатом или анонимным пользователем, а файл на диске остался.
 */
async function sweepOrphanBlobs() {
    try {
        const stale = await dbAll(
            `SELECT id FROM encrypted_blobs
             WHERE message_id IS NULL AND created_at < now() - ($1 || ' milliseconds')::interval`,
            [String(ORPHAN_BLOB_TTL_MS)]
        );
        for (const b of stale) {
            await fs.promises.unlink(blobPath(b.id)).catch(() => {});
            await dbRun('DELETE FROM encrypted_blobs WHERE id = $1', [b.id]);
        }

        const known = new Set((await dbAll('SELECT id FROM encrypted_blobs')).map(r => r.id));
        const cutoff = Date.now() - ORPHAN_BLOB_TTL_MS;
        for (const name of await fs.promises.readdir(BLOBS_DIR)) {
            const id = name.replace(/\.bin$/, '');
            if (known.has(id)) continue;
            const full = path.join(BLOBS_DIR, name);
            const stat = await fs.promises.stat(full).catch(() => null);
            // Свежие файлы не трогаем: между записью файла и строки в базе
            // есть окно, и уборщик не должен съедать загрузку на лету.
            if (stat && stat.isFile() && stat.mtimeMs < cutoff) {
                await fs.promises.unlink(full).catch(() => {});
            }
        }
    } catch (error) {
        console.error('Blob sweep error:', error.message);
    }
}
setInterval(sweepOrphanBlobs, ORPHAN_BLOB_TTL_MS).unref();

const MAX_ENVELOPES = 256;
const MAX_HEADER_B64 = 2048;
const MAX_CIPHERTEXT_B64 = 16384;

// Строгий base64: иначе в BYTEA уехал бы мусор, а ошибка всплыла бы только
// у получателя при расшифровке, где её уже не с чем связать.
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeB64(value, maxLen, field) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLen) {
        return { error: `${field}: ожидается base64 до ${maxLen} символов` };
    }
    if (!B64_RE.test(value)) return { error: `${field}: некорректный base64` };
    const buf = Buffer.from(value, 'base64');
    if (buf.length === 0) return { error: `${field}: пустое значение` };
    // Buffer.from не бросает на мусоре, а молча отбрасывает лишнее —
    // сверяем обратной кодировкой, что ничего не потерялось.
    if (buf.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
        return { error: `${field}: некорректный base64` };
    }
    return { buf };
}

// Групповой заголовок: версия + id распространения (16) + номер (4).
const GROUP_HEADER_BYTES = 21;
const GROUP_SIGNATURE_BYTES = 64;

/**
 * Разобрать список конвертов. Каждый обязан быть адресован устройству
 * участника чата: иначе сервер превращается в хранилище, куда можно писать
 * кому угодно. Возвращает { parsed } или { status, message }.
 */
function parseEnvelopeList(list, allowedIds, label) {
    const parsed = [];
    const seen = new Set();
    for (const item of list) {
        const deviceId = Number(item && item.recipientDeviceId);
        if (!Number.isInteger(deviceId) || deviceId <= 0) {
            return { status: 400, message: `${label}: некорректный recipientDeviceId` };
        }
        if (seen.has(deviceId)) {
            return { status: 400, message: `${label}: дубликат для устройства ${deviceId}` };
        }
        if (!allowedIds.has(deviceId)) {
            return { status: 403, message: `Устройство ${deviceId} не участвует в чате` };
        }
        const type = Number(item.envelopeType);
        if (type !== 1 && type !== 2) {
            return { status: 400, message: 'envelopeType должен быть 1 (prekey) или 2 (normal)' };
        }
        const header = decodeB64(item.header, MAX_HEADER_B64, 'header');
        if (header.error) return { status: 400, message: header.error };
        const ciphertext = decodeB64(item.ciphertext, MAX_CIPHERTEXT_B64, 'ciphertext');
        if (ciphertext.error) return { status: 400, message: ciphertext.error };

        seen.add(deviceId);
        parsed.push({ deviceId, type, header: header.buf, ciphertext: ciphertext.buf });
    }
    return { parsed, seen };
}

function parseGroupPayload(group) {
    if (!group || typeof group !== 'object') return { message: 'group: ожидается объект' };
    const header = decodeB64(group.header, MAX_HEADER_B64, 'group.header');
    if (header.error) return { message: header.error };
    if (header.buf.length !== GROUP_HEADER_BYTES) return { message: 'group.header: неверная длина' };
    const signature = decodeB64(group.signature, MAX_HEADER_B64, 'group.signature');
    if (signature.error) return { message: signature.error };
    if (signature.buf.length !== GROUP_SIGNATURE_BYTES) return { message: 'group.signature: неверная длина' };
    const ciphertext = decodeB64(group.ciphertext, MAX_CIPHERTEXT_B64, 'group.ciphertext');
    if (ciphertext.error) return { message: ciphertext.error };
    return { header: header.buf, ciphertext: ciphertext.buf, signature: signature.buf };
}

const b64 = buf => buf.toString('base64');

/**
 * POST /api/messages/encrypted
 *
 * Отправка зашифрованного сообщения. Сервер не видит содержимого: он
 * проверяет, что конверты адресованы участникам чата, складывает их и
 * рассылает каждому устройству то, что ему адресовано.
 *
 * Два режима:
 *   - попарный (envelopes): конверт с содержимым на каждое устройство;
 *   - групповой (group + keyEnvelopes): один шифротекст на всех, и конверты
 *     с sender key только тем устройствам, у которых его ещё нет. Только
 *     для комнат.
 *
 * Открытый путь POST /api/messages оставлен рядом для чата с ботом и чатов,
 * где пока не для кого шифровать.
 */
/** Срок жизни из запроса: null — не задан, false — недопустим. */
function expiryFrom(value) {
    if (value === undefined || value === null || value === '' || Number(value) === 0) return null;
    return normalizeExpiry(value) ?? false;
}

/**
 * Проверить, на что отвечает сообщение. Ответить можно только на живое
 * сообщение этой же переписки: история отдаёт вместе с ответом текст
 * цитаты, и чужой id открывал бы текст из чужого чата.
 */
async function replyTargetFor(chat, replyToId) {
    if (replyToId === undefined || replyToId === null || replyToId === '') return { id: null };
    const id = Number(replyToId);
    if (!Number.isSafeInteger(id) || id <= 0) return { error: 'Некорректный ответ' };
    const target = chat.room_id
        ? await dbGet('SELECT id FROM messages WHERE id = $1 AND room_id = $2 AND deleted = 0', [id, chat.room_id])
        : await dbGet('SELECT id FROM messages WHERE id = $1 AND chat_id = $2 AND room_id IS NULL AND deleted = 0', [id, chat.id]);
    return target ? { id } : { error: 'Сообщение, на которое вы отвечаете, не найдено' };
}

app.post('/api/messages/encrypted', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
    if (!req.session.deviceId) {
        return res.status(409).json({ success: false, message: 'Устройство не зарегистрировано' });
    }

    const {
        chatId, replyToId, expirySeconds, envelopes = [], keyEnvelopes = [], group = null, blobIds = [],
    } = req.body || {};

    if (!Array.isArray(blobIds) || blobIds.length > MAX_BLOBS_PER_MESSAGE
        || !blobIds.every(id => typeof id === 'string' && BLOB_ID_RE.test(id))) {
        return res.status(400).json({ success: false, message: 'Некорректный список вложений' });
    }

    if (!Array.isArray(envelopes) || !Array.isArray(keyEnvelopes)) {
        return res.status(400).json({ success: false, message: 'Конверты должны быть массивом' });
    }
    // Содержимое идёт либо попарно, либо одним групповым шифротекстом. Оба
    // сразу означали бы, что разные устройства прочтут разное.
    if (group ? envelopes.length > 0 : envelopes.length === 0) {
        return res.status(400).json({ success: false, message: group
            ? 'Групповое сообщение не несёт попарных конвертов'
            : 'Нет конвертов' });
    }
    if (!group && keyEnvelopes.length > 0) {
        return res.status(400).json({ success: false, message: 'Раздача ключа — только с групповым сообщением' });
    }
    if (envelopes.length > MAX_ENVELOPES || keyEnvelopes.length > MAX_ENVELOPES) {
        return res.status(400).json({ success: false, message: `Не больше ${MAX_ENVELOPES} конвертов` });
    }
    const groupPayload = group ? parseGroupPayload(group) : null;
    if (groupPayload && groupPayload.message) {
        return res.status(400).json({ success: false, message: groupPayload.message });
    }

    try {
        const chat = await dbGet('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
        if (!chat) return res.status(404).json({ success: false, message: 'Чат не найден' });

        if (groupPayload && !chat.room_id) {
            return res.status(400).json({ success: false, message: 'Групповое шифрование — только для комнат' });
        }
        const reply = await replyTargetFor(chat, replyToId);
        if (reply.error) return res.status(400).json({ success: false, message: reply.error });
        const replyTo = reply.id;
        const expiry = expiryFrom(expirySeconds);
        if (expiry === false) return res.status(400).json({ success: false, message: 'Недопустимый срок жизни сообщения' });

        const senderDeviceId = req.session.deviceId;
        const allowed = await resolveEnvelopeRecipients(chat);
        const allowedIds = new Set(allowed.map(d => d.id));

        // Разбор и проверка до единой записи в БД: половина вставленных
        // конвертов хуже отказа — сообщение прочитается у части устройств.
        const content = parseEnvelopeList(envelopes, allowedIds, 'envelopes');
        if (content.status) return res.status(content.status).json({ success: false, message: content.message });
        const keys = parseEnvelopeList(keyEnvelopes, allowedIds, 'keyEnvelopes');
        if (keys.status) return res.status(keys.status).json({ success: false, message: keys.message });
        const parsed = content.parsed;
        const seen = content.seen;

        // Привязать можно только своё, ещё не отправленное вложение из этого
        // же чата. Иначе можно было бы «переотправить» чужой файл в другой
        // чат и открыть к нему доступ его участникам.
        if (blobIds.length > 0) {
            const owned = await dbAll(
                `SELECT id FROM encrypted_blobs
                 WHERE id = ANY($1::text[]) AND uploader_user_id = $2 AND chat_id = $3 AND message_id IS NULL`,
                [blobIds, req.session.userId, chat.id]
            );
            if (owned.length !== new Set(blobIds).size) {
                return res.status(403).json({ success: false, message: 'Вложение не найдено или уже отправлено' });
            }
        }

        const time = getCurrentTime();
        const roomId = chat.room_id || null;
        const socketRoomKey = getSocketRoomKey(chatId, roomId);

        const client = await pool.connect();
        let messageId;
        let createdAt;
        try {
            await client.query('BEGIN');
            const inserted = await client.query(
                `INSERT INTO messages (chat_id, room_id, user_id, text, message_type, sent, time, status, reply_to_id, encrypted, sender_device_id)
                 VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, TRUE, $9) RETURNING id, created_at`,
                [chatId, roomId, req.session.userId, 'text', 1, time, 'sent', replyTo, senderDeviceId]
            );
            messageId = inserted.rows[0].id;
            createdAt = inserted.rows[0].created_at;
            if (blobIds.length > 0) {
                const linked = await client.query(
                    'UPDATE encrypted_blobs SET message_id = $1 WHERE id = ANY($2::text[]) AND message_id IS NULL',
                    [messageId, blobIds]
                );
                // Проверка выше была до транзакции: параллельный запрос мог
                // успеть привязать то же вложение. Тогда это сообщение
                // ссылалось бы на файл, доступ к которому решает чужое.
                if (linked.rowCount !== new Set(blobIds).size) {
                    const conflict = new Error('вложение уже привязано');
                    conflict.status = 409;
                    throw conflict;
                }
            }
            for (const e of parsed) {
                await client.query(
                    `INSERT INTO message_envelopes (message_id, recipient_device_id, sender_device_id, envelope_type, header, ciphertext)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [messageId, e.deviceId, senderDeviceId, e.type, e.header, e.ciphertext]
                );
            }
            if (groupPayload) {
                await client.query(
                    'INSERT INTO message_group_payloads (message_id, header, ciphertext, signature) VALUES ($1, $2, $3, $4)',
                    [messageId, groupPayload.header, groupPayload.ciphertext, groupPayload.signature]
                );
            }
            for (const e of keys.parsed) {
                const row = await client.query(
                    `INSERT INTO sender_key_envelopes
                        (room_id, sender_user_id, sender_device_id, recipient_device_id, envelope_type, header, ciphertext)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                    [chat.room_id, req.session.userId, senderDeviceId, e.deviceId, e.type, e.header, e.ciphertext]
                );
                e.id = Number(row.rows[0].id);
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

        if (expiry) {
            await disappearingMessagesManager.setMessageExpiry(messageId, expiry, false);
        } else {
            const chatSettings = await disappearingMessagesManager.getChatSettings(chatId);
            if (chatSettings && chatSettings.default_message_expiry) {
                await disappearingMessagesManager.setMessageExpiry(messageId, chatSettings.default_message_expiry, false);
            }
        }

        const sender = await dbGet('SELECT username, avatar FROM users WHERE id = $1', [req.session.userId]);
        const base = {
            id: messageId,
            chat_id: Number(chatId),
            room_id: roomId,
            user_id: req.session.userId,
            sender_username: sender ? sender.username : '',
            sender_avatar: sender ? sender.avatar || '' : '',
            sender_device_id: senderDeviceId,
            encrypted: true,
            text: null,
            message_type: 'text',
            reply_to_id: replyTo,
            sent: true,
            time,
            created_at: createdAt,
            status: 'sent',
        };

        if (groupPayload) {
            // Групповой шифротекст — всем устройствам комнаты, кроме
            // отправляющего (оно дорисует сообщение само). Конверт с ключом —
            // только тем, кому он предназначен.
            const groupOut = {
                header: b64(groupPayload.header),
                ciphertext: b64(groupPayload.ciphertext),
                signature: b64(groupPayload.signature),
            };
            const keyByDevice = new Map(keys.parsed.map(e => [e.deviceId, {
                id: e.id,
                room_id: roomId,
                sender_device_id: senderDeviceId,
                envelope_type: e.type,
                header: b64(e.header),
                ciphertext: b64(e.ciphertext),
            }]));
            for (const d of allowed) {
                if (d.id === senderDeviceId) continue;
                io.to(`device:${d.id}`).emit('newMessage', {
                    ...base,
                    envelope: null,
                    group: groupOut,
                    keyEnvelope: keyByDevice.get(d.id) || null,
                });
            }
        } else {
            // Каждому устройству — только его конверт. Общий broadcast тут не
            // годится: конверты разные, и отдать устройству чужой означало бы
            // рассылать шифротекст, который оно всё равно не прочитает.
            for (const e of parsed) {
                io.to(`device:${e.deviceId}`).emit('newMessage', {
                    ...base,
                    envelope: {
                        envelope_type: e.type,
                        header: b64(e.header),
                        ciphertext: b64(e.ciphertext),
                    },
                });
            }
        }

        res.json({
            success: true,
            message: base,
            // Устройства чата, для которых конверта не прислали: клиент
            // должен увидеть это и добрать их ключи, иначе там сообщение
            // не прочитается. У группового сообщения конверта нет почти ни у
            // кого (ключ у них уже есть), и кто его прочтёт, знает только
            // отправитель.
            missingDeviceIds: groupPayload ? [] : allowed.filter(d => !seen.has(d.id)).map(d => d.id),
            socketRoomKey,
        });
    } catch (error) {
        if (error.status === 409) {
            return res.status(409).json({ success: false, message: 'Вложение уже отправлено' });
        }
        console.error('Encrypted message error:', error);
        res.status(500).json({ success: false, message: 'Не удалось отправить сообщение' });
    }
});

/**
 * POST /api/sender-keys/ack — устройство забрало конверты с sender key.
 * Удалять можно только адресованное этому устройству.
 */
app.post('/api/sender-keys/ack', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
    if (!req.session.deviceId) return res.status(409).json({ success: false, message: 'Устройство не зарегистрировано' });
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number) : [];
    if (ids.length === 0 || ids.length > MAX_ENVELOPES || !ids.every(id => Number.isInteger(id) && id > 0)) {
        return res.status(400).json({ success: false, message: 'Некорректный список конвертов' });
    }
    try {
        const result = await pool.query(
            'DELETE FROM sender_key_envelopes WHERE id = ANY($1::bigint[]) AND recipient_device_id = $2',
            [ids, req.session.deviceId]
        );
        res.json({ success: true, deleted: result.rowCount });
    } catch (error) {
        console.error('Sender key ack error:', error);
        res.status(500).json({ success: false, message: 'Не удалось подтвердить получение ключей' });
    }
});

app.get('/api/messages/:chatId', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const chatId = req.params.chatId;
    try {
        const chat = await dbGet('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
        if (!chat) return res.json({ success: false, message: 'Чат не найден' });

        const selectParam = chat.room_id || chatId;
        const selectQuery = chat.room_id
            ? `SELECT m.*, u.username as sender_username, u.avatar as sender_avatar,
                      rt.id as reply_to_id, rt.text as reply_to_text, rt.deleted as reply_to_deleted, ru.username as reply_to_sender_username, ru.avatar as reply_to_sender_avatar
               FROM messages m
               JOIN users u ON m.user_id = u.id
               LEFT JOIN messages rt ON m.reply_to_id = rt.id AND rt.room_id = m.room_id
               LEFT JOIN users ru ON rt.user_id = ru.id
               WHERE m.room_id = $1 AND m.deleted = 0
               ORDER BY m.id ASC`
            : `SELECT m.*, u.username as sender_username, u.avatar as sender_avatar,
                      rt.id as reply_to_id, rt.text as reply_to_text, rt.deleted as reply_to_deleted, ru.username as reply_to_sender_username, ru.avatar as reply_to_sender_avatar
               FROM messages m
               JOIN users u ON m.user_id = u.id
               LEFT JOIN messages rt ON m.reply_to_id = rt.id AND rt.chat_id = m.chat_id AND rt.room_id IS NULL
               LEFT JOIN users ru ON rt.user_id = ru.id
               WHERE m.chat_id = $1 AND m.deleted = 0
               ORDER BY m.id ASC`;

        let messages = await dbAll(selectQuery, [selectParam]);

        if (messages.length === 0) {
            const updateQuery = chat.room_id
                ? 'UPDATE messages SET status = $1 WHERE room_id = $2 AND sent = 0'
                : 'UPDATE messages SET status = $1 WHERE chat_id = $2 AND sent = 0';
            await dbRun(updateQuery, ['read', selectParam]);
            return res.json({ success: true, messages: [], chat });
        }

        const messageIds = messages.map(m => m.id);
        const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(',');
        const reactions = await dbAll(
            `SELECT message_id, STRING_AGG(DISTINCT emoji, ',') as emojis FROM reactions WHERE message_id IN (${placeholders}) GROUP BY message_id`,
            messageIds
        );

        const reactionsMap = {};
        reactions.forEach(r => { reactionsMap[r.message_id] = r.emojis.split(','); });

        // Конверты — только адресованные ЭТОМУ устройству. Чужие сервер
        // отдавать не должен: прочитать их устройство всё равно не может,
        // а отдача чужого шифротекста — лишняя утечка без пользы.
        const envelopeMap = {};
        if (req.session.deviceId) {
            const encryptedIds = messages.filter(m => m.encrypted).map(m => m.id);
            if (encryptedIds.length > 0) {
                const envPlaceholders = encryptedIds.map((_, i) => `$${i + 2}`).join(',');
                const envelopes = await dbAll(
                    `SELECT message_id, envelope_type, header, ciphertext, sender_device_id
                     FROM message_envelopes
                     WHERE recipient_device_id = $1 AND message_id IN (${envPlaceholders})`,
                    [req.session.deviceId, ...encryptedIds]
                );
                envelopes.forEach(e => {
                    envelopeMap[e.message_id] = {
                        envelope_type: e.envelope_type,
                        header: e.header.toString('base64'),
                        ciphertext: e.ciphertext.toString('base64'),
                        sender_device_id: e.sender_device_id,
                    };
                });
            }
        }

        // Групповой шифротекст одинаков для всех устройств комнаты.
        const groupMap = {};
        const encryptedMessageIds = messages.filter(m => m.encrypted).map(m => m.id);
        if (encryptedMessageIds.length > 0) {
            const payloads = await dbAll(
                'SELECT message_id, header, ciphertext, signature FROM message_group_payloads WHERE message_id = ANY($1::int[])',
                [encryptedMessageIds]
            );
            payloads.forEach(p => {
                groupMap[p.message_id] = { header: b64(p.header), ciphertext: b64(p.ciphertext), signature: b64(p.signature) };
            });
        }

        // Ещё не забранные этим устройством sender keys этой комнаты. Клиент
        // обрабатывает их ДО сообщений: без ключа групповые не расшифровать.
        let keyEnvelopes = [];
        if (req.session.deviceId && chat.room_id) {
            keyEnvelopes = (await dbAll(
                `SELECT id, sender_user_id, sender_device_id, envelope_type, header, ciphertext
                 FROM sender_key_envelopes
                 WHERE recipient_device_id = $1 AND room_id = $2
                 ORDER BY id ASC`,
                [req.session.deviceId, chat.room_id]
            )).map(e => ({
                id: Number(e.id),
                room_id: chat.room_id,
                sender_user_id: e.sender_user_id,
                sender_device_id: e.sender_device_id,
                envelope_type: e.envelope_type,
                header: b64(e.header),
                ciphertext: b64(e.ciphertext),
            }));
        }

        messages = messages.map(m => ({
            ...m,
            reactions: reactionsMap[m.id] || [],
            group: m.encrypted ? (groupMap[m.id] || null) : undefined,
            // Для зашифрованного сообщения без конверта клиент обязан
            // показать заглушку, а не пустое сообщение: это либо устройство
            // подключили после отправки (историю оно не получает), либо
            // отправитель не прислал конверт для него.
            envelope: m.encrypted ? (envelopeMap[m.id] || null) : undefined,
            reply_to: m.reply_to_id ? { id: m.reply_to_id, text: m.reply_to_text, deleted: Number(m.reply_to_deleted) === 1, sender_username: m.reply_to_sender_username, sender_avatar: m.reply_to_sender_avatar } : null
        }));

        const updateQuery = chat.room_id
            ? 'UPDATE messages SET status = $1 WHERE room_id = $2 AND sent = 0'
            : 'UPDATE messages SET status = $1 WHERE chat_id = $2 AND sent = 0';
        await dbRun(updateQuery, ['read', selectParam]);

        res.json({ success: true, messages, chat, keyEnvelopes });
    } catch (error) {
        console.error('Get messages error:', error);
        res.json({ success: false, message: 'Ошибка загрузки сообщений' });
    }
});

app.post('/api/messages', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const { chatId, text, replyToId, expirySeconds } = req.body;
    if (!text || text.trim() === '' || !chatId) return res.json({ success: false, message: 'Введите текст сообщения' });
    if (text.length > 4000) return res.json({ success: false, message: 'Сообщение не может быть длиннее 4000 символов' });

    try {
        const chat = await dbGet('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
        if (!chat) return res.json({ success: false, message: 'Чат не найден' });
        const reply = await replyTargetFor(chat, replyToId);
        if (reply.error) return res.json({ success: false, message: reply.error });
        const replyTo = reply.id;
        const expiry = expiryFrom(expirySeconds);
        if (expiry === false) return res.json({ success: false, message: 'Недопустимый срок жизни сообщения' });

        const time = getCurrentTime();
        const roomId = chat.room_id || null;
        const socketRoomKey = getSocketRoomKey(chatId, roomId);

        // Очистка текста от опасных метаданных
        const safeText = sanitizeText(text.trim());

        const result = await pool.query(
            'INSERT INTO messages (chat_id, room_id, user_id, text, message_type, sent, time, status, reply_to_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
            [chatId, roomId, req.session.userId, safeText, 'text', 1, time, 'sent', replyTo]
        );
        const messageId = result.rows[0].id;

        // Установка времени жизни сообщения если указано
        if (expiry) {
            await disappearingMessagesManager.setMessageExpiry(messageId, expiry, false);
        } else {
            // Проверка настроек чата на автоудаление
            const chatSettings = await disappearingMessagesManager.getChatSettings(chatId);
            if (chatSettings && chatSettings.default_message_expiry) {
                await disappearingMessagesManager.setMessageExpiry(messageId, chatSettings.default_message_expiry, false);
            }
        }

        const fullMessage = await dbGet(
            'SELECT m.*, u.username, u.avatar as user_avatar FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = $1',
            [messageId]
        );

        const messageForSocket = { ...fullMessage, sender_username: fullMessage.username, sender_avatar: fullMessage.user_avatar };
        io.to(socketRoomKey).emit('newMessage', messageForSocket);
        res.json({ success: true, message: messageForSocket });

        if (chat.is_bot) {
            const botUserId = req.session.userId;
            setTimeout(async () => {
                const stillExists = await dbGet(
                    'SELECT id FROM chats WHERE id = $1 AND user_id = $2 AND is_bot = 1',
                    [chatId, botUserId]
                );
                if (!stillExists) return;

                const botResponses = ['Интересный вопрос! Расскажите подробнее.', 'Я получил ваше сообщение!', 'Хмм, дайте подумать...', 'Отличное сообщение! Продолжайте.', 'Я бот, но стараюсь быть полезным!', 'Можете уточнить, что именно вас интересует?'];
                const randomResponse = botResponses[Math.floor(Math.random() * botResponses.length)];
                const botTime = getCurrentTime();
                try {
                    const botResult = await pool.query(
                        'INSERT INTO messages (chat_id, room_id, user_id, text, sent, time, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
                        [chatId, roomId, botUserId, randomResponse, 0, botTime, 'read']
                    );
                    const botMessageId = botResult.rows[0].id;
                    const botMessage = await dbGet(
                        'SELECT m.*, u.username, u.avatar as user_avatar FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = $1',
                        [botMessageId]
                    );
                    if (botMessage) {
                        io.to(socketRoomKey).emit('newMessage', { ...botMessage, sender_username: botMessage.username, sender_avatar: botMessage.user_avatar });
                    }
                } catch (e) { console.error('Bot error:', e); }
            }, 1500);
        }
    } catch (error) {
        console.error('Send message error:', error);
        res.json({ success: false, message: 'Ошибка отправки' });
    }
});

app.post('/api/chats', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const { name } = req.body;
    if (!name) return res.json({ success: false, message: 'Введите имя чата' });
    if (name.length > 64) return res.json({ success: false, message: 'Название чата не может быть длиннее 64 символов' });

    const avatar = name.charAt(0).toUpperCase();
    try {
        const roomCode = await generateInviteCodeAsync();
        const client = await pool.connect();
        let roomId, chatId;
        try {
            await client.query('BEGIN');
            const roomResult = await client.query('INSERT INTO rooms (name, code) VALUES ($1, $2) RETURNING id', [name, roomCode]);
            roomId = roomResult.rows[0].id;
            await client.query('INSERT INTO room_participants (room_id, user_id) VALUES ($1, $2)', [roomId, req.session.userId]);
            const chatResult = await client.query(
                'INSERT INTO chats (user_id, room_id, name, avatar, online, is_bot) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
                [req.session.userId, roomId, name, avatar, 0, 0]
            );
            chatId = chatResult.rows[0].id;
            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }
        res.json({ success: true, chat: { id: chatId, name, avatar, online: 0, is_bot: 0, room_id: roomId, invite_code: roomCode } });
    } catch (error) {
        console.error('Create chat error:', error);
        res.json({ success: false, message: 'Ошибка создания чата' });
    }
});

/**
 * Системное сообщение в комнате: кто вошёл, кто вышел, кто сменил код.
 * Раньше человек с кодом входил молча, и участники не знали, что их
 * читает ещё кто-то: его устройства получали ключи автоматически.
 * Шифровать тут нечего — сервер эти события и так знает.
 */
async function postSystemMessage({ roomId, chatId, userId, text }) {
    const inserted = await pool.query(
        `INSERT INTO messages (chat_id, room_id, user_id, text, message_type, sent, time, status)
         VALUES ($1, $2, $3, $4, 'system', 0, $5, 'read') RETURNING id`,
        [chatId, roomId, userId, text, getCurrentTime()]
    );
    const message = await dbGet(
        `SELECT m.*, u.username AS sender_username, u.avatar AS sender_avatar
         FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = $1`,
        [inserted.rows[0].id]
    );
    io.to(`room:${roomId}`).emit('newMessage', message);
}

app.get('/api/chats/invite/:chatId', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const chatId = req.params.chatId;
    try {
        const chat = await dbGet('SELECT room_id FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
        if (!chat) return res.json({ success: false, message: 'Чат не найден' });
        if (!chat.room_id) return res.json({ success: false, message: 'У этого чата нет кода приглашения' });
        const room = await dbGet('SELECT code FROM rooms WHERE id = $1', [chat.room_id]);
        if (!room) return res.json({ success: false, message: 'Код не найден' });
        // code: null — приглашение отключено.
        res.json({ success: true, code: room.code });
    } catch (error) {
        res.json({ success: false, message: 'Ошибка получения кода' });
    }
});

/**
 * Сменить код приглашения ({ action: 'reset' }) или отключить приглашение
 * ({ action: 'disable' }). Утёкший код иначе действовал бы вечно. Может
 * любой участник — ролей в комнате нет, — и все видят, кто это сделал.
 */
app.post('/api/chats/:chatId/invite', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const action = req.body && req.body.action;
    if (action !== 'reset' && action !== 'disable') {
        return res.status(400).json({ success: false, message: 'Неизвестное действие' });
    }
    try {
        const chat = await dbGet('SELECT id, room_id FROM chats WHERE id = $1 AND user_id = $2', [req.params.chatId, req.session.userId]);
        if (!chat || !chat.room_id) return res.json({ success: false, message: 'Чат не найден' });
        const code = action === 'reset' ? await generateInviteCodeAsync() : null;
        await dbRun('UPDATE rooms SET code = $1 WHERE id = $2', [code, chat.room_id]);
        const user = await dbGet('SELECT username FROM users WHERE id = $1', [req.session.userId]);
        await postSystemMessage({
            roomId: chat.room_id, chatId: chat.id, userId: req.session.userId,
            text: `${user.username} ${code ? 'сменил(а) код приглашения' : 'отключил(а) приглашение'}`,
        });
        res.json({ success: true, code });
    } catch (error) {
        console.error('Invite update error:', error);
        res.json({ success: false, message: 'Не удалось изменить приглашение' });
    }
});

app.post('/api/chats/join', joinLimiter, async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    // Код вводят руками и копируют из переписки: регистр, пробелы и дефисы
    // («k7q2 mx», «K7Q-2MX») не должны мешать.
    const code = String((req.body && req.body.code) || '').toUpperCase().replace(/[\s-]/g, '');
    if (!code) return res.json({ success: false, message: 'Введите код приглашения' });

    try {
        const room = await dbGet('SELECT * FROM rooms WHERE code = $1', [code]);
        if (!room) return res.json({ success: false, message: 'Чат по этому коду не найден' });

        const participant = await dbGet('SELECT id FROM room_participants WHERE room_id = $1 AND user_id = $2', [room.id, req.session.userId]);
        if (participant) {
            res.locals.joined = true;
            const chat = await dbGet('SELECT id FROM chats WHERE room_id = $1 AND user_id = $2', [room.id, req.session.userId]);
            if (!chat) return res.json({ success: false, message: 'Чат уже добавлен' });
            return res.json({ success: true, chat: { id: chat.id } });
        }

        const otherUser = await dbGet('SELECT u.username FROM users u JOIN room_participants rp ON u.id = rp.user_id WHERE rp.room_id = $1 AND u.id != $2 LIMIT 1', [room.id, req.session.userId]);
        const chatName = otherUser ? `Чат с ${otherUser.username}` : room.name;
        const avatar = chatName.charAt(0).toUpperCase();

        await pool.query('INSERT INTO room_participants (room_id, user_id) VALUES ($1, $2)', [room.id, req.session.userId]);
        const chatResult = await pool.query(
            'INSERT INTO chats (user_id, room_id, name, avatar, online, is_bot) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [req.session.userId, room.id, chatName, avatar, 0, 0]
        );
        res.locals.joined = true;
        const me = await dbGet('SELECT username FROM users WHERE id = $1', [req.session.userId]);
        await postSystemMessage({
            roomId: room.id, chatId: chatResult.rows[0].id, userId: req.session.userId,
            text: `${me.username} вошёл(ла) в чат по коду приглашения`,
        });
        res.json({ success: true, chat: { id: chatResult.rows[0].id, name: chatName, avatar, online: 0, is_bot: 0, room_id: room.id, invite_code: room.code } });
    } catch (error) {
        console.error('Join chat error:', error);
        res.json({ success: false, message: 'Ошибка входа в чат' });
    }
});

app.delete('/api/chats/:chatId', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const chatId = req.params.chatId;
    try {
        const chat = await dbGet('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
        if (!chat) return res.json({ success: false, message: 'Чат не найден' });

        if (chat.room_id) {
            await dbRun('DELETE FROM room_participants WHERE room_id = $1 AND user_id = $2', [chat.room_id, req.session.userId]);
            // Ключи группы, которые ушедший так и не забрал, ему больше не
            // нужны. Остальные участники сменят свои sender keys при
            // следующей отправке: клиент видит, что устройство пропало.
            await dbRun(
                `DELETE FROM sender_key_envelopes WHERE room_id = $1
                 AND recipient_device_id IN (SELECT id FROM devices WHERE user_id = $2)`,
                [chat.room_id, req.session.userId]
            );
            const remaining = await dbGet('SELECT COUNT(*) as cnt FROM room_participants WHERE room_id = $1', [chat.room_id]);
            if (remaining && Number(remaining.cnt) > 0) {
                const me = await dbGet('SELECT username FROM users WHERE id = $1', [req.session.userId]);
                await postSystemMessage({
                    roomId: chat.room_id, chatId: null, userId: req.session.userId,
                    text: `${me.username} вышел(ла) из чата`,
                });
            }
            await dbRun('DELETE FROM unread WHERE chat_id = $1', [chatId]);
            await dbRun('DELETE FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
            if (!remaining || Number(remaining.cnt) === 0) {
                // Последний участник вышел — сносим комнату целиком.
                await dbRun('DELETE FROM messages WHERE room_id = $1', [chat.room_id]);
                await dbRun('DELETE FROM rooms WHERE id = $1', [chat.room_id]);
            }
            // Если участники остались — историю не трогаем, она у них
            // по-прежнему доступна по room_id (chat_id этого сообщения,
            // если оно было отправлено уходящим, просто станет NULL).
        } else {
            await dbRun('DELETE FROM messages WHERE chat_id = $1', [chatId]);
            await dbRun('DELETE FROM unread WHERE chat_id = $1', [chatId]);
            await dbRun('DELETE FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
        }
        // Сокеты этого пользователя больше не должны получать сообщения чата.
        io.in(`user:${req.session.userId}`).socketsLeave(
            chat.room_id ? [`room:${chat.room_id}`, `chat:${chat.id}`] : [`chat:${chat.id}`]);
        res.json({ success: true });
    } catch (error) {
        console.error('Delete chat error:', error);
        res.json({ success: false, message: 'Ошибка удаления чата' });
    }
});

app.put('/api/messages/:messageId', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const { messageId } = req.params;
    const { text } = req.body;
    if (!text || text.trim() === '') return res.json({ success: false, message: 'Текст не может быть пустым' });
    if (text.length > 4000) return res.json({ success: false, message: 'Сообщение не может быть длиннее 4000 символов' });

    try {
        const message = await dbGet('SELECT * FROM messages WHERE id = $1 AND user_id = $2', [messageId, req.session.userId]);
        if (!message) return res.json({ success: false, message: 'Сообщение не найдено' });
        // Правка шла бы открытым текстом: этот эндпоинт кладёт новый текст в
        // messages.text и рассылает его всем. Для зашифрованного сообщения
        // это означало бы выложить на сервер то, что было зашифровано.
        if (message.encrypted) {
            return res.status(409).json({ success: false, message: 'Зашифрованные сообщения нельзя редактировать' });
        }
        const editedAt = new Date().toISOString();
        const trimmedText = text.trim();
        await dbRun('UPDATE messages SET text = $1, edited_at = $2 WHERE id = $3', [trimmedText, editedAt, messageId]);

        // Раньше правки не рассылались по сокету — у остальных участников
        // комнаты изменение не появлялось без перезагрузки (см. "Мелочи").
        const socketRoomKey = getSocketRoomKey(message.chat_id, message.room_id);
        io.to(socketRoomKey).emit('messageEdited', {
            id: Number(messageId), text: trimmedText, edited_at: editedAt,
            chat_id: message.chat_id, room_id: message.room_id
        });

        res.json({ success: true, edited_at: editedAt });
    } catch (error) {
        res.json({ success: false, message: 'Ошибка редактирования' });
    }
});

app.delete('/api/messages/:messageId', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const { messageId } = req.params;
    try {
        const message = await dbGet('SELECT * FROM messages WHERE id = $1 AND user_id = $2', [messageId, req.session.userId]);
        if (!message) return res.json({ success: false, message: 'Сообщение не найдено' });
        await dbRun('UPDATE messages SET deleted = 1 WHERE id = $1', [messageId]);
        await purgeMessageContent(message.id);

        const socketRoomKey = getSocketRoomKey(message.chat_id, message.room_id);
        io.to(socketRoomKey).emit('messageDeleted', {
            id: Number(messageId), chat_id: message.chat_id, room_id: message.room_id
        });

        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, message: 'Ошибка удаления' });
    }
});
/**
 * Имя файла из multipart. Браузер присылает его в UTF-8, а multer (busboy)
 * читает как latin1 — русские имена превращались в «Ð·Ð°Ð¼ÐµÑ…». Если после
 * перекодировки получается некорректный UTF-8, значит имя и было latin1 —
 * оставляем как есть.
 */
function decodeUploadName(name) {
    const utf8 = Buffer.from(String(name || ''), 'latin1').toString('utf8');
    return utf8.includes('\uFFFD') ? String(name || '') : utf8;
}

// multer(upload.single('file')) уже записал файл на диск ДО этого хендлера —
// значит, ранние return (401/400/404) должны сами убирать за собой, иначе
// каждая неудачная/подделанная попытка загрузки будет накапливать файлы-сироты.
function cleanupUploadedFile(file) {
    if (!file) return;
    try {
        const p = path.join(__dirname, 'uploads', file.filename);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) { /* ignore */ }
}

app.post('/api/messages/file', upload.single('file'), async (req, res) => {
    if (!req.session.userId) {
        cleanupUploadedFile(req.file);
        return res.status(401).json({ success: false, message: 'Не авторизован' });
    }
    const { chatId, text } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ success: false, message: 'Файл не выбран' });
    if (!chatId) {
        cleanupUploadedFile(file);
        return res.status(400).json({ success: false, message: 'Указан чат' });
    }

    const uploadedFilePath = path.join(__dirname, 'uploads', file.filename);
    try {
        // Тип — по всему содержимому, а не по первым байтам: text/plain
        // раньше не проверялся вовсе, и JPEG с координатами, названный
        // .txt, уходил мимо очистки. Видео MP4/MOV/3GP — один контейнер, и
        // расхождение внутри семейства не считается подменой.
        const detected = fileTypes.detectType(await fs.promises.readFile(uploadedFilePath));
        const sameFamily = detected === file.mimetype
            || (fileTypes.ISO_BMFF_TYPES.has(detected) && fileTypes.ISO_BMFF_TYPES.has(file.mimetype));
        if (!sameFamily) {
            fs.unlinkSync(uploadedFilePath);
            return res.status(400).json({ success: false, message: 'Содержимое файла не соответствует его типу' });
        }

        // Удаление метаданных из файла для защиты приватности. Не удалось —
        // файл не отправляется: молча раздать фото с координатами хуже,
        // чем не отправить его вовсе.
        if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf'
            || fileTypes.ISO_BMFF_TYPES.has(file.mimetype)) {
            try {
                await stripMetadataFromFile(uploadedFilePath, file.mimetype);
            } catch (stripErr) {
                console.error('Metadata strip error:', stripErr.message);
                try { if (fs.existsSync(uploadedFilePath)) fs.unlinkSync(uploadedFilePath); } catch (_) { /* ignore */ }
                // У PDF причина бывает двух видов — защищён паролем или
                // повреждён, — и советы для них разные.
                return res.status(400).json({ success: false, message: stripErr.name === 'PdfCleanError'
                    ? `Файл не отправлен: ${stripErr.message}`
                    : 'Не удалось удалить метаданные из файла — он не отправлен' });
            }
        }
    } catch (magicErr) {
        // Раньше при исключении здесь проверка молча пропускалась и файл
        // проходил дальше — теоретическая лазейка мимо проверки типа файла.
        // Теперь любая ошибка проверки = отказ (fail closed), а не fail open.
        console.error('Magic bytes check error:', magicErr);
        try { if (fs.existsSync(uploadedFilePath)) fs.unlinkSync(uploadedFilePath); } catch (_) { /* ignore */ }
        return res.status(400).json({ success: false, message: 'Не удалось проверить содержимое файла' });
    }

    try {
        const chat = await dbGet('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
        if (!chat) {
            cleanupUploadedFile(file);
            return res.status(404).json({ success: false, message: 'Чат не найден' });
        }

        const time = getCurrentTime();
        const roomId = chat.room_id || null;
        const socketRoomKey = getSocketRoomKey(chatId, roomId);
        const fileUrl = `/uploads/${file.filename}`;
        const fileType = file.mimetype;
        // Имя фото и видео выдаёт дату, время и приложение — оно
        // заменяется нейтральным; имя документа остаётся (см. filetypes.js).
        const sanitizedFileName = fileTypes.attachmentName(fileType, path.basename(decodeUploadName(file.originalname)))
            .slice(0, 200).replace(/[<>&"']/g, '');

        const messageType = fileType.startsWith('image/') ? 'image' : fileType.startsWith('video/') ? 'video' : 'file';
        const messageText = text ? String(text).trim() : sanitizedFileName;

        const result = await pool.query(
            'INSERT INTO messages (chat_id, room_id, user_id, text, file_url, file_name, file_type, message_type, sent, time, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, created_at',
            [chatId, roomId, req.session.userId, messageText, fileUrl, sanitizedFileName, fileType, messageType, 1, time, 'sent']
        );
        const messageId = result.rows[0].id;
        const createdAt = result.rows[0].created_at;

        const senderUser = await dbGet('SELECT username, avatar FROM users WHERE id = $1', [req.session.userId]);
        const senderUsername = senderUser ? senderUser.username : '';
        const senderAvatar = senderUser ? (senderUser.avatar || '') : '';

        setTimeout(() => dbRun('UPDATE messages SET status = $1 WHERE id = $2', ['delivered', messageId]), 1000);
        setTimeout(() => dbRun('UPDATE messages SET status = $1 WHERE id = $2', ['read', messageId]), 2000);

        const fileMessage = {
            id: messageId, chat_id: Number(chatId), room_id: roomId, user_id: req.session.userId,
            sender_username: senderUsername, sender_avatar: senderAvatar,
            text: messageText, file_url: fileUrl, file_name: sanitizedFileName,
            file_type: fileType, message_type: messageType, sent: true, time, status: 'sent',
            // Без него получатель не знал дня и показывал время сервера.
            created_at: createdAt,
        };
        io.to(socketRoomKey).emit('newMessage', fileMessage);
        res.json({ success: true, message: fileMessage });
    } catch (error) {
        console.error('Upload file error:', error);
        res.status(500).json({ success: false, message: 'Ошибка отправки файла' });
    }
});

async function userCanAccessMessage(userId, messageId) {
    // LEFT JOIN, не INNER JOIN (см. п.3 аудита): если автор сообщения вышел
    // из групповой комнаты, его персональная строка в chats удаляется и
    // m.chat_id уходит в NULL (ON DELETE SET NULL). INNER JOIN на chats
    // тогда терял строку сообщения целиком, и функция возвращала false для
    // абсолютно любого пользователя — файл переставал открываться вообще
    // всем, включая оставшихся участников комнаты. m.room_id при этом всегда
    // записан прямо на сообщении в момент отправки (см. /api/messages,
    // /api/messages/file) и не зависит от того, жива ли ещё запись chats
    // автора, поэтому для групповых чатов JOIN для доступа не обязателен.
    const row = await dbGet(
        `SELECT m.room_id, c.room_id AS chat_room_id, c.user_id AS chat_owner_id
         FROM messages m
         LEFT JOIN chats c ON m.chat_id = c.id
         WHERE m.id = $1`,
        [messageId]
    );
    if (!row) return false;
    const roomId = row.room_id || row.chat_room_id;
    if (!roomId) {
        // Не групповой (1:1) чат — доступ только у владельца самой записи
        // chats. Если chat_id уже NULL, значит запись chats удалена вместе
        // со всем DM-чатом (см. DELETE /api/chats/:chatId, ветка без
        // room_id — там messages удаляются явно перед чатом), и доступа ни
        // у кого больше нет.
        return row.chat_owner_id != null && row.chat_owner_id === userId;
    }
    const participant = await dbGet(
        'SELECT id FROM room_participants WHERE room_id = $1 AND user_id = $2',
        [roomId, userId]
    );
    return Boolean(participant);
}

// Файлы отдаются только тому, кто реально является участником чата/комнаты,
// к которому относится сообщение с этим файлом — а не просто "залогинен ли
// кто-то вообще" (см. п.1 аудита). Имя файла уникально (Date.now() + random),
// поэтому джойн messages.file_url -> chats/room_participants однозначно
// определяет владельца.
// В UI предлагается фиксированный набор из 5 эмодзи для реакций. Раньше на
// бэке проверялась только длина строки (≤10 символов), а не содержимое — это
// пропускало вход в message.reactions, который на фронте рендерится в
// innerHTML без escapeHtml (см. п.3 аудита). Теперь бэк принимает только
// эмодзи из этого списка.
const ALLOWED_REACTION_EMOJIS = new Set(['👍', '❤️', '😂', '😢', '🔥']);

async function userCanAccessFile(userId, filename) {
    const fileUrl = `/uploads/${filename}`;
    // Файл удалённого сообщения не отдаётся никому, даже если он ещё не
    // успел исчезнуть с диска.
    const message = await dbGet('SELECT id FROM messages WHERE file_url = $1 AND deleted = 0 LIMIT 1', [fileUrl]);
    if (!message) return false;
    return userCanAccessMessage(userId, message.id);
}

app.post('/api/reactions', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const { messageId, emoji } = req.body;
    if (!messageId || !emoji) return res.json({ success: false, message: 'Параметры отсутствуют' });
    if (typeof emoji !== 'string' || !ALLOWED_REACTION_EMOJIS.has(emoji)) return res.json({ success: false, message: 'Недопустимый emoji' });

    try {
        if (!(await userCanAccessMessage(req.session.userId, messageId))) {
            return res.json({ success: false, message: 'Сообщение недоступно' });
        }
        await pool.query('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [messageId, req.session.userId, emoji]);
        res.json({ success: true });
    } catch (error) {
        console.error('Add reaction error:', error);
        res.json({ success: false, message: 'Ошибка добавления реакции' });
    }
});

app.delete('/api/reactions/:messageId/:emoji', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const messageId = Number(req.params.messageId);
    const emoji = decodeURIComponent(req.params.emoji);
    if (!Number.isFinite(messageId) || !ALLOWED_REACTION_EMOJIS.has(emoji)) {
        return res.json({ success: false, message: 'Недопустимые параметры' });
    }

    try {
        if (!(await userCanAccessMessage(req.session.userId, messageId))) {
            return res.json({ success: false, message: 'Сообщение недоступно' });
        }
        await dbRun(
            'DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
            [messageId, req.session.userId, emoji]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Remove reaction error:', error);
        res.json({ success: false, message: 'Ошибка удаления реакции' });
    }
});

app.get('/api/search', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const query = req.query.q || '';
    // results всегда объект с chats: раньше на пустой запрос отдавался массив,
    // и форма ответа отличалась от успешного случая.
    if (!query || query.length < 1) return res.json({ success: true, results: { chats: [] } });
    if (query.length > 100) return res.json({ success: false, message: 'Запрос слишком длинный' });

    const safeTerm = query.replace(/[%_\\]/g, '\\$&');
    const searchTerm = `%${safeTerm}%`;
    try {
        // Ищем только по названиям чатов.
        //
        // Поиск по тексту сообщений убран намеренно и окончательно: он делал
        // `m.text ILIKE` на сервере, то есть требовал, чтобы сервер читал
        // переписку. Это прямо противоречит E2EE, к которому идёт проект, —
        // после включения шифрования сервер увидит только шифротекст, и
        // такой запрос перестанет находить что-либо в принципе.
        //
        // Клиент эти результаты и так никогда не показывал: performSearch()
        // рендерит только results.chats, а results.messages выбрасывал. То
        // есть запрос выполнялся на каждое нажатие клавиши (debounce 300 мс)
        // впустую.
        //
        // Если поиск по сообщениям понадобится снова, единственный
        // совместимый с E2EE вариант — индекс на клиенте, по расшифрованным
        // у него же сообщениям. Серверная реализация возможна только за счёт
        // отказа от шифрования.
        const chats = await dbAll('SELECT id, name, avatar FROM chats WHERE user_id = $1 AND name ILIKE $2 LIMIT 10', [req.session.userId, searchTerm]);
        res.json({ success: true, results: { chats } });
    } catch (error) {
        res.json({ success: false, message: 'Ошибка поиска' });
    }
});

// API для disappearing messages
app.post('/api/messages/:messageId/set-expiry', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const messageId = Number(req.params.messageId);
    const { expirySeconds, autoDeleteOnRead } = req.body;

    if (!Number.isFinite(messageId) || normalizeExpiry(expirySeconds) === null) {
        return res.json({ success: false, message: 'Неверные параметры' });
    }

    try {
        // Проверка доступа к сообщению
        const message = await dbGet('SELECT user_id FROM messages WHERE id = $1', [messageId]);
        if (!message || message.user_id !== req.session.userId) {
            return res.json({ success: false, message: 'Сообщение не найдено или нет доступа' });
        }

        await disappearingMessagesManager.setMessageExpiry(
            messageId,
            expirySeconds,
            autoDeleteOnRead || false
        );

        res.json({ success: true, message: 'Таймер самоуничтожения установлен' });
    } catch (error) {
        console.error('Set expiry error:', error);
        res.json({ success: false, message: 'Ошибка установки таймера' });
    }
});

app.post('/api/chats/:chatId/set-default-expiry', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const chatId = Number(req.params.chatId);
    const { expirySeconds } = req.body;

    if (!Number.isFinite(chatId) || (Number(expirySeconds) !== 0 && normalizeExpiry(expirySeconds) === null)) {
        return res.json({ success: false, message: 'Неверные параметры' });
    }

    try {
        // Проверка доступа к чату
        const chat = await dbGet('SELECT id FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
        if (!chat) {
            return res.json({ success: false, message: 'Чат не найден' });
        }

        await disappearingMessagesManager.setChatDefaultExpiry(chatId, expirySeconds);

        res.json({ success: true, message: 'Автоудаление сообщений настроено для чата' });
    } catch (error) {
        console.error('Set chat default expiry error:', error);
        res.json({ success: false, message: 'Ошибка настройки автоудаления' });
    }
});

app.get('/api/chats/:chatId/settings', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const chatId = Number(req.params.chatId);

    try {
        const chat = await dbGet('SELECT id FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
        if (!chat) {
            return res.json({ success: false, message: 'Чат не найден' });
        }

        const settings = await disappearingMessagesManager.getChatSettings(chatId);
        res.json({ success: true, settings: settings || {} });
    } catch (error) {
        console.error('Get chat settings error:', error);
        res.json({ success: false, message: 'Ошибка получения настроек' });
    }
});

app.post('/api/change-password', passwordLimiter, async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmPassword) return res.json({ success: false, message: 'Заполните все поля' });
    if (newPassword !== confirmPassword) return res.json({ success: false, message: 'Новые пароли не совпадают' });
    if (newPassword.length < 8) return res.json({ success: false, message: 'Пароль должен быть не менее 8 символов' });
    if (newPassword.length > 128 || currentPassword.length > 128) {
        return res.json({ success: false, message: 'Пароль не может быть длиннее 128 символов' });
    }

    try {
        const user = await dbGet('SELECT password FROM users WHERE id = $1', [req.session.userId]);
        if (!user) return res.json({ success: false, message: 'Пользователь не найден' });
        if (!user.password) return res.json({ success: false, message: 'У этого аккаунта нет пароля (приватный режим)' });
        const validPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validPassword) return res.json({ success: false, message: 'Неверный текущий пароль' });
        const hashedPassword = await bcrypt.hash(newPassword, 12);
        const userId = req.session.userId;

        await dbRun('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);
        // Пароль меняют чаще всего, когда он утёк. Значит, выйти надо везде:
        // сессия, открытая по старому паролю, иначе живёт до истечения срока.
        await dbRun(`DELETE FROM "session" WHERE sess->>'userId' = $1`, [String(userId)]);
        disconnectSockets(`user:${userId}`);

        req.session.destroy((err) => {
            res.clearCookie('connect.sid');
            if (err) console.error('Session destroy error on password change:', err);
            res.json({ success: true, message: 'Пароль успешно изменён. Войдите заново.' });
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.json({ success: false, message: 'Ошибка изменения пароля' });
    }
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ success: false, message: 'Файл слишком большой (макс. 50 МБ)' });
        }
        return res.status(400).json({ success: false, message: `Ошибка загрузки: ${err.message}` });
    }
    if (err.message === 'Неподдерживаемый тип файла') {
        return res.status(400).json({ success: false, message: 'Этот тип файла не поддерживается: можно фото, видео, PDF и текст' });
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ success: false, message: 'Внутренняя ошибка сервера' });
});

server.listen(PORT, HOST, async () => {
    const addresses = getLocalAddresses();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Nyxo Messenger запущен на порту ${PORT}`);
    console.log(`${'='.repeat(60)}\n`);

    if (addresses.length > 0) {
        console.log('Доступен по адресам:');
        addresses.forEach(addr => console.log(`  → http://${addr}:${PORT}`));
        console.log('');
    }

    // Проверка Tor подключения
    if (ENABLE_TOR_ROUTING) {
        console.log('Проверка Tor подключения...');
        const torStatus = await checkTorConnection();
        if (torStatus.available && torStatus.isTor) {
            console.log('✓ Tor успешно подключен');
            console.log(`  IP через Tor: ${torStatus.ip}`);

            const hiddenServiceConfig = getTorHiddenServiceConfig();
            console.log('\nДля настройки Hidden Service добавьте в torrc:');
            console.log(hiddenServiceConfig.hiddenServiceConfig);
        } else {
            console.warn('⚠ Tor не доступен:', torStatus.message);
            console.warn('  Сервер работает без Tor routing');
        }
        console.log('');
    }

    // Фоновая уборка файлов, на которые не ссылается ни одно сообщение.
    const sweepUploads = () => sweepOrphanUploads(UPLOADS_DIR, { dbAll, ttlMs: ORPHAN_UPLOAD_TTL_MS })
        .catch(error => console.error('Uploads sweep error:', error.message));
    setInterval(sweepUploads, ORPHAN_UPLOAD_TTL_MS).unref();

    console.log('Функции безопасности:');
    console.log('  ✓ CSRF Protection');
    console.log('  ✓ Rate Limiting');
    console.log('  ✓ Metadata Stripping');
    console.log('  ✓ Disappearing Messages');
    console.log('  ✓ Enhanced Privacy Headers');
    console.log('  ✓ Timing Attack Protection');
    if (ENABLE_TOR_ROUTING) console.log('  ✓ Tor Hidden Service Support');
    console.log(`\n${'='.repeat(60)}\n`);
});
