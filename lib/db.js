'use strict';

// Подключение к PostgreSQL и короткие обёртки над запросами.

const { Pool } = require('pg');
const { log } = require('./log');

async function maybeDumpCa() {
    if (process.env.DUMP_CA !== 'true') return;
    const tls = require('tls');
    const net = require('net');
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) { log.error('DATABASE_URL не задан'); process.exit(1); }
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

// В production — либо TLS до базы с проверкой сертификата (DB_CA_CERT),
// либо явно без TLS (DB_SSL=disable: база на этом же хосте или во
// внутренней сети). Раньше без DB_CA_CERT шёл TLS без проверки: он только
// выглядит защищённым, а подменить сервер базы по дороге можно так же, как
// без него.
const sslConfig = (() => {
    if (process.env.NODE_ENV !== 'production') return false;
    if (process.env.DB_CA_CERT) {
        log.info('[SSL] production: сертификат базы проверяется (DB_CA_CERT)');
        return { ca: process.env.DB_CA_CERT, rejectUnauthorized: true };
    }
    if (process.env.DB_SSL === 'disable') {
        log.info('[SSL] production: соединение с базой без TLS (DB_SSL=disable)');
        return false;
    }
    log.fatal('[SSL] production: задайте DB_CA_CERT (сертификат базы; цепочку покажет запуск с '
        + 'DUMP_CA=true) или DB_SSL=disable, если база в той же внутренней сети.');
    process.exit(1);
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

module.exports = { pool, dbGet, dbAll, dbRun, maybeDumpCa };
