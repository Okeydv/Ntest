// Журнал ошибок страницы: последние 50 записей, только в памяти вкладки.
// Сам он никуда ничего не отправляет. Из него собирается «Отчёт об ошибке»
// в профиле: человек видит текст целиком и сам решает, кому его переслать.
//
// Подключается раньше script.js, чтобы поймать и ошибки при его загрузке.
// Адреса сокращаются до пути на своём сайте, чужие скрываются совсем;
// текстов сообщений здесь нет — в журнал попадают только ошибки.
(function () {
    'use strict';

    var LIMIT = 50;
    var entries = [];

    function scrub(value) {
        return String(value == null ? '' : value)
            .replace(/(?:https?|wss?|blob):\/\/[^\s)'"]+/g, function (url) {
                try {
                    var u = new URL(url.replace(/^blob:/, ''));
                    return u.origin === location.origin ? u.pathname : '[адрес]';
                } catch (e) {
                    return '[адрес]';
                }
            })
            .slice(0, 800);
    }

    function describe(value) {
        if (value instanceof Error) return value.name + ': ' + value.message;
        if (typeof value === 'object' && value !== null) {
            try { return JSON.stringify(value); } catch (e) { return String(value); }
        }
        return String(value);
    }

    function add(kind, message, extra) {
        var entry = { at: new Date().toISOString(), kind: kind, message: scrub(message) };
        if (extra) {
            for (var key in extra) {
                if (extra[key] != null && extra[key] !== '') entry[key] = scrub(extra[key]);
            }
        }
        entries.push(entry);
        if (entries.length > LIMIT) entries.shift();
    }

    window.addEventListener('error', function (event) {
        var target = event.target;
        if (target && target !== window && target.tagName) {
            // Не загрузился ресурс: скрипт, картинка, стиль.
            add('resource', target.tagName.toLowerCase() + ' не загрузился', { where: target.src || target.href });
            return;
        }
        add('error', event.message, {
            where: event.filename ? event.filename + ':' + event.lineno + ':' + event.colno : '',
            stack: event.error && event.error.stack,
        });
    }, true);

    window.addEventListener('unhandledrejection', function (event) {
        var reason = event.reason;
        add('rejection', describe(reason), { stack: reason && reason.stack });
    });

    ['warn', 'error'].forEach(function (level) {
        var original = console[level];
        console[level] = function () {
            add(level, Array.prototype.map.call(arguments, describe).join(' '));
            return original.apply(console, arguments);
        };
    });

    window.nyxoErrorLog = {
        add: add,
        entries: function () { return entries.slice(); },
    };
})();
