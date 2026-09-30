/*
 * Service worker Nyxo. Минимальный: ничего не кэширует и запросы к API не
 * трогает — страница всегда берётся с сервера. Он нужен для трёх вещей:
 *
 *   - уведомления через registration.showNotification: Chrome на Android
 *     и Safari на iPhone иначе их не показывают;
 *   - Web Push: пустой push с сервера (lib/push.js) — «Новое сообщение»,
 *     даже когда вкладка закрыта; на iPhone — из приложения на экране
 *     «Домой»;
 *   - «Поделиться» из других приложений (share_target в манифесте).
 *
 * Новая версия не включается молча: ждёт, пока страница не покажет тост
 * «Обновить» и человек не нажмёт его (сообщение skip-waiting).
 */

const SHARE_CACHE = 'nyxo-share';

self.addEventListener('install', () => {
    // Без skipWaiting: новая версия ждёт согласия (см. выше).
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

/* --- Push ------------------------------------------------------------------
   В push нет ничего — ни текста, ни чата. Если Nyxo открыт на экране,
   показывать нечего: вкладка уведомит сама. */

self.addEventListener('push', event => {
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (windows.some(w => w.visibilityState === 'visible' && w.focused)) return;
        await self.registration.showNotification('Nyxo', {
            body: 'Новое сообщение',
            tag: 'nyxo-push',
            renotify: true,
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-192.png',
            data: {},
        });
    })());
});

/* --- Нажатие на уведомление ---------------------------------------------------
   Открытое окно — вперёд и открыть в нём чат; окна нет — открыть. */

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const chatId = event.notification.data && event.notification.data.chatId;
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const target = windows.find(w => new URL(w.url).origin === self.location.origin);
        if (target) {
            await target.focus();
            if (chatId) target.postMessage({ type: 'open-chat', chatId });
            return;
        }
        await self.clients.openWindow(chatId ? `/?chat=${encodeURIComponent(chatId)}` : '/');
    })());
});

/* --- «Поделиться» ----------------------------------------------------------------
   Система присылает POST /share с текстом, ссылкой и файлами. Кладём их в
   кэш на один раз — страница заберёт и сотрёт (script.js, «Поделиться»), —
   и открываем приложение. Всё остальное идёт в сеть как обычно. */

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'POST' || url.origin !== self.location.origin || url.pathname !== '/share') return;
    event.respondWith((async () => {
        try {
            const form = await event.request.formData();
            const files = form.getAll('files').filter(f => f && typeof f === 'object' && f.size > 0);
            const cache = await caches.open(SHARE_CACHE);
            await Promise.all((await cache.keys()).map(k => cache.delete(k)));
            await Promise.all(files.map((file, i) => cache.put(`/__share/file/${i}`,
                new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } }))));
            const meta = {
                title: String(form.get('title') || ''),
                text: String(form.get('text') || ''),
                url: String(form.get('url') || ''),
                files: files.map(f => ({ name: f.name, type: f.type })),
            };
            await cache.put('/__share/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
            return Response.redirect('/?share=1', 303);
        } catch {
            return Response.redirect('/?share=unavailable', 303);
        }
    })());
});
