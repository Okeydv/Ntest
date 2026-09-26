const socket = io();
let currentChatId = null;
let currentRoomId = null;
let currentChatIsBot = false;
let currentUser = null;
let replyToMessageId = null;
let editingMessageId = null;
let longPressTimer = null;

const elements = {
    authScreen: document.getElementById('auth-screen'),
    app: document.getElementById('app'),
    loginForm: document.getElementById('login-form'),
    registerForm: document.getElementById('register-form'),
    loginBtn: document.getElementById('login-btn'),
    registerBtn: document.getElementById('register-btn'),
    anonymousLoginBtn: document.getElementById('anonymous-login-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    chatsList: document.getElementById('chats-list'),
    chatMessages: document.getElementById('chat-messages'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    attachBtn: document.getElementById('attach-btn'),
    fileInput: document.getElementById('file-input'),
    newChatBtn: document.getElementById('new-chat-btn'),
    chatHeader: document.getElementById('chat-header'),
    sidebar: document.querySelector('.sidebar'),
    mainContent: document.querySelector('.main-content'),
    chatBackBtn: document.getElementById('chat-back-btn'),
    chatName: document.getElementById('chat-name'),
    chatStatus: document.getElementById('chat-status'),
    chatAvatar: document.getElementById('chat-avatar'),
    chatEncryption: document.getElementById('chat-encryption'),
    safetyModal: document.getElementById('safety-modal'),
    safetyList: document.getElementById('safety-list'),
    emptyState: document.getElementById('empty-state'),
    messageInputContainer: document.getElementById('message-input-container'),
    searchInput: document.getElementById('search-input'),
    newChatModal: document.getElementById('new-chat-modal'),
    chatMenuModal: document.getElementById('chat-menu-modal'),
    profileModal: document.getElementById('profile-modal'),
    passwordModal: document.getElementById('password-modal'),
    inviteModal: document.getElementById('invite-modal'),
    createChatBtn: document.getElementById('create-chat-btn'),
    joinChatBtn: document.getElementById('join-chat-btn'),
    deleteChatBtn: document.getElementById('delete-chat-btn'),
    getChatCodeBtn: document.getElementById('get-chat-code-btn'),
    chatMenuBtn: document.getElementById('chat-menu-btn'),
    profileBtn: document.getElementById('profile-btn'),
    changePasswordBtn: document.getElementById('change-password-btn'),
    savePasswordBtn: document.getElementById('save-password-btn'),
    inviteCodeDisplay: document.getElementById('invite-code-display'),
    copyInviteBtn: document.getElementById('copy-invite-btn'),
    messageMenu: document.getElementById('message-menu'),
    replyMessageBtn: document.getElementById('reply-message-btn'),
    editMessageBtn: document.getElementById('edit-message-btn'),
    deleteMessageBtn: document.getElementById('delete-message-btn'),
    replyPreview: document.getElementById('reply-preview'),
    replyPreviewText: document.getElementById('reply-preview-text'),
    cancelReplyBtn: document.getElementById('cancel-reply-btn'),
    toast: document.getElementById('toast'),
    profileUsername: document.getElementById('profile-username'),
    profileEmail: document.getElementById('profile-email'),
    profileCode: document.getElementById('profile-code'),
    profileAvatar: document.getElementById('profile-avatar'),
    profileAnonBadge: document.getElementById('profile-anon-badge'),
    emptyNewChatBtn: document.getElementById('empty-new-chat-btn'),
};

/* --- E2EE -------------------------------------------------------------
   Крипта живёт в ES-модулях (public/crypto/*), а этот файл — обычный
   скрипт. Модульные скрипты всегда deferred, поэтому крипта может быть ещё
   не поднята к моменту исполнения этого кода; bootstrap.js сообщает о
   готовности событием, и обе очерёдности обрабатываются. */

let e2ee = null;          // модуль крипты, когда он загрузился
let e2eeDeviceId = null;  // id этого устройства, если E2EE поднялся

function cryptoModule() {
    if (window.NyxoCrypto) return Promise.resolve(window.NyxoCrypto);
    return new Promise(resolve => {
        window.addEventListener('nyxo-crypto-ready', () => resolve(window.NyxoCrypto), { once: true });
        // Если модуль не загрузился (сеть, CSP, старый браузер) — приложение
        // обязано работать дальше без шифрования, а не висеть.
        setTimeout(() => resolve(window.NyxoCrypto || null), 5000);
    });
}

/**
 * Поднять шифрование для текущей сессии: зарегистрировать или привязать
 * устройство, опубликовать ключи, пополнить пул prekeys.
 *
 * Сокет после этого переподключается: серверная комната device:<id>
 * выбирается по сессии в момент рукопожатия, а deviceId там появился
 * только что.
 */
async function setupE2EE() {
    e2ee = await cryptoModule();
    if (!e2ee) {
        console.warn('[E2EE] модуль крипты не загрузился, работаем без шифрования');
        return;
    }
    const result = await e2ee.bootstrap({
        api,
        userId: currentUser.id,
        deviceName: navigator.userAgent.slice(0, 64),
    });
    if (!result) {
        e2eeDeviceId = null;
        return;
    }
    e2eeDeviceId = result.deviceId;

    // Сокет обязан переподключиться ПЕРЕД тем, как кто-то позовёт
    // joinChat: серверную комнату device:<id> выбирают по сессии в момент
    // рукопожатия, а deviceId там появился только что. Без ожидания
    // следующий joinChat уходил в ещё не поднятое соединение.
    socket.disconnect();
    await new Promise(resolve => {
        socket.once('connect', resolve);
        socket.connect();
        // Не зависаем, если сокет не поднимется: без него приложение
        // деградирует до обновления по перезагрузке, но работает.
        setTimeout(resolve, 3000);
    });
}

/**
 * Текст сообщения для отображения.
 *
 * Возвращает null, если прочитать нечем — это не ошибка, а нормальное
 * состояние: сообщение отправлено до того, как появилось это устройство.
 * Вызывающий обязан показать заглушку, а не пустой пузырь.
 */
async function resolveMessageText(message) {
    if (!message.encrypted) return message.text;
    if (!e2ee) return null;

    // Кэш проверяется первым и для своих, и для чужих сообщений. Это не
    // ускорение: ключ сообщения в Double Ratchet одноразовый, и повторно
    // расшифровать тот же конверт нельзя. Без кэша история после
    // перезагрузки восстанавливалась бы только для своих сообщений.
    const cached = await e2ee.recallPlaintext(message.id);
    if (cached != null) return cached;

    if (!message.envelope && !message.group && !message.keyEnvelope) return null;
    return e2ee.decryptIncoming(message);
}

/**
 * Обновить превью в списке чатов на месте.
 *
 * Раньше превью приходило с сервера в last_message, и строка обновлялась
 * сама при следующем loadChats. Под E2EE сервер текста не знает, превью
 * считает клиент — значит и обновлять строку теперь его забота, иначе в
 * списке навсегда остаётся «Нет сообщений».
 *
 * Ищем по room_id, если он есть: у сообщения chat_id указывает на запись
 * чата ОТПРАВИТЕЛЯ, а у получателя запись своя, с другим id.
 */
function updateChatPreviewInList(message, text) {
    const selector = message.room_id
        ? `.chat-item[data-room-id="${message.room_id}"]`
        : `.chat-item[data-id="${message.chat_id}"]`;
    const line = elements.chatsList.querySelector(`${selector} .chat-last`);
    if (line) line.textContent = text.substring(0, 30);
}

/**
 * Разложить расшифрованное содержимое по полям сообщения для отрисовки.
 * Зашифрованное сообщение — это JSON с типом: текст или вложение.
 */
function applyDecryptedContent(message, content) {
    message.undecryptable = content === null;
    message.text = content && content.t === 'text' ? content.body : '';
    message.encryptedFile = content && content.t === 'file' ? content : null;
    message.brokenAttachment = Boolean(content && content.t === 'invalid');
}

/** Расшифровать и дорисовать сообщение в открытый чат. */
async function appendMessageDecrypted(message) {
    if (message.encrypted) {
        const raw = await resolveMessageText(message);
        const content = raw === null ? null : e2ee.decodePayload(raw);
        applyDecryptedContent(message, content);
        if (content) {
            const preview = e2ee.payloadPreview(content);
            await e2ee.rememberPreview(message.chat_id, preview);
            updateChatPreviewInList(message, preview);
        }
    }
    appendMessage(message);
}

/** Есть ли в чате устройства, кроме этого: то есть есть ли для кого шифровать. */
async function chatDevices(chatId) {
    const info = await api(`/api/chats/${chatId}/devices`);
    return info && info.success ? info : null;
}

const hasForeignDevices = info => Boolean(info && info.devices.some(d => d.device_id !== e2eeDeviceId));

async function chatHasForeignDevices(chatId) {
    if (!e2ee || !e2ee.isReady()) return false;
    return hasForeignDevices(await chatDevices(chatId));
}

/**
 * Индикатор в шапке чата: шифруется ли то, что здесь пишут, и сверены ли
 * ключи собеседников.
 *
 * Приложение смешанное — общие чаты шифруются, чат с ботом нет, а чат без
 * собеседника пока тоже нет. До этого индикатора отличить одно от другого
 * было нельзя никак. В зашифрованном чате он же — вход в сверку ключей.
 */
async function refreshEncryptionBadge(chatId, isBot) {
    const badge = elements.chatEncryption;
    let mode = 'off';
    let icon = 'i-unlock';
    let text;
    if (isBot) {
        text = 'Без шифрования: бот';
    } else if (!e2ee || !e2ee.isReady()) {
        text = 'Без шифрования: ключи устройства недоступны';
    } else {
        const info = await chatDevices(chatId);
        if (hasForeignDevices(info)) {
            const states = [...(await e2ee.verificationStatus(info.devices)).values()];
            if (states.includes('changed')) {
                mode = 'warn';
                icon = 'i-alert';
                text = 'Ключи собеседника изменились';
            } else if (states.length > 0 && states.every(v => v === 'verified')) {
                mode = 'on';
                icon = 'i-shield-check';
                text = 'Сквозное шифрование · ключи сверены';
            } else {
                mode = 'on';
                icon = 'i-lock';
                text = 'Сквозное шифрование';
            }
        } else {
            text = 'Без шифрования: собеседника пока нет';
        }
    }
    // Пока ждали ответа, могли открыть другой чат — не перезаписываем его.
    if (currentChatId !== chatId) return;
    badge.className = `encryption-badge is-${mode}`;
    badge.disabled = mode === 'off';
    badge.title = mode === 'off' ? '' : 'Сверить ключи';
    badge.replaceChildren(createIcon(icon), document.createTextNode(text));
}

/* --- Сверка ключей -------------------------------------------------------
   Код безопасности считается на каждого собеседника: в группе их несколько,
   и сверять приходится с каждым. */

const SAFETY_STATE_TEXT = {
    unverified: 'Не сверено',
    verified: 'Сверено',
    changed: 'Изменились после сверки',
};

function safetyNote(text) {
    const p = document.createElement('p');
    p.className = 'safety-warning';
    p.append(createIcon('i-alert'), document.createTextNode(text));
    return p;
}

async function renderSafetyEntry(chatId, user) {
    const section = document.createElement('section');
    section.className = 'safety-entry';
    section.dataset.userId = user.user_id;

    const head = document.createElement('div');
    head.className = 'safety-entry-head';
    const name = document.createElement('strong');
    name.textContent = user.username;
    head.appendChild(name);
    section.appendChild(head);

    let info;
    try {
        info = await e2ee.safetyInfo(user.user_id);
    } catch (error) {
        const p = document.createElement('p');
        p.className = 'safety-muted';
        p.textContent = `Не удалось получить ключи: ${error.message}`;
        section.appendChild(p);
        return section;
    }
    if (!info.available) {
        const p = document.createElement('p');
        p.className = 'safety-muted';
        p.textContent = 'У собеседника пока нет ключей шифрования.';
        section.appendChild(p);
        return section;
    }

    const chip = document.createElement('span');
    chip.className = `safety-state is-${info.state}`;
    chip.textContent = SAFETY_STATE_TEXT[info.state];
    head.appendChild(chip);

    if (info.state === 'changed') {
        section.appendChild(safetyNote('После сверки у собеседника появилось новое устройство. '
            + 'Пока вы не сверите код заново, сообщения в этот чат не отправляются.'));
    }
    if (info.conflicts.length > 0) {
        section.appendChild(safetyNote('Сервер выдаёт для устройства собеседника ключ, который не совпадает '
            + 'с известным. Этому устройству сообщения не отправляются.'));
    }
    if (info.ownConflicts.length > 0) {
        section.appendChild(safetyNote('Сервер раздаёт от имени ваших устройств чужие ключи. '
            + 'Код у собеседника не совпадёт с вашим.'));
    }

    const groups = e2ee.formatSafetyNumber(info.safetyNumber);
    const number = document.createElement('div');
    number.className = 'safety-number';
    number.setAttribute('aria-label', `Код безопасности: ${groups.join(' ')}`);
    for (const group of groups) {
        const span = document.createElement('span');
        span.textContent = group;
        number.appendChild(span);
    }
    section.appendChild(number);

    const meta = document.createElement('p');
    meta.className = 'safety-muted';
    meta.textContent = `Устройств собеседника: ${info.devices.length}`;
    section.appendChild(meta);

    const action = document.createElement('button');
    action.type = 'button';
    if (info.state === 'verified') {
        action.className = 'btn btn-secondary btn-block';
        action.textContent = 'Снять отметку';
        action.addEventListener('click', async () => {
            await e2ee.clearVerified(user.user_id);
            section.replaceWith(await renderSafetyEntry(chatId, user));
            refreshEncryptionBadge(chatId, currentChatIsBot);
        });
    } else {
        action.className = 'btn btn-primary btn-block';
        action.textContent = 'Код совпал — отметить сверенным';
        action.addEventListener('click', async () => {
            // Отмечается ровно тот набор устройств, по которому посчитан
            // показанный код, а не тот, что окажется на сервере к моменту клика.
            await e2ee.markVerified(user.user_id, info.devices);
            section.replaceWith(await renderSafetyEntry(chatId, user));
            refreshEncryptionBadge(chatId, currentChatIsBot);
        });
    }
    section.appendChild(action);
    return section;
}

async function openSafetyModal(chatId) {
    if (!e2ee || !e2ee.isReady()) return;
    const list = elements.safetyList;
    const loading = document.createElement('div');
    loading.className = 'skeleton safety-skeleton';
    list.replaceChildren(loading);
    openModal(elements.safetyModal);

    const info = await chatDevices(chatId);
    const others = ((info && info.users) || []).filter(u => u.user_id !== currentUser.id);
    if (others.length === 0) {
        const p = document.createElement('p');
        p.className = 'safety-muted';
        p.textContent = 'В чате пока нет собеседников — сверять не с кем. '
            + 'Сообщения шифруются только для других ваших устройств.';
        list.replaceChildren(p);
        return;
    }
    const entries = [];
    for (const user of others) entries.push(await renderSafetyEntry(chatId, user));
    list.replaceChildren(...entries);
}

const THEME_KEY = 'nyxo-theme';
const DEFAULT_AVATAR = '#6D5EFC';
const SVG_NS = 'http://www.w3.org/2000/svg';

// Иконки берутся из спрайта в index.html. className у SVG-элемента — это
// SVGAnimatedString, присвоить строку нельзя, поэтому класс ставится
// атрибутом.
function createIcon(id) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
}

/* --- Тема ----------------------------------------------------------------
   Первичная установка data-theme живёт в theme.js и выполняется до отрисовки;
   здесь только переключение и запись выбора. */

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try {
        localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
        // Приватный режим браузера: выбор не сохранится, но тема применится.
    }
    const label = theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
    });
}

function setupTheme() {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
        btn.addEventListener('click', () => {
            const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            applyTheme(next);
        });
    });
}

/* --- Состояния полей ----------------------------------------------------
   Раньше любая ошибка показывалась только тостом: он исчезает через три
   секунды и не говорит, какое поле виновато. Теперь ошибка подсвечивает
   само поле и подписывается под ним, а тост остаётся для событий уровня
   экрана. */

function setFieldError(inputId, message) {
    const input = document.getElementById(inputId);
    const msg = document.querySelector('.field-msg[data-msg-for="' + inputId + '"]');
    if (input) {
        input.classList.add('is-invalid');
        input.setAttribute('aria-invalid', 'true');
    }
    if (msg) {
        msg.textContent = message;
        msg.classList.add('is-visible');
    }
    return false;
}

function clearFieldError(input) {
    if (!input) return;
    input.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
    const msg = document.querySelector('.field-msg[data-msg-for="' + input.id + '"]');
    if (msg) {
        msg.textContent = '';
        msg.classList.remove('is-visible');
    }
}

function clearFieldErrors(scope) {
    (scope || document).querySelectorAll('input.is-invalid').forEach(clearFieldError);
}

function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function init() {
    setupTheme();
    // Ошибка снимается, как только пользователь начал править поле: держать
    // подсветку на поле, которое уже переписывают, — только мешать.
    document.addEventListener('input', (e) => {
        if (e.target instanceof HTMLInputElement && e.target.classList.contains('is-invalid')) {
            clearFieldError(e.target);
        }
    });
    checkAuth();
    try {
        setupEventListeners();
    } catch (e) {
        console.error('setupEventListeners() failed — some UI controls may not respond:', e);
    }
}

async function checkAuth() {
    try {
        const res = await fetch('/api/auth');
        const data = await res.json();
        if (data.authenticated) {
            currentUser = data.user;
            showApp();
            await setupE2EE();
            loadChats();
        } else {
            showAuth();
        }
    } catch (e) {
        showAuth();
    }
}

function showAuth() {
    elements.authScreen.classList.remove('hidden');
    elements.app.classList.add('hidden');
}

function showApp() {
    elements.authScreen.classList.add('hidden');
    elements.app.classList.remove('hidden');
}

let toastTimer = null;

/**
 * Кнопка недоступна, пока идёт запрос. Двойной клик по «Зарегистрироваться»
 * отправлял две регистрации: вторая падала с «email занят», и человек
 * видел ошибку, хотя аккаунт уже создан.
 */
async function withBusy(button, fn) {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
        await fn();
    } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
    }
}

/**
 * Тост. options.action — кнопка действия { label, onClick }, options.duration —
 * сколько держать.
 *
 * Ошибка по таймеру не прячется: за три секунды её легко не успеть
 * прочитать, а она объясняет, почему не сработало. Она висит, пока её не
 * закроют или не сменит другой тост.
 *
 * Тост — popover="manual": он в верхнем слое и виден поверх открытого
 * окна. Показ заново поднимает его над окном, открытым позже.
 */
function showToast(message, type = 'info', { action = null, duration = null } = {}) {
    const toast = elements.toast;
    const sticky = type === 'error' && !duration;
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    toast.replaceChildren(text);
    if (action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'toast-action';
        button.textContent = action.label;
        button.addEventListener('click', () => {
            hideToast();
            action.onClick();
        });
        toast.appendChild(button);
    }
    if (sticky || action) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'icon-btn icon-btn-sm icon-btn-quiet toast-close';
        close.setAttribute('aria-label', 'Закрыть');
        close.appendChild(createIcon('i-close'));
        close.addEventListener('click', hideToast);
        toast.appendChild(close);
    }
    toast.className = `toast ${type}`;
    // Открытое модальное окно делает всё вне себя inert — тост был бы виден,
    // но крестик и «Вернуть» не нажимались бы. Поэтому тост кладётся внутрь
    // открытого окна, а когда окна нет — обратно в body.
    const host = document.querySelector('dialog.modal[open]') || document.body;
    if (toast.parentElement !== host) {
        if (toast.matches(':popover-open')) toast.hidePopover();
        host.appendChild(toast);
    }
    // Ошибку экранный диктор зачитывает сразу, остальное — в паузе.
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    if (toast.matches(':popover-open')) toast.hidePopover();
    toast.showPopover();
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(hideToast, duration || 3200);
}

function hideToast() {
    clearTimeout(toastTimer);
    if (elements.toast.matches(':popover-open')) elements.toast.hidePopover();
}

function getCsrfToken() {
    const match = document.cookie.match(/csrf_token=([^;]+)/);
    return match ? match[1] : '';
}

async function api(url, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        'X-CSRF-Token': getCsrfToken(),
        ...options.headers,
    };
    const res = await fetch(url, { ...options, headers });
    return res.json();
}

function setupEventListeners() {
    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const target = tab.dataset.tab;
            if (target === 'login') {
                elements.loginForm.classList.add('active');
                elements.registerForm.classList.remove('active');
            } else {
                elements.loginForm.classList.remove('active');
                elements.registerForm.classList.add('active');
            }
        });
    });

    elements.loginBtn.addEventListener('click', () => withBusy(elements.loginBtn, async () => {
        clearFieldErrors(elements.loginForm);
        const email = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;

        let valid = true;
        if (!email) valid = setFieldError('login-email', 'Укажите email');
        else if (!isEmail(email)) valid = setFieldError('login-email', 'Похоже, в адресе опечатка');
        if (!password) valid = setFieldError('login-password', 'Введите пароль');
        if (!valid) return;

        const data = await api('/api/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        });
        if (data.success) {
            currentUser = data.user;
            showToast('Вход выполнен', 'success');
            showApp();
            await setupE2EE();
            loadChats();
        } else {
            setFieldError('login-password', data.message);
        }
    }));

    elements.registerBtn.addEventListener('click', () => withBusy(elements.registerBtn, async () => {
        clearFieldErrors(elements.registerForm);
        const username = document.getElementById('register-username').value.trim();
        const email = document.getElementById('register-email').value.trim();
        const password = document.getElementById('register-password').value;
        const confirmPassword = document.getElementById('register-confirm-password').value;

        let valid = true;
        if (!username) valid = setFieldError('register-username', 'Укажите имя пользователя');
        else if (username.length < 2) valid = setFieldError('register-username', 'Минимум 2 символа');
        if (!email) valid = setFieldError('register-email', 'Укажите email');
        else if (!isEmail(email)) valid = setFieldError('register-email', 'Похоже, в адресе опечатка');
        if (!password) valid = setFieldError('register-password', 'Придумайте пароль');
        else if (password.length < 8) valid = setFieldError('register-password', 'Минимум 8 символов');
        if (password && confirmPassword !== password) {
            valid = setFieldError('register-confirm-password', 'Пароли не совпадают');
        }
        if (!valid) return;

        const data = await api('/api/register', {
            method: 'POST',
            body: JSON.stringify({ username, email, password, confirmPassword }),
        });
        if (data.success) {
            currentUser = data.user;
            showToast('Регистрация завершена', 'success');
            showApp();
            await setupE2EE();
            loadChats();
        } else {
            setFieldError('register-email', data.message);
        }
    }));

    elements.anonymousLoginBtn.addEventListener('click', () => withBusy(elements.anonymousLoginBtn, async () => {
        const data = await api('/api/register/anonymous', { method: 'POST' });
        if (data.success) {
            currentUser = data.user;
            showToast('Приватный режим активирован', 'success');
            showApp();
            await setupE2EE();
            loadChats();
        } else {
            showToast(data.message, 'error');
        }
    }));

    elements.logoutBtn.addEventListener('click', async () => {
        await api('/api/logout', { method: 'POST' });
        currentUser = null;
        currentChatId = null;
        currentRoomId = null;
        showToast('Вы вышли из аккаунта', 'info');
        showAuth();
    });

    elements.newChatBtn.addEventListener('click', () => openModal(elements.newChatModal));
    if (elements.emptyNewChatBtn) {
        elements.emptyNewChatBtn.addEventListener('click', () => openModal(elements.newChatModal));
    }
    elements.createChatBtn.addEventListener('click', createChat);
    elements.joinChatBtn.addEventListener('click', joinChat);

    elements.chatMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(elements.chatMenuModal);
    });

    elements.deleteChatBtn.addEventListener('click', deleteChat);

    elements.getChatCodeBtn.addEventListener('click', async () => {
        if (!currentChatId) return;
        const data = await api(`/api/chats/invite/${currentChatId}`);
        if (data.success) {
            elements.inviteCodeDisplay.textContent = data.code;
            openModal(elements.inviteModal);
        } else {
            showToast(data.message, 'error');
        }
    });

    elements.copyInviteBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(elements.inviteCodeDisplay.textContent);
        showToast('Код скопирован!', 'success');
    });

    elements.profileBtn.addEventListener('click', async () => {
        const data = await api('/api/user');
        if (data.success) {
            elements.profileUsername.textContent = data.user.username;
            elements.profileEmail.textContent = data.user.email || 'Нет email (приватный режим)';
            elements.profileCode.textContent = `Код: ${data.user.uniqueCode}`;
            const avatarColor = data.user.avatar || DEFAULT_AVATAR;
            elements.profileAvatar.style.background = avatarColor;
            elements.profileAvatar.textContent = data.user.username.charAt(0).toUpperCase();
            document.querySelectorAll('.color-option').forEach(o => {
                o.classList.toggle('active', o.dataset.color.toLowerCase() === avatarColor.toLowerCase());
            });
            if (data.user.email === null || data.user.email === undefined) {
                elements.profileAnonBadge.classList.remove('hidden');
                elements.changePasswordBtn.classList.add('hidden');
            } else {
                elements.profileAnonBadge.classList.add('hidden');
                elements.changePasswordBtn.classList.remove('hidden');
            }
            openModal(elements.profileModal);
        }
    });

    elements.changePasswordBtn.addEventListener('click', () => {
        closeModal(elements.profileModal);
        openModal(elements.passwordModal);
    });

    elements.savePasswordBtn.addEventListener('click', async () => {
        clearFieldErrors(elements.passwordModal);
        const currentPassword = document.getElementById('current-password').value;
        const newPassword = document.getElementById('new-password').value;
        const confirmPassword = document.getElementById('confirm-new-password').value;

        let valid = true;
        if (!currentPassword) valid = setFieldError('current-password', 'Введите текущий пароль');
        if (!newPassword) valid = setFieldError('new-password', 'Введите новый пароль');
        else if (newPassword.length < 8) valid = setFieldError('new-password', 'Минимум 8 символов');
        if (newPassword && confirmPassword !== newPassword) {
            valid = setFieldError('confirm-new-password', 'Пароли не совпадают');
        }
        if (!valid) return;

        const data = await api('/api/change-password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
        });
        if (data.success) {
            showToast(data.message, 'success');
            closeModal(elements.passwordModal);
            setTimeout(() => {
                currentUser = null;
                showAuth();
            }, 1500);
        } else {
            setFieldError('current-password', data.message);
        }
    });

    document.querySelectorAll('.color-option').forEach(btn => {
        btn.addEventListener('click', async () => {
            const color = btn.dataset.color;
            const data = await api('/api/user/avatar-color', {
                method: 'POST',
                body: JSON.stringify({ avatarColor: color }),
            });
            if (data.success) {
                elements.profileAvatar.style.background = color;
                if (currentUser) currentUser.avatar = color;
                document.querySelectorAll('.color-option').forEach(o => o.classList.remove('active'));
                btn.classList.add('active');
                showToast('Цвет обновлён', 'success');
            }
        });
    });

    elements.sendBtn.addEventListener('click', sendMessage);
    // keydown, а не устаревший keypress. Enter, которым подтверждают слово
    // в IME (японский, китайский, корейский ввод, часть экранных
    // клавиатур), не должен отправлять недописанное сообщение: isComposing,
    // а keyCode 229 — для Safari, где isComposing на этом Enter уже false.
    elements.messageInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        sendMessage();
    });

    elements.attachBtn.addEventListener('click', () => elements.fileInput.click());
    elements.fileInput.addEventListener('change', handleFileUpload);
    elements.cancelReplyBtn.addEventListener('click', clearReply);

    elements.replyMessageBtn.addEventListener('click', () => {
        replyToMessageId = elements.messageMenu.dataset.forMessage;
        const text = elements.messageMenu.dataset.forMessageText;
        elements.replyPreviewText.textContent = text.substring(0, 100);
        elements.replyPreview.classList.remove('hidden');
        hideMessageMenu();
    });

    elements.editMessageBtn.addEventListener('click', () => {
        editingMessageId = elements.messageMenu.dataset.forMessage;
        const text = elements.messageMenu.dataset.forMessageText;
        elements.messageInput.value = text;
        elements.messageInput.focus();
        hideMessageMenu();
    });

    elements.deleteMessageBtn.addEventListener('click', () => {
        hideMessageMenu();
        scheduleDelete(elements.messageMenu.dataset.forMessage);
    });

    let searchTimeout;
    elements.searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(performSearch, 300);
    });

    elements.chatEncryption.addEventListener('click', () => {
        if (currentChatId) openSafetyModal(currentChatId);
    });

    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.addEventListener('click', () => closeModal(btn.closest('dialog')));
    });

    document.querySelectorAll('dialog.modal').forEach(dialog => {
        // Клик по затемнению вокруг окна. Сам dialog без полей, поэтому
        // клик с target === dialog — это клик по ::backdrop, а не по окну.
        // Нажатие тоже должно быть на затемнении: если выделять текст в
        // окне и отпустить кнопку снаружи, click приходит на dialog —
        // общего предка, — и окно закрывалось посреди выделения.
        let pressedOnBackdrop = false;
        dialog.addEventListener('pointerdown', e => { pressedOnBackdrop = e.target === dialog; });
        dialog.addEventListener('click', e => {
            if (e.target === dialog && pressedOnBackdrop) closeModal(dialog);
            pressedOnBackdrop = false;
        });
        // Esc закрывает окно сам (событие cancel) — ошибки полей чистим и тут.
        // Тост, если он жил внутри окна, возвращается в body и остаётся виден.
        dialog.addEventListener('close', () => {
            clearFieldErrors(dialog);
            const toast = elements.toast;
            if (dialog.contains(toast)) {
                const wasOpen = toast.matches(':popover-open');
                if (wasOpen) toast.hidePopover();
                document.body.appendChild(toast);
                if (wasOpen) toast.showPopover();
            }
        });
    });

    setupMessageMenu();
    setupMessageKeyboard();
    setupMobileScreens();
    // Не дожидаемся таймера отмены, если страницу закрывают.
    window.addEventListener('pagehide', flushPendingDeletes);

    // Сообщения обрабатываются строго по одному, в порядке прихода. Иначе
    // второе сообщение группы могло бы начать расшифровываться раньше, чем
    // первое принесёт ключ, и показалось бы заглушкой.
    let incoming = Promise.resolve();
    socket.on('newMessage', message => {
        incoming = incoming.then(() => handleNewMessage(message)).catch(error => {
            console.error('Ошибка обработки сообщения:', error);
        });
    });

    socket.on('messageEdited', ({ id, text, chat_id, room_id }) => {
        if (chat_id == currentChatId || room_id == currentRoomId) {
            const bubble = elements.chatMessages.querySelector(`[data-message-id="${id}"]`);
            if (!bubble) return;
            const textEl = bubble.querySelector('.message-text');
            if (textEl) textEl.textContent = text;
            if (!bubble.querySelector('.edited-label')) {
                const contentEl = bubble.querySelector('.message-content');
                if (contentEl) {
                    const label = document.createElement('div');
                    label.className = 'edited-label';
                    label.textContent = 'изменено';
                    contentEl.appendChild(label);
                }
            }
        }
    });

    socket.on('messageDeleted', ({ id, chat_id, room_id }) => {
        if (chat_id == currentChatId || room_id == currentRoomId) {
            const bubble = elements.chatMessages.querySelector(`[data-message-id="${id}"]`);
            if (bubble) removeMessageElement(bubble);
        }
    });

    // Меню стоит на месте, а переписка под ним прокручивается — оно бы
    // «отклеилось» от сообщения. Закрываем, как и системные меню.
    elements.chatMessages.addEventListener('scroll', () => hideMessageMenu(), { passive: true });
}

/* --- Окна ------------------------------------------------------------------
   <dialog> + showModal(): фокус заперт внутри окна и возвращается туда,
   откуда окно открыли, Esc закрывает, фон недоступен для мыши и экранного
   диктора (inert), а слой — верхний, без ручного оверлея и z-index. */

function openModal(modal) {
    if (modal.open) return;
    modal.showModal();
    // Тост, показанный до окна, остался бы под затемнением: вне окна всё
    // inert, и крестик с кнопкой действия не нажимались бы. Переносим его
    // внутрь и показываем заново — так он поднимается над окном.
    const toast = elements.toast;
    if (toast.matches(':popover-open') && !modal.contains(toast)) {
        toast.hidePopover();
        modal.appendChild(toast);
        toast.showPopover();
    }
}

function closeModal(modal) {
    if (!modal) return;
    clearFieldErrors(modal);
    if (modal.open) modal.close();
}

// Скелетон повторяет форму реального элемента списка — круглая аватарка и
// две строки разной длины, — поэтому подмена на данные не двигает вёрстку.
// Ширины строк намеренно разные: ряд одинаковых полосок выдаёт заглушку.
function renderChatsSkeleton(count = 5) {
    elements.chatsList.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const item = document.createElement('div');
        item.className = 'skeleton-item';

        const avatar = document.createElement('div');
        avatar.className = 'skeleton skeleton-avatar';

        const lines = document.createElement('div');
        lines.className = 'skeleton-lines';
        const title = document.createElement('div');
        title.className = 'skeleton skeleton-line';
        title.style.width = (54 + (i % 3) * 14) + '%';
        const subtitle = document.createElement('div');
        subtitle.className = 'skeleton skeleton-line skeleton-line-sm';
        subtitle.style.width = (32 + (i % 4) * 10) + '%';
        lines.append(title, subtitle);

        item.append(avatar, lines);
        elements.chatsList.appendChild(item);
    }
}

function renderChatsPlaceholder(text) {
    elements.chatsList.innerHTML = '';
    const note = document.createElement('p');
    note.className = 'chats-placeholder';
    note.textContent = text;
    elements.chatsList.appendChild(note);
}

async function loadChats() {
    // Скелетон показывается только когда в списке ещё нечего показать:
    // перерисовка после socket-события не должна мигать заглушкой.
    if (!elements.chatsList.querySelector('.chat-item')) {
        renderChatsSkeleton();
    }

    const data = await api('/api/chats');
    if (!data.success) {
        // Без этой ветки скелетон остался бы висеть навсегда.
        renderChatsPlaceholder('Не удалось загрузить чаты');
        return;
    }

    elements.chatsList.innerHTML = '';
    if (!data.chats.length) {
        renderChatsPlaceholder('Чатов пока нет');
        return;
    }

    // for...of, а не forEach: превью зашифрованных чатов лежит в IndexedDB,
    // и его чтение асинхронно.
    for (const chat of data.chats) {
        const div = document.createElement('div');
        div.className = 'chat-item';
        div.dataset.id = chat.id;
        div.dataset.roomId = chat.room_id || '';
        div.innerHTML = `
            <div class="chat-avatar-small" style="background:${chat.avatar && chat.avatar.startsWith('#') ? chat.avatar : DEFAULT_AVATAR}">${chat.name.charAt(0).toUpperCase()}</div>
            <div class="chat-info">
                <div class="chat-name">${escapeHtml(chat.name)}</div>
                <div class="chat-last">${escapeHtml(await chatPreview(chat))}</div>
            </div>
            ${chat.unread > 0 ? `<div class="chat-badge">${chat.unread}</div>` : ''}
        `;
        div.addEventListener('click', () => openChat(chat.id, chat.room_id, chat.name, chat.avatar, chat.online, chat.is_bot));
        elements.chatsList.appendChild(div);
    }
}

/**
 * Превью последнего сообщения.
 *
 * Для зашифрованного чата сервер его дать не может — в базе нет текста.
 * Поэтому берём то, что клиент расшифровал сам. Если это устройство чат
 * ещё не открывало, превью честно нет.
 */
async function chatPreview(chat) {
    if (chat.last_message) return chat.last_message.substring(0, 30);
    if (e2ee) {
        const cached = await e2ee.recallPreview(chat.id);
        if (cached) return cached.substring(0, 30);
    }
    return 'Нет сообщений';
}

/* --- Телефон: список и переписка — два экрана ---------------------------
   Открытый чат прячет список, кнопка «назад» (и системная «назад» — через
   history) возвращает к нему. Невидимый экран делается inert, чтобы его
   кнопки не ловили Tab и экранный диктор. На широком экране — ничего. */

const mobileLayout = window.matchMedia('(max-width: 640px)');

function showChatScreen(show) {
    elements.sidebar.classList.toggle('hidden-mobile', show);
    applyMobileInert();
}

function applyMobileInert() {
    const chatShown = elements.sidebar.classList.contains('hidden-mobile');
    elements.sidebar.inert = mobileLayout.matches && chatShown;
    elements.mainContent.inert = mobileLayout.matches && !chatShown;
}

function setupMobileScreens() {
    mobileLayout.addEventListener('change', applyMobileInert);
    applyMobileInert();
    elements.chatBackBtn.addEventListener('click', () => {
        if (history.state && history.state.nyxoChat) history.back();
        else backToChatList();
    });
    window.addEventListener('popstate', () => {
        if (!(history.state && history.state.nyxoChat)) backToChatList();
    });
}

function backToChatList() {
    showChatScreen(false);
    elements.chatsList.querySelector('.chat-item.active')?.focus();
}

async function openChat(chatId, roomId, name, avatar, online, isBot) {
    showChatScreen(true);
    if (mobileLayout.matches && !(history.state && history.state.nyxoChat)) {
        history.pushState({ nyxoChat: true }, '');
    }
    currentChatId = chatId;
    currentRoomId = roomId;
    currentChatIsBot = Boolean(isBot);
    // Расшифрованные вложения прошлого чата больше не нужны в памяти.
    if (e2ee) e2ee.releaseAttachments();
    refreshEncryptionBadge(chatId, isBot);
    elements.chatsList.querySelectorAll('.chat-item').forEach(item => {
        item.classList.toggle('active', item.dataset.id === String(chatId));
    });
    elements.chatName.textContent = name;
    elements.chatStatus.textContent = isBot ? 'Бот' : (online ? 'В сети' : 'Не в сети');
    elements.chatStatus.className = 'status ' + (online ? 'online' : 'offline');
    elements.chatAvatar.textContent = name.charAt(0).toUpperCase();
    elements.chatAvatar.style.background = (avatar && avatar.startsWith('#')) ? avatar : DEFAULT_AVATAR;
    elements.chatHeader.classList.remove('hidden');
    elements.messageInputContainer.classList.remove('hidden');
    elements.emptyState.classList.add('hidden');
    elements.chatMessages.innerHTML = '';

    const data = await api(`/api/messages/${chatId}`);
    if (!data.success) return;

    if (data.messages) {
        // Последовательно, а не Promise.all: у Double Ratchet состояние
        // сессии меняется на каждом сообщении, и параллельная расшифровка
        // двух сообщений одной сессии затирала бы состояние друг друга.
        // Ключи групп — до сообщений: без них групповые не расшифровать.
        if (e2ee && data.keyEnvelopes) await e2ee.processKeyEnvelopes(data.keyEnvelopes);
        for (const msg of data.messages) await appendMessageDecrypted(msg);
        scrollToBottom();
    }

    const roomKey = roomId ? `room:${roomId}` : `chat:${chatId}`;
    socket.emit('joinChat', roomKey);
}

/* --- Время и дни ----------------------------------------------------------
   Сервер присылает момент отправки (created_at, с часовым поясом), а
   форматирует клиент — в своём поясе. Раньше приходила строка «ЧЧ:ММ» в
   поясе сервера: у собеседника в другом поясе время было неверным, а по
   какому дню сообщение, не было видно вовсе. Язык — язык интерфейса. */

const UI_LOCALE = document.documentElement.lang || 'ru';
const timeFormat = new Intl.DateTimeFormat(UI_LOCALE, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(UI_LOCALE, { day: 'numeric', month: 'long' });
const dayWithYearFormat = new Intl.DateTimeFormat(UI_LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
const fullFormat = new Intl.DateTimeFormat(UI_LOCALE, { dateStyle: 'long', timeStyle: 'short' });

function messageDate(message) {
    const date = message.created_at ? new Date(message.created_at) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
}

// Ключ дня в поясе пользователя: сравнивать надо по местному календарю.
const dayKey = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

function dayLabel(date) {
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (dayKey(date) === dayKey(today)) return 'Сегодня';
    if (dayKey(date) === dayKey(yesterday)) return 'Вчера';
    return (date.getFullYear() === today.getFullYear() ? dayFormat : dayWithYearFormat).format(date);
}

function lastDayInChat() {
    const bubbles = elements.chatMessages.querySelectorAll('[data-day]');
    return bubbles.length ? bubbles[bubbles.length - 1].dataset.day : null;
}

function appendMessage(message) {
    const el = createMessageElement(message);
    const date = messageDate(message);
    if (date) {
        el.dataset.day = dayKey(date);
        if (lastDayInChat() !== el.dataset.day) {
            const separator = document.createElement('div');
            separator.className = 'day-separator';
            separator.setAttribute('role', 'separator');
            separator.dataset.day = el.dataset.day;
            const label = document.createElement('span');
            label.textContent = dayLabel(date);
            separator.appendChild(label);
            elements.chatMessages.appendChild(separator);
        }
    }
    elements.chatMessages.appendChild(el);
    refreshMessageTabStop();
}

/**
 * Убрать пузырь сообщения. Если это было последнее сообщение дня,
 * вместе с ним уходит и разделитель, иначе он висел бы над пустотой.
 */
function removeMessageElement(el) {
    const prev = el.previousElementSibling;
    const next = el.nextElementSibling;
    el.remove();
    if (prev && prev.classList.contains('day-separator')
        && (!next || next.classList.contains('day-separator'))) {
        prev.remove();
    }
    refreshMessageTabStop();
}

/* --- Клавиатура в переписке ----------------------------------------------
   Вся переписка — одна остановка Tab, как список в системных программах:
   раньше каждая кнопка «⋯» была отдельной остановкой, и до поля ввода
   приходилось пролистывать все сообщения. Tab приводит на одно сообщение
   (последнее или то, где были), стрелки ходят по сообщениям, Enter или
   клавиша меню открывает действия. */

const visibleMessages = () => [...elements.chatMessages.querySelectorAll('.message')].filter(m => !m.hidden);

function refreshMessageTabStop() {
    const current = elements.chatMessages.querySelector('.message[tabindex="0"]');
    if (current && !current.hidden && current.isConnected && current.contains(document.activeElement)) return;
    const list = visibleMessages();
    const target = list[list.length - 1] || null;
    if (current && current !== target) current.tabIndex = -1;
    if (target) target.tabIndex = 0;
}

function setMessageTabStop(message) {
    elements.chatMessages.querySelectorAll('.message[tabindex="0"]').forEach(m => { m.tabIndex = -1; });
    message.tabIndex = 0;
}

function focusMessage(message) {
    setMessageTabStop(message);
    message.focus();
}

function setupMessageKeyboard() {
    const list = elements.chatMessages;
    // Щелчок или фокус на сообщении переносит на него остановку Tab.
    list.addEventListener('focusin', e => {
        const message = e.target.closest && e.target.closest('.message');
        if (message && message.tabIndex !== 0) setMessageTabStop(message);
    });
    list.addEventListener('keydown', e => {
        const message = e.target.classList && e.target.classList.contains('message') ? e.target : null;
        if (!message) return;   // кнопки и ссылки внутри сообщения — сами
        const all = visibleMessages();
        const index = all.indexOf(message);
        const next = { ArrowDown: all[index + 1], ArrowUp: all[index - 1], Home: all[0], End: all[all.length - 1] }[e.key];
        if (next) {
            e.preventDefault();
            focusMessage(next);
            next.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' || e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault();
            message.openMenu?.();
        }
    });
}

// Элементы с файлом (img/video/audio/a) собираются через DOM API, а не через
// шаблонную строку с сырым message.file_url — см. п.2 аудита. file_url сейчас
// всегда безопасен (имя генерируется сервером из Date.now()+random), но даже
// если бы в нём оказались произвольные символы, .src/.href — это присвоение
// свойства, а не вставка HTML-текста, так что вырваться из атрибута нельзя.
// Заодно клик по картинке навешан через addEventListener, а не инлайновый
// onclick, который CSP (script-src без 'unsafe-inline') всё равно блокирует.
/**
 * Зашифрованное вложение: сначала заглушка, потом — по мере скачивания и
 * расшифровки — картинка, видео или ссылка на скачивание.
 */
function createEncryptedAttachmentElement(p) {
    const holder = document.createElement('div');
    holder.className = 'encrypted-attachment';
    const loading = document.createElement('div');
    loading.className = 'skeleton attachment-skeleton';
    holder.appendChild(loading);

    e2ee.openAttachment(p).then(({ url, kind }) => {
        holder.replaceChildren();
        if (kind === 'image') {
            const img = document.createElement('img');
            img.src = url;
            img.alt = p.name;
            img.className = 'message-image';
            holder.appendChild(img);
        } else if (kind === 'video') {
            const video = document.createElement('video');
            video.src = url;
            video.controls = true;
            video.className = 'message-video';
            holder.appendChild(video);
        } else {
            // Только скачивание, без target=_blank: открытие blob-ссылки во
            // вкладке исполнило бы файл в нашем origin.
            const wrapper = document.createElement('div');
            wrapper.className = 'file-attachment';
            const a = document.createElement('a');
            a.href = url;
            a.download = p.name;
            a.appendChild(createIcon('i-file'));
            const nameSpan = document.createElement('span');
            nameSpan.textContent = `${p.name} · ${formatSize(p.size)}`;
            a.appendChild(nameSpan);
            wrapper.appendChild(a);
            holder.appendChild(wrapper);
        }
    }).catch(err => {
        const em = document.createElement('em');
        em.className = 'message-locked';
        em.textContent = `Вложение недоступно: ${err.message}`;
        holder.replaceChildren(em);
    });
    return holder;
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function createFileAttachmentElement(message) {
    const { file_url, file_name, message_type } = message;
    if (message_type === 'image') {
        const img = document.createElement('img');
        img.src = file_url;
        img.className = 'message-image';
        img.loading = 'lazy';
        img.addEventListener('click', () => window.open(file_url, '_blank'));
        return img;
    }
    if (message_type === 'video') {
        const video = document.createElement('video');
        video.src = file_url;
        video.controls = true;
        video.className = 'message-video';
        return video;
    }
    // Аудио больше нельзя отправить, но сообщения из истории, записанные до
    // отключения этой возможности, по-прежнему должны проигрываться.
    if (message_type === 'audio') {
        const audio = document.createElement('audio');
        audio.src = file_url;
        audio.controls = true;
        audio.className = 'message-audio';
        return audio;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'file-attachment';
    const a = document.createElement('a');
    a.href = file_url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.download = file_name || 'file';
    a.appendChild(createIcon('i-file'));
    const nameSpan = document.createElement('span');
    nameSpan.textContent = file_name || 'Файл';
    a.appendChild(nameSpan);
    wrapper.appendChild(a);
    return wrapper;
}

function createMessageElement(message) {
    const isMine = message.user_id === (currentUser ? currentUser.id : 0);
    const div = document.createElement('div');
    div.className = `message ${isMine ? 'sent' : 'received'}`;
    div.dataset.messageId = message.id;
    div.tabIndex = -1;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    if (message.deleted) {
        const em = document.createElement('em');
        em.textContent = 'Сообщение удалено';
        contentDiv.appendChild(em);
    } else if (message.undecryptable) {
        // Сообщение зашифровано, но ключа у этого устройства нет: оно
        // появилось в чате позже. Показываем это прямо, а не пустотой.
        const em = document.createElement('em');
        em.className = 'message-locked';
        em.textContent = 'Сообщение недоступно на этом устройстве';
        contentDiv.appendChild(em);
    } else {
        if (message.reply_to) {
            const replyDiv = document.createElement('div');
            replyDiv.className = 'reply-to';
            const author = document.createElement('span');
            author.className = 'reply-to-author';
            author.textContent = message.reply_to.sender_username || 'Неизвестно';
            const quoted = document.createElement('span');
            quoted.className = 'reply-to-text';
            // Текст удалённого сообщения сервер стирает — цитировать нечего.
            quoted.textContent = message.reply_to.deleted
                ? 'Сообщение удалено'
                : (message.reply_to.text || '').substring(0, 60);
            replyDiv.append(author, quoted);
            contentDiv.appendChild(replyDiv);
        }
        if (message.file_url) {
            contentDiv.appendChild(createFileAttachmentElement(message));
        }
        if (message.encryptedFile) {
            contentDiv.appendChild(createEncryptedAttachmentElement(message.encryptedFile));
        }
        if (message.brokenAttachment) {
            const em = document.createElement('em');
            em.className = 'message-locked';
            em.textContent = 'Повреждённое вложение';
            contentDiv.appendChild(em);
        }
        // Пустой текст у вложения не рисуем: иначе под картинкой остаётся
        // пустая строка с отступом.
        if (message.text || !(message.encryptedFile || message.brokenAttachment)) {
            const textDiv = document.createElement('div');
            textDiv.className = 'message-text';
            textDiv.textContent = message.text || '';
            contentDiv.appendChild(textDiv);
        }

        if (message.edited_at) {
            const editedDiv = document.createElement('div');
            editedDiv.className = 'edited-label';
            editedDiv.textContent = 'изменено';
            contentDiv.appendChild(editedDiv);
        }
        if (message.reactions && message.reactions.length > 0) {
            const reactionsDiv = document.createElement('div');
            reactionsDiv.className = 'reactions';
            message.reactions.forEach(r => {
                const span = document.createElement('span');
                span.className = 'reaction';
                span.textContent = r;
                reactionsDiv.appendChild(span);
            });
            contentDiv.appendChild(reactionsDiv);
        }
    }

    const metaDiv = document.createElement('div');
    metaDiv.className = 'message-meta';
    if (message.encrypted) {
        const lock = document.createElement('span');
        lock.className = 'message-encrypted';
        lock.title = 'Сквозное шифрование';
        lock.appendChild(createIcon('i-lock'));
        metaDiv.appendChild(lock);
    }
    const timeSpan = document.createElement('time');
    timeSpan.className = 'message-time';
    const sentAt = messageDate(message);
    if (sentAt) {
        timeSpan.dateTime = sentAt.toISOString();
        timeSpan.textContent = timeFormat.format(sentAt);
        timeSpan.title = fullFormat.format(sentAt);
    } else {
        timeSpan.textContent = message.time || '';
    }
    metaDiv.appendChild(timeSpan);
    if (isMine) {
        const statusSpan = document.createElement('span');
        statusSpan.className = 'message-status';
        statusSpan.textContent = message.status === 'read' ? '✓✓' : (message.status === 'delivered' ? '✓' : '○');
        metaDiv.appendChild(statusSpan);
    }

    div.appendChild(contentDiv);
    div.appendChild(metaDiv);

    // Кнопка «⋯» — меню для клавиатуры и тача, где правого клика нет.
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'icon-btn icon-btn-sm icon-btn-quiet message-more';
    more.setAttribute('aria-label', 'Действия с сообщением');
    more.setAttribute('aria-haspopup', 'menu');
    more.tabIndex = -1;
    more.appendChild(createIcon('i-more'));
    more.addEventListener('click', e => {
        e.stopPropagation();
        const rect = more.getBoundingClientRect();
        showMessageMenu(rect.left, rect.bottom + 4, message, div);
    });
    div.appendChild(more);
    // С клавиатуры: меню под сообщением, фокус потом возвращается на него.
    if (!message.deleted) {
        div.openMenu = () => {
            const rect = div.getBoundingClientRect();
            showMessageMenu(rect.left, rect.bottom + 4, message, div);
        };
    }

    div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (message.deleted) return;
        showMessageMenu(e.clientX, e.clientY, message);
    });

    div.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showMessageMenu(touch.clientX, touch.clientY, message);
        }, 600);
    }, { passive: true });

    div.addEventListener('touchend', () => clearTimeout(longPressTimer));
    div.addEventListener('touchmove', () => clearTimeout(longPressTimer));

    return div;
}

/* --- Меню сообщения --------------------------------------------------------
   popover в верхнем слое. Открывается правым кликом, долгим нажатием и
   кнопкой «⋯» — последняя нужна клавиатуре и тачу, где правого клика нет.

   popover="manual", а закрытие по клику мимо и по Esc — своё. У
   popover="auto" это делает браузер, но в Linux и macOS contextmenu
   приходит на НАЖАТИИ кнопки мыши: меню открывалось, а отпускание той же
   кнопки браузер считал кликом мимо и тут же меню закрывал. */

let menuTrigger = null;

function menuItems() {
    return [...elements.messageMenu.querySelectorAll('.menu-item')].filter(b => !b.hidden);
}

/**
 * Показать меню у точки (x, y) в координатах окна. trigger — сообщение,
 * если меню открыли кнопкой «⋯» или с клавиатуры: фокус уходит в меню и
 * потом возвращается на сообщение.
 */
function showMessageMenu(x, y, message, trigger = null) {
    const menu = elements.messageMenu;
    // Не data-message-id: по этому атрибуту ищут пузыри сообщений, и после
    // удаления пузыря находилось бы само меню.
    menu.dataset.forMessage = message.id;
    menu.dataset.forMessageText = message.text || '';
    const isMine = message.user_id === (currentUser ? currentUser.id : 0);
    // Правка зашифрованного сообщения ушла бы на сервер открытым текстом,
    // поэтому её нет вовсе — удалить и отправить заново можно.
    elements.editMessageBtn.hidden = !(isMine && !message.encrypted);
    elements.deleteMessageBtn.hidden = !isMine;

    menuTrigger = trigger;
    if (menu.matches(':popover-open')) menu.hidePopover();
    menu.showPopover();
    // Размер известен только после показа: прижимаем меню к краям окна.
    const margin = 8;
    menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - menu.offsetWidth - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - menu.offsetHeight - margin))}px`;
    if (trigger) menuItems()[0]?.focus();
}

function setupMessageMenu() {
    const menu = elements.messageMenu;
    // Нажатие мимо меню закрывает его. pointerdown, а не click: правый клик,
    // открывающий меню, начинается раньше, чем меню появилось.
    // Кнопка «⋯» того же сообщения — исключение: её click сам покажет меню.
    document.addEventListener('pointerdown', e => {
        const ownMoreButton = menuTrigger && e.target.closest && e.target.closest('.message-more')
            && menuTrigger.contains(e.target);
        if (menu.matches(':popover-open') && !menu.contains(e.target) && !ownMoreButton) {
            hideMessageMenu();
        }
    }, true);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && menu.matches(':popover-open')) {
            e.preventDefault();
            hideMessageMenu();
        }
    });
    // Стрелки по пунктам — как в системных меню (role="menu").
    menu.addEventListener('keydown', e => {
        const items = menuItems();
        const index = items.indexOf(document.activeElement);
        let next = null;
        if (e.key === 'ArrowDown') next = items[(index + 1) % items.length];
        else if (e.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
        else if (e.key === 'Home') next = items[0];
        else if (e.key === 'End') next = items[items.length - 1];
        if (next) {
            e.preventDefault();
            next.focus();
        }
    });
    menu.addEventListener('toggle', e => {
        if (e.newState === 'closed' && menuTrigger && menuTrigger.isConnected
            && (!document.activeElement || document.activeElement === document.body || menu.contains(document.activeElement))) {
            menuTrigger.focus();
        }
        if (e.newState === 'closed') menuTrigger = null;
    });
}

/* --- Удаление с отменой ----------------------------------------------------
   Сообщение сначала только прячется, а удаляется на сервере через 5 секунд
   — если за это время не нажали «Вернуть». Удалённое на сервере вернуть
   нельзя: содержимое стирается по-настоящему. */

const UNDO_DELETE_MS = 5000;
const pendingDeletes = new Map();

function scheduleDelete(messageId) {
    const el = elements.chatMessages.querySelector(`[data-message-id="${messageId}"]`);
    if (!el || pendingDeletes.has(messageId)) return;
    el.hidden = true;
    refreshMessageTabStop();
    pendingDeletes.set(messageId, { el, timer: setTimeout(() => commitDelete(messageId), UNDO_DELETE_MS) });
    showToast('Сообщение удалено', 'info', {
        duration: UNDO_DELETE_MS,
        action: { label: 'Вернуть', onClick: () => undoDelete(messageId) },
    });
}

function undoDelete(messageId) {
    const pending = pendingDeletes.get(messageId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDeletes.delete(messageId);
    pending.el.hidden = false;
    refreshMessageTabStop();
}

async function commitDelete(messageId) {
    const pending = pendingDeletes.get(messageId);
    if (!pending) return;
    pendingDeletes.delete(messageId);
    clearTimeout(pending.timer);
    const data = await api(`/api/messages/${messageId}`, { method: 'DELETE' });
    if (data && data.success) {
        if (pending.el.isConnected) removeMessageElement(pending.el);
    } else {
        pending.el.hidden = false;
        showToast(`Сообщение не удалено: ${(data && data.message) || 'ошибка сети'}`, 'error');
    }
}

/** Страницу закрывают — удаляем сразу; keepalive доживает до конца запроса. */
function flushPendingDeletes() {
    for (const [messageId, pending] of pendingDeletes) {
        clearTimeout(pending.timer);
        fetch(`/api/messages/${messageId}`, {
            method: 'DELETE',
            keepalive: true,
            credentials: 'same-origin',
            headers: { 'X-CSRF-Token': getCsrfToken() },
        });
    }
    pendingDeletes.clear();
}

async function handleNewMessage(message) {
    if (message.chat_id == currentChatId || message.room_id == currentRoomId) {
        await appendMessageDecrypted(message);
        scrollToBottom();
    } else {
        // Чужой чат: расшифровываем ради превью в списке, рисовать
        // нечего.
        if (message.encrypted && e2ee) {
            const raw = await resolveMessageText(message);
            if (raw !== null) {
                await e2ee.rememberPreview(message.chat_id, e2ee.payloadPreview(e2ee.decodePayload(raw)));
            }
        }
        loadChats();
    }
}

function hideMessageMenu() {
    if (elements.messageMenu.matches(':popover-open')) elements.messageMenu.hidePopover();
}

function clearReply() {
    replyToMessageId = null;
    elements.replyPreview.classList.add('hidden');
    elements.replyPreviewText.textContent = '';
}

async function sendMessage() {
    const text = elements.messageInput.value.trim();
    if (!text) return;
    if (!currentChatId) {
        showToast('Выберите чат', 'error');
        return;
    }
    const payload = { chatId: currentChatId, text };
    if (replyToMessageId) payload.replyToId = replyToMessageId;

    if (editingMessageId) {
        const data = await api(`/api/messages/${editingMessageId}`, {
            method: 'PUT',
            body: JSON.stringify({ text }),
        });
        if (data.success) {
            showToast('Сообщение изменено', 'success');
            const el = elements.chatMessages.querySelector(`[data-message-id="${editingMessageId}"] .message-text`);
            if (el) el.textContent = text;
        }
        editingMessageId = null;
    } else {
        const outcome = await sendEncrypted(text, payload);
        // Не отправилось — текст остаётся в поле: иначе его пришлось бы
        // набирать заново.
        if (outcome === 'failed') return;
        if (outcome === 'plain') {
            await api('/api/messages', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
        }
    }

    elements.messageInput.value = '';
    clearReply();
}

/**
 * Зашифровать и отправить готовую полезную нагрузку (текст или вложение).
 *
 * chatId передаётся явно, а не берётся из currentChatId: пока шифруется и
 * загружается файл, пользователь может переключить чат, и сообщение ушло
 * бы не туда.
 *
 * Возвращает { sent: false }, только если в чате не для кого шифровать.
 * Любая другая неудача — исключение: откатываться на открытый путь после
 * провала шифрования нельзя, человек считал бы переписку защищённой.
 */
async function sendEncryptedPayload(chatId, encoded, { replyToId = null, blobIds = [] } = {}) {
    const encrypted = await e2ee.encryptForChat(chatId, encoded);
    const { targets, rejected } = encrypted;
    if (targets.length === 0) return { sent: false };
    // Получатели есть, а прочитать не сможет никто: ключи не выдал сервер
    // или все они подменены. Уходить в открытый текст здесь нельзя —
    // индикатор обещает шифрование.
    if (encrypted.readers === 0) {
        throw new Error(rejected.length > 0
            ? 'ключи устройств собеседника не совпадают с известными'
            : 'не удалось получить ключи собеседника');
    }

    // Попарно — конверт с содержимым на каждое устройство; в группе —
    // один шифротекст на всех и ключ только тем, у кого его ещё нет.
    const body = encrypted.mode === 'group'
        ? { chatId, replyToId, blobIds, group: encrypted.group, keyEnvelopes: encrypted.keyEnvelopes }
        : { chatId, replyToId, blobIds, envelopes: encrypted.envelopes };
    const data = await api('/api/messages/encrypted', { method: 'POST', body: JSON.stringify(body) });
    if (!data || !data.success) throw new Error((data && data.message) || 'сервер не принял сообщение');
    await encrypted.commit();

    // Своё содержимое — локально: конверт себе не отправляется. По этой же
    // причине своё сообщение приходится дорисовать самому: сокет-события о
    // нём не будет.
    await e2ee.rememberSent(data.message.id, encoded);
    const content = e2ee.decodePayload(encoded);
    const preview = e2ee.payloadPreview(content);
    await e2ee.rememberPreview(chatId, preview);
    updateChatPreviewInList(data.message, preview);

    if (chatId === currentChatId) {
        const local = { ...data.message };
        applyDecryptedContent(local, content);
        appendMessage(local);
        scrollToBottom();
    }

    // Устройства, для которых конверта не нашлось: у них сообщение не
    // прочитается, и об этом честнее сказать сразу.
    if (rejected.length > 0) {
        showToast(rejected.length === 1
            ? 'Ключ устройства собеседника не совпадает с известным — ему сообщение не отправлено'
            : `Ключи ${devicesGenitive(rejected.length)} собеседника не совпадают с известными — им сообщение не отправлено`,
        'error');
    }
    const missing = [...(data.missingDeviceIds || []), ...encrypted.undelivered]
        .filter(id => id !== e2eeDeviceId && !rejected.includes(id));
    if (missing.length > 0) {
        showToast(`Сообщение не дойдёт до ${devicesGenitive(missing.length)}: нет ключей`, 'error');
    }
    return { sent: true };
}

/** «до 1 устройства», «до 5 устройств», «до 21 устройства». */
function devicesGenitive(n) {
    const one = n % 10 === 1 && n % 100 !== 11;
    return `${n} ${one ? 'устройства' : 'устройств'}`;
}

/** Итог: 'sent', 'plain' (шифровать не для кого) или 'failed'. */
async function sendEncrypted(text, payload) {
    if (!e2ee || !e2ee.isReady()) return 'plain';
    const chatId = currentChatId;
    try {
        const result = await sendEncryptedPayload(chatId, e2ee.encodeText(text), {
            replyToId: payload.replyToId || null,
        });
        // В чате не для кого шифровать (бот, никто не присоединился) —
        // это единственный случай, когда уходим на открытый путь.
        return result.sent ? 'sent' : 'plain';
    } catch (error) {
        const replyToId = payload.replyToId || null;
        reportEncryptedSendError('Сообщение не отправлено', chatId, error,
            () => resendText(chatId, text, replyToId));
        return 'failed';
    }
}

/**
 * «Повторить» из тоста об ошибке. Раньше кнопка вызывала sendMessage, а
 * та берёт текущий чат и то, что сейчас в поле ввода: переключился на
 * другой чат — и повтор уходил туда. Теперь повторяется то же сообщение в
 * тот же чат; текст из поля убирается, только если это он и есть.
 */
async function resendText(chatId, text, replyToId) {
    try {
        const result = await sendEncryptedPayload(chatId, e2ee.encodeText(text), { replyToId });
        if (!result.sent) {
            const data = await api('/api/messages', { method: 'POST', body: JSON.stringify({ chatId, text, replyToId }) });
            if (!data.success) throw new Error(data.message || 'ошибка сервера');
        }
        if (chatId === currentChatId && elements.messageInput.value.trim() === text) {
            elements.messageInput.value = '';
            clearReply();
        }
    } catch (error) {
        reportEncryptedSendError('Сообщение не отправлено', chatId, error,
            () => resendText(chatId, text, replyToId));
    }
}

function reportEncryptedSendError(prefix, chatId, error, retry = null) {
    console.error('[E2EE] отправка не удалась:', error);
    // Если отправку остановила сверка ключей, из ошибки сразу можно перейти
    // к ней; иначе — повторить то же самое в тот же чат.
    const action = error.code === 'verification-changed'
        ? { label: 'Сверить ключи', onClick: () => openSafetyModal(chatId) }
        : (retry ? { label: 'Повторить', onClick: retry } : null);
    showToast(`${prefix}: ${error.message}`, 'error', { action });
    // Отправку остановила сверка — индикатор должен это показать сразу,
    // а не после переоткрытия чата.
    if (error.code === 'verification-changed' && chatId === currentChatId) {
        refreshEncryptionBadge(chatId, currentChatIsBot);
    }
}

// Сервер принимает до 50 МБ шифротекста; GCM добавляет 16 байт тега.
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024 - 16;

/**
 * Отправить файл зашифрованным: очистить метаданные (для картинок),
 * зашифровать своим ключом, загрузить непрозрачные байты, отправить ключ
 * внутри E2EE-сообщения.
 */
async function sendEncryptedFile(chatId, file) {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('файл больше 50 МБ');

    const { ciphertext, meta } = await e2ee.encryptAttachment(file);

    const upload = await fetch(`/api/blobs?chatId=${encodeURIComponent(chatId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': getCsrfToken() },
        body: ciphertext,
    });
    const uploaded = await upload.json().catch(() => null);
    if (!uploaded || !uploaded.success) {
        throw new Error((uploaded && uploaded.message) || `загрузка не удалась (${upload.status})`);
    }

    const result = await sendEncryptedPayload(chatId, e2ee.encodeFile({ blob: uploaded.blobId, ...meta }), {
        blobIds: [uploaded.blobId],
    });
    // Между проверкой и отправкой собеседник мог выйти из чата. Файл при
    // этом уже загружен — его уберёт уборщик, а пользователю говорим прямо.
    if (!result.sent) throw new Error('в чате больше не для кого шифровать');
}

async function handleFileUpload() {
    const file = elements.fileInput.files[0];
    if (!file || !currentChatId) return;
    const chatId = currentChatId;
    elements.fileInput.value = '';

    // Если в чате есть для кого шифровать — только зашифрованный путь.
    // Ошибка шифрования не откатывает на открытую загрузку.
    if (await chatHasForeignDevices(chatId)) {
        try {
            await sendEncryptedFile(chatId, file);
        } catch (error) {
            reportEncryptedSendError('Файл не отправлен', chatId, error);
        }
        return;
    }

    // Открытый путь готовит файл так же: HEIC превращается в JPEG, имя фото
    // и видео — в нейтральное. Сервер всё равно проверит и почистит сам,
    // но переименовать HEIC в JPEG он не может, а имя видит уже в запросе.
    let upload = file;
    let uploadName = file.name;
    if (e2ee) {
        try {
            const prepared = await e2ee.prepareAttachment(file);
            upload = prepared.blob;
            uploadName = prepared.name;
        } catch (error) {
            showToast(`Файл не отправлен: ${error.message}`, 'error');
            return;
        }
    }

    const formData = new FormData();
    formData.append('file', upload, uploadName);
    formData.append('chatId', chatId);

    const res = await fetch('/api/messages/file', {
        method: 'POST',
        headers: { 'X-CSRF-Token': getCsrfToken() },
        body: formData,
    });
    const data = await res.json();
    if (!data.success) {
        showToast(data.message, 'error');
    }
}

async function createChat() {
    clearFieldErrors(elements.newChatModal);
    const input = document.getElementById('new-chat-name');
    const name = input.value.trim();
    if (!name) return setFieldError('new-chat-name', 'Введите название чата');

    const data = await api('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ name }),
    });
    if (data.success) {
        input.value = '';
        closeModal(elements.newChatModal);
        showToast('Чат создан', 'success');
        loadChats();
        openChat(data.chat.id, data.chat.room_id, data.chat.name, data.chat.avatar, 0, 0);
    } else {
        setFieldError('new-chat-name', data.message);
    }
}

async function joinChat() {
    clearFieldErrors(elements.newChatModal);
    const input = document.getElementById('join-chat-code');
    const code = input.value.trim();
    if (!code) return setFieldError('join-chat-code', 'Введите код приглашения');

    const data = await api('/api/chats/join', {
        method: 'POST',
        body: JSON.stringify({ code }),
    });
    if (data.success) {
        input.value = '';
        closeModal(elements.newChatModal);
        showToast('Вы присоединились к чату', 'success');
        loadChats();
        openChat(data.chat.id, data.chat.room_id, data.chat.name, data.chat.avatar, 0, 0);
    } else {
        setFieldError('join-chat-code', data.message);
    }
}

async function deleteChat() {
    if (!currentChatId) return;
    if (!confirm('Удалить чат?')) return;
    const data = await api(`/api/chats/${currentChatId}`, { method: 'DELETE' });
    if (data.success) {
        showToast('Чат удалён', 'success');
        closeModal(elements.chatMenuModal);
        currentChatId = null;
        currentRoomId = null;
        elements.chatHeader.classList.add('hidden');
        elements.messageInputContainer.classList.add('hidden');
        elements.emptyState.classList.remove('hidden');
        elements.chatMessages.innerHTML = '';
        loadChats();
    } else {
        showToast(data.message, 'error');
    }
}

async function performSearch() {
    const q = elements.searchInput.value.trim();
    if (!q) return loadChats();
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (!data.success) return;
    elements.chatsList.innerHTML = '';
    if (!data.results.chats || !data.results.chats.length) {
        renderChatsPlaceholder('Ничего не найдено');
        return;
    }

    data.results.chats.forEach(chat => {
        const div = document.createElement('div');
        div.className = 'chat-item';
        div.dataset.id = chat.id;
        div.innerHTML = `
            <div class="chat-avatar-small" style="background:${chat.avatar && chat.avatar.startsWith('#') ? chat.avatar : DEFAULT_AVATAR}">${chat.name.charAt(0).toUpperCase()}</div>
            <div class="chat-info">
                <div class="chat-name">${escapeHtml(chat.name)}</div>
            </div>
        `;
        div.addEventListener('click', () => openChat(chat.id, null, chat.name, chat.avatar, 0, 0));
        elements.chatsList.appendChild(div);
    });
}

function scrollToBottom() {
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

init();
