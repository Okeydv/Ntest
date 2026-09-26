'use strict';

/*
 * Задача в отдельном процессе с пределом памяти и времени.
 *
 * Разбор присланных файлов (PDF, видео, картинки) — это чужие байты, и
 * хитро собранный файл может заставить парсер есть память или крутиться
 * бесконечно. В процессе сервера это роняло или вешало бы весь сервер,
 * а здесь падает только дочерний процесс: по памяти его останавливает сам
 * V8 (--max-old-space-size), по времени — SIGKILL по таймеру. Падение
 * нативного кода (sharp) сервер тоже не задевает.
 *
 * Процесс, а не worker_threads: предел resourceLimits у потоков в Node 22
 * на деле не держит — поток с пределом 64 МБ спокойно набирал гигабайты.
 *
 * Одновременно работает не больше MAX_PARALLEL процессов, остальные ждут:
 * иначе сотня одновременных загрузок подняла бы сотню процессов.
 *
 * Скрипт задачи получает данные первым IPC-сообщением и отвечает одним:
 * { ok: true, result } или { ok: false, name, message }.
 */

const { fork } = require('child_process');

const MAX_PARALLEL = Math.max(1, Number(process.env.WORKER_PARALLEL) || 2);
let running = 0;
const waiting = [];

class WorkerLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WorkerLimitError';
    }
}

function acquire() {
    if (running < MAX_PARALLEL) {
        running++;
        return Promise.resolve();
    }
    return new Promise(resolve => waiting.push(resolve));
}

function release() {
    const next = waiting.shift();
    if (next) next();
    else running--;
}

function runOnce(script, data, { timeoutMs, maxHeapMb }) {
    return new Promise((resolve, reject) => {
        const child = fork(script, [], {
            execArgv: [`--max-old-space-size=${maxHeapMb}`],
            // Вывод процесса — в журнал сервера, как есть; ввод не нужен.
            stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
            serialization: 'advanced',
        });
        let stderr = '';
        child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            fn(value);
        };
        const timer = setTimeout(() => {
            finish(reject, new WorkerLimitError(`не уложились в ${timeoutMs / 1000} с`));
        }, timeoutMs);

        child.once('message', message => {
            if (message && message.ok) {
                finish(resolve, message.result);
            } else {
                const error = new Error(message && message.message || 'задача не выполнена');
                if (message && message.name) error.name = message.name;
                finish(reject, error);
            }
        });
        child.once('error', error => finish(reject, error));
        child.once('exit', (code, signal) => {
            finish(reject, /heap out of memory|Allocation failed/i.test(stderr)
                ? new WorkerLimitError(`не хватило памяти (предел ${maxHeapMb} МБ)`)
                : new Error(`процесс завершился: ${signal || code}`));
        });
        child.send(data);
    });
}

async function runLimited(script, data, { timeoutMs = 30000, maxHeapMb = 256 } = {}) {
    await acquire();
    try {
        return await runOnce(script, data, { timeoutMs, maxHeapMb });
    } finally {
        release();
    }
}

module.exports = { runLimited, WorkerLimitError };
