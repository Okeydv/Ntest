require('dotenv').config();

/*
 * Nyxo: HTTP-сервер и сборка приложения. Здесь — общий порядок обработки
 * запроса (номер запроса, CSRF, заголовки, сессия, статика) и запуск.
 * Сами маршруты — в routes/, общие части — в lib/.
 */

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const pgSession = require('connect-pg-simple')(session);
const cookieParser = require('cookie-parser');

const { log, requestContext } = require('./lib/log');
const { pool, dbGet, dbAll, dbRun, maybeDumpCa } = require('./lib/db');
const { migrate } = require('./lib/migrate');
const { secureCookieFor, sessionCookieSecurity } = require('./lib/cookie-security');
const { sweepOrphanUploads } = require('./lib/upload-sweeper');
const DisappearingMessagesManager = require('./lib/disappearing-messages');
const { getPrivacyHeaders } = require('./lib/privacy');
const { resolveRealIp, isAllowedOrigin, getLocalAddresses } = require('./lib/client-ip');
const { apiLimiter } = require('./lib/rate-limits');
const { getSocketRoomKey } = require('./lib/helpers');
const { UPLOADS_DIR, ORPHAN_UPLOAD_TTL_MS, purgeMessageContent } = require('./lib/storage');
const { createSocketServer } = require('./lib/sockets');
const e2eeProxy = require('./lib/e2ee-proxy');
const { createDevicesRouter } = require('./lib/devices');
const {
    checkTorConnection,
    getTorHiddenServiceConfig,
    torConnectionLogger,
    ENABLE_TOR_ROUTING
} = require('./lib/tor-support');

const ROOT = __dirname;

// Забытый .catch где угодно не должен ронять весь сервер: такой отказ
// пишется в журнал, и работа продолжается.
process.on('unhandledRejection', reason => {
    log.error({ err: reason }, 'unhandledRejection');
});

const app = express();

// Название фреймворка наружу ни к чему: это подсказка, какие уязвимости
// пробовать.
app.disable('x-powered-by');

app.set('trust proxy', 1);

// Номер запроса. Уходит клиенту в X-Request-Id, а в ответах 5xx — ещё и
// полем errorId: клиент показывает его человеку как код ошибки. Этот же
// номер сам попадает в каждую запись журнала, сделанную по ходу запроса
// (lib/log.js), так что по коду из жалобы находится нужная строка.
// Свой номер от клиента не принимаем: он бы выбирал, что писать в журнал.
app.use((req, res, next) => {
    req.id = crypto.randomBytes(6).toString('hex');
    res.set('X-Request-Id', req.id);
    const json = res.json.bind(res);
    res.json = body => {
        if (res.statusCode >= 500 && body && body.success === false && !body.errorId) {
            body = { ...body, errorId: req.id };
        }
        return json(body);
    };
    const started = process.hrtime.bigint();
    res.on('finish', () => {
        // Маршрут шаблоном (/api/messages/:chatId), а не адресом: в адресе
        // id чатов и пользователей.
        const entry = {
            reqId: req.id,
            method: req.method,
            route: req.route ? req.baseUrl + req.route.path : undefined,
            status: res.statusCode,
            ms: Number((process.hrtime.bigint() - started) / 1000000n),
        };
        if (res.statusCode >= 500) log.warn(entry, 'ответ с ошибкой сервера');
        else log.debug(entry, 'запрос');
    });
    requestContext.run({ reqId: req.id }, next);
});

// id чата и сообщения — положительные int4. Всё остальное (буквы, 0,
// числа за 2^31) раньше доходило до базы и падало там ошибкой 500.
const isDbId = value => /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647;

for (const name of ['chatId', 'messageId']) {
    app.param(name, (req, res, next, value) => (isDbId(value)
        ? next()
        : res.status(404).json({ success: false, message: 'Не найдено' })));
}

// Для балансировщика и мониторинга: отвечает ли база и сервер ключей.
// Стоит до сессий, чтобы проверка не создавала их в базе.
app.get('/healthz', async (req, res) => {
    const db = await Promise.race([
        pool.query('SELECT 1').then(() => true, () => false),
        new Promise(resolve => setTimeout(resolve, 2000, false).unref()),
    ]);
    const keyServer = await e2eeProxy.keyServerHealthy();
    res.status(db && keyServer ? 200 : 503).json({ ok: db && keyServer, db, keyServer });
});

app.use((req, res, next) => {
    // req.ip уже учитывает 1 доверенный хоп (trust proxy = 1), то есть это IP,
    // который реально подключился к Railway — Cloudflare edge, если трафик шёл
    // через CF, либо настоящий IP клиента, если Railway-домен открыт напрямую.
    req.realIp = resolveRealIp(req.headers, req.ip);
    next();
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
        log.warn('SSL сертификаты не найдены. Запуск HTTP сервера.');
        server = http.createServer(app);
    }
}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function initDatabase() {
    await maybeDumpCa().catch(err => { log.error({ err: err }, '[DUMP_CA] Ошибка'); process.exit(1); });

    // Схема — в migrations/, каждая миграция применяется один раз (lib/migrate.js).
    await migrate(pool, { log });

    // Уборка исчезающих сообщений — после миграций: ей нужны их таблицы.
    ctx.disappearingMessagesManager = new DisappearingMessagesManager(pool, {
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
    await ctx.disappearingMessagesManager.initialize();

    log.info('База данных инициализирована');
}

// Порт открывается только после миграций: раньше сервер принимал запросы
// сразу, и первые из них падали с 500 на ещё не созданных таблицах.
const databaseReady = initDatabase().catch(err => {
    log.error({ err: err }, 'Ошибка инициализации БД');
    process.exit(1);
});

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
// Общее для маршрутов, которое не импортируется напрямую: сокеты, уборщик
// исчезающих сообщений (появляется после миграций) и функции, которыми
// маршруты разных файлов пользуются друг у друга.
const io = createSocketServer(server, { sessionMiddleware });
const ctx = { io, disappearingMessagesManager: null };

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

    // Второй рубеж, кроме токена: изменяющий запрос с чужого сайта. Браузер
    // присылает Origin (и Sec-Fetch-Site) сам, подделать их страница не может.
    // Без Origin — не браузер, это решает токен.
    if (!isAllowedOrigin(req) || req.headers['sec-fetch-site'] === 'cross-site') {
        return res.status(403).json({ success: false, message: 'Запрещено: запрос с чужого сайта' });
    }

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
app.use(express.static(path.join(ROOT, 'public')));

// pdf-lib для браузера: в зашифрованном чате метаданные PDF снимает
// отправитель, до шифрования. Сборка самодостаточная (без импортов), а
// отдаётся со своего origin, потому что CSP разрешает скрипты только
// отсюда. Клиент подгружает её лишь тогда, когда прикладывают PDF.
const PDF_LIB_BROWSER = path.join(ROOT, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.esm.min.js');

app.get('/vendor/pdf-lib.esm.min.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('application/javascript').sendFile(PDF_LIB_BROWSER);
});

// QR-код для сверки ключей: рисует qrcode-generator, распознаёт jsQR (там,
// где у браузера нет своего BarcodeDetector). Тоже со своего origin и
// только когда открывают сверку.
const QR_VENDOR = {
    '/vendor/qrcode.js': path.join(ROOT, 'node_modules', 'qrcode-generator', 'qrcode.js'),
    '/vendor/jsqr.js': path.join(ROOT, 'node_modules', 'jsqr', 'dist', 'jsQR.js'),
};

for (const [route, file] of Object.entries(QR_VENDOR)) {
    app.get(route, (req, res) => {
        res.set('Cache-Control', 'public, max-age=86400');
        res.type('application/javascript').sendFile(file);
    });
}

app.get('/link.my', (req, res) => {
    serveIndexWithNonce(req, res);
});

function serveIndexWithNonce(req, res) {
    const nonce = res.locals.cspNonce || '';
    const indexPath = path.join(ROOT, 'public', 'index.html');
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
    // Всем открытым сокетам аккаунта — и тем, что на других устройствах.
    onDeviceAdded: (userId, device) => io.to(`user:${userId}`).emit('deviceAdded', {
        id: device.id, name: device.name, created_at: device.created_at,
    }),
}));

// Ключи собеседника — только при общем чате (см. requirePeer в e2ee-proxy).
e2eeProxy.setPeerCheck(async (userId, otherUserId) => Boolean(await dbGet(
    `SELECT 1 FROM room_participants mine
     JOIN room_participants theirs ON theirs.room_id = mine.room_id
     WHERE mine.user_id = $1 AND theirs.user_id = $2 LIMIT 1`,
    [userId, otherUserId])));
app.use(e2eeProxy.router);

Object.assign(ctx, require('./routes/auth')(app, ctx));
Object.assign(ctx, require('./routes/chats')(app, ctx));
Object.assign(ctx, require('./routes/messages')(app, ctx));
Object.assign(ctx, require('./routes/files')(app, ctx));
require('./routes/link')(app, ctx);

// security.txt (RFC 9116): куда сообщать об уязвимостях. Адрес — из
// SECURITY_CONTACT; не задан — файла нет.
app.get('/.well-known/security.txt', (req, res, next) => {
    const contact = process.env.SECURITY_CONTACT;
    if (!contact) return next();
    const expires = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
    res.type('text/plain').send(`Contact: ${contact}\nExpires: ${expires}\nPreferred-Languages: ru, en\n`);
});

// Всё, чего нет, — один и тот же ответ, без страницы Express «Cannot GET»,
// по которой видно фреймворк. Для API — JSON, для остального — страница.
app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ success: false, message: 'Не найдено' });
    res.status(404).type('text/html').send('<!doctype html><meta charset="utf-8"><title>Не найдено</title><p>Не найдено</p>');
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
    log.error({ err }, 'Unhandled error');
    res.status(500).json({ success: false, message: 'Внутренняя ошибка сервера' });
});

databaseReady.then(() => server.listen(PORT, HOST, async () => {
    log.info({ port: PORT, addresses: getLocalAddresses().map(addr => `http://${addr}:${PORT}`) }, 'Nyxo запущен');

    if (ENABLE_TOR_ROUTING) {
        const torStatus = await checkTorConnection();
        if (torStatus.available && torStatus.isTor) {
            log.info('Tor подключён');
            // Подсказка для torrc — человеку, а не в журнал.
            process.stderr.write(`\nДля скрытого сервиса добавьте в torrc:\n${getTorHiddenServiceConfig().hiddenServiceConfig}\n\n`);
        } else {
            log.warn({ reason: torStatus.message }, 'Tor недоступен, сервер работает без него');
        }
    }

    // Фоновая уборка файлов, на которые не ссылается ни одно сообщение.
    const sweepUploads = () => sweepOrphanUploads(UPLOADS_DIR, { dbAll, ttlMs: ORPHAN_UPLOAD_TTL_MS })
        .catch(error => log.error({ err: error }, 'Uploads sweep error'));
    setInterval(sweepUploads, ORPHAN_UPLOAD_TTL_MS).unref();
}));
