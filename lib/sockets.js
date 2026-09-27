'use strict';

// Socket.IO: проверка Origin, не больше пяти подключений с адреса, сессия
// и комнаты, в которые сокет входит.

const { Server } = require('socket.io');
const { log } = require('./log');
const { dbGet } = require('./db');
const { isAllowedOrigin, getClientIp, handshakeViaTor } = require('./client-ip');
const { socketConnected, socketDisconnected } = require('./presence');

function createSocketServer(server, { sessionMiddleware }) {
    const io = new Server(server, {
        allowRequest: (req, callback) => callback(null, isAllowedOrigin(req)),
    });

    const ipConnectionCount = new Map();

    setInterval(() => {
        for (const [ip, count] of ipConnectionCount.entries()) {
            if (count <= 0) ipConnectionCount.delete(ip);
        }
    }, 10 * 60 * 1000);

    io.use((socket, next) => {
        sessionMiddleware(socket.request, socket.request.res || {}, next);
    });

    // Не больше пяти сокетов с адреса. Через Tor у всех адрес один
    // (127.0.0.1), и там считаем по пользователю — по пять на каждого,
    // а не пять на всех.
    io.use((socket, next) => {
        const userId = socket.request.session && socket.request.session.userId;
        const ip = handshakeViaTor(socket.handshake) ? `tor-user:${userId || 'guest'}` : getClientIp(socket.handshake);
        const count = ipConnectionCount.get(ip) || 0;
        if (count >= 5) {
            return next(new Error('Слишком много подключений с вашего адреса'));
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
        socketConnected(io, userId);
        socket.on('disconnect', () => socketDisconnected(io, userId));

        // Кто и когда подключался — в журнал не пишется: журнал сервера
        // приватного мессенджера не должен складываться в историю активности.

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
                log.error({ err: err }, 'joinChat error');
            }
        });

        /*
         * «Печатает…»: без содержимого — только кто и в каком чате.
         * Участие в комнате проверяется, как в joinChat; не чаще раза в 2 с
         * на сокет; выключившего «Показывать, что я печатаю» не слушаем.
         * Уходит всем в комнате, кроме этого сокета (свои устройства клиент
         * отсеивает сам). В чате с ботом (без комнаты) печатать некому.
         */
        let lastTyping = 0;
        socket.on('typing', async (payload) => {
            const chatId = Number(payload && payload.chatId);
            const now = Date.now();
            if (!Number.isInteger(chatId) || chatId <= 0 || now - lastTyping < 2000) return;
            lastTyping = now;
            try {
                const row = await dbGet(
                    `SELECT c.room_id, u.username FROM chats c
                     JOIN users u ON u.id = c.user_id
                     JOIN room_participants rp ON rp.room_id = c.room_id AND rp.user_id = c.user_id
                     WHERE c.id = $1 AND c.user_id = $2 AND u.send_typing`, [chatId, userId]);
                if (!row) return;
                socket.to(`room:${row.room_id}`).emit('typing', { room_id: row.room_id, user_id: userId, username: row.username });
            } catch (err) {
                log.error({ err: err }, 'typing error');
            }
        });

    });

    return io;
}

module.exports = { createSocketServer };
