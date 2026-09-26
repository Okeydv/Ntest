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

    // Инициализация таблицы для disappearing messages
    async initialize() {
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS message_expiry (
                message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
                expires_at TIMESTAMP NOT NULL,
                auto_delete_on_read BOOLEAN DEFAULT FALSE
            )
        `);

        // Было TIMESTAMP без пояса, а срок приходил из JS Date: pg отдаёт
        // его строкой с поясом процесса, и поле без пояса этот пояс молча
        // отбрасывало — при разных поясах у Node и базы сообщения исчезали
        // на несколько часов раньше или позже.
        await this.pool.query(`
            ALTER TABLE message_expiry ALTER COLUMN expires_at TYPE TIMESTAMPTZ
        `);
        await this.pool.query(`
            CREATE INDEX IF NOT EXISTS idx_message_expiry_expires_at
            ON message_expiry(expires_at)
        `);
        // Раньше таблица создавалась только при первой настройке чата, и
        // до того каждое сообщение делало запрос к несуществующей таблице.
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS chat_settings (
                chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
                default_message_expiry INTEGER
            )
        `);

        console.log('[DisappearingMessages] Initialized');

        // Запускаем фоновый процесс очистки
        this.startCleanupWorker();
    }

    // Установка времени жизни сообщения
    async setMessageExpiry(messageId, expirySeconds, autoDeleteOnRead = false) {
        const seconds = normalizeExpiry(expirySeconds);
        if (seconds === null) throw new Error(`Недопустимый срок жизни: ${expirySeconds}`);

        // Срок считает база: и хранит, и сравнивает его она.
        await this.pool.query(
            `INSERT INTO message_expiry (message_id, expires_at, auto_delete_on_read)
             VALUES ($1, NOW() + make_interval(secs => $2), $3)
             ON CONFLICT (message_id) DO UPDATE
             SET expires_at = EXCLUDED.expires_at, auto_delete_on_read = EXCLUDED.auto_delete_on_read`,
            [messageId, seconds, Boolean(autoDeleteOnRead)]
        );

        if (seconds * 1000 <= TIMER_WINDOW_MS) {
            this.scheduleMessageDeletion(messageId, seconds * 1000);
        }
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

            console.log(`[DisappearingMessages] Deleted message ${messageId}`);
        } catch (error) {
            console.error('[DisappearingMessages] Error deleting message:', error.message);
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
            console.error('[DisappearingMessages] Error handling message read:', error.message);
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
                    console.log(`[DisappearingMessages] Cleaned up ${result.rows.length} expired messages`);
                }
            } catch (error) {
                console.error('[DisappearingMessages] Cleanup worker error:', error.message);
            }
        }, CLEANUP_INTERVAL_MS);
    }

    // Установка глобального времени жизни для чата. 0 — выключить.
    async setChatDefaultExpiry(chatId, expirySeconds) {
        const seconds = Number(expirySeconds) === 0 ? null : normalizeExpiry(expirySeconds);
        if (seconds === null && Number(expirySeconds) !== 0) {
            throw new Error(`Недопустимый срок жизни: ${expirySeconds}`);
        }
        await this.pool.query(
            `INSERT INTO chat_settings (chat_id, default_message_expiry)
             VALUES ($1, $2)
             ON CONFLICT (chat_id) DO UPDATE SET default_message_expiry = $2`,
            [chatId, seconds]
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
module.exports.MAX_EXPIRY_SECONDS = MAX_EXPIRY_SECONDS;
