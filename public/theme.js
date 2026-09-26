// Тема ставится до первой отрисовки, отдельным файлом в <head>: инлайновый
// <script> сюда нельзя — CSP отдаёт script-src 'self' с nonce, который на
// статический index.html не подставляется. Без этого на старте успевал
// мигнуть тёмный фон у тех, кто выбрал светлую тему.
(function () {
    var STORAGE_KEY = 'nyxo-theme';
    var stored = null;
    try {
        stored = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
        // localStorage недоступен (приватный режим браузера, отключённые
        // cookies) — молча падаем на системную тему.
    }
    var theme = stored === 'light' || stored === 'dark'
        ? stored
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);
    // Цвет строки состояния на телефоне: по умолчанию он следует системной
    // теме, а тема Nyxo могла быть выбрана вручную и не совпадать с ней.
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
        metas[i].setAttribute('content', theme === 'light' ? '#f4f4f7' : '#08080e');
    }
})();
