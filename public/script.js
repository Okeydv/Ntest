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
    jumpDown: document.getElementById('jump-down'),
    jumpDownCount: document.getElementById('jump-down-count'),
    reactionRow: document.getElementById('reaction-row'),
    securitySection: document.getElementById('security-section'),
    securityList: document.getElementById('security-list'),
    connectionStatus: document.getElementById('connection-status'),
    readReceiptsToggle: document.getElementById('read-receipts-toggle'),
    linkLoginBtn: document.getElementById('link-login-btn'),
    linkLoginModal: document.getElementById('link-login-modal'),
    linkQr: document.getElementById('link-qr'),
    linkStatus: document.getElementById('link-status'),
    linkDeviceBtn: document.getElementById('link-device-btn'),
    linkScanModal: document.getElementById('link-scan-modal'),
    linkScanStep: document.getElementById('link-scan-step'),
    linkScanArea: document.getElementById('link-scan-area'),
    linkScanCamera: document.getElementById('link-scan-camera'),
    linkConfirmStep: document.getElementById('link-confirm-step'),
    linkConfirmLabel: document.getElementById('link-confirm-label'),
    linkConfirmAge: document.getElementById('link-confirm-age'),
    linkApproveBtn: document.getElementById('link-approve-btn'),
    linkCancelBtn: document.getElementById('link-cancel-btn'),
    chatExpiry: document.getElementById('chat-expiry'),
    chatExpirySelect: document.getElementById('chat-expiry-select'),
    logoutModal: document.getElementById('logout-modal'),
    logoutWipeBtn: document.getElementById('logout-wipe-btn'),
    logoutKeepBtn: document.getElementById('logout-keep-btn'),
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
    errorReportBtn: document.getElementById('error-report-btn'),
    errorReportModal: document.getElementById('error-report-modal'),
    errorReportText: document.getElementById('error-report-text'),
    copyErrorReportBtn: document.getElementById('copy-error-report-btn'),
    savePasswordBtn: document.getElementById('save-password-btn'),
    inviteCodeDisplay: document.getElementById('invite-code-display'),
    inviteText: document.getElementById('invite-text'),
    inviteCodeBox: document.getElementById('invite-code-box'),
    resetInviteBtn: document.getElementById('reset-invite-btn'),
    disableInviteBtn: document.getElementById('disable-invite-btn'),
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
    devicesList: document.getElementById('devices-list'),
    devicesSection: document.getElementById('devices-section'),
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
 * Имя устройства для списка и уведомлений: «Chrome, Linux». Раньше уходил
 * User-Agent целиком — нечитаемо, и серверу ни к чему лишняя примета
 * браузера.
 */
function deviceLabel(ua = navigator.userAgent) {
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Браузер';
    const os = /Android/.test(ua) ? 'Android' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad'
        : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${browser}, ${os}` : browser;
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
        deviceName: deviceLabel(),
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
    checkNewDevices();
    // Хранилище устройства доступно — сразу стираем истёкшее, не дожидаясь таймера.
    sweepExpiredMessages();
}

/* --- Новые устройства аккаунта --------------------------------------------
   Устройство, подключённое к аккаунту, получает ключи ко всем новым
   сообщениям. Раньше оно появлялось молча: узнавший пароль мог читать
   переписку, и никто бы не заметил. Теперь о нём говорят остальные
   устройства — сразу, если они в сети, и при следующем запуске, если нет. */

function notifyNewDevices(devices) {
    if (devices.length === 0) return;
    const names = devices.map(d => `«${d.name}»`).join(', ');
    showToast(devices.length === 1
        ? `К аккаунту подключено новое устройство ${names}. Если это не вы — смените пароль и отзовите его.`
        : `К аккаунту подключены новые устройства: ${names}. Если это не вы — смените пароль и отзовите их.`,
    'error', { action: { label: 'Устройства', onClick: () => elements.profileBtn.click() } });
}

async function checkNewDevices() {
    if (!e2ee || !e2ee.isReady()) return;
    const list = await api('/api/devices').catch(() => null);
    if (!list || !list.success) return;
    const active = list.devices.filter(d => !d.revoked_at);
    const known = await e2ee.knownOwnDevices();
    // Устройство только что появилось само — о тех, что были до него,
    // сообщать нечего.
    const fresh = known ? active.filter(d => d.id !== e2eeDeviceId && !known.includes(d.id)) : [];
    await e2ee.rememberOwnDevices(active.map(d => d.id));
    notifyNewDevices(fresh);
}

const SECURITY_EVENT_TEXT = {
    login: 'Вход по паролю',
    login_failed: 'Неверный пароль',
    password_changed: 'Пароль изменён',
    device_added: 'Подключено устройство',
    device_revoked: 'Устройство отозвано',
    link_approved: 'Подтверждён вход по QR-коду',
    link_login: 'Вход по QR-коду',
};

async function renderSecurityEvents() {
    const data = await api('/api/security-events').catch(() => null);
    const events = data && data.success ? data.events : [];
    elements.securitySection.hidden = events.length === 0;
    elements.securityList.replaceChildren(...events.map(event => {
        const item = document.createElement('li');
        item.className = 'security-item';
        if (event.kind === 'login_failed') item.classList.add('is-warn');
        const what = document.createElement('span');
        what.className = 'security-what';
        what.textContent = SECURITY_EVENT_TEXT[event.kind] || event.kind;
        const meta = document.createElement('span');
        meta.className = 'security-meta';
        const at = new Date(event.created_at);
        meta.textContent = [event.label, Number.isNaN(at.getTime()) ? '' : fullFormat.format(at)].filter(Boolean).join(' · ');
        item.append(what, meta);
        return item;
    }));
}

async function renderDevices() {
    const list = await api('/api/devices').catch(() => null);
    elements.devicesSection.hidden = !(list && list.success);
    if (!list || !list.success) return;
    elements.devicesList.replaceChildren();
    for (const device of list.devices.filter(d => !d.revoked_at)) {
        const item = document.createElement('li');
        item.className = 'device-item';
        const info = document.createElement('div');
        info.className = 'device-info';
        const name = document.createElement('div');
        name.className = 'device-name';
        name.textContent = device.name;
        name.title = device.name;
        const meta = document.createElement('div');
        meta.className = 'device-meta';
        const since = new Date(device.created_at);
        meta.textContent = device.id === e2eeDeviceId
            ? 'Это устройство'
            : `Подключено ${Number.isNaN(since.getTime()) ? '' : fullFormat.format(since)}`;
        info.append(name, meta);
        item.appendChild(info);
        if (device.id !== e2eeDeviceId) {
            const revoke = document.createElement('button');
            revoke.type = 'button';
            revoke.className = 'btn btn-ghost';
            revoke.textContent = 'Отозвать';
            revoke.setAttribute('aria-label', `Отозвать устройство ${device.name}`);
            revoke.addEventListener('click', () => withBusy(revoke, async () => {
                if (!confirm(`Отозвать «${device.name}»? На нём больше не получится читать новые сообщения.`)) return;
                const r = await api(`/api/devices/${device.id}`, { method: 'DELETE' });
                if (!r.success) return showToast(r.message || 'Не удалось отозвать устройство', 'error');
                showToast('Устройство отозвано', 'success');
                renderDevices();
            }));
            item.appendChild(revoke);
        }
        elements.devicesList.appendChild(item);
    }
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
    message.newerVersion = Boolean(content && content.t === 'newer');
}

/**
 * Расшифровать и дорисовать сообщение в открытый чат. fresh — сообщение
 * пришло только что (анимируется), а не из истории.
 */
// container — куда складывать: для страницы старой истории это отдельный
// блок, который потом целиком встаёт в начало переписки. Превью в списке
// чатов старые сообщения не трогают.
async function appendMessageDecrypted(message, { fresh = false, container = null } = {}) {
    // Одно сообщение может прийти дважды: по сокету, пока грузится
    // история, и в самой истории.
    if (message.id && elements.chatMessages.querySelector(`[data-message-id="${message.id}"]`)) return;
    await resolveReplyQuote(message);
    if (message.encrypted) {
        const raw = await resolveMessageText(message);
        const content = raw === null ? null : e2ee.decodePayload(raw);
        applyDecryptedContent(message, content);
        message.deviceTrust = await e2ee.senderDeviceTrust(message.user_id, message.sender_device_id);
        if (content && !container) {
            const preview = e2ee.payloadPreview(content);
            await e2ee.rememberPreview(message, preview);
            updateChatPreviewInList(message, preview);
        }
    }
    appendMessage(message, { fresh, container: container || elements.chatMessages });
}

/**
 * Цитата ответа. Текст цитаты сервер берёт из базы, а у зашифрованного
 * сообщения его там нет — цитата была пустой. По сокету приходит только
 * reply_to_id — и цитаты не было вовсе до перезагрузки. Текст берём из
 * локального кэша расшифрованного или из пузыря на экране.
 */
async function resolveReplyQuote(message) {
    if (!message.reply_to_id && !message.reply_to) return;
    const quote = message.reply_to
        || { id: message.reply_to_id, text: null, deleted: false, sender_username: null };
    const bubble = elements.chatMessages.querySelector(`[data-message-id="${quote.id}"]`);
    if (!quote.deleted && !quote.text) {
        const cached = e2ee ? await e2ee.recallPlaintext(quote.id) : null;
        if (cached) quote.text = e2ee.payloadPreview(e2ee.decodePayload(cached));
        else if (bubble) quote.text = bubble.querySelector('.message-text')?.textContent || null;
    }
    if (!quote.sender_username && bubble) quote.sender_username = bubble.dataset.sender || null;
    message.reply_to = quote;
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
    // Текст в отдельном элементе: на узком экране он обрезается
    // многоточием, а замок остаётся виден.
    const label = document.createElement('span');
    label.className = 'encryption-badge-text';
    label.textContent = text;
    badge.replaceChildren(createIcon(icon), label);
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

/* --- QR-код сверки ----------------------------------------------------------
   Тот же код безопасности, что цифрами, но сверяется одним наведением
   камеры. В QR два сегмента: префикс буквенно-цифровым режимом и 60 цифр —
   цифровым; так код меньше и читается с экрана телефона издалека.
   Библиотеки грузятся только когда открывают сверку. */

const SAFETY_QR_PREFIX = 'NYXO1:';
const vendorScripts = new Map();

function loadVendor(src, globalName) {
    if (!vendorScripts.has(src)) {
        vendorScripts.set(src, new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(`${src} не загрузился`)));
            script.onerror = () => { vendorScripts.delete(src); reject(new Error(`${src} не загрузился`)); };
            document.head.appendChild(script);
        }));
    }
    return vendorScripts.get(src);
}

function drawSafetyQr(canvas, safetyNumber) {
    return drawQr(canvas, [[SAFETY_QR_PREFIX, 'Alphanumeric'], [safetyNumber, 'Numeric']]);
}

// segments — [[данные, режим]]: режим qrcode-generator (Numeric, Alphanumeric).
async function drawQr(canvas, segments) {
    const qrcode = await loadVendor('/vendor/qrcode.js', 'qrcode');
    const qr = qrcode(0, 'M');
    for (const [data, mode] of segments) qr.addData(data, mode);
    qr.make();
    const count = qr.getModuleCount();
    const cell = 6;
    const quiet = cell * 4;
    canvas.width = canvas.height = count * cell + quiet * 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    // Сами: renderTo2dContext библиотеки рисует код транспонированным.
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            if (qr.isDark(row, col)) ctx.fillRect(quiet + col * cell, quiet + row * cell, cell, cell);
        }
    }
}

/**
 * Распознать QR на картинке или кадре. Кадр уменьшается до ~1000 px по
 * длинной стороне: крупнее — распознавание тормозит, мельче — модули
 * сливаются. Сначала BarcodeDetector браузера, если он есть, потом jsQR.
 */
async function decodeQr(source, width, height) {
    const scale = Math.min(1, 1000 / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    if ('BarcodeDetector' in window) {
        try {
            const codes = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(canvas);
            if (codes.length > 0) return codes[0].rawValue;
        } catch {
            // формат не поддержан — ниже jsQR
        }
    }
    const jsQR = await loadVendor('/vendor/jsqr.js', 'jsQR');
    const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
    return code ? code.data : null;
}

/** Камера до первого распознанного кода или до «Отмена». */
async function scanWithCamera(container) {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
    });
    const video = document.createElement('video');
    video.className = 'safety-scan-video';
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-secondary btn-block';
    cancel.textContent = 'Отмена';
    container.replaceChildren(video, cancel);
    container.hidden = false;
    try {
        await video.play();
        return await new Promise(resolve => {
            let done = false;
            const stop = () => { done = true; resolve(null); };
            cancel.addEventListener('click', stop);
            // Закрыли окно сверки (крестиком, Esc, кликом мимо) — камера
            // гаснет вместе с ним, а не продолжает снимать в скрытом окне.
            container.closest('dialog')?.addEventListener('close', stop, { once: true });
            const tick = async () => {
                if (done) return;
                if (video.readyState >= 2 && video.videoWidth > 0) {
                    const value = await decodeQr(video, video.videoWidth, video.videoHeight).catch(() => null);
                    if (value) { done = true; resolve(value); return; }
                }
                setTimeout(tick, 200);
            };
            tick();
        });
    } finally {
        stream.getTracks().forEach(t => t.stop());
        container.replaceChildren();
        container.hidden = true;
    }
}

async function decodeQrFromFile(file) {
    const bitmap = await createImageBitmap(file);
    try {
        return await decodeQr(bitmap, bitmap.width, bitmap.height);
    } finally {
        bitmap.close();
    }
}

/** Блок QR в сверке: показать свой код, отсканировать код собеседника. */
function safetyQrBlock(info, onMatch) {
    const block = document.createElement('div');
    block.className = 'safety-qr';
    const canvas = document.createElement('canvas');
    canvas.className = 'safety-qr-code';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'QR-код с кодом безопасности');
    drawSafetyQr(canvas, info.safetyNumber).catch(() => { canvas.hidden = true; });
    block.appendChild(canvas);

    const warn = document.createElement('p');
    warn.className = 'safety-muted';
    warn.textContent = 'Не пересылайте снимок этого кода через Nyxo: если сервер подменяет ключи, '
        + 'он подменит и снимок. Покажите код на экране при встрече или сверьте цифры по другому каналу.';
    block.appendChild(warn);

    const check = async value => {
        if (value === null) return;
        if (!value || !value.startsWith(SAFETY_QR_PREFIX)) {
            showToast('Это не код сверки Nyxo', 'error');
        } else if (value.slice(SAFETY_QR_PREFIX.length) !== info.safetyNumber) {
            showToast('Код не совпал: ключи могли подменить. Не отмечайте собеседника сверенным — сверьте цифры при встрече.', 'error');
        } else {
            await onMatch();
            showToast('Код совпал — собеседник сверен', 'success');
        }
    };

    const actions = document.createElement('div');
    actions.className = 'safety-qr-actions';
    const scanArea = document.createElement('div');
    scanArea.className = 'safety-scan';
    scanArea.hidden = true;
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const scan = document.createElement('button');
        scan.type = 'button';
        scan.className = 'btn btn-secondary';
        scan.textContent = 'Сканировать камерой';
        scan.addEventListener('click', async () => {
            try {
                await check(await scanWithCamera(scanArea));
            } catch {
                showToast('Камера недоступна — распознайте код с фото или сверьте цифры', 'error');
            }
        });
        actions.appendChild(scan);
    }
    const photoInput = document.createElement('input');
    photoInput.type = 'file';
    photoInput.accept = 'image/*';
    photoInput.hidden = true;
    photoInput.className = 'safety-qr-photo';
    photoInput.addEventListener('change', async () => {
        const file = photoInput.files[0];
        photoInput.value = '';
        if (!file) return;
        const value = await decodeQrFromFile(file).catch(() => '');
        await check(value || '');
    });
    const photo = document.createElement('button');
    photo.type = 'button';
    photo.className = 'btn btn-ghost';
    photo.textContent = 'Распознать с фото';
    photo.addEventListener('click', () => photoInput.click());
    actions.append(photo, photoInput);
    block.append(actions, scanArea);
    return block;
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

    if (info.state !== 'verified') {
        section.appendChild(safetyQrBlock(info, async () => {
            await e2ee.markVerified(user.user_id, info.devices);
            section.replaceWith(await renderSafetyEntry(chatId, user));
            refreshEncryptionBadge(chatId, currentChatIsBot);
        }));
    }

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
    // Строка состояния на телефоне красится по theme-color. Обе метки (для
    // светлой и тёмной системы) получают цвет выбранной темы, иначе при
    // ручной смене полоса сверху осталась бы цвета системной.
    document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
        meta.setAttribute('content', theme === 'light' ? '#f4f4f7' : '#08080e');
    });
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
    // Истёкшее стирается сразу при запуске и дальше по таймеру.
    startExpirySweep();
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
    const icon = createIcon(type === 'success' ? 'i-check' : type === 'error' ? 'i-alert' : 'i-info');
    icon.classList.add('toast-icon');
    toast.replaceChildren(icon, text);
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

// Кука с токеном пропадает после выхода (сервер её стирает) и через сутки.
// Тогда любой изменяющий запрос получал бы 403 до перезагрузки страницы —
// например, вход сразу после выхода. Без куки сначала берём новую.
async function csrfToken() {
    if (!getCsrfToken()) await fetch('/api/csrf', { credentials: 'same-origin' });
    return getCsrfToken();
}

async function api(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = {
        'Content-Type': 'application/json',
        'X-CSRF-Token': method === 'GET' ? getCsrfToken() : await csrfToken(),
        ...options.headers,
    };
    let res;
    try {
        res = await fetch(url, { ...options, headers });
    } catch (e) {
        logApiFailure(method, url, 'нет связи', null);
        throw e;
    }
    let data;
    try {
        data = await res.json();
    } catch (e) {
        // Не JSON: ответил не наш сервер, а прокси перед ним (502, 504).
        data = { success: false, message: `Сервер не ответил (${res.status})` };
    }
    if (!res.ok) logApiFailure(method, url, res.status, res.headers.get('X-Request-Id'));
    // Код ошибки — номер запроса в журнале сервера. Человеку он ничего не
    // говорит, но по нему находится, что именно сломалось.
    if (data && data.errorId && typeof data.message === 'string') {
        data.message = `${data.message} (код ${data.errorId})`;
    }
    return data;
}

// В журнал ошибок страницы — маршрут без id: /api/messages/:id.
function logApiFailure(method, url, status, requestId) {
    if (!window.nyxoErrorLog) return;
    const route = new URL(url, location.href).pathname.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, '/:id');
    window.nyxoErrorLog.add('api', `${method} ${route} → ${status}`, { requestId });
}

/* --- Отчёт об ошибке ------------------------------------------------------
   Собирается из журнала ошибок страницы (error-log.js) и никуда сам не
   уходит: человек видит его целиком, копирует и сам решает, кому отправить.
   Переписки, ключей, почты в нём нет. */

function buildErrorReport() {
    const entries = window.nyxoErrorLog ? window.nyxoErrorLog.entries() : [];
    const lines = [
        'Отчёт об ошибке Nyxo',
        `Время: ${new Date().toISOString()}`,
        `Браузер: ${deviceLabel()}`,
        `Экран: ${window.innerWidth}×${window.innerHeight}, тема: ${document.documentElement.dataset.theme}`,
        `Шифрование: ${e2ee && e2ee.isReady() ? 'работает' : 'не поднялось'}`,
        `Сокет: ${socket && socket.connected ? 'подключён' : 'не подключён'}`,
        '',
        entries.length ? `Последние ошибки (${entries.length}):` : 'Ошибок на странице не было.',
    ];
    for (const e of entries) {
        lines.push(`[${e.at}] ${e.kind}: ${e.message}`);
        if (e.requestId) lines.push(`    код: ${e.requestId}`);
        if (e.where) lines.push(`    где: ${e.where}`);
        if (e.stack) lines.push(...e.stack.split('\n').slice(0, 6).map(l => `    ${l.trim()}`));
    }
    return lines.join('\n');
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

    // Выход стирает с устройства ключи и расшифрованную переписку и
    // отзывает устройство: иначе всё это оставалось бы в браузере для
    // любого, кто сядет за него следом. На своём устройстве можно выйти, не
    // стирая, — тогда при следующем входе собеседникам не придётся заново
    // сверять ключи. Анонимный аккаунт при выходе удаляется целиком, так что
    // спрашивать не о чем.
    const finishLogout = async ({ keepDevice }) => {
        if (e2ee && e2ee.isReady()) {
            await (keepDevice ? e2ee.detach() : e2ee.wipeDevice());
            e2eeDeviceId = null;
        }
        await api('/api/logout', { method: 'POST' });
        currentUser = null;
        currentChatId = null;
        currentRoomId = null;
        // Черновики — чужому, кто войдёт следом, они ни к чему.
        chatViews.clear();
        elements.messageInput.value = '';
        clearReply();
        editingMessageId = null;
        showToast('Вы вышли из аккаунта', 'info');
        showAuth();
    };
    elements.logoutBtn.addEventListener('click', () => {
        if (!(e2ee && e2ee.isReady()) || (currentUser && currentUser.isAnonymous)) {
            return finishLogout({ keepDevice: false });
        }
        openModal(elements.logoutModal);
    });
    elements.logoutWipeBtn.addEventListener('click', () => withBusy(elements.logoutWipeBtn, async () => {
        closeModal(elements.logoutModal);
        await finishLogout({ keepDevice: false });
    }));
    elements.logoutKeepBtn.addEventListener('click', () => withBusy(elements.logoutKeepBtn, async () => {
        closeModal(elements.logoutModal);
        await finishLogout({ keepDevice: true });
    }));

    elements.errorReportBtn.addEventListener('click', () => {
        elements.errorReportText.value = buildErrorReport();
        closeModal(elements.profileModal);
        openModal(elements.errorReportModal);
    });
    elements.copyErrorReportBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(elements.errorReportText.value);
            showToast('Отчёт скопирован', 'success');
        } catch (e) {
            // Буфер обмена недоступен (не HTTPS, запрет браузера): выделяем
            // текст, чтобы его можно было скопировать вручную.
            elements.errorReportText.select();
            showToast('Скопируйте выделенный текст', 'info');
        }
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
    elements.chatExpiry.addEventListener('click', () => openModal(elements.chatMenuModal));
    // Смена срока с «Отменить»: выбрали не то — вернуть прежний одним нажатием.
    const setChatExpiry = async (expirySeconds, { undoable = true } = {}) => {
        const select = elements.chatExpirySelect;
        const previous = chatExpirySeconds || 0;
        const chatId = currentChatId;
        select.disabled = true;
        try {
            const data = await api(`/api/chats/${chatId}/set-default-expiry`, {
                method: 'POST', body: JSON.stringify({ expirySeconds }) });
            if (!data.success) {
                select.value = String(previous);
                return showToast(data.message, 'error');
            }
            if (chatId === currentChatId) showChatExpiry(data.expirySeconds);
            showToast(`Исчезающие сообщения: ${data.expirySeconds ? expiryName(data.expirySeconds) : 'выключены'}`, 'success',
                undoable && previous !== (data.expirySeconds || 0) ? {
                    duration: 6000,
                    action: { label: 'Отменить', onClick: () => currentChatId === chatId && setChatExpiry(previous, { undoable: false }) },
                } : {});
        } finally {
            select.disabled = false;
        }
    };
    elements.chatExpirySelect.addEventListener('change', () => setChatExpiry(Number(elements.chatExpirySelect.value)));

    elements.deleteChatBtn.addEventListener('click', deleteChat);

    elements.getChatCodeBtn.addEventListener('click', async () => {
        if (!currentChatId) return;
        const data = await api(`/api/chats/invite/${currentChatId}`);
        if (data.success) {
            showInviteCode(data.code);
            openModal(elements.inviteModal);
        } else {
            showToast(data.message, 'error');
        }
    });

    const updateInvite = action => withBusy(action === 'reset' ? elements.resetInviteBtn : elements.disableInviteBtn, async () => {
        const data = await api(`/api/chats/${currentChatId}/invite`, { method: 'POST', body: JSON.stringify({ action }) });
        if (!data.success) return showToast(data.message, 'error');
        showInviteCode(data.code);
        showToast(data.code ? 'Код сменён, старый больше не действует' : 'Приглашение отключено', 'success');
    });
    elements.resetInviteBtn.addEventListener('click', () => updateInvite('reset'));
    elements.disableInviteBtn.addEventListener('click', () => updateInvite('disable'));

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
                elements.linkDeviceBtn.hidden = true;
            } else {
                elements.profileAnonBadge.classList.add('hidden');
                elements.changePasswordBtn.classList.remove('hidden');
                elements.linkDeviceBtn.hidden = false;
            }
            elements.readReceiptsToggle.checked = data.user.sendReadReceipts !== false;
            await renderDevices();
            await renderSecurityEvents();
            openModal(elements.profileModal);
        }
    });

    elements.readReceiptsToggle.addEventListener('change', async () => {
        const toggle = elements.readReceiptsToggle;
        toggle.disabled = true;
        const data = await api('/api/user/read-receipts', { method: 'POST', body: JSON.stringify({ enabled: toggle.checked }) });
        toggle.disabled = false;
        if (!data.success) {
            toggle.checked = !toggle.checked;
            return showToast(data.message, 'error');
        }
        showToast(data.enabled ? 'Отметки о прочтении включены' : 'Отметки о прочтении выключены', 'success');
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
        // Esc отменяет правку, а если её нет — ответ.
        if (e.key === 'Escape' && (editingMessageId || replyToMessageId)) {
            e.preventDefault();
            if (editingMessageId) {
                editingMessageId = null;
                elements.messageInput.value = '';
            } else {
                clearReply();
            }
            return;
        }
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

    elements.reactionRow.addEventListener('click', event => {
        const choice = event.target.closest('.reaction-choice');
        if (!choice) return;
        hideMessageMenu();
        toggleReaction(elements.messageMenu.dataset.forMessage, choice.dataset.emoji);
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
    setupHistoryPaging();
    setupReadMarks();
    setupFeed();
    setupConnectionStatus();
    setupDeviceLinking();
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

    socket.on('deviceAdded', device => {
        if (!e2ee || !e2ee.isReady() || device.id === e2eeDeviceId) return;
        notifyNewDevices([device]);
        e2ee.knownOwnDevices().then(known => e2ee.rememberOwnDevices([...(known || []), device.id]));
    });

    socket.on('chatExpiryChanged', ({ room_id, expirySeconds }) => {
        if (currentRoomId && Number(room_id) === Number(currentRoomId)) showChatExpiry(expirySeconds);
    });

    socket.on('messageDeleted', ({ id, chat_id, room_id }) => {
        // Расшифрованная копия удалённого сообщения не должна пережить его.
        if (e2ee) e2ee.forgetMessage({ id, chat_id, room_id });
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
    chatsMeta.clear();
    for (const chat of data.chats) {
        chatsMeta.set(chat.id, chat);
        for (const id of chat.peer_ids || []) peerOnline.set(Number(id), (chat.online_ids || []).includes(id));
        // Открытый чат, который сейчас на экране, — прочитан, даже если
        // отметка ещё в пути.
        if (chat.id === currentChatId && document.visibilityState === 'visible') chat.unread = 0;
        const div = chatItemElement(chat, await chatPreview(chat));
        div.dataset.roomId = chat.room_id || '';
        div.addEventListener('click', () => openChat(chat.id, chat.room_id, chat.name, chat.avatar, chat.online, chat.is_bot));
        elements.chatsList.appendChild(div);
    }
    updateTitleCounter();
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
        const cached = await e2ee.recallPreview(chat);
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

let lastOpenChat = null;

async function openChat(chatId, roomId, name, avatar, online, isBot) {
    const reopening = currentChatId === chatId;
    if (!reopening) rememberChatView();
    lastOpenChat = [chatId, roomId, name, avatar, online, isBot];
    // В комнату сокета — до загрузки истории: пришедшее, пока она
    // грузится, иначе потерялось бы (дубли отсекает appendMessage).
    socket.emit('joinChat', roomId ? `room:${roomId}` : `chat:${chatId}`);
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
    renderChatStatus(isBot, online);
    elements.chatAvatar.textContent = name.charAt(0).toUpperCase();
    elements.chatAvatar.style.background = /^#[0-9a-f]{3,8}$/i.test(avatar || '') ? avatar : DEFAULT_AVATAR;
    elements.chatHeader.classList.remove('hidden');
    elements.messageInputContainer.classList.remove('hidden');
    elements.emptyState.classList.add('hidden');
    const view = reopening ? captureChatView() : chatViews.get(chatId);
    elements.chatMessages.innerHTML = '';
    resetNewBelow();
    if (!reopening) restoreDraft(chatId);
    showChatExpiry(null);
    // Скелетон — только если история грузится заметно долго.
    const skeletonTimer = setTimeout(renderMessagesSkeleton, 150);

    // Что из этого чата лежит у нас расшифрованным — до запроса истории:
    // сообщение, пришедшее, пока она грузится, не должно попасть под чистку.
    const known = e2ee && e2ee.isReady() ? await e2ee.knownMessages({ id: chatId, room_id: roomId }) : [];
    historyPaging.chatId = chatId;
    historyPaging.hasMore = false;
    historyPaging.oldestId = null;
    const data = await api(`/api/messages/${chatId}?limit=${historyPageSize}`).finally(() => clearTimeout(skeletonTimer));
    if (currentChatId !== chatId) return;
    elements.chatMessages.querySelectorAll('.message-skeleton').forEach(el => el.remove());
    elements.chatMessages.removeAttribute('aria-busy');
    if (!data.success) return;
    const page = data.messages || [];
    showChatExpiry(data.expirySeconds);
    historyPaging.hasMore = Boolean(data.hasMore);
    historyPaging.oldestId = page.length ? page[0].id : null;
    // Удалённое и исчезнувшее, пока устройство было не в сети, стираем и
    // отсюда: в истории его уже нет.
    if (e2ee) await e2ee.forgetMissing({ id: chatId, room_id: roomId }, known, await liveMessageIds(chatId, known, page));

    // Последовательно, а не Promise.all: у Double Ratchet состояние
    // сессии меняется на каждом сообщении, и параллельная расшифровка
    // двух сообщений одной сессии затирала бы состояние друг друга.
    // Ключи групп — до сообщений: без них групповые не расшифровать.
    if (e2ee && data.keyEnvelopes) await e2ee.processKeyEnvelopes(data.keyEnvelopes);
    for (const msg of page) await appendMessageDecrypted(msg);
    if (currentChatId !== chatId) return;
    await fillScreenWithHistory();
    // Куда встать: туда, где были (возврат в чат), к «Непрочитанным» или вниз.
    const separator = reopening ? null : placeUnreadSeparator(Number(data.chat && data.chat.last_read_id) || 0);
    if (!restoreChatView(view)) {
        if (separator) {
            const list = elements.chatMessages;
            list.scrollTop += separator.getBoundingClientRect().top - list.getBoundingClientRect().top - 16;
        }
        else scrollToBottom();
    }
    scheduleReadMark();
}

/* --- Черновик и место в каждом чате ----------------------------------------
   Недописанное сообщение и место, где читали, остаются за чатом: вернулся —
   всё как было. Держится только в памяти вкладки: текст черновика не
   пишется ни на диск, ни на сервер. */

const chatViews = new Map();

// Место в ленте — сообщение у верхнего края и его сдвиг: высота ленты после
// перезагрузки истории другая, а сообщение то же.
function captureChatView() {
    const list = elements.chatMessages;
    if (atChatBottom()) return { bottom: true };
    const top = list.getBoundingClientRect().top;
    const anchor = visibleMessages().find(el => el.getBoundingClientRect().bottom > top);
    return anchor ? { id: anchor.dataset.messageId, offset: anchor.getBoundingClientRect().top - top } : { bottom: true };
}

function rememberChatView() {
    if (!currentChatId) return;
    chatViews.set(currentChatId, {
        ...captureChatView(),
        draft: editingMessageId ? '' : elements.messageInput.value,
    });
    // Правка и ответ относятся к сообщению этого чата — в другой не переносятся.
    editingMessageId = null;
    clearReply();
}

function restoreDraft(chatId) {
    const saved = chatViews.get(chatId);
    elements.messageInput.value = saved ? saved.draft || '' : '';
}

function restoreChatView(view) {
    if (!view || view.bottom) return false;
    const anchor = elements.chatMessages.querySelector(`.message[data-message-id="${view.id}"]`);
    if (!anchor) return false;
    const list = elements.chatMessages;
    list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - view.offset;
    return true;
}

function renderMessagesSkeleton() {
    if (elements.chatMessages.querySelector('.message, .message-skeleton')) return;
    elements.chatMessages.setAttribute('aria-busy', 'true');
    for (const [side, width] of [['received', 60], ['received', 35], ['sent', 50], ['received', 70], ['sent', 30]]) {
        const bubble = document.createElement('div');
        bubble.className = `message-skeleton ${side}`;
        bubble.style.setProperty('--w', `${width}%`);
        bubble.setAttribute('aria-hidden', 'true');
        elements.chatMessages.appendChild(bubble);
    }
}

/* --- Привязка устройства по QR ---------------------------------------------
   Новое устройство показывает одноразовый код и ждёт, устройство, где уже
   вошли, сканирует его и подтверждает. Пароль на новом устройстве не
   вводится. Код живёт 5 минут; забрать вход по нему может только браузер,
   который его показал (см. routes/link.js). */

const LINK_QR_PREFIX = 'NYXOLINK1:';
let linkPollTimer = null;

async function startLinkLogin() {
    clearTimeout(linkPollTimer);
    elements.linkStatus.textContent = 'Готовим код…';
    elements.linkQr.hidden = true;
    const data = await api('/api/link/start', { method: 'POST', body: '{}' });
    if (!data.success) {
        elements.linkStatus.textContent = data.message;
        return;
    }
    await drawQr(elements.linkQr, [[LINK_QR_PREFIX + data.token, 'Alphanumeric']]);
    elements.linkQr.hidden = false;
    elements.linkStatus.textContent = 'Код действует 5 минут. Ждём подтверждения…';
    pollLinkLogin();
}

function pollLinkLogin() {
    linkPollTimer = setTimeout(async () => {
        if (!elements.linkLoginModal.open) return;
        const data = await api('/api/link/status').catch(() => null);
        if (!elements.linkLoginModal.open) return;
        if (!data || !data.success || data.status === 'pending') return pollLinkLogin();
        if (data.status === 'expired') {
            elements.linkQr.hidden = true;
            elements.linkStatus.replaceChildren('Код устарел. ');
            const again = document.createElement('button');
            again.type = 'button';
            again.className = 'link-inline';
            again.textContent = 'Показать новый';
            again.addEventListener('click', startLinkLogin);
            elements.linkStatus.appendChild(again);
            return;
        }
        closeModal(elements.linkLoginModal);
        currentUser = data.user;
        showToast(`Вы вошли как ${data.user.username}`, 'success');
        showApp();
        await setupE2EE();
        loadChats();
    }, 2000);
}

let pendingLinkToken = null;

function resetLinkScan() {
    pendingLinkToken = null;
    elements.linkScanStep.hidden = false;
    elements.linkConfirmStep.hidden = true;
}

async function inspectLinkCode(value) {
    if (value === null) return;
    if (!value || !value.startsWith(LINK_QR_PREFIX)) {
        showToast('Это не код подключения Nyxo', 'error');
        return;
    }
    const token = value.slice(LINK_QR_PREFIX.length);
    const data = await api('/api/link/inspect', { method: 'POST', body: JSON.stringify({ token }) });
    if (!data.success) {
        showToast(data.message, 'error');
        return;
    }
    pendingLinkToken = token;
    elements.linkConfirmLabel.textContent = `«${data.label}»`;
    const age = Math.max(0, Number(data.ageSeconds) || 0);
    elements.linkConfirmAge.textContent = age < 60
        ? `Код показан ${age} с назад. Название браузера определил сервер.`
        : `Код показан ${Math.round(age / 60)} мин назад. Название браузера определил сервер.`;
    elements.linkScanStep.hidden = true;
    elements.linkConfirmStep.hidden = false;
    // По умолчанию — «Отмена»: подключение не должно пройти от случайного Enter.
    elements.linkCancelBtn.focus();
}

function setupDeviceLinking() {
    elements.linkLoginBtn.addEventListener('click', () => {
        openModal(elements.linkLoginModal);
        startLinkLogin();
    });
    elements.linkLoginModal.addEventListener('close', () => clearTimeout(linkPollTimer));

    elements.linkDeviceBtn.addEventListener('click', () => {
        resetLinkScan();
        closeModal(elements.profileModal);
        openModal(elements.linkScanModal);
    });
    // Без камеры подключить по QR нельзя — остаётся вход по паролю.
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) elements.linkScanCamera.disabled = true;
    elements.linkScanCamera.addEventListener('click', async () => {
        try {
            await inspectLinkCode(await scanWithCamera(elements.linkScanArea));
        } catch {
            showToast('Камера недоступна — распознайте код с фото', 'error');
        }
    });
    elements.linkCancelBtn.addEventListener('click', () => closeModal(elements.linkScanModal));
    elements.linkApproveBtn.addEventListener('click', () => withBusy(elements.linkApproveBtn, async () => {
        const data = await api('/api/link/approve', { method: 'POST', body: JSON.stringify({ token: pendingLinkToken }) });
        if (!data.success) return showToast(data.message, 'error');
        closeModal(elements.linkScanModal);
        showToast('Устройство подключено', 'success');
    }));
}

/* --- Лента: «↓», непрочитанные, группировка, цитаты -------------------------
   Новое, пока читаешь историю, не выдёргивает вниз — появляется «↓» со
   счётчиком. При открытии чата лента встаёт на разделитель
   «Непрочитанные». Подряд идущие сообщения одного автора (в пределах
   5 минут) собираются в группу. Цитата ведёт к исходному сообщению. */

let newBelow = 0;

function noteNewBelow() {
    newBelow++;
    elements.jumpDownCount.textContent = newBelow > 99 ? '99+' : String(newBelow);
    elements.jumpDown.hidden = false;
}

function resetNewBelow() {
    newBelow = 0;
    elements.jumpDown.hidden = true;
    elements.jumpDownCount.textContent = '';
}

function setupFeed() {
    elements.jumpDown.addEventListener('click', () => {
        scrollToBottom({ smooth: true });
        resetNewBelow();
    });
    elements.chatMessages.addEventListener('scroll', () => {
        if (atChatBottom()) resetNewBelow();
        else if (!newBelow) elements.jumpDown.hidden = elements.chatMessages.scrollHeight - elements.chatMessages.scrollTop
            - elements.chatMessages.clientHeight < 600;
    }, { passive: true });
    elements.chatMessages.addEventListener('click', event => {
        const quote = event.target.closest('.reply-to[data-reply-id]');
        if (quote) goToMessage(Number(quote.dataset.replyId));
        const chip = event.target.closest('.reaction[data-emoji]');
        const bubble = chip && chip.closest('.message[data-message-id]');
        if (bubble && !currentChatIsBot) toggleReaction(bubble.dataset.messageId, chip.dataset.emoji);
    });
    elements.chatMessages.addEventListener('keydown', event => {
        const quote = event.target.closest && event.target.closest('.reply-to[data-reply-id]');
        if (quote && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            goToMessage(Number(quote.dataset.replyId));
        }
    });
    socket.on('presence', ({ user_id, online }) => {
        peerOnline.set(Number(user_id), Boolean(online));
        const chat = currentChatMeta();
        if (chat && (chat.peer_ids || []).map(Number).includes(Number(user_id))) renderChatStatus(chat.is_bot);
    });
    socket.on('reactionsChanged', ({ id, reactions }) => {
        const bubble = elements.chatMessages.querySelector(`.message[data-message-id="${id}"]`);
        if (bubble) renderReactions(bubble, reactions);
    });
}

// «В сети», если в сети хоть кто-то из собеседников. В группе — ещё и
// сколько в ней участников.
const chatsMeta = new Map();
const peerOnline = new Map();
const currentChatMeta = () => chatsMeta.get(currentChatId) || null;

function renderChatStatus(isBot, online = false) {
    const chat = currentChatMeta();
    const status = elements.chatStatus;
    if (chat) online = (chat.peer_ids || []).some(id => peerOnline.get(Number(id)));
    if (isBot) {
        status.textContent = 'Бот';
        status.className = 'status online';
        return;
    }
    if (chat && chat.room_id && !chat.peer_count) {
        status.textContent = 'Пока никого';
        status.className = 'status offline';
        return;
    }
    const members = chat ? chat.peer_count + 1 : 0;
    const group = members > 2 ? `${members} ${['участник', 'участника', 'участников'][pluralForm(members)]} · ` : '';
    status.textContent = group + (online ? 'в сети' : 'не в сети');
    if (!group) status.textContent = online ? 'В сети' : 'Не в сети';
    status.className = 'status ' + (online ? 'online' : 'offline');
}

async function goToMessage(id) {
    let bubble = elements.chatMessages.querySelector(`.message[data-message-id="${id}"]`);
    // Исходное сообщение старше загруженного — догружаем страницы.
    for (let i = 0; !bubble && historyPaging.hasMore && i < 20; i++) {
        await loadOlderMessages();
        bubble = elements.chatMessages.querySelector(`.message[data-message-id="${id}"]`);
    }
    if (!bubble || bubble.hidden) {
        showToast('Исходное сообщение не найдено — возможно, его удалили', 'info');
        return;
    }
    bubble.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    bubble.classList.remove('is-highlighted');
    bubble.getBoundingClientRect();
    bubble.classList.add('is-highlighted');
    setTimeout(() => bubble.classList.remove('is-highlighted'), 1600);
    bubble.focus({ preventScroll: true });
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Подряд идущие сообщения одного автора в пределах 5 минут — группа:
// меньше отступ, без повторного имени.
const GROUP_GAP_MS = 5 * 60 * 1000;
function regroupMessages() {
    let prev = null;
    for (const el of elements.chatMessages.querySelectorAll('.message, .message-system, .unread-separator, .day-separator')) {
        const bubble = el.classList.contains('message') && !el.hidden ? el : null;
        const same = bubble && prev && prev.dataset.senderKey === bubble.dataset.senderKey
            && Math.abs(Number(bubble.dataset.at) - Number(prev.dataset.at)) < GROUP_GAP_MS;
        if (bubble) bubble.classList.toggle('is-continuation', Boolean(same));
        if (!el.hidden) prev = bubble;
    }
}

// Разделитель «Непрочитанные» — перед первым чужим сообщением после
// прочитанного. Возвращает его или null.
function placeUnreadSeparator(lastReadId) {
    elements.chatMessages.querySelector('.unread-separator')?.remove();
    const first = [...elements.chatMessages.querySelectorAll('.message.received[data-message-id]')]
        .find(el => Number(el.dataset.messageId) > lastReadId);
    if (!first) return null;
    const separator = document.createElement('div');
    separator.className = 'unread-separator';
    separator.setAttribute('role', 'separator');
    const label = document.createElement('span');
    label.textContent = 'Непрочитанные';
    separator.appendChild(label);
    first.before(separator);
    regroupMessages();
    return separator;
}

// Реакции пузыря: новые появляются с лёгким увеличением.
function renderReactions(bubble, reactions) {
    const content = bubble.querySelector('.message-content');
    if (!content) return;
    let box = content.querySelector('.reactions');
    const before = new Set(box ? [...box.children].map(c => c.dataset.emoji) : []);
    if (!reactions.length) {
        box?.remove();
        return;
    }
    if (!box) {
        box = document.createElement('div');
        box.className = 'reactions';
        content.appendChild(box);
    }
    box.replaceChildren(...reactions.map(emoji => reactionChip(emoji, !before.has(emoji))));
}

function reactionChip(emoji, fresh = false) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'reaction' + (fresh ? ' is-new' : '');
    chip.dataset.emoji = emoji;
    chip.textContent = emoji;
    chip.setAttribute('aria-label', `Реакция ${emoji}: нажмите, чтобы поставить или снять`);
    chip.tabIndex = -1;
    return chip;
}

// Поставить реакцию или снять свою.
async function toggleReaction(messageId, emoji) {
    const removed = await api(`/api/reactions/${messageId}/${encodeURIComponent(emoji)}`, { method: 'DELETE' });
    if (removed && removed.success && removed.removed) return;
    const added = await api('/api/reactions', { method: 'POST', body: JSON.stringify({ messageId: Number(messageId), emoji }) });
    if (!added.success) showToast(added.message, 'error');
}

/* --- Соединение -------------------------------------------------------------
   Сокет рвётся (сон ноутбука, смена сети, перезапуск сервера) и сам
   переподключается. Пока его нет, новое не приходит — это видно плашкой.
   После переподключения сокет заново входит в комнату открытого чата, а
   пропущенное — сообщения, удаления, правки, смена срока — догружается:
   список чатов и открытый чат перечитываются. */

let connectionTimer = null;
let wasDisconnected = false;

function setupConnectionStatus() {
    socket.on('disconnect', reason => {
        // Разрыв по нашей же команде (после входа сокет переподключается
        // с новой сессией) — не обрыв.
        if (reason === 'io client disconnect') return;
        wasDisconnected = true;
        clearTimeout(connectionTimer);
        // Короткие переподключения плашкой не мигают.
        connectionTimer = setTimeout(() => { elements.connectionStatus.hidden = false; }, 1500);
    });
    socket.on('connect', async () => {
        clearTimeout(connectionTimer);
        elements.connectionStatus.hidden = true;
        if (!wasDisconnected || !currentUser) return;
        wasDisconnected = false;
        await loadChats();
        if (lastOpenChat && currentChatId === lastOpenChat[0]) {
            const list = elements.chatMessages;
            const fromBottom = list.scrollHeight - list.scrollTop;
            const wasAtBottom = atChatBottom();
            await openChat(...lastOpenChat);
            if (!wasAtBottom) list.scrollTop = Math.max(0, list.scrollHeight - fromBottom);
        }
    });
}

/* --- Истёкшие сообщения на устройстве ------------------------------------
   Раз в 10 секунд и при запуске: стереть из IndexedDB расшифрованное с
   истёкшим сроком (e2ee.sweepExpired) и убрать такие пузыри с экрана —
   в том числе незашифрованные, их текст на устройстве не хранится. */

const EXPIRY_SWEEP_MS = 10 * 1000;
let expirySweepTimer = null;

async function sweepExpiredMessages() {
    const now = Date.now();
    let changed = false;
    if (e2ee && e2ee.isReady()) changed = (await e2ee.sweepExpired(now).catch(() => [])).length > 0;
    for (const bubble of elements.chatMessages.querySelectorAll('[data-expires-at]')) {
        if (Number(bubble.dataset.expiresAt) <= now) removeMessageElement(bubble);
    }
    if (changed && currentUser) loadChats();
}

function startExpirySweep() {
    clearInterval(expirySweepTimer);
    sweepExpiredMessages();
    expirySweepTimer = setInterval(sweepExpiredMessages, EXPIRY_SWEEP_MS);
}

/* --- Прочитано и доставлено ----------------------------------------------
   Прочитанным чат отмечается, когда конец переписки на экране и вкладка
   видна; пришедшее в фоне — только доставленным. Сервер пересчитывает
   счётчик непрочитанного и рассылает собеседникам их статусы
   (lib/read-state.js), а сюда — наши. */

const STATUS_VIEW = {
    sent: ['○', 'Отправлено'],
    delivered: ['✓', 'Доставлено'],
    read: ['✓✓', 'Прочитано'],
};
const STATUS_RANK = { sent: 0, delivered: 1, read: 2 };

function setMessageStatus(span, status) {
    const [mark, label] = STATUS_VIEW[status] || STATUS_VIEW.sent;
    const changed = span.isConnected && span.textContent && span.textContent !== mark;
    span.dataset.status = status in STATUS_VIEW ? status : 'sent';
    span.textContent = mark;
    // ✓ → ✓✓ не скачком: новая отметка проявляется. Только прозрачность —
    // её оставляем и при «уменьшить движение».
    if (changed && span.animate) span.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
    span.title = label;
    span.setAttribute('aria-label', label);
}

const readMarks = { chatId: null, read: 0, delivered: 0, timer: null };

function newestShownMessageId() {
    const ids = [...elements.chatMessages.querySelectorAll('[data-message-id]')]
        .map(el => Number(el.dataset.messageId)).filter(Number.isInteger);
    return ids.length ? Math.max(...ids) : 0;
}

function atChatBottom() {
    const list = elements.chatMessages;
    return list.scrollHeight - list.scrollTop - list.clientHeight < 80;
}

async function sendReadMark(kind, chatId, upTo) {
    const data = await api(`/api/chats/${chatId}/${kind}`, { method: 'POST', body: JSON.stringify({ upTo }) }).catch(() => null);
    if (data && data.success && kind === 'read') {
        const badge = elements.chatsList.querySelector(`.chat-item[data-id="${chatId}"] .chat-badge`);
        if (badge && data.unread === 0) badge.remove();
        else if (badge) badge.textContent = String(data.unread);
        updateTitleCounter();
    }
}

// Вызывается при открытии чата, новом сообщении, прокрутке и когда вкладка
// снова на экране; сама решает, что отметить.
function scheduleReadMark() {
    clearTimeout(readMarks.timer);
    readMarks.timer = setTimeout(() => {
        const chatId = currentChatId;
        if (!chatId) return;
        if (readMarks.chatId !== chatId) Object.assign(readMarks, { chatId, read: 0, delivered: 0 });
        const upTo = newestShownMessageId();
        if (!upTo) return;
        const visible = document.visibilityState === 'visible' && atChatBottom();
        if (visible && upTo > readMarks.read) {
            readMarks.read = readMarks.delivered = upTo;
            sendReadMark('read', chatId, upTo);
        } else if (!visible && upTo > readMarks.delivered) {
            readMarks.delivered = upTo;
            sendReadMark('delivered', chatId, upTo);
        }
    }, 300);
}

// Наши статусы у собеседников: галочки у своих сообщений в открытом чате.
function applyReceipts({ room_id, read, delivered }) {
    if (!currentRoomId || Number(room_id) !== Number(currentRoomId)) return;
    for (const span of elements.chatMessages.querySelectorAll('.message.sent .message-status')) {
        const id = Number(span.closest('[data-message-id]')?.dataset.messageId);
        if (!Number.isInteger(id)) continue;
        const status = id <= read ? 'read' : id <= delivered ? 'delivered' : 'sent';
        if (STATUS_RANK[status] > (STATUS_RANK[span.dataset.status] ?? 0)) setMessageStatus(span, status);
    }
}

// Непрочитанное по всем чатам — в заголовке вкладки.
const BASE_TITLE = document.title;
function updateTitleCounter() {
    const total = [...elements.chatsList.querySelectorAll('.chat-badge')]
        .reduce((sum, badge) => sum + (Number(badge.textContent) || 0), 0);
    document.title = total ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
}

function setupReadMarks() {
    socket.on('receipts', applyReceipts);
    elements.chatMessages.addEventListener('scroll', scheduleReadMark, { passive: true });
    document.addEventListener('visibilitychange', scheduleReadMark);
    window.addEventListener('focus', scheduleReadMark);
}

/* --- Исчезающие сообщения ---------------------------------------------------
   Срок общий для чата: его видно в шапке, у каждого исчезающего сообщения
   таймер, а сменить можно в меню чата. */

let chatExpirySeconds = null;

const EXPIRY_UNITS = [
    [604800, ['неделю', 'недели', 'недель']], [86400, ['день', 'дня', 'дней']],
    [3600, ['час', 'часа', 'часов']], [60, ['минуту', 'минуты', 'минут']], [1, ['секунду', 'секунды', 'секунд']],
];

const EXPIRY_NAMES = [
    [604800, ['неделя', 'недели', 'недель']], [86400, ['день', 'дня', 'дней']],
    [3600, ['час', 'часа', 'часов']], [60, ['минута', 'минуты', 'минут']], [1, ['секунда', 'секунды', 'секунд']],
];

const pluralForm = n => (n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2);

// «1 неделя», «5 минут»
function expiryName(seconds) {
    for (const [size, forms] of EXPIRY_NAMES) {
        if (seconds % size === 0) return `${seconds / size} ${forms[pluralForm(seconds / size)]}`;
    }
    return `${seconds} с`;
}

// «через 1 день», «через 5 минут»
function expiryPhrase(seconds) {
    for (const [size, forms] of EXPIRY_UNITS) {
        if (seconds % size !== 0) continue;
        const n = seconds / size;
        const form = n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2;
        return `через ${n} ${forms[form]}`;
    }
    return `через ${seconds} с`;
}

function showChatExpiry(seconds) {
    chatExpirySeconds = seconds || null;
    const badge = elements.chatExpiry;
    badge.classList.toggle('hidden', !chatExpirySeconds);
    elements.chatExpirySelect.value = String(chatExpirySeconds || 0);
    if (!chatExpirySeconds) return;
    const phrase = expiryPhrase(chatExpirySeconds);
    const label = document.createElement('span');
    label.className = 'expiry-badge-text';
    label.textContent = phrase.replace(/^через /, '');
    badge.replaceChildren(createIcon('i-timer'), label);
    badge.title = `Новые сообщения исчезают ${phrase}`;
    badge.setAttribute('aria-label', badge.title);
}

/* --- История страницами ---------------------------------------------------
   Чат открывается с последних historyPageSize сообщений, старые
   подгружаются, когда долистали до верха. Раньше история приходила вся
   сразу — и в долгом чате каждый раз расшифровывалась целиком. */

let historyPageSize = 50;
const historyPaging = { chatId: null, oldestId: null, hasMore: false, loading: false };

/*
 * Какие из сообщений, что лежат у нас расшифрованными, ещё есть на
 * сервере. Про новые скажет сама страница истории, про те, что старше
 * неё, спрашиваем отдельно. Не получилось спросить — считаем, что есть:
 * стереть по ошибке хуже, чем стереть позже.
 */
async function liveMessageIds(chatId, known, page) {
    const live = page.map(m => m.id);
    if (!historyPaging.hasMore) return live;
    const oldest = historyPaging.oldestId;
    const older = known.map(Number).filter(id => id < oldest);
    for (let i = 0; i < older.length; i += 1000) {
        const chunk = older.slice(i, i + 1000);
        const data = await api(`/api/messages/${chatId}/existing`, { method: 'POST', body: JSON.stringify({ ids: chunk }) })
            .catch(() => null);
        live.push(...(data && data.success ? data.ids : chunk));
    }
    return live;
}

async function loadOlderMessages() {
    const chatId = currentChatId;
    if (historyPaging.loading || !historyPaging.hasMore || historyPaging.chatId !== chatId) return;
    historyPaging.loading = true;
    elements.chatMessages.setAttribute('aria-busy', 'true');
    try {
        const data = await api(`/api/messages/${chatId}?limit=${historyPageSize}&before=${historyPaging.oldestId}`);
        if (!data.success || currentChatId !== chatId) return;
        const page = data.messages || [];
        if (e2ee && data.keyEnvelopes) await e2ee.processKeyEnvelopes(data.keyEnvelopes);
        const batch = document.createElement('div');
        for (const msg of page) await appendMessageDecrypted(msg, { container: batch });
        if (currentChatId !== chatId) return;
        // Экран не должен прыгать: то, что было перед глазами, остаётся на месте.
        const list = elements.chatMessages;
        const fromBottom = list.scrollHeight - list.scrollTop;
        prependMessages(batch);
        list.scrollTop = list.scrollHeight - fromBottom;
        historyPaging.hasMore = Boolean(data.hasMore);
        if (page.length) historyPaging.oldestId = page[0].id;
    } finally {
        historyPaging.loading = false;
        elements.chatMessages.removeAttribute('aria-busy');
    }
}

// Первая страница может не заполнить высокий экран — тогда прокрутки нет
// и листать вверх нечем. Догружаем, пока не появится прокрутка.
async function fillScreenWithHistory() {
    const list = elements.chatMessages;
    while (historyPaging.hasMore && list.scrollHeight <= list.clientHeight + 1) {
        const before = historyPaging.oldestId;
        await loadOlderMessages();
        if (historyPaging.oldestId === before) break;
    }
}

function setupHistoryPaging() {
    elements.chatMessages.addEventListener('scroll', () => {
        if (elements.chatMessages.scrollTop < 300) loadOlderMessages();
    }, { passive: true });
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

/*
 * Каждый день — свой блок, и разделитель прилипает к верху только в
 * пределах своего дня. Когда все разделители лежали вперемешку с
 * сообщениями в одном списке, при прокрутке они прилипали все разом и
 * наезжали друг на друга.
 */
function dayGroup(date, container = elements.chatMessages) {
    const day = date ? dayKey(date) : '';
    const last = container.lastElementChild;
    // Сообщение без даты (своё, ещё не дошедшее) идёт в текущий день.
    if (last && (!date || last.dataset.day === day)) return last;
    const group = document.createElement('div');
    group.className = 'day-group';
    group.dataset.day = day;
    if (date) {
        const separator = document.createElement('div');
        separator.className = 'day-separator';
        separator.setAttribute('role', 'separator');
        const label = document.createElement('span');
        label.textContent = dayLabel(date);
        separator.appendChild(label);
        group.appendChild(separator);
    }
    container.appendChild(group);
    return group;
}

function appendMessage(message, { fresh = false, container = elements.chatMessages } = {}) {
    const el = createMessageElement(message);
    if (fresh) el.classList.add('is-new');
    dayGroup(messageDate(message), container).appendChild(el);
    if (container === elements.chatMessages) {
        refreshMessageTabStop();
        regroupMessages();
    }
}

/*
 * Страница старой истории встаёт в начало переписки. Если она кончается
 * тем же днём, с которого начинался экран, два блока этого дня сливаются
 * в один — иначе разделитель дня стоял бы дважды.
 */
function prependMessages(batch) {
    const list = elements.chatMessages;
    const lastOld = batch.lastElementChild;
    const firstShown = list.firstElementChild;
    if (lastOld && firstShown && lastOld.dataset.day && lastOld.dataset.day === firstShown.dataset.day) {
        for (const child of [...firstShown.children]) {
            if (!child.classList.contains('day-separator')) lastOld.appendChild(child);
        }
        firstShown.remove();
    }
    list.prepend(...batch.children);
    refreshMessageTabStop();
    regroupMessages();
}

/**
 * Убрать пузырь сообщения. Если это было последнее сообщение дня,
 * вместе с ним уходит и день с разделителем, иначе разделитель висел бы
 * над пустотой.
 */
function removeMessageElement(el) {
    const group = el.closest('.day-group');
    el.remove();
    if (group && !group.querySelector('.message, .message-system')) group.remove();
    refreshMessageTabStop();
    regroupMessages();
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

/**
 * Своё ли сообщение. Ответы бота записаны от имени владельца чата, но с
 * sent = 0: раньше они рисовались справа, как свои, и их предлагалось
 * редактировать и удалять.
 */
function isOwnMessage(message) {
    return Boolean(currentUser) && message.user_id === currentUser.id
        && message.sent !== 0 && message.sent !== false;
}

/** Код приглашения в окне; null — приглашение отключено. */
function showInviteCode(code) {
    elements.inviteCodeBox.hidden = !code;
    elements.inviteCodeDisplay.textContent = code || '';
    elements.inviteText.textContent = code
        ? 'Поделитесь этим кодом с друзьями:'
        : 'Приглашение отключено: по старому коду войти нельзя.';
    elements.resetInviteBtn.textContent = code ? 'Сменить код' : 'Включить с новым кодом';
    elements.disableInviteBtn.hidden = !code;
}

/*
 * Системная строка пишется сервером в третьем лице («alice включил(а)…»).
 * О себе — «Вы включили…».
 */
const SELF_VERBS = [
    [/^включил\(а\)/, 'включили'], [/^выключил\(а\)/, 'выключили'], [/^изменил\(а\)/, 'изменили'],
    [/^вошёл\(ла\)/, 'вошли'], [/^вышел\(ла\)/, 'вышли'], [/^сменил\(а\)/, 'сменили'], [/^отключил\(а\)/, 'отключили'],
];

function systemLineText(text) {
    const me = currentUser && currentUser.username;
    if (!me || !text.startsWith(`${me} `)) return text;
    let rest = text.slice(me.length + 1);
    for (const [pattern, replacement] of SELF_VERBS) {
        if (pattern.test(rest)) {
            rest = rest.replace(pattern, replacement);
            return `Вы ${rest}`;
        }
    }
    return text;
}

function createMessageElement(message) {
    // Событие чата (вошёл, вышел, сменил код) — строкой, без меню.
    if (message.message_type === 'system') {
        const line = document.createElement('div');
        line.className = 'message-system';
        line.dataset.messageId = message.id;
        const text = systemLineText(message.text || '');
        if (/исчезающ/.test(text)) line.appendChild(createIcon('i-timer'));
        line.append(text);
        return line;
    }
    const isMine = isOwnMessage(message);
    const div = document.createElement('div');
    div.className = `message ${isMine ? 'sent' : 'received'}`;
    div.dataset.messageId = message.id;
    if (message.sender_username) div.dataset.sender = message.sender_username;
    div.dataset.senderKey = `${isOwnMessage(message) ? 'me' : message.user_id}:${message.sent}`;
    const at = messageDate(message);
    div.dataset.at = String(at ? at.getTime() : 0);
    div.tabIndex = -1;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    if (message.deleted) {
        const em = document.createElement('em');
        em.textContent = 'Сообщение удалено';
        contentDiv.appendChild(em);
    } else if (message.newerVersion) {
        // Отправлено более новой версией Nyxo: разобрать её формат этот
        // клиент не может, но после обновления страницы сообщение прочитается.
        const em = document.createElement('em');
        em.className = 'message-locked';
        em.textContent = 'Сообщение из более новой версии Nyxo — обновите страницу';
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
            // Нажатие ведёт к исходному сообщению (setupFeed).
            if (message.reply_to.id && !message.reply_to.deleted) {
                replyDiv.dataset.replyId = message.reply_to.id;
                replyDiv.setAttribute('role', 'link');
                replyDiv.tabIndex = -1;
                replyDiv.title = 'Показать исходное сообщение';
            }
            const author = document.createElement('span');
            author.className = 'reply-to-author';
            author.textContent = message.reply_to.sender_username || 'Неизвестно';
            const quoted = document.createElement('span');
            quoted.className = 'reply-to-text';
            // Текст удалённого сообщения сервер стирает — цитировать нечего.
            quoted.textContent = message.reply_to.deleted
                ? 'Сообщение удалено'
                : (message.reply_to.text || 'Сообщение').substring(0, 60);
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
            reactionsDiv.append(...message.reactions.map(r => reactionChip(r)));
            contentDiv.appendChild(reactionsDiv);
        }
    }

    const metaDiv = document.createElement('div');
    metaDiv.className = 'message-meta';
    if (message.deviceTrust === 'new') {
        // Собеседник сверен, а это устройство — нет. Так выглядела бы и
        // подмена сервером, поэтому видно у каждого такого сообщения.
        div.classList.add('from-new-device');
        const warn = document.createElement('span');
        warn.className = 'message-new-device';
        warn.title = 'Отправлено с устройства, которого не было при сверке ключей. Сверьте код заново.';
        warn.setAttribute('role', 'img');
        warn.setAttribute('aria-label', warn.title);
        warn.appendChild(createIcon('i-alert'));
        metaDiv.appendChild(warn);
    } else if (message.encrypted) {
        const lock = document.createElement('span');
        lock.className = 'message-encrypted';
        lock.title = 'Сквозное шифрование';
        lock.appendChild(createIcon('i-lock'));
        metaDiv.appendChild(lock);
    }
    const expiresAt = message.expires_at ? new Date(message.expires_at) : null;
    if (expiresAt && !Number.isNaN(expiresAt.getTime())) {
        div.dataset.expiresAt = String(expiresAt.getTime());
        const timer = document.createElement('span');
        timer.className = 'message-expiry';
        timer.title = `Исчезнет ${fullFormat.format(expiresAt)}`;
        timer.setAttribute('role', 'img');
        timer.setAttribute('aria-label', timer.title);
        timer.appendChild(createIcon('i-timer'));
        metaDiv.appendChild(timer);
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
        setMessageStatus(statusSpan, message.status);
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
    const isMine = isOwnMessage(message);
    // Правка зашифрованного сообщения ушла бы на сервер открытым текстом,
    // поэтому её нет вовсе — удалить и отправить заново можно.
    elements.editMessageBtn.hidden = !(isMine && !message.encrypted);
    elements.deleteMessageBtn.hidden = !isMine;
    // С ботом реакции ни к чему: ответить некому.
    elements.reactionRow.hidden = currentChatIsBot;

    menuTrigger = trigger;
    if (menu.matches(':popover-open')) menu.hidePopover();
    menu.showPopover();
    // Размер известен только после показа: прижимаем меню к краям окна.
    const margin = 8;
    const left = Math.max(margin, Math.min(x, window.innerWidth - menu.offsetWidth - margin));
    const top = Math.max(margin, Math.min(y, window.innerHeight - menu.offsetHeight - margin));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    // Раскрывается из точки нажатия, даже если меню пришлось сдвинуть от края.
    menu.style.transformOrigin = `${x - left}px ${y - top}px`;
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

/*
 * Удалённое не пропадает скачком: пузырь за 150 мс сжимается по высоте и
 * гаснет, соседние сообщения плавно смыкаются. Потом — hidden, как раньше.
 */
const COLLAPSE_MS = 150;

function collapseMessage(el) {
    el.style.height = `${el.offsetHeight}px`;
    el.getBoundingClientRect();
    el.classList.add('is-collapsing');
    el.style.height = '0px';
    el.collapseTimer = setTimeout(() => {
        el.hidden = true;
        el.classList.remove('is-collapsing');
        el.style.height = '';
        refreshMessageTabStop();
        regroupMessages();
    }, COLLAPSE_MS);
}

function expandMessage(el) {
    clearTimeout(el.collapseTimer);
    el.classList.remove('is-collapsing');
    el.style.height = '';
    el.hidden = false;
    refreshMessageTabStop();
    regroupMessages();
}

function scheduleDelete(messageId) {
    const el = elements.chatMessages.querySelector(`[data-message-id="${messageId}"]`);
    if (!el || pendingDeletes.has(messageId)) return;
    collapseMessage(el);
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
    expandMessage(pending.el);
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
        expandMessage(pending.el);
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
        // Читают историю — не выдёргиваем вниз, а показываем «↓» со
        // счётчиком. У конца переписки — прокручиваем, как раньше.
        const wasAtBottom = atChatBottom();
        await appendMessageDecrypted(message, { fresh: true });
        if (wasAtBottom || isOwnMessage(message)) scrollToBottom();
        else noteNewBelow();
        scheduleReadMark();
    } else {
        // Чужой чат: расшифровываем ради превью в списке, рисовать
        // нечего.
        if (message.encrypted && e2ee) {
            const raw = await resolveMessageText(message);
            if (raw !== null) {
                await e2ee.rememberPreview(message, e2ee.payloadPreview(e2ee.decodePayload(raw)));
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
    await e2ee.rememberSent(data.message, encoded);
    const content = e2ee.decodePayload(encoded);
    const preview = e2ee.payloadPreview(content);
    await e2ee.rememberPreview(data.message, preview);
    updateChatPreviewInList(data.message, preview);

    if (chatId === currentChatId) {
        const local = { ...data.message };
        applyDecryptedContent(local, content);
        await resolveReplyQuote(local);
        appendMessage(local, { fresh: true });
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
        headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': await csrfToken() },
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
        headers: { 'X-CSRF-Token': await csrfToken() },
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
    const leaving = { id: currentChatId, room_id: currentRoomId };
    const data = await api(`/api/chats/${currentChatId}`, { method: 'DELETE' });
    if (data.success) {
        if (e2ee) await e2ee.forgetConversation(leaving);
        showToast('Чат удалён', 'success');
        closeModal(elements.chatMenuModal);
        chatViews.delete(currentChatId);
        elements.messageInput.value = '';
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
        const div = chatItemElement(chat, null);
        div.addEventListener('click', () => openChat(chat.id, null, chat.name, chat.avatar, 0, 0));
        elements.chatsList.appendChild(div);
    });
}

/**
 * Элемент списка чатов — через DOM, а не шаблонной строкой в innerHTML:
 * первая буква названия и цвет аватара попадали туда без экранирования.
 * Цвет принимается только вида #rrggbb.
 */
function chatItemElement(chat, previewText) {
    const div = document.createElement('div');
    div.className = 'chat-item';
    div.dataset.id = chat.id;
    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar-small';
    avatar.style.background = /^#[0-9a-f]{3,8}$/i.test(chat.avatar || '') ? chat.avatar : DEFAULT_AVATAR;
    avatar.textContent = chat.name.charAt(0).toUpperCase();
    const info = document.createElement('div');
    info.className = 'chat-info';
    const name = document.createElement('div');
    name.className = 'chat-name';
    name.textContent = chat.name;
    info.appendChild(name);
    if (previewText !== null) {
        const last = document.createElement('div');
        last.className = 'chat-last';
        last.textContent = previewText;
        info.appendChild(last);
    }
    div.append(avatar, info);
    if (chat.unread > 0) {
        const badge = document.createElement('div');
        badge.className = 'chat-badge';
        badge.textContent = String(chat.unread);
        div.appendChild(badge);
    }
    return div;
}

function scrollToBottom({ smooth = false } = {}) {
    const list = elements.chatMessages;
    if (smooth && !prefersReducedMotion()) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    else list.scrollTop = list.scrollHeight;
}


init();
