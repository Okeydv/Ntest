const { log } = require('./log');
// Самый долгий срок жизни сообщения — год. Больше — это уже не
// исчезающее сообщение, а ошибка или попытка забить таблицу.
const MAX_EXPIRY_SECONDS = 365 * 24 * 60 * 60;
// Таймер в памяти ставится только на близкие сроки. setTimeout не умеет
// ждать дольше 2^31 мс (~24,8 суток): такой таймер срабатывает сразу, и
// сообщение со сроком в месяц исчезало через миллисекунду. Дальние сроки
// забирает уборка раз в минуту — ей хватает строки в message_expiry, и она
// переживает перезапуск сервера, в отличие от таймеров.
const TIMER_WINDOW_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

/** Срок жизни в секундах — целое от 1 до года, иначе null. */
function normalizeExpiry(value) {
    const seconds = Number(value);
    return Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_EXPIRY_SECONDS ? seconds : null;
}

// «5 минут», «1 день» — для системного сообщения о сроке.
function expiryLabel(seconds) {
    const units = [[604800, ['неделя', 'недели', 'недель']], [86400, ['день', 'дня', 'дней']],
        [3600, ['час', 'часа', 'часов']], [60, ['минута', 'минуты', 'минут']], [1, ['секунда', 'секунды', 'секунд']]];
    for (const [size, forms] of units) {
        if (seconds % size === 0) {
            const n = seconds / size;
            const form = n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2;
            return `${n} ${forms[form]}`;
        }
    }
    return `${seconds} с`;
}

class DisappearingMessagesManager {
    /**
     * onDelete(messageId) — вызывается после удаления сообщения. Нужен для
     * содержимого, которое живёт вне строки messages: у зашифрованного
     * сообщения это конверты и вложения, и мягкое удаление их не трогает.
     */
    constructor(pool, { onDelete } = {}) {
        this.pool = pool;
        this.onDelete = onDelete || null;
        this.scheduledDeletions = new Map();
    }

    // Таблицы message_expiry и chat_settings создаёт миграция
    // (migrations/001_baseline.sql); здесь только запуск уборки.
    async initialize() {
        log.info('[DisappearingMessages] Initialized');

        // Запускаем фоновый процесс очистки
        this.startCleanupWorker();
    }

    // Установка времени жизни сообщения
    async setMessageExpiry(messageId, expirySeconds, autoDeleteOnRead = false) {
        const seconds = normalizeExpiry(expirySeconds);
        if (seconds === null) throw new Error(`Недопустимый срок жизни: ${expirySeconds}`);

        // Срок считает база: и хранит, и сравнивает его она.
        const stored = await this.pool.query(
            `INSERT INTO message_expiry (message_id, expires_at, auto_delete_on_read)
             VALUES ($1, NOW() + make_interval(secs => $2), $3)
             ON CONFLICT (message_id) DO UPDATE
             SET expires_at = EXCLUDED.expires_at, auto_delete_on_read = EXCLUDED.auto_delete_on_read
             RETURNING expires_at`,
            [messageId, seconds, Boolean(autoDeleteOnRead)]
        );

        if (seconds * 1000 <= TIMER_WINDOW_MS) {
            this.scheduleMessageDeletion(messageId, seconds * 1000);
        }
        return stored.rows[0].expires_at;
    }

    // Планирование удаления сообщения
    scheduleMessageDeletion(messageId, delayMs) {
        // Отменяем предыдущее запланированное удаление если есть
        if (this.scheduledDeletions.has(messageId)) {
            clearTimeout(this.scheduledDeletions.get(messageId));
        }

        const timeoutId = setTimeout(async () => {
            await this.deleteMessage(messageId);
            this.scheduledDeletions.delete(messageId);
        }, delayMs);

        this.scheduledDeletions.set(messageId, timeoutId);
    }

    // Удаление сообщения
    async deleteMessage(messageId) {
        try {
            await this.pool.query(
                'UPDATE messages SET deleted = 1, text = \'[Сообщение удалено]\' WHERE id = $1',
                [messageId]
            );

            await this.pool.query(
                'DELETE FROM message_expiry WHERE message_id = $1',
                [messageId]
            );

            if (this.onDelete) await this.onDelete(messageId);

        } catch (error) {
            log.error({ err: error }, '[DisappearingMessages] Error deleting message');
        }
    }

    // Обработка прочтения сообщения (для auto-delete-on-read)
    async handleMessageRead(messageId) {
        try {
            const result = await this.pool.query(
                'SELECT auto_delete_on_read FROM message_expiry WHERE message_id = $1',
                [messageId]
            );

            if (result.rows.length > 0 && result.rows[0].auto_delete_on_read) {
                // Удаляем через 3 секунды после прочтения
                setTimeout(() => this.deleteMessage(messageId), 3000);
            }
        } catch (error) {
            log.error({ err: error }, '[DisappearingMessages] Error handling message read');
        }
    }

    // Фоновый процесс очистки просроченных сообщений
    startCleanupWorker() {
        setInterval(async () => {
            try {
                const result = await this.pool.query(
                    'SELECT message_id FROM message_expiry WHERE expires_at <= NOW()'
                );

                for (const row of result.rows) {
                    await this.deleteMessage(row.message_id);
                }

                if (result.rows.length > 0) {
                    log.info({ count: result.rows.length }, '[DisappearingMessages] Удалены исчезнувшие сообщения');
                }
            } catch (error) {
                log.error({ err: error }, '[DisappearingMessages] Cleanup worker error');
            }
        }, CLEANUP_INTERVAL_MS);
    }

    // Срок жизни новых сообщений чата. 0 — выключить. У комнаты он общий:
    // ставится всем её участникам, иначе в группе исчезали бы только
    // сообщения того, кто включил. Возвращает прежнее значение.
    async setChatDefaultExpiry(chatId, expirySeconds) {
        const seconds = Number(expirySeconds) === 0 ? null : normalizeExpiry(expirySeconds);
        if (seconds === null && Number(expirySeconds) !== 0) {
            throw new Error(`Недопустимый срок жизни: ${expirySeconds}`);
        }
        const before = await this.getChatSettings(chatId);
        await this.pool.query(
            `INSERT INTO chat_settings (chat_id, default_message_expiry)
             SELECT c.id, $2::int FROM chats c
             WHERE c.id = $1 OR (c.room_id IS NOT NULL
                 AND c.room_id = (SELECT room_id FROM chats WHERE id = $1))
             ON CONFLICT (chat_id) DO UPDATE SET default_message_expiry = EXCLUDED.default_message_expiry`,
            [chatId, seconds]
        );
        return before ? before.default_message_expiry : null;
    }

    // Новый участник комнаты получает её срок.
    async copyRoomExpiry(chatId, roomId) {
        await this.pool.query(
            `INSERT INTO chat_settings (chat_id, default_message_expiry)
             SELECT $1, cs.default_message_expiry FROM chat_settings cs
             JOIN chats c ON c.id = cs.chat_id
             WHERE c.room_id = $2 AND c.id <> $1 AND cs.default_message_expiry IS NOT NULL
             LIMIT 1
             ON CONFLICT (chat_id) DO UPDATE SET default_message_expiry = EXCLUDED.default_message_expiry`,
            [chatId, roomId]
        );
    }

    // Получение настроек чата
    async getChatSettings(chatId) {
        try {
            const result = await this.pool.query(
                'SELECT default_message_expiry FROM chat_settings WHERE chat_id = $1',
                [chatId]
            );

            return result.rows.length > 0 ? result.rows[0] : null;
        } catch (error) {
            return null;
        }
    }
}

module.exports = DisappearingMessagesManager;
module.exports.normalizeExpiry = normalizeExpiry;
module.exports.expiryLabel = expiryLabel;
module.exports.MAX_EXPIRY_SECONDS = MAX_EXPIRY_SECONDS;
