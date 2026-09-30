const socket = io();
let currentChatId = null;
let currentRoomId = null;
let currentChatIsBot = false;
let currentUser = null;
let replyToMessageId = null;
let editingMessageId = null;
let longPressTimer = null;
// Когда в последний раз открыли меню долгим нажатием: Android вслед за ним
// присылает ещё и системный contextmenu — второй раз меню не открываем.
let longPressShownAt = 0;
let lastTap = null;
const LONG_PRESS_MS = 400;
// Долгое нажатие на сообщение: через 120 мс пузырь начинает сжиматься,
// меню — на 320 мс (как в Telegram).
const MESSAGE_PRESS_MS = 320;
const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;

const elements = {
    authScreen: document.getElementById('auth-screen'),
    app: document.getElementById('app'),
    loginForm: document.getElementById('login-form'),
    registerForm: document.getElementById('register-form'),
    loginBtn: document.getElementById('login-btn'),
    registerBtn: document.getElementById('register-btn'),
    anonymousLoginBtn: document.getElementById('anonymous-login-btn'),
    anonModal: document.getElementById('anon-modal'),
    anonConfirmBtn: document.getElementById('anon-confirm-btn'),
    anonNote: document.getElementById('anon-note'),
    anonNoteText: document.getElementById('anon-note-text'),
    pinChatBtn: document.getElementById('pin-chat-btn'),
    muteChatBtn: document.getElementById('mute-chat-btn'),
    archiveChatBtn: document.getElementById('archive-chat-btn'),
    chatItemMenu: document.getElementById('chat-item-menu'),
    logoutBtn: document.getElementById('logout-btn'),
    settingsBtn: document.getElementById('settings-btn'),
    settingsModal: document.getElementById('settings-modal'),
    typingToggle: document.getElementById('typing-toggle'),
    soundsToggle: document.getElementById('sounds-toggle'),
    chatTop: document.getElementById('chat-top'),
    jumpDown: document.getElementById('jump-down'),
    jumpDownCount: document.getElementById('jump-down-count'),
    reactionRow: document.getElementById('reaction-row'),
    reactionPicker: document.getElementById('reaction-picker'),
    reactionWho: document.getElementById('reaction-who'),
    selectTextBtn: document.getElementById('select-text-btn'),
    chatMenuInviteBtn: document.getElementById('chat-menu-invite-btn'),
    uploadStatus: document.getElementById('upload-status'),
    uploadStatusName: document.getElementById('upload-status-name'),
    uploadStatusNote: document.getElementById('upload-status-note'),
    uploadProgress: document.getElementById('upload-progress'),
    uploadStatusPercent: document.getElementById('upload-status-percent'),
    uploadCancelBtn: document.getElementById('upload-cancel-btn'),
    dropZone: document.getElementById('drop-zone'),
    dropZoneCount: document.getElementById('drop-zone-count'),
    sidebarResizer: document.getElementById('sidebar-resizer'),
    compactTip: document.getElementById('compact-tip'),
    notifyToggle: document.getElementById('notify-toggle'),
    sendFilesModal: document.getElementById('send-files-modal'),
    sendFilesTitle: document.getElementById('send-files-title'),
    sendFilesList: document.getElementById('send-files-list'),
    sendFilesConfirm: document.getElementById('send-files-confirm'),
    sendFilesCancel: document.getElementById('send-files-cancel'),
    securitySection: document.getElementById('security-section'),
    securityList: document.getElementById('security-list'),
    connectionStatus: document.getElementById('connection-status'),
    connectionStatusText: document.getElementById('connection-status-text'),
    readReceiptsToggle: document.getElementById('read-receipts-toggle'),
    hidePresenceToggle: document.getElementById('hide-presence-toggle'),
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
    chatExpiryOptions: document.getElementById('chat-expiry-options'),
    logoutModal: document.getElementById('logout-modal'),
    logoutWipeBtn: document.getElementById('logout-wipe-btn'),
    logoutKeepBtn: document.getElementById('logout-keep-btn'),
    chatsList: document.getElementById('chats-list'),
    chatMessages: document.getElementById('chat-messages'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    fileInput: document.getElementById('file-input'),
    newChatBtn: document.getElementById('new-chat-btn'),
    shareModal: document.getElementById('share-modal'),
    chatHeader: document.getElementById('chat-header'),
    sidebar: document.querySelector('.sidebar'),
    mainContent: document.querySelector('.main-content'),
    roomEmpty: document.getElementById('room-empty'),
    plaintextNotice: document.getElementById('plaintext-notice'),
    roomEmptyInvite: document.getElementById('room-empty-invite'),
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
    inviteTerms: document.getElementById('invite-terms'),
    inviteQr: document.getElementById('invite-qr'),
    inviteExpiry: document.getElementById('invite-expiry'),
    inviteLimit: document.getElementById('invite-limit'),
    inviteApproval: document.getElementById('invite-approval'),
    newChatBack: document.getElementById('new-chat-back'),
    newChatTitle: document.getElementById('new-chat-modal-title'),
    newChatName: document.getElementById('new-chat-name'),
    joinChatCode: document.getElementById('join-chat-code'),
    joinPreview: document.getElementById('join-preview'),
    joinPreviewAvatar: document.getElementById('join-preview-avatar'),
    joinPreviewName: document.getElementById('join-preview-name'),
    joinPreviewMeta: document.getElementById('join-preview-meta'),
    joinSentText: document.getElementById('join-sent-text'),
    joinSentCancel: document.getElementById('join-sent-cancel'),
    joinSentClose: document.getElementById('join-sent-close'),
    myRequests: document.getElementById('my-requests'),
    joinRequestsBar: document.getElementById('join-requests-bar'),
    joinRequestsBarText: document.getElementById('join-requests-bar-text'),
    chatMenuMembersBtn: document.getElementById('chat-menu-members-btn'),
    deleteChatLabel: document.getElementById('delete-chat-label'),
    membersModal: document.getElementById('members-modal'),
    membersTitle: document.getElementById('members-title'),
    membersList: document.getElementById('members-list'),
    membersInviteBtn: document.getElementById('members-invite-btn'),
    requestsSection: document.getElementById('requests-section'),
    requestsList: document.getElementById('requests-list'),
    groupNameInput: document.getElementById('group-name-input'),
    groupNameSave: document.getElementById('group-name-save'),
    directCode: document.getElementById('direct-code'),
    directPreview: document.getElementById('direct-preview'),
    directPreviewAvatar: document.getElementById('direct-preview-avatar'),
    directPreviewName: document.getElementById('direct-preview-name'),
    directPreviewMeta: document.getElementById('direct-preview-meta'),
    directFindBtn: document.getElementById('direct-find-btn'),
    directMeetBtn: document.getElementById('direct-meet-btn'),
    userCodeDisplay: document.getElementById('user-code-display'),
    copyUserCodeBtn: document.getElementById('copy-user-code-btn'),
    rotateUserCodeBtn: document.getElementById('rotate-user-code-btn'),
    profileMeetBtn: document.getElementById('profile-meet-btn'),
    codeRequestsToggle: document.getElementById('code-requests-toggle'),
    blockedSection: document.getElementById('blocked-section'),
    blockedList: document.getElementById('blocked-list'),
    blockPeerBtn: document.getElementById('block-peer-btn'),
    blockPeerLabel: document.getElementById('block-peer-label'),
    meetModal: document.getElementById('meet-modal'),
    meetQr: document.getElementById('meet-qr'),
    meetCode: document.getElementById('meet-code'),
    meetResult: document.getElementById('meet-result'),
    meetScan: document.getElementById('meet-scan'),
    meetScanBtn: document.getElementById('meet-scan-btn'),
    messageMenu: document.getElementById('message-menu'),
    replyMessageBtn: document.getElementById('reply-message-btn'),
    editMessageBtn: document.getElementById('edit-message-btn'),
    deleteMessageBtn: document.getElementById('delete-message-btn'),
    replyPreview: document.getElementById('reply-preview'),
    replyPreviewText: document.getElementById('reply-preview-text'),
    replyPreviewAuthor: document.getElementById('reply-preview-author'),
    editPreview: document.getElementById('edit-preview'),
    editPreviewText: document.getElementById('edit-preview-text'),
    cancelEditBtn: document.getElementById('cancel-edit-btn'),
    cancelReplyBtn: document.getElementById('cancel-reply-btn'),
    toast: document.getElementById('toast'),
    profileUsername: document.getElementById('profile-username'),
    profileEmail: document.getElementById('profile-email'),
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
let e2eeFailure = null;   // почему шифрование на этом устройстве не поднялось

/*
 * Почему не поднялось шифрование — человеческими словами. Без него писать
 * можно только боту: открытым текстом в чат клиент не отправляет, поэтому
 * причину надо назвать, а не промолчать.
 */
async function describeE2eeFailure(detail) {
    if (!window.isSecureContext || !(window.crypto && crypto.subtle)) {
        return 'страница открыта не по HTTPS, и браузер отключил шифрование. Откройте адрес, начинающийся с https://';
    }
    try {
        await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
        await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    } catch {
        return 'этот браузер не умеет ключи, которые нужны для шифрования (Ed25519 и X25519). Обновите его';
    }
    return `сервер ключей недоступен или не ответил${detail ? ` (${detail})` : ''}`;
}

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
    try {
        await bootstrapE2EE();
    } finally {
        // Сокет переподключается после входа всегда, поднялось шифрование или
        // нет: рукопожатие несёт сессию, а она только что сменилась. Раньше
        // это делалось лишь при удачном шифровании, и без него сокет
        // оставался со старой (гостевой) сессией — новые сообщения не
        // приходили.
        await reconnectSocket();
    }
    if (!e2ee || !e2ee.isReady()) return;
    checkNewDevices();
    // Хранилище устройства доступно — сразу стираем истёкшее, не дожидаясь таймера.
    sweepExpiredMessages();
    // И отправляем то, что ждало ключей собеседника.
    flushPending();
}

async function bootstrapE2EE() {
    e2ee = await cryptoModule();
    if (!e2ee) {
        console.warn('[E2EE] модуль крипты не загрузился');
        e2eeFailure = await describeE2eeFailure('модуль шифрования не загрузился');
        return;
    }
    const result = await e2ee.bootstrap({
        api,
        userId: currentUser.id,
        deviceName: deviceLabel(),
    });
    if (!result) {
        e2eeDeviceId = null;
        e2eeFailure = await describeE2eeFailure(e2ee.lastError());
        return;
    }
    e2eeDeviceId = result.deviceId;
    e2eeFailure = null;
}

// Серверная комната device:<id> выбирается по сессии в момент рукопожатия,
// поэтому сокет переподключается ПЕРЕД тем, как кто-то позовёт joinChat.
async function reconnectSocket() {
    socket.disconnect();
    await new Promise(resolve => {
        socket.once('connect', resolve);
        socket.connect();
        // Не зависаем, если сокет не поднимется: без него приложение
        // деградирует до обновления по перезагрузке, но работает.
        setTimeout(resolve, 3000);
    });
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

/*
 * Ключи шифрования лежат в IndexedDB, а её браузер вправе стереть: Safari
 * удаляет данные сайта, если неделю пользовались Safari и не открывали
 * Nyxo. «Постоянное» хранилище (navigator.storage.persist) от этого
 * защищает. Просим по нажатию: Safari и Firefox без жеста не дают или
 * спрашивают невпопад. Chrome решает сам — по тому, насколько сайтом
 * пользуются, и у установленного приложения обычно даёт.
 */
async function renderStorageState() {
    const section = document.getElementById('storage-section');
    const state = document.getElementById('storage-state');
    const button = document.getElementById('storage-persist-btn');
    if (!navigator.storage || !navigator.storage.persisted) {
        section.hidden = true;
        return true;
    }
    const persisted = await navigator.storage.persisted().catch(() => false);
    section.hidden = false;
    state.textContent = persisted
        ? 'Защищены: браузер не сотрёт их сам, только если вы очистите данные сайта.'
        : 'Браузер может стереть их, если долго не открывать Nyxo (Safari — через неделю). Тогда старые сообщения на этом устройстве не прочитать.';
    button.hidden = persisted;
    return true;
}

async function requestPersistentStorage() {
    const granted = await navigator.storage.persist().catch(() => false);
    await renderStorageState();
    showToast(granted ? 'Ключи защищены от очистки' : 'Браузер отказал — это решает он сам. Установите Nyxo на экран «Домой» и попробуйте снова',
        granted ? 'success' : 'info');
}

async function renderSecurityEvents() {
    const data = await api('/api/security-events').catch(() => null);
    if (!data || !data.success) return false;
    const events = data.events;
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
    return true;
}

async function renderDevices() {
    const list = await api('/api/devices').catch(() => null);
    if (!list || !list.success) return false;
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
    return true;
}

/* --- Профиль ----------------------------------------------------------------
   Окно открывается сразу: имя, почта и цвет — из того, что уже известно,
   остальные разделы — заготовками, и каждый заполняется по своему ответу
   (запросы идут параллельно). Раздел, который не загрузился, говорит об
   этом у себя и предлагает повторить, — остальные от него не зависят.
   Второй раз окно показывает прошлое и тихо обновляется. */

let profileLoaded = false;

function fillProfileUser(user) {
    elements.profileUsername.textContent = user.username || '';
    elements.profileEmail.textContent = user.email || (user.email === undefined ? '' : 'Нет email (приватный режим)');
    const avatar = user.avatar || DEFAULT_AVATAR;
    paintAvatar(elements.profileAvatar, avatar, user.username);
    document.querySelectorAll('.color-option').forEach(o => {
        o.classList.toggle('active', o.dataset.color.toLowerCase() === avatar.toLowerCase());
    });
    const anonymous = user.email === null || Boolean(user.isAnonymous);
    elements.profileAnonBadge.classList.toggle('hidden', !anonymous);
    elements.changePasswordBtn.classList.toggle('hidden', anonymous);
    elements.linkDeviceBtn.hidden = anonymous;
    if ('sendReadReceipts' in user) elements.readReceiptsToggle.checked = user.sendReadReceipts !== false;
    if ('hidePresence' in user) elements.hidePresenceToggle.checked = Boolean(user.hidePresence);
}

async function saveAvatar(avatar) {
    const data = await api('/api/user/avatar', { method: 'POST', body: JSON.stringify({ avatar }) });
    if (!data.success) return showToast(data.message, 'error');
    if (currentUser) currentUser.avatar = data.avatar;
    paintAvatar(elements.profileAvatar, data.avatar, currentUser && currentUser.username);
    document.querySelectorAll('.color-option[data-color]').forEach(o => {
        o.classList.toggle('active', o.dataset.color.toLowerCase() === data.avatar.toLowerCase());
    });
    showToast('Аватар обновлён', 'success');
}

async function loadProfileUser() {
    const data = await api('/api/user').catch(() => null);
    if (!data || !data.success) return false;
    fillProfileUser(data.user);
    if (currentUser) Object.assign(currentUser, { sendTyping: data.user.sendTyping !== false });
    elements.typingToggle.checked = data.user.sendTyping !== false;
    return true;
}

/* --- Настройки --------------------------------------------------------------
   Окно — сразу, из того, что известно; значения с сервера — следом. Звуки
   и фон — настройки этого браузера. */

async function openSettings() {
    elements.notifyToggle.checked = notificationsOn();
    elements.soundsToggle.checked = soundsOn();
    document.getElementById('haptics-toggle').checked = hapticsOn();
    const bg = chatBackground();
    for (const radio of document.querySelectorAll('input[name="chat-bg"]')) radio.checked = radio.value === bg;
    elements.typingToggle.checked = !currentUser || currentUser.sendTyping !== false;
    openModal(elements.settingsModal);
    await loadProfileSection(elements.settingsModal.querySelector('.modal-body'), loadProfileUser);
}

const CHAT_BG_KEY = 'nyxo-chat-bg';
function chatBackground() {
    try {
        return localStorage.getItem(CHAT_BG_KEY) === 'plain' ? 'plain' : 'gradient';
    } catch {
        return 'gradient';
    }
}
function setChatBackground(value) {
    try { localStorage.setItem(CHAT_BG_KEY, value); } catch { /* хранилище недоступно */ }
    applyChatBackground();
}
function applyChatBackground() {
    if (chatBackground() === 'plain') document.documentElement.dataset.chatBg = 'plain';
    else delete document.documentElement.dataset.chatBg;
}

// Раздел профиля: заполнить; не вышло — «Не удалось загрузить · Повторить»
// на его месте.
async function loadProfileSection(host, load) {
    host.querySelector(':scope > .section-error')?.remove();
    let ok = false;
    try {
        ok = await load();
    } catch (error) {
        console.warn('Раздел профиля не загрузился:', error);
    }
    if (ok) return;
    const row = document.createElement('p');
    row.className = 'section-error';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'link-inline';
    retry.textContent = 'Повторить';
    retry.addEventListener('click', () => loadProfileSection(host, load));
    const text = document.createElement('span');
    text.textContent = 'Не удалось загрузить · ';
    row.append(createIcon('i-alert'), text, retry);
    host.appendChild(row);
}

function profileSkeletons() {
    const line = () => {
        const li = document.createElement('li');
        li.className = 'skeleton members-skeleton';
        li.setAttribute('aria-hidden', 'true');
        return li;
    };
    elements.devicesList.replaceChildren(line());
    elements.userCodeDisplay.textContent = '';
    elements.userCodeDisplay.parentElement.classList.add('is-loading');
}

async function openProfile() {
    if (!profileLoaded) {
        fillProfileUser({ ...currentUser, email: currentUser.isAnonymous ? null : currentUser.email });
        profileSkeletons();
    }
    elements.notifyToggle.checked = notificationsOn();
    openModal(elements.profileModal);
    profileLoaded = true;
    await Promise.allSettled([
        loadProfileSection(elements.profileUsername.closest('.profile-info'), loadProfileUser),
        loadProfileSection(elements.userCodeDisplay.closest('section'), renderUserCode),
        loadProfileSection(elements.blockedSection, renderBlocked),
        loadProfileSection(elements.devicesSection, renderDevices),
        loadProfileSection(elements.securitySection, renderSecurityEvents),
        renderStorageState(),
    ]);
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
    if (!line) return;
    const item = line.closest('.chat-item');
    const chat = item && chatsMeta.get(Number(item.dataset.id));
    if (!chat) {
        line.textContent = text.substring(0, 30);
        return;
    }
    chat.last_user_id = message.user_id;
    chat.last_sender = message.sender_username || null;
    chat.last_sent = message.sent;
    chat.last_type = message.message_type || 'text';
    chat.last_status = isOwnMessage(message) ? message.status || 'sent' : null;
    fillChatLast(line, chat, text.substring(0, 30));
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
/*
 * Одно сообщение может прийти дважды: по сокету, пока грузится история, и
 * в самой истории. Проверка «уже показано» — до первого await: раньше она
 * смотрела в DOM, и два вызова, начавшиеся до того, как первый дорисовал
 * пузырь, проходили оба. Набор чистится вместе с лентой (clearFeed).
 */
const shownMessageIds = new Set();

function clearFeed() {
    elements.chatMessages.innerHTML = '';
    shownMessageIds.clear();
    metaWidthObserver.disconnect();
}

async function appendMessageDecrypted(message, { fresh = false, container = null } = {}) {
    if (message.id) {
        if (shownMessageIds.has(message.id)) return;
        shownMessageIds.add(message.id);
    }
    await resolveReplyQuote(message);
    if (message.encrypted) {
        const raw = await resolveMessageText(message);
        const content = raw === null ? null : e2ee.decodePayload(raw);
        applyDecryptedContent(message, content);
        message.deviceTrust = await e2ee.senderDeviceTrust(message.user_id, message.sender_device_id);
        if (content) message.preview = e2ee.payloadPreview(content);
        if (content && !container) {
            const preview = message.preview;
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

// Собеседники (без себя) и те из них, у кого нет ни одного устройства.
function peersOf(info) {
    const others = ((info && info.participants) || []).filter(p => p.user_id !== (currentUser && currentUser.id));
    const withDevices = new Set(((info && info.devices) || []).map(d => d.user_id));
    return { others, withoutDevices: others.filter(p => !withDevices.has(p.user_id)) };
}

const namesList = users => users.map(u => u.username).join(', ');

function noKeysText(users) {
    return users.length === 1
        ? `У ${users[0].username} нет устройства с шифрованием`
        : `У ${namesList(users)} нет устройств с шифрованием`;
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
    let checkable = true;
    if (isBot) {
        text = 'Без шифрования: бот';
    } else if (!e2ee || !e2ee.isReady()) {
        // Писать сюда не выйдет, пока шифрование не заработает.
        mode = 'warn';
        icon = 'i-alert';
        checkable = false;
        text = 'Шифрование на этом устройстве не работает';
    } else {
        const info = await chatDevices(chatId);
        const { others, withoutDevices } = peersOf(info);
        if (others.length > 0 && withoutDevices.length === others.length) {
            // Сообщения будут ждать на устройстве, пока ключи не появятся.
            mode = 'warn';
            icon = 'i-timer';
            checkable = false;
            text = noKeysText(withoutDevices);
        } else if (hasForeignDevices(info)) {
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
    badge.dataset.checkable = mode !== 'off' && checkable ? '1' : '';
    // На телефоне видно только значок — нажатие показывает подробности,
    // даже когда сверять нечего.
    badge.disabled = !mobileLayout.matches && (mode === 'off' || !checkable);
    badge.title = badge.disabled ? (mode === 'warn' && e2eeFailure && !checkable ? e2eeFailure : '') : 'Сверить ключи';
    // Текст в отдельном элементе: на узком экране он обрезается
    // многоточием, а замок остаётся виден.
    const label = document.createElement('span');
    label.className = 'encryption-badge-text';
    label.textContent = text;
    // На телефоне места мало: вместо одинокого значка — короткое слово.
    const short = document.createElement('span');
    short.className = 'encryption-badge-short';
    short.setAttribute('aria-hidden', 'true');
    short.textContent = isBot ? 'Без шифрования'
        : !checkable && mode === 'warn' && icon === 'i-timer' ? 'Нет ключей'
            : !checkable && mode === 'warn' ? 'Не шифруется'
                : mode === 'warn' ? 'Ключи изменились'
                    : icon === 'i-shield-check' ? 'Сверено'
                        : mode === 'on' ? 'Шифруется' : 'Без шифрования';
    badge.replaceChildren(createIcon(icon), label, short);
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

// Единственный «свой» момент: код совпал — галочка прорисовывается,
// плашка слегка вырастает, телефон коротко вздрагивает.
async function renderVerified(section, chatId, user) {
    const fresh = await renderSafetyEntry(chatId, user);
    section.replaceWith(fresh);
    const burst = document.createElement('div');
    burst.className = 'verified-burst';
    burst.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M7 12.5l3.2 3.2L17 9"/></svg>';
    burst.append('Ключи сверены');
    fresh.prepend(burst);
    haptic('light');
    refreshEncryptionBadge(chatId, currentChatIsBot);
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
            await renderVerified(section, chatId, user);
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
            await renderVerified(section, chatId, user);
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

/* --- Аватары ----------------------------------------------------------------
   Цвет с первой буквой имени ('#RRGGBB'). Непонятное значение — цвет по
   умолчанию. */

// Оформление чёрно-белое: у всех аватаров один нейтральный фон (--avatar)
// и буква цветом текста. Выбранный цвет хранится, но пока не показывается.
function avatarLook() {
    return { background: 'var(--avatar)', color: 'var(--text)' };
}

function paintAvatar(el, avatar, name) {
    const look = avatarLook(avatar);
    el.style.background = look.background;
    el.textContent = (name || '?').charAt(0).toUpperCase();
    return look;
}

// У бота — значок робота вместо буквы.
function paintBotAvatar(el) {
    el.style.background = 'var(--avatar)';
    el.replaceChildren(createIcon('i-bot'));
    el.classList.add('is-bot-avatar');
}
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
    updateThemeColor();
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

/*
 * Строка состояния на телефоне красится по theme-color. Обе метки (для
 * светлой и тёмной системы) получают цвет выбранной темы, иначе при ручной
 * смене полоса сверху осталась бы цвета системной. В приложении — цвет
 * шапки, на экране входа — цвет фона.
 */
function updateThemeColor() {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    const inApp = !elements.app.classList.contains('hidden');
    const color = inApp ? (light ? '#ffffff' : '#121212') : (light ? '#f5f5f5' : '#0a0a0a');
    document.querySelectorAll('meta[name="theme-color"]').forEach(meta => meta.setAttribute('content', color));
}

/*
 * Смена темы — мягким перетеканием: старая тема тает, новая проявляется
 * (View Transitions, 400 мс). Круг от кнопки на телефоне заливал экран
 * почти мгновенно и выглядел скачком. Без View Transitions на время смены
 * включаются переходы цвета у всех элементов. «Уменьшить движение» — то же
 * затухание, короче. Зависнуть переход не может дольше 1,5 с.
 */
function switchTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    const root = document.documentElement;
    const duration = prefersReducedMotion() ? 150 : 400;
    root.style.setProperty('--theme-fade', `${duration}ms`);
    if (document.startViewTransition) {
        const transition = document.startViewTransition(() => applyTheme(next));
        const stuck = setTimeout(() => transition.skipTransition(), 1500);
        transition.finished.finally(() => clearTimeout(stuck));
        return;
    }
    root.classList.add('is-theme-fading');
    applyTheme(next);
    setTimeout(() => root.classList.remove('is-theme-fading'), duration + 50);
}

function setupTheme() {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    applyChatBackground();
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
        btn.addEventListener('click', () => switchTheme());
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
    updateThemeColor();
}

function showApp() {
    // Истёкшее стирается сразу при запуске и дальше по таймеру.
    startExpirySweep();
    showAnonNote(currentUser);
    elements.authScreen.classList.add('hidden');
    elements.app.classList.remove('hidden');
    updateThemeColor();
    loadMyRequests();
    loadDirectRequests();
    setTimeout(offerJoinFromUrl);
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
function showToast(message, type = 'info', { action = null, duration = null, progress = false } = {}) {
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
    // Сколько осталось, чтобы передумать: полоска тает за время тоста.
    if (progress && duration) {
        const bar = document.createElement('span');
        bar.className = 'toast-progress';
        bar.setAttribute('aria-hidden', 'true');
        bar.style.setProperty('--toast-duration', `${duration}ms`);
        toast.appendChild(bar);
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
        if (toast.matches(':popover-open')) moveToast(host);
        else host.appendChild(toast);
    }
    // Ошибку экранный диктор зачитывает сразу, остальное — в паузе.
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    // Уже открыт на том же месте — меняется только содержимое, без
    // повторного въезда.
    if (!toast.matches(':popover-open')) toast.showPopover();
    toastClock.stop();
    toastClock.remaining = sticky ? null : (duration || 3200);
    toast.classList.remove('is-paused');
    toastClock.resume();
}

/*
 * Таймер тоста стоит, пока тост под пальцем или мышью, в фокусе или
 * вкладка скрыта, — прочитать и нажать «Вернуть» успевают.
 */
const toastClock = {
    remaining: null, started: 0, timer: null, holds: new Set(),
    stop() {
        clearTimeout(this.timer);
        this.timer = null;
    },
    resume() {
        if (this.remaining === null || this.holds.size || this.timer) return;
        this.started = Date.now();
        this.timer = setTimeout(hideToast, this.remaining);
        elements.toast.classList.remove('is-paused');
    },
    hold(reason) {
        this.holds.add(reason);
        if (this.timer) {
            this.stop();
            this.remaining = Math.max(0, this.remaining - (Date.now() - this.started));
        }
        elements.toast.classList.add('is-paused');
    },
    release(reason) {
        this.holds.delete(reason);
        this.resume();
    },
};

function setupToastPause() {
    const toast = elements.toast;
    toast.addEventListener('pointerenter', () => toastClock.hold('pointer'));
    toast.addEventListener('pointerleave', () => toastClock.release('pointer'));
    toast.addEventListener('focusin', () => toastClock.hold('focus'));
    toast.addEventListener('focusout', () => toastClock.release('focus'));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') toastClock.hold('hidden');
        else toastClock.release('hidden');
    });
}

// Перенос открытого тоста в окно (или обратно): без перехода ухода, иначе
// он задержался бы в верхнем слое под окном.
function moveToast(host) {
    const toast = elements.toast;
    toast.style.transition = 'none';
    toast.hidePopover();
    host.appendChild(toast);
    toast.showPopover();
    toast.getBoundingClientRect();
    toast.style.transition = '';
}

/*
 * Тост смахивают вниз: по расстоянию (40px) или рывком быстрее 0,11 px/мс
 * — для маленьких элементов этот порог уместен. На телефоне тост без
 * крестика закрывал поле ввода до конца таймера.
 */
function setupToastSwipe() {
    const toast = elements.toast;
    let drag = null;
    toast.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' || e.target.closest('button')) return;
        drag = { y: e.clientY, dy: 0, id: e.pointerId, samples: [[performance.now(), 0]] };
        toast.setPointerCapture(e.pointerId);
        toast.style.transition = 'none';
    });
    toast.addEventListener('pointermove', e => {
        if (!drag || e.pointerId !== drag.id) return;
        const dy = e.clientY - drag.y;
        drag.dy = dy > 0 ? dy : dy * 0.2;
        drag.samples.push([performance.now(), dy]);
        if (drag.samples.length > 5) drag.samples.shift();
        toast.style.translate = `0 ${drag.dy}px`;
        toast.style.opacity = String(Math.max(0.3, 1 - Math.max(0, drag.dy) / 120));
    });
    const end = e => {
        if (!drag || e.pointerId !== drag.id) return;
        const { dy, samples } = drag;
        drag = null;
        const [t0, y0] = samples[0];
        const [t1, y1] = samples[samples.length - 1];
        const speed = t1 > t0 ? (y1 - y0) / (t1 - t0) : 0;
        toast.style.transition = '';
        toast.style.removeProperty('translate');
        toast.style.removeProperty('opacity');
        if (dy > 40 || (speed > 0.11 && dy > 0)) hideToast();
    };
    toast.addEventListener('pointerup', end);
    toast.addEventListener('pointercancel', end);
}

function hideToast() {
    toastClock.stop();
    toastClock.remaining = null;
    toastClock.holds.delete('pointer');
    toastClock.holds.delete('focus');
    if (elements.toast.matches(':popover-open')) elements.toast.hidePopover();
}

/*
 * На телефоне окна — шторкой снизу; тянут её за шапку вниз. Вверх — с
 * сопротивлением. Закрывается дальше четверти высоты или рывком быстрее
 * 0,5 px/мс (как в iOS), иначе возвращается. Сдвиг — прямо у шторки.
 */
function setupSheetDrag() {
    document.querySelectorAll('dialog.modal').forEach(dialog => {
        const header = dialog.querySelector('.modal-header');
        const content = dialog.querySelector('.modal-content');
        if (!header || !content) return;
        let drag = null;
        header.addEventListener('pointerdown', e => {
            if (!mobileLayout.matches || e.button !== 0 || e.target.closest('button, input, a')) return;
            drag = { y: e.clientY, dy: 0, samples: [[performance.now(), 0]], id: e.pointerId };
            header.setPointerCapture(e.pointerId);
            dialog.classList.add('is-dragging');
        });
        header.addEventListener('pointermove', e => {
            if (!drag || e.pointerId !== drag.id) return;
            const dy = e.clientY - drag.y;
            drag.dy = dy >= 0 ? dy : dy * 0.2;
            drag.samples.push([performance.now(), dy]);
            if (drag.samples.length > 5) drag.samples.shift();
            content.style.setProperty('--sheet-drag', `${drag.dy}px`);
        });
        const end = e => {
            if (!drag || e.pointerId !== drag.id) return;
            const { dy, samples } = drag;
            drag = null;
            dialog.classList.remove('is-dragging');
            const [t0, y0] = samples[0];
            const [t1, y1] = samples[samples.length - 1];
            const speed = t1 > t0 ? (y1 - y0) / (t1 - t0) : 0;
            content.style.removeProperty('--sheet-drag');
            if (dy > content.offsetHeight * 0.25 || (speed > 0.5 && dy > 0)) closeModal(dialog);
        };
        header.addEventListener('pointerup', end);
        header.addEventListener('pointercancel', end);
    });
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
        e.network = true;
        throw e;
    }
    let data;
    try {
        data = await res.json();
    } catch (e) {
        // Не JSON: ответил не наш сервер, а прокси перед ним (502, 504) —
        // сервер недоступен, это как обрыв сети.
        data = { success: false, message: `Сервер не ответил (${res.status})`, unreachable: true };
    }
    if (!res.ok) logApiFailure(method, url, res.status, res.headers.get('X-Request-Id'));
    // Код ошибки — номер запроса в журнале сервера. Человеку он ничего не
    // говорит, но по нему находится, что именно сломалось.
    if (data && data.errorId && typeof data.message === 'string') {
        data.message = `${data.message}\nКод ошибки: ${data.errorId}`;
    }
    if (data && data.code === 'ANON_EXPIRED') onAnonExpired();
    return data;
}

/* --- Закрепление, «Без звука», архив ---------------------------------------
   Хранятся у записи чата на сервере — одинаковы на всех устройствах, другие
   узнают событием chatListChanged. Закрепить можно до пяти; закреплённые
   сверху в своём порядке, переставляются перетаскиванием, Alt+Shift+↑/↓ или
   пунктами «Выше»/«Ниже». Архив прячет чат из списка, ничего не удаляя. */

let archiveShown = false;

async function chatListAction(chatId, action) {
    const chat = chatsMeta.get(Number(chatId));
    if (!chat) return false;
    const flags = action === 'mute' ? { muted: !chat.muted }
        : action === 'unread' ? { markedUnread: true }
            : action.startsWith('mute:') ? { muted: true, mutedFor: Number(action.slice(5)) || null }
                : { archived: !chat.archived };
    const request = action === 'pin'
        ? api(`/api/chats/${chat.id}/pin`, { method: 'POST', body: JSON.stringify({ pinned: !chat.pin_position }) })
        : api(`/api/chats/${chat.id}/flags`, { method: 'POST', body: JSON.stringify(flags) });
    const data = await request;
    if (!data.success) {
        showToast(data.message, 'error');
        return false;
    }
    const MUTE_TEXT = { 3600: 'на 1 час', 28800: 'на 8 часов', 86400: 'на 1 день', 259200: 'на 3 дня' };
    const done = action.startsWith('mute:') ? `Без звука ${MUTE_TEXT[action.slice(5)] || 'навсегда'}` : {
        pin: chat.pin_position ? 'Чат откреплён' : 'Чат закреплён',
        mute: chat.muted ? 'Звук включён' : 'Без звука: уведомлений от этого чата не будет',
        archive: chat.archived ? 'Чат вернулся из архива' : 'Чат в архиве — он внизу списка',
        unread: 'Чат отмечен непрочитанным',
    }[action];
    await loadChats();
    applyRoomState();
    showToast(done, 'success');
    return true;
}

function pinnedOrder() {
    return [...chatsMeta.values()].filter(c => c.pin_position && !c.archived)
        .sort((a, b) => a.pin_position - b.pin_position).map(c => c.id);
}

async function savePinnedOrder(order) {
    const data = await api('/api/chats/pins', { method: 'PUT', body: JSON.stringify({ order }) });
    if (!data.success) showToast(data.message, 'error');
    await loadChats();
    return data.success;
}

async function movePinned(chatId, step) {
    const order = pinnedOrder();
    const from = order.indexOf(chatId);
    const to = from + step;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    if (await savePinnedOrder(order)) {
        const item = elements.chatsList.querySelector(`.chat-item[data-id="${chatId}"]`);
        if (item) {
            elements.chatsList.querySelectorAll('.chat-item').forEach(i => { i.tabIndex = -1; });
            item.tabIndex = 0;
            item.focus();
        }
    }
}

let chatItemMenuShownAt = 0;

function openChatItemMenu(item, x, y) {
    const menu = elements.chatItemMenu;
    const chat = chatsMeta.get(Number(item.dataset.id));
    if (!chat) return;
    menu.dataset.forChat = chat.id;
    const order = pinnedOrder();
    const at = order.indexOf(chat.id);
    const set = (action, text, hidden = false) => {
        const button = menu.querySelector(`[data-action="${action}"]`);
        button.hidden = hidden;
        button.querySelector('span').textContent = text;
    };
    set('pin', chat.pin_position ? 'Открепить' : 'Закрепить');
    set('up', 'Выше', !chat.pin_position || at <= 0);
    set('down', 'Ниже', !chat.pin_position || at < 0 || at >= order.length - 1);
    set('mute', chat.muted ? 'Со звуком' : 'Без звука');
    set('archive', chat.archived ? 'Из архива' : 'В архив');
    chatItemMenuShownAt = Date.now();
    if (menu.matches(':popover-open')) menu.hidePopover();
    menu.showPopover();
    watchMenuClose(hideChatItemMenu);
    const margin = 8;
    menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - menu.offsetWidth - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - menu.offsetHeight - margin))}px`;
    menu.querySelector('.menu-item:not([hidden])').focus();
}

function hideChatItemMenu() {
    if (elements.chatItemMenu.matches(':popover-open')) elements.chatItemMenu.hidePopover();
    unwatchMenuClose();
}

/*
 * Свайп строки чата влево — «В архив», как по умолчанию в Android.
 * Срабатывает на 45% ширины, на пороге — вибрация; под строкой — подложка
 * со значком. Жест начинается, только если движение явно горизонтальное:
 * |dx| > 4 и 2,5·|dy| < |dx| — иначе это прокрутка списка.
 */
let chatPressTimer = null;
function setupChatRowSwipe() {
    const list = elements.chatsList;
    let row = null;
    list.addEventListener('touchstart', e => {
        const item = e.target.closest && e.target.closest('.chat-item[data-id]');
        if (!item || e.touches.length !== 1) return;
        const t = e.touches[0];
        row = { item, x: t.clientX, y: t.clientY, dx: 0, active: false, ready: false, under: null };
    }, { passive: true });
    list.addEventListener('touchmove', e => {
        if (!row || e.touches.length !== 1) return;
        const t = e.touches[0];
        const dx = t.clientX - row.x;
        const dy = t.clientY - row.y;
        if (!row.active) {
            if (Math.abs(dy) > 10 && Math.abs(dy) * 2.5 >= Math.abs(dx)) { row = null; return; }
            if (!(dx < -4 && 2.5 * Math.abs(dy) < Math.abs(dx))) return;
            row.active = true;
            clearTimeout(chatPressTimer);
            const under = document.createElement('div');
            under.className = 'chat-swipe-under';
            under.setAttribute('aria-hidden', 'true');
            under.append(createIcon('i-archive'), 'В архив');
            row.item.after(under);
            under.style.top = `${row.item.offsetTop}px`;
            under.style.height = `${row.item.offsetHeight}px`;
            row.under = under;
            row.item.classList.add('is-swiping');
        }
        row.dx = Math.min(0, dx);
        row.item.style.transform = `translateX(${row.dx}px)`;
        const ready = -row.dx >= row.item.offsetWidth * 0.45;
        if (ready && !row.ready) haptic('medium');
        row.ready = ready;
        row.under.classList.toggle('is-ready', ready);
    }, { passive: true });
    const end = () => {
        if (!row) return;
        const { item, under, active, ready } = row;
        row = null;
        if (!active) return;
        item.style.transition = prefersReducedMotion() ? 'none' : 'transform 200ms var(--ease-out)';
        item.style.transform = ready ? 'translateX(-100%)' : '';
        setTimeout(() => {
            item.style.transition = '';
            item.style.transform = '';
            item.classList.remove('is-swiping');
            under.remove();
            if (ready) chatListAction(Number(item.dataset.id), 'archive');
        }, prefersReducedMotion() ? 0 : 200);
    };
    list.addEventListener('touchend', end);
    list.addEventListener('touchcancel', end);
}

function setupChatItemMenu() {
    const list = elements.chatsList;
    const menu = elements.chatItemMenu;
    list.addEventListener('contextmenu', event => {
        const item = event.target.closest && event.target.closest('.chat-item');
        if (!item || !item.closest('#chats-list')) return;
        event.preventDefault();
        openChatItemMenu(item, event.clientX, event.clientY);
    });
    // Долгое нажатие на телефоне. Меню ручное: светлое закрытие сработало
    // бы на том же отпускании пальца.
    setupChatRowSwipe();
    let pressTimer = null;
    list.addEventListener('touchstart', event => {
        const item = event.target.closest && event.target.closest('.chat-item');
        if (!item) return;
        const touch = event.touches[0];
        chatPressTimer = pressTimer = setTimeout(() => {
            haptic('medium');
            openChatItemMenu(item, touch.clientX, touch.clientY);
        }, LONG_PRESS_MS);
    }, { passive: true });
    for (const type of ['touchend', 'touchmove', 'touchcancel']) {
        list.addEventListener(type, () => clearTimeout(pressTimer), { passive: true });
    }
    // Отпускание после долгого нажатия — не «открыть чат».
    list.addEventListener('click', event => {
        if (Date.now() - chatItemMenuShownAt < 600 && menu.matches(':popover-open')) {
            event.stopPropagation();
            event.preventDefault();
        }
    }, true);
    document.addEventListener('pointerdown', event => {
        if (!menu.contains(event.target)) hideChatItemMenu();
    }, true);
    menu.addEventListener('keydown', event => {
        const items = [...menu.querySelectorAll('.menu-item:not([hidden])')];
        const index = items.indexOf(document.activeElement);
        if (event.key === 'Escape') {
            hideChatItemMenu();
            list.querySelector(`.chat-item[data-id="${menu.dataset.forChat}"]`)?.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
        }
    });
    list.addEventListener('scroll', hideChatItemMenu, { passive: true });
    menu.addEventListener('click', async event => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const chatId = Number(menu.dataset.forChat);
        hideChatItemMenu();
        const action = button.dataset.action;
        if (action === 'up' || action === 'down') await movePinned(chatId, action === 'up' ? -1 : 1);
        else await chatListAction(chatId, action);
    });
}

// Перетаскивание закреплённых мышью.
function setupPinDrag() {
    const list = elements.chatsList;
    let dragged = null;
    const clear = () => list.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
    list.addEventListener('dragstart', event => {
        const item = event.target.closest && event.target.closest('.chat-item.is-pinned');
        if (!item) return;
        dragged = item;
        item.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', item.dataset.id);
    });
    list.addEventListener('dragover', event => {
        const target = event.target.closest && event.target.closest('.chat-item.is-pinned');
        if (!dragged || !target || target === dragged) return;
        event.preventDefault();
        clear();
        const r = target.getBoundingClientRect();
        target.classList.add(event.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    });
    list.addEventListener('drop', event => {
        const target = event.target.closest && event.target.closest('.chat-item.is-pinned');
        if (!dragged || !target || target === dragged) return;
        event.preventDefault();
        const order = pinnedOrder().filter(id => id !== Number(dragged.dataset.id));
        const after = target.classList.contains('drop-after');
        order.splice(order.indexOf(Number(target.dataset.id)) + (after ? 1 : 0), 0, Number(dragged.dataset.id));
        clear();
        savePinnedOrder(order);
    });
    list.addEventListener('dragend', () => {
        if (dragged) dragged.classList.remove('is-dragging');
        dragged = null;
        clear();
    });
}

/* --- «Печатает…» ------------------------------------------------------------
   Событие без содержимого: кто и в каком чате. Шлём не чаще раза в 3 с,
   пока человек набирает; подпись у собеседников держится 5 с и снимается,
   когда от него приходит сообщение. В чате с ботом не шлём; выключено в
   настройках — не шлём (и сервер такое не разошлёт). */

const TYPING_SEND_MS = 3000;
const TYPING_SHOW_MS = 5000;
let typingSentAt = 0;
// room_id → Map(user_id → { username, until })
const typingState = new Map();

function noteTyping() {
    if (!currentChatId || currentChatIsBot || !currentRoomId || !elements.messageInput.value.trim()) return;
    if (currentUser && currentUser.sendTyping === false) return;
    const now = Date.now();
    if (now - typingSentAt < TYPING_SEND_MS) return;
    typingSentAt = now;
    socket.emit('typing', { chatId: currentChatId });
}

function onTyping({ room_id: roomId, user_id: userId, username }) {
    if (!currentUser || userId === currentUser.id) return;
    const room = typingState.get(Number(roomId)) || new Map();
    room.set(userId, { username, until: Date.now() + TYPING_SHOW_MS });
    typingState.set(Number(roomId), room);
    renderTyping();
    setTimeout(renderTyping, TYPING_SHOW_MS + 50);
}

// Сообщение пришло — этот человек больше не «печатает».
function stopTyping(roomId, userId) {
    const room = typingState.get(Number(roomId));
    if (room && room.delete(userId)) renderTyping();
}

function typingNames(roomId) {
    const room = typingState.get(Number(roomId));
    if (!room) return [];
    const now = Date.now();
    for (const [id, entry] of room) if (entry.until <= now) room.delete(id);
    if (!room.size) typingState.delete(Number(roomId));
    return [...room.values()].map(e => e.username);
}

function typingText(names, direct) {
    if (direct || !names.length) return 'печатает';
    if (names.length === 1) return `${names[0]} печатает`;
    if (names.length === 2) return `${names[0]} и ${names[1]} печатают`;
    return `${names[0]} и ещё ${names.length - 1} печатают`;
}

function typingElement(names, direct) {
    const box = document.createElement('span');
    box.className = 'typing';
    const dots = document.createElement('span');
    dots.className = 'typing-dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    box.append(`${typingText(names, direct)}`, dots);
    return box;
}

function renderTyping() {
    // Список: вместо последнего сообщения.
    for (const item of elements.chatsList.querySelectorAll('.chat-item[data-room-id]')) {
        const roomId = Number(item.dataset.roomId);
        const names = roomId ? typingNames(roomId) : [];
        const chat = chatsMeta.get(Number(item.dataset.id));
        let line = item.querySelector('.chat-typing');
        item.classList.toggle('is-typing', names.length > 0);
        if (!names.length) {
            line?.remove();
            continue;
        }
        if (!line) {
            line = document.createElement('div');
            line.className = 'chat-typing';
            item.querySelector('.chat-info')?.appendChild(line);
        }
        line.replaceChildren(typingElement(names, chat && chat.kind === 'direct'));
    }
    // Шапка открытого чата.
    if (currentChatId) renderChatStatus(currentChatIsBot);
}

/* --- Звуки ------------------------------------------------------------------
   Короткие (до 150 мс) и тихие, синтезом — без файлов. По умолчанию
   выключены; включаются в настройках этого браузера. */

const SOUNDS_KEY = 'nyxo-sounds';
let audioContext = null;

function soundsOn() {
    try {
        return localStorage.getItem(SOUNDS_KEY) === '1';
    } catch {
        return false;
    }
}

function setSoundsOn(on) {
    try { localStorage.setItem(SOUNDS_KEY, on ? '1' : '0'); } catch { /* хранилище недоступно */ }
    if (on) playSound('receive');
}

/*
 * Когда звенеть о входящем: на компьютере — только если окно не в фокусе
 * (в фокусе сообщение и так видно); на телефоне — если этот чат не открыт
 * или приложение свёрнуто. И не чаще раза в секунду.
 */
let lastRingAt = 0;
function shouldRing(message) {
    const hidden = document.visibilityState !== 'visible';
    const ring = mobileLayout.matches ? hidden || !isForOpenChat(message) : hidden || !document.hasFocus();
    if (!ring || Date.now() - lastRingAt < 1000) return false;
    lastRingAt = Date.now();
    return true;
}

function playSound(kind) {
    if (!soundsOn()) return;
    try {
        audioContext = audioContext || new AudioContext();
        // Браузер усыпляет звук без жеста и в фоне — будим.
        if (audioContext.state !== 'running') audioContext.resume().catch(() => {});
        const t = audioContext.currentTime;
        const tones = kind === 'send' ? [[740, 0, 0.07]] : [[560, 0, 0.06], [840, 0.06, 0.08]];
        for (const [frequency, start, length] of tones) {
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            osc.type = 'sine';
            osc.frequency.value = frequency;
            gain.gain.setValueAtTime(0.0001, t + start);
            gain.gain.exponentialRampToValueAtTime(0.04, t + start + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + start + length);
            osc.connect(gain).connect(audioContext.destination);
            osc.start(t + start);
            osc.stop(t + start + length + 0.02);
        }
    } catch {
        // Звука нет — не беда.
    }
}

/* --- Приватный режим -------------------------------------------------------
   Когда удалится аккаунт — строкой над кнопками профиля; за 10 минут до
   потолка (7 дней с создания) — предупреждение. Срок вышел — сервер уже
   удалил аккаунт; здесь стирается и то, что лежало в браузере. */

const ANON_LIFETIME_TEXT = {
    tab: 'через 30 мин после закрытия вкладки',
    day: 'через 24 ч без активности',
    week: 'через 7 дн без активности',
};
let anonWarnTimer = null;
let anonExpiring = false;

function showAnonNote(user) {
    clearTimeout(anonWarnTimer);
    const anon = user && user.isAnonymous ? user.anon : null;
    elements.anonNote.hidden = !anon;
    if (!anon) return;
    const deadline = new Date(anon.deadline);
    elements.anonNoteText.textContent = `Приватный режим · удалится ${ANON_LIFETIME_TEXT[anon.lifetime] || 'через 4 ч без активности'}`;
    elements.anonNote.title = `И в любом случае не позже ${fullFormat.format(deadline)}`;
    const warnIn = deadline.getTime() - 10 * 60 * 1000 - Date.now();
    // setTimeout дальше ~24 дней не умеет — а потолок и так 7 дней.
    if (warnIn < 2 ** 31 - 1) {
        anonWarnTimer = setTimeout(() => showToast(
            `Приватный аккаунт удалится через 10 минут (в ${timeFormat.format(deadline)}) вместе с перепиской. Сохраните нужное.`,
            'error'), Math.max(0, warnIn));
    }
}

async function onAnonExpired() {
    if (anonExpiring || !currentUser) return;
    anonExpiring = true;
    try {
        clearTimeout(anonWarnTimer);
        if (e2ee && e2ee.isReady()) await e2ee.wipeDevice().catch(() => {});
        e2eeDeviceId = null;
        currentUser = null;
        closeCurrentChat();
        chatViews.clear();
        for (const modal of document.querySelectorAll('dialog[open]')) closeModal(modal);
        if (socket) socket.disconnect();
        showAuth();
        showToast('Срок приватного аккаунта истёк: аккаунт и переписка удалены', 'info');
    } finally {
        anonExpiring = false;
    }
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

    // Сначала — срок: сколько аккаунт живёт без активности.
    elements.anonymousLoginBtn.addEventListener('click', () => openModal(elements.anonModal));
    elements.anonConfirmBtn.addEventListener('click', () => withBusy(elements.anonConfirmBtn, async () => {
        const lifetime = elements.anonModal.querySelector('input[name="anon-lifetime"]:checked').value;
        const data = await api('/api/register/anonymous', { method: 'POST', body: JSON.stringify({ lifetime }) });
        if (data.success) closeModal(elements.anonModal);
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
        // Push этому браузеру больше не нужен, а открытые уведомления —
        // чужому, кто сядет следом.
        await unsubscribePush();
        await closeChatNotifications(null);
        if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
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
        drafts = {};
        draftsLoadedFor = null;
        setMessageInput('');
        clearReply();
        editingMessageId = null;
        showEditBar(false);
        showToast('Вы вышли из аккаунта', 'info');
        showAuth();
    };
    elements.logoutBtn.addEventListener('click', () => {
        closeModal(elements.settingsModal);
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
        closeModal(elements.settingsModal);
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

    elements.newChatBtn.addEventListener('click', () => openNewChat());
    if (elements.emptyNewChatBtn) {
        elements.emptyNewChatBtn.addEventListener('click', () => openNewChat());
    }
    for (const card of elements.newChatModal.querySelectorAll('.choice-card')) {
        card.addEventListener('click', () => showNewChatPane(card.dataset.path));
    }
    elements.newChatBack.addEventListener('click', () => showNewChatPane('choice'));
    elements.createChatBtn.addEventListener('click', () => withBusy(elements.createChatBtn, createChat));
    elements.newChatName.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) withBusy(elements.createChatBtn, createChat);
    });
    elements.joinChatBtn.addEventListener('click', () => withBusy(elements.joinChatBtn, joinChat));
    elements.joinChatCode.addEventListener('input', resetJoinPreview);
    elements.joinChatCode.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) withBusy(elements.joinChatBtn, joinChat);
    });
    elements.joinSentCancel.addEventListener('click', () => withBusy(elements.joinSentCancel, async () => {
        if (await cancelJoinRequest(sentRequestId)) closeModal(elements.newChatModal);
    }));
    elements.joinSentClose.addEventListener('click', () => closeModal(elements.newChatModal));
    elements.directFindBtn.addEventListener('click', () => withBusy(elements.directFindBtn, findDirect));
    elements.directCode.addEventListener('input', resetDirectLookup);
    elements.directCode.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) withBusy(elements.directFindBtn, findDirect);
    });
    for (const button of [elements.directMeetBtn, elements.profileMeetBtn]) {
        button.addEventListener('click', () => {
            closeModal(button.closest('dialog'));
            openMeetModal();
        });
    }
    elements.meetScanBtn.addEventListener('click', () => withBusy(elements.meetScanBtn, scanMeetQr));

    elements.copyUserCodeBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(elements.userCodeDisplay.textContent);
            showToast('Код скопирован', 'success');
        } catch {
            window.getSelection().selectAllChildren(elements.userCodeDisplay);
            showToast('Скопируйте выделенный код', 'info');
        }
    });
    elements.rotateUserCodeBtn.addEventListener('click', () => withBusy(elements.rotateUserCodeBtn, async () => {
        if (!confirm('Сменить код? По прежнему вас больше не найдут.')) return;
        const data = await api('/api/user/code', { method: 'POST' });
        if (!data.success) return showToast(data.message, 'error');
        elements.userCodeDisplay.textContent = data.code;
        showToast('Код сменён, прежний больше не действует', 'success');
    }));
    elements.codeRequestsToggle.addEventListener('change', async () => {
        const toggle = elements.codeRequestsToggle;
        toggle.disabled = true;
        const data = await api('/api/user/code-requests', { method: 'POST', body: JSON.stringify({ enabled: toggle.checked }) });
        toggle.disabled = false;
        if (!data.success) {
            toggle.checked = !toggle.checked;
            return showToast(data.message, 'error');
        }
        showToast(data.requestsEnabled ? 'По коду вас снова можно найти' : 'По коду вас больше не найти', 'success');
    });
    elements.blockPeerBtn.addEventListener('click', () => withBusy(elements.blockPeerBtn, async () => {
        const chat = currentChatMeta();
        const peer = chat && chat.peer_ids && chat.peer_ids[0];
        if (!peer) return;
        if (await setBlocked(Number(peer), chat.name, !chat.peer_blocked)) closeModal(elements.chatMenuModal);
    }));

    elements.chatMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(elements.chatMenuModal);
    });
    elements.chatExpiry.addEventListener('click', () => openModal(elements.chatMenuModal));
    // Смена срока с «Отменить»: выбрали не то — вернуть прежний одним нажатием.
    const setChatExpiry = async (expirySeconds, { undoable = true } = {}) => {
        const options = elements.chatExpiryOptions;
        const previous = chatExpirySeconds || 0;
        const chatId = currentChatId;
        options.disabled = true;
        try {
            const data = await api(`/api/chats/${chatId}/set-default-expiry`, {
                method: 'POST', body: JSON.stringify({ expirySeconds }) });
            if (!data.success) {
                checkExpiryOption(previous);
                return showToast(data.message, 'error');
            }
            if (chatId === currentChatId) showChatExpiry(data.expirySeconds);
            showToast(`Исчезающие сообщения: ${data.expirySeconds ? expiryName(data.expirySeconds) : 'выключены'}`, 'success',
                undoable && previous !== (data.expirySeconds || 0) ? {
                    duration: 6000,
                    progress: true,
                    action: { label: 'Отменить', onClick: () => currentChatId === chatId && setChatExpiry(previous, { undoable: false }) },
                } : {});
        } finally {
            options.disabled = false;
        }
    };
    elements.chatExpiryOptions.addEventListener('change', event => {
        if (event.target.name === 'chat-expiry') setChatExpiry(Number(event.target.value));
    });

    elements.deleteChatBtn.addEventListener('click', deleteChat);

    elements.roomEmptyInvite.addEventListener('click', () => openInviteModal());
    elements.getChatCodeBtn.addEventListener('click', () => openInviteModal());
    elements.resetInviteBtn.addEventListener('click', () => withBusy(elements.resetInviteBtn, saveInviteLink));
    elements.disableInviteBtn.addEventListener('click', () => withBusy(elements.disableInviteBtn, disableInviteLink));
    elements.copyInviteBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(elements.inviteCodeDisplay.textContent);
            showToast('Ссылка скопирована', 'success');
        } catch {
            window.getSelection().selectAllChildren(elements.inviteCodeDisplay);
            showToast('Скопируйте выделенную ссылку', 'info');
        }
    });

    for (const [button, action] of [[elements.pinChatBtn, 'pin'], [elements.archiveChatBtn, 'archive']]) {
        button.addEventListener('click', () => withBusy(button, async () => {
            if (await chatListAction(currentChatId, action)) closeModal(elements.chatMenuModal);
        }));
    }
    // «Без звука»: заглушённый — включить звук; иначе — выбрать, на сколько.
    const muteFor = document.getElementById('mute-for');
    elements.muteChatBtn.addEventListener('click', () => withBusy(elements.muteChatBtn, async () => {
        const chat = currentChatMeta();
        if (chat && chat.muted) {
            if (await chatListAction(currentChatId, 'mute')) closeModal(elements.chatMenuModal);
            return;
        }
        muteFor.hidden = !muteFor.hidden;
        if (!muteFor.hidden) muteFor.querySelector('button').focus();
    }));
    muteFor.addEventListener('click', event => {
        const button = event.target.closest('[data-mute-for]');
        if (!button) return;
        withBusy(button, async () => {
            if (await chatListAction(currentChatId, `mute:${button.dataset.muteFor || 0}`)) {
                muteFor.hidden = true;
                closeModal(elements.chatMenuModal);
            }
        });
    });
    elements.chatMenuModal.addEventListener('close', () => { muteFor.hidden = true; });
    document.getElementById('mark-unread-btn').addEventListener('click', event => withBusy(event.currentTarget, async () => {
        const chatId = currentChatId;
        if (!await chatListAction(chatId, 'unread')) return;
        closeModal(elements.chatMenuModal);
        // Отмеченный непрочитанным не открыт — иначе отметка тут же снимется.
        if (mobileLayout.matches) backToChatList();
    }));
    setupChatItemMenu();
    setupPinDrag();

    elements.chatMenuMembersBtn.addEventListener('click', () => {
        closeModal(elements.chatMenuModal);
        openMembersModal();
    });
    elements.joinRequestsBar.addEventListener('click', () => openMembersModal());
    elements.membersInviteBtn.addEventListener('click', () => {
        closeModal(elements.membersModal);
        openInviteModal();
    });
    elements.groupNameSave.addEventListener('click', () => withBusy(elements.groupNameSave, renameGroup));
    elements.groupNameInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) withBusy(elements.groupNameSave, renameGroup);
    });

    elements.profileBtn.addEventListener('click', openProfile);
    elements.settingsBtn.addEventListener('click', openSettings);
    for (const radio of document.querySelectorAll('input[name="chat-bg"]')) {
        radio.addEventListener('change', () => setChatBackground(radio.value));
    }
    elements.soundsToggle.addEventListener('change', () => setSoundsOn(elements.soundsToggle.checked));
    elements.typingToggle.addEventListener('change', async () => {
        const toggle = elements.typingToggle;
        toggle.disabled = true;
        const data = await api('/api/user/typing', { method: 'POST', body: JSON.stringify({ enabled: toggle.checked }) });
        toggle.disabled = false;
        if (!data.success) {
            toggle.checked = !toggle.checked;
            return showToast(data.message, 'error');
        }
        if (currentUser) currentUser.sendTyping = data.enabled;
        showToast(data.enabled ? 'Собеседники видят, когда вы печатаете' : 'Собеседники больше не видят, что вы печатаете', 'success');
    });

    elements.hidePresenceToggle.addEventListener('change', async () => {
        const toggle = elements.hidePresenceToggle;
        toggle.disabled = true;
        const data = await api('/api/user/presence', { method: 'POST', body: JSON.stringify({ hidden: toggle.checked }) });
        toggle.disabled = false;
        if (!data.success) {
            toggle.checked = !toggle.checked;
            return showToast(data.message, 'error');
        }
        showToast(data.hidden ? 'Теперь никто не видит, когда вы в сети' : 'Собеседники снова видят, когда вы в сети', 'success');
        await loadChats();
        if (currentChatId) renderChatStatus(currentChatIsBot);
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

    document.querySelectorAll('.color-option[data-color]').forEach(btn => {
        btn.addEventListener('click', () => saveAvatar(btn.dataset.color));
    });

    // Кнопка не забирает фокус у поля: иначе на телефоне после отправки
    // закрывалась бы клавиатура.
    elements.sendBtn.addEventListener('mousedown', e => e.preventDefault());
    elements.sendBtn.addEventListener('click', () => {
        if (elements.sendBtn.dataset.mode === 'attach') return elements.fileInput.click();
        elements.messageInput.focus({ preventScroll: true });
        sendMessage();
    });
    elements.messageInput.addEventListener('input', updateSendButton);
    elements.messageInput.addEventListener('input', updateMessageCounter);
    elements.messageInput.addEventListener('input', noteDraftEdit);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            captureDraft();
            persistDrafts();
        }
    });
    window.addEventListener('pagehide', () => {
        captureDraft();
        persistDrafts();
    });
    elements.messageInput.addEventListener('input', noteTyping);
    // keydown, а не устаревший keypress. Enter, которым подтверждают слово
    // в IME (японский, китайский, корейский ввод, часть экранных
    // клавиатур), не должен отправлять недописанное сообщение: isComposing,
    // а keyCode 229 — для Safari, где isComposing на этом Enter уже false.
    elements.messageInput.addEventListener('keydown', (e) => {
        // Esc отменяет правку, а если её нет — ответ.
        if (e.key === 'Escape' && (editingMessageId || replyToMessageId)) {
            e.preventDefault();
            if (editingMessageId) {
                cancelEdit();
            } else {
                clearReply();
            }
            return;
        }
        // Ctrl/Cmd+↑/↓ в пустом поле — ответить на предыдущее или следующее.
        if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !elements.messageInput.value) {
            e.preventDefault();
            stepReply(e.key === 'ArrowUp' ? -1 : 1);
            return;
        }
        // На телефоне Enter — перенос строки, отправка — кнопкой: на
        // экранной клавиатуре Shift+Enter не набрать. На компьютере — по
        // настройке: Enter или Ctrl/Cmd+Enter.
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229 || coarsePointer()) return;
        const withCtrl = e.ctrlKey || e.metaKey;
        if (sendKey() === 'ctrl' && !withCtrl) return;
        e.preventDefault();
        // Зажатый Enter повторяется — это не второе сообщение.
        if (e.repeat) return;
        sendMessage();
    });

    elements.fileInput.addEventListener('change', handleFileUpload);
    elements.cancelReplyBtn.addEventListener('click', clearReply);

    elements.replyMessageBtn.addEventListener('click', () => {
        startReply({ id: elements.messageMenu.dataset.forMessage, text: elements.messageMenu.dataset.forMessageText,
            author: elements.messageMenu.dataset.forMessageAuthor });
        hideMessageMenu();
    });

    // Выделение текста в пузыре на телефоне включается только отсюда.
    elements.selectTextBtn.addEventListener('click', () => {
        const bubble = menuBubble;
        hideMessageMenu();
        const text = bubble && bubble.querySelector('.message-text');
        if (!text) return;
        bubble.classList.add('is-selectable');
        const range = document.createRange();
        range.selectNodeContents(text);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    });
    document.addEventListener('selectionchange', () => {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;
        document.querySelectorAll('.message.is-selectable').forEach(el => el.classList.remove('is-selectable'));
    });

    elements.chatMenuInviteBtn.addEventListener('click', () => {
        closeModal(elements.chatMenuModal);
        openInviteModal();
    });

    elements.editMessageBtn.addEventListener('click', () => {
        editingMessageId = elements.messageMenu.dataset.forMessage;
        const text = elements.messageMenu.dataset.forMessageText;
        clearReply();
        setMessageInput(text);
        showEditBar(true, text);
        elements.messageInput.focus();
        hideMessageMenu();
    });
    elements.cancelEditBtn.addEventListener('click', cancelEdit);

    document.getElementById('copy-message-btn').addEventListener('click', async () => {
        const bubble = menuBubble;
        hideMessageMenu();
        const text = messageTextOf(bubble && bubble.querySelector('.message-text'));
        if (!text) return;
        await copyText(text);
    });
    document.getElementById('select-message-btn').addEventListener('click', () => {
        const bubble = menuBubble;
        hideMessageMenu();
        if (bubble) startSelection(bubble);
    });
    elements.deleteMessageBtn.addEventListener('click', () => {
        hideMessageMenu();
        scheduleDelete(elements.messageMenu.dataset.forMessage);
    });

    elements.reactionRow.addEventListener('click', event => {
        const messageId = elements.messageMenu.dataset.forMessage;
        if (event.target.closest('.reaction-more')) {
            const r = elements.messageMenu.getBoundingClientRect();
            hideMessageMenu();
            openReactionPicker(messageId, r.left, r.top);
            return;
        }
        const choice = event.target.closest('.reaction-choice');
        if (!choice) return;
        hideMessageMenu();
        toggleReaction(messageId, choice.dataset.emoji);
    });
    elements.reactionPicker.addEventListener('click', event => {
        const pick = event.target.closest('.reaction-pick');
        if (!pick) return;
        elements.reactionPicker.hidePopover();
        toggleReaction(elements.reactionPicker.dataset.forMessage, pick.dataset.emoji);
    });
    loadEmojiSet();

    let searchTimeout;
    elements.searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(performSearch, 300);
    });

    elements.chatEncryption.addEventListener('click', () => {
        if (!currentChatId) return;
        if (elements.chatEncryption.dataset.checkable) return openSafetyModal(currentChatId);
        const text = elements.chatEncryption.querySelector('.encryption-badge-text')?.textContent || '';
        const why = elements.chatEncryption.title && elements.chatEncryption.title !== 'Сверить ключи' ? ` — ${elements.chatEncryption.title}` : '';
        showToast(`${text}${why}`, 'info');
    });

    // Верх чата лежит поверх ленты: его высота — отступ ленты и липкой даты.
    new ResizeObserver(() => {
        elements.mainContent.style.setProperty('--chat-top-h', `${Math.round(elements.chatTop.getBoundingClientRect().height)}px`);
    }).observe(elements.chatTop);

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
    setupChatListTouch();
    setupToastPause();
    setupToastSwipe();
    setupSheetDrag();
    setupComposer();
    setupPending();
    setupSidebarResize();
    setupChatListKeyboard();
    setupNotifications();
    setupStorageWarnings();
    setupHapticsToggle();
    setupPrivacyCover();
    setupKeyboardShortcuts();
    setupChatSearch();
    setupSelection();
    setupServiceWorker();
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
        if (isForOpenChat({ chat_id, room_id })) {
            const bubble = elements.chatMessages.querySelector(`[data-message-id="${id}"]`);
            if (!bubble) return;
            const textEl = bubble.querySelector('.message-text');
            if (textEl) {
                const spacer = textEl.querySelector('.meta-spacer');
                renderMessageText(textEl, text);
                if (spacer) textEl.appendChild(spacer);
            }
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

    socket.on('joinRequestDecided', onJoinRequestDecided);
    socket.on('typing', onTyping);
    // Закрепили, переставили, отправили в архив на другом устройстве.
    socket.on('chatListChanged', async () => {
        await loadChats();
        applyRoomState();
    });
    socket.on('directRequestsChanged', loadDirectRequests);
    socket.on('directRequestAccepted', onDirectRequestAccepted);
    socket.on('joinRequestsChanged', onJoinRequestsChanged);
    socket.on('membersChanged', onMembersChanged);
    socket.on('removedFromChat', onRemovedFromChat);
    socket.on('chatRenamed', ({ room_id: roomId, name }) => {
        for (const chat of chatsMeta.values()) if (Number(chat.room_id) === Number(roomId)) chat.name = name;
        applyRoomState();
    });

    socket.on('chatExpiryChanged', ({ room_id, expirySeconds }) => {
        if (currentRoomId && Number(room_id) === Number(currentRoomId)) showChatExpiry(expirySeconds);
    });

    socket.on('messageDeleted', ({ id, chat_id, room_id }) => {
        // Расшифрованная копия удалённого сообщения не должна пережить его.
        if (e2ee) e2ee.forgetMessage({ id, chat_id, room_id });
        if (isForOpenChat({ chat_id, room_id })) {
            const bubble = elements.chatMessages.querySelector(`[data-message-id="${id}"]`);
            if (bubble) removeMessageElement(bubble);
        }
    });

    // Меню стоит на месте, а переписка под ним прокручивается — оно бы
    // «отклеилось» от сообщения. Закрываем, как и системные меню.
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
    if (toast.matches(':popover-open') && !modal.contains(toast)) moveToast(modal);
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

function renderChatsPlaceholder(text, { art = false } = {}) {
    elements.chatsList.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'chats-placeholder';
    if (art) note.appendChild(emptyArt('list'));
    const p = document.createElement('p');
    p.textContent = text;
    note.appendChild(p);
    elements.chatsList.appendChild(note);
}

// Иллюстрации пустых экранов: знак Nyxo на орбитах и пара пузырей.
function emptyArt(kind) {
    const box = document.createElement('div');
    box.className = `empty-illustration is-${kind}`;
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = kind === 'list'
        ? '<svg viewBox="0 0 120 96" fill="none"><rect x="14" y="14" width="92" height="20" rx="10" class="ei-line"/>'
            + '<rect x="14" y="40" width="92" height="20" rx="10" class="ei-line ei-dim"/><rect x="14" y="66" width="60" height="20" rx="10" class="ei-line ei-dimmer"/>'
            + '<circle cx="24" cy="24" r="6" class="ei-dot"/><circle cx="24" cy="50" r="6" class="ei-dot ei-dim"/><circle cx="24" cy="76" r="6" class="ei-dot ei-dimmer"/></svg>'
        : '<svg viewBox="0 0 120 96" fill="none"><rect x="10" y="16" width="58" height="24" rx="12" class="ei-bubble"/>'
            + '<rect x="50" y="50" width="60" height="24" rx="12" class="ei-bubble ei-own"/><circle cx="24" cy="28" r="3" class="ei-dot"/>'
            + '<circle cx="34" cy="28" r="3" class="ei-dot"/><circle cx="44" cy="28" r="3" class="ei-dot"/></svg>';
    return box;
}

async function loadChats() {
    // Скелетон показывается только когда в списке ещё нечего показать:
    // перерисовка после socket-события не должна мигать заглушкой.
    if (!elements.chatsList.querySelector('.chat-item')) {
        renderChatsSkeleton();
    }

    await loadDrafts();
    const data = await api('/api/chats');
    if (!data.success) {
        // Без этой ветки скелетон остался бы висеть навсегда.
        renderChatsPlaceholder('Не удалось загрузить чаты');
        return;
    }

    if (!data.chats.length) {
        elements.chatsList.innerHTML = '';
        renderChatsPlaceholder('Чатов пока нет — начните новый', { art: true });
        handleLaunchOnce();
        return;
    }

    // for...of, а не forEach: превью зашифрованных чатов лежит в IndexedDB,
    // и его чтение асинхронно. Строки собираются целиком и ставятся разом:
    // два одновременных loadChats иначе перемешали бы список.
    chatsMeta.clear();
    presenceHidden = Boolean(data.presenceHidden);
    // Незакреплённые — по последнему событию: сообщению или черновику.
    const lastEvent = chat => Math.max(Date.parse(chat.last_at) || 0, (drafts[String(chat.id)] && drafts[String(chat.id)].at) || 0);
    const pinned = data.chats.filter(c => c.pin_position);
    const rest = data.chats.filter(c => !c.pin_position).map((c, i) => [c, i])
        .sort((a, b) => lastEvent(b[0]) - lastEvent(a[0]) || a[1] - b[1]).map(([c]) => c);
    data.chats = [...pinned, ...rest];
    const rows = [];
    const archived = [];
    let pinnedCount = 0;
    for (const chat of data.chats) {
        chatsMeta.set(chat.id, chat);
        if (chat.peer_ids && chat.peer_ids.length === 1) peerLastSeen.set(Number(chat.peer_ids[0]), chat.last_seen || null);
        for (const id of chat.peer_ids || []) peerOnline.set(Number(id), (chat.online_ids || []).includes(id));
        // Открытый чат: прочитано то, что было на экране, — счётчик не
        // больше того, что уже насчитали здесь (отметка может быть в пути).
        if (chat.id === currentChatId && readMarks.chatId === chat.id && readMarks.localLeft !== undefined) {
            chat.unread = Math.min(chat.unread, readMarks.localLeft);
        }
        if (chat.archived) {
            archived.push(chat);
            continue;
        }
        if (chat.pin_position) pinnedCount++;
        rows.push(await chatListItem(chat));
    }
    // Закреплённые сверху и отделены чертой.
    if (pinnedCount && rows.length > pinnedCount) {
        const line = document.createElement('div');
        line.className = 'chats-separator';
        line.setAttribute('role', 'separator');
        rows.splice(pinnedCount, 0, line);
    }
    if (archived.length) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'archive-toggle';
        toggle.setAttribute('aria-expanded', String(archiveShown));
        const label = document.createElement('span');
        label.textContent = `Архив · ${archived.length}`;
        toggle.append(createIcon('i-archive'), label);
        toggle.addEventListener('click', () => {
            archiveShown = !archiveShown;
            loadChats();
        });
        rows.push(toggle);
        if (archiveShown) for (const chat of archived) rows.push(await chatListItem(chat));
    }
    placeChatRows(rows);
    pulseGrownBadges();
    updateTitleCounter();
    refreshPresenceDots();
    refreshChatListTabStop();
    renderTyping();
    // Первый список после входа — теперь можно открыть чат из адреса
    // (уведомление, «Поделиться», ярлык).
    handleLaunchOnce();
}

/*
 * Новый список встаёт на место старого без пересборки: строка, которая не
 * изменилась, остаётся тем же узлом (с фокусом и обработчиками), и
 * перестановка видна — строки доезжают до новых мест за 200 мс (FLIP:
 * сначала все старые позиции, потом все новые, потом transform). Без
 * доезда — при «уменьшить движение», если сдвинулось больше 10 строк или
 * список держат пальцем.
 */
let chatListTouched = false;
function placeChatRows(rows) {
    const list = elements.chatsList;
    const before = new Map();
    for (const item of list.querySelectorAll('.chat-item[data-id]')) before.set(item.dataset.id, item);
    const oldTop = new Map([...before].map(([id, item]) => [id, item.getBoundingClientRect().top]));
    const next = rows.map(row => {
        const old = row.classList && row.classList.contains('chat-item') ? before.get(row.dataset.id) : null;
        return old && old.outerHTML === row.outerHTML ? old : row;
    });
    list.replaceChildren(...next);
    if (prefersReducedMotion() || chatListTouched) return;
    const moved = [];
    for (const item of list.querySelectorAll('.chat-item[data-id]')) {
        const top = oldTop.get(item.dataset.id);
        if (top === undefined) continue;
        const dy = top - item.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) moved.push([item, dy]);
    }
    if (!moved.length || moved.length > 10) return;
    for (const [item, dy] of moved) {
        item.style.transition = 'none';
        item.style.transform = `translateY(${dy}px)`;
    }
    list.getBoundingClientRect();
    for (const [item] of moved) {
        item.style.transition = 'transform 200ms var(--ease-in-out)';
        item.style.transform = '';
        // Не transitionend: прерванный переход его не присылает.
        Promise.all(item.getAnimations().map(a => a.finished)).catch(() => {}).finally(() => { item.style.transition = ''; });
    }
}

/*
 * Новое в другом чате — список обновляется не на каждое сообщение: вызовы
 * склеиваются за 250 мс, запрос в полёте один. Пока список держат пальцем,
 * он не переставляется — обновится, когда отпустят.
 */
let chatsReloadTimer = null;
let chatsReloadRunning = null;
let chatsReloadAgain = false;
function scheduleChatsReload() {
    clearTimeout(chatsReloadTimer);
    chatsReloadTimer = setTimeout(async () => {
        if (chatListTouched) return scheduleChatsReload();
        if (chatsReloadRunning) {
            chatsReloadAgain = true;
            return;
        }
        chatsReloadRunning = loadChats().finally(() => {
            chatsReloadRunning = null;
            if (chatsReloadAgain) {
                chatsReloadAgain = false;
                scheduleChatsReload();
            }
        });
    }, 250);
}

function setupChatListTouch() {
    const list = elements.chatsList;
    list.addEventListener('touchstart', () => { chatListTouched = true; }, { passive: true });
    for (const type of ['touchend', 'touchcancel']) {
        list.addEventListener(type, () => { chatListTouched = false; }, { passive: true });
    }
}

/*
 * Чат открывается быстрее: историю запрашиваем уже на pointerdown по строке,
 * а openChat берёт этот летящий запрос (выигрыш 100–200 мс между нажатием
 * и отпусканием). А ленту чата, из которого ушли, держим в памяти: при
 * возврате она рисуется сразу, потом сверяется с сервером.
 */
const prefetched = new Map();
function historyUrl(chatId) {
    const meta = chatsMeta.get(Number(chatId));
    const lastRead = Number(meta && meta.last_read_id) || 0;
    const view = chatViews.get(chatId);
    const around = view && !view.bottom && view.id ? Number(view.id)
        : meta && meta.unread > 0 && lastRead ? lastRead : null;
    return `/api/messages/${chatId}?${around ? `around=${around}&` : ''}limit=${openPageSize()}`;
}
function prefetchHistory(chatId) {
    if (Number(chatId) === Number(currentChatId)) return;
    const url = historyUrl(chatId);
    const hit = prefetched.get(url);
    if (hit && Date.now() - hit.at < 5000) return;
    prefetched.set(url, { at: Date.now(), promise: api(url).catch(() => null) });
}
function takePrefetched(url) {
    const hit = prefetched.get(url);
    prefetched.delete(url);
    return hit && Date.now() - hit.at < 5000 ? hit.promise : null;
}
const feedCache = new Map();

async function chatListItem(chat) {
    const div = chatItemElement(chat, await chatPreview(chat));
    div.addEventListener('pointerdown', () => prefetchHistory(chat.id), { passive: true });
    div.dataset.roomId = chat.room_id || '';
    if (chat.pin_position) {
        div.classList.add('is-pinned');
        div.draggable = true;
    }
    div.classList.toggle('active', chat.id === currentChatId);
    div.querySelector('.chat-avatar-small')?.classList.toggle('is-online', !chat.is_bot && chatOnline(chat));
    div.addEventListener('click', () => openChat(chat.id, chat.room_id, chat.name, chat.avatar, chat.online, chat.is_bot));
    return div;
}

// Новое в открытом чате: время и превью в списке обновляются на месте, чат
// поднимается наверх — весь список ради этого не перечитывается.
async function refreshOpenChatItem(message) {
    const chat = currentChatMeta();
    const item = elements.chatsList.querySelector(`.chat-item[data-id="${currentChatId}"]`);
    if (!chat || !item || message.message_type === 'system') return;
    chat.last_at = message.created_at || new Date().toISOString();
    chat.last_message = message.encrypted ? null : message.text;
    chat.last_user_id = message.user_id;
    chat.last_sender = message.sender_username || null;
    chat.last_sent = message.sent;
    chat.last_type = message.message_type || 'text';
    chat.last_status = isOwnMessage(message) ? message.status || 'sent' : null;
    chat.unread = 0;
    const fresh = await chatListItem(chat);
    if (!item.isConnected) return;
    if (chat.pin_position || chat.archived) return item.replaceWith(fresh);
    item.remove();
    const line = elements.chatsList.querySelector('.chats-separator');
    if (line) line.after(fresh);
    else elements.chatsList.prepend(fresh);
}

/**
 * Превью последнего сообщения.
 *
 * Для зашифрованного чата сервер его дать не может — в базе нет текста.
 * Поэтому берём то, что клиент расшифровал сам. Если это устройство чат
 * ещё не открывало, превью честно нет.
 */
async function chatPreview(chat) {
    if (chat.last_message && chat.last_type === 'system') return systemLineText(chat.last_message).substring(0, 40);
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
    elements.app.classList.toggle('is-chat-open', show);
    applyMobileInert();
}

/*
 * Свайп вправо по чату — назад к списку (на iPhone с экрана «Домой»
 * системного «назад» нет). Чат идёт за пальцем, список выезжает из −25%,
 * затемнение тает. Пороги — как в Telegram: дальше 30% ширины или быстрее
 * 0,8 px/мс (медленное ведение с лёгким рывком в конце чат больше не
 * закрывает). Доводка — от скорости пальца: остаток / скорость, от 50 до
 * 200 мс; отмена — за 110 мс. Положение — transform прямо на списке и
 * чате: переменная на .app пересчитывала стили всего приложения на каждое
 * движение пальца. Касания у самого края (x < 20) — жест вкладки Safari.
 */
function setupSwipeBack() {
    const area = elements.mainContent;
    const app = elements.app;
    let drag = null;
    area.addEventListener('touchstart', e => {
        if (!mobileLayout.matches || !app.classList.contains('is-chat-open') || e.touches.length !== 1) return;
        const t = e.touches[0];
        if (t.clientX < 20 || e.target.closest('input, textarea, dialog, .message.is-lifted')) return;
        drag = { x: t.clientX, y: t.clientY, dx: 0, active: false, samples: [[performance.now(), 0]] };
    }, { passive: true });
    area.addEventListener('touchmove', e => {
        if (!drag || e.touches.length !== 1) return;
        const t = e.touches[0];
        const dx = t.clientX - drag.x;
        const dy = t.clientY - drag.y;
        if (!drag.active) {
            if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
            if (dx < 12 || dx < Math.abs(dy) * 1.5) return;
            drag.active = true;
            app.classList.add('is-swiping-back');
        }
        drag.dx = Math.max(0, dx);
        drag.samples.push([performance.now(), drag.dx]);
        if (drag.samples.length > 5) drag.samples.shift();
        placeSwipeBack(Math.min(1, drag.dx / area.clientWidth));
    }, { passive: true });
    const sidebar = elements.sidebar;
    const placeSwipeBack = (progress, duration = 0) => {
        const transition = duration ? `transform ${duration}ms var(--ease-drawer)` : 'none';
        area.style.transition = sidebar.style.transition = transition;
        area.style.transform = `translateX(${progress * 100}%)`;
        sidebar.style.transform = `translateX(${-25 * (1 - progress)}%)`;
        sidebar.style.setProperty('--dim-progress', String(1 - progress));
    };
    const clearSwipeBack = () => {
        for (const el of [area, sidebar]) {
            el.style.removeProperty('transition');
            el.style.removeProperty('transform');
        }
        sidebar.style.removeProperty('--dim-progress');
        app.classList.remove('is-swiping-back');
    };
    const end = () => {
        if (!drag) return;
        const { active, dx, samples } = drag;
        drag = null;
        if (!active) return;
        const [t0, x0] = samples[0];
        const [t1, x1] = samples[samples.length - 1];
        const speed = t1 > t0 ? (x1 - x0) / (t1 - t0) : 0;
        const width = area.clientWidth;
        const back = dx > width * 0.3 || speed > 0.8;
        const reduced = prefersReducedMotion();
        const duration = reduced ? 0 : back ? Math.min(200, Math.max(50, (width - dx) / Math.max(speed, 0.01))) : 110;
        placeSwipeBack(back ? 1 : 0, duration);
        setTimeout(() => {
            if (back) {
                // Экран уже там, где надо: без второго перехода.
                app.classList.add('no-screen-transition');
                if (history.state && history.state.nyxoChat) history.back();
                else backToChatList();
                clearSwipeBack();
                requestAnimationFrame(() => app.classList.remove('no-screen-transition'));
            } else {
                clearSwipeBack();
            }
        }, duration);
    };
    area.addEventListener('touchend', end);
    area.addEventListener('touchcancel', end);
}

function applyMobileInert() {
    const chatShown = elements.sidebar.classList.contains('hidden-mobile');
    elements.sidebar.inert = mobileLayout.matches && chatShown;
    elements.mainContent.inert = mobileLayout.matches && !chatShown;
}

/*
 * Экранная клавиатура. На iPhone отступ под «полоской Домой»
 * (safe-area-inset-bottom) у поля ввода оставался и над клавиатурой —
 * пустая полоса ~34px. Клавиатура открыта (visualViewport заметно ниже
 * окна) — на body класс keyboard-visible, отступа нет. Закрылась, а
 * страница осталась сдвинутой (offsetTop ≠ 0) — возвращаем её. Android:
 * клавиатуру закрыли кнопкой «Назад», а поле осталось в фокусе — снимаем
 * фокус, иначе следующее касание поля её не откроет.
 */
function setupKeyboardInsets() {
    const vv = window.visualViewport;
    if (!vv) return;
    let lastHeight = vv.height;
    const update = () => {
        const open = window.innerHeight - vv.height > 120;
        document.body.classList.toggle('keyboard-visible', open);
        if (!open && vv.offsetTop !== 0) window.scrollTo(0, 0);
        if (vv.height - lastHeight > 150 && !isIOS && document.activeElement === elements.messageInput) {
            elements.messageInput.blur();
        }
        lastHeight = vv.height;
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
}

function setupMobileScreens() {
    setupKeyboardInsets();
    setupSwipeBack();
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

let lastLeftChat = null;
async function openChat(chatId, roomId, name, avatar, online, isBot) {
    const reopening = currentChatId === chatId;
    if (!reopening) rememberChatView();
    lastLeftChat = reopening ? null : currentChatId;
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
    refreshChatListTabStop();
    elements.chatName.textContent = name;
    renderChatStatus(isBot, online);
    const openedMeta = chatsMeta.get(Number(chatId));
    elements.chatAvatar.classList.remove('is-bot-avatar');
    if (isBot) paintBotAvatar(elements.chatAvatar);
    else if (openedMeta && openedMeta.kind === 'direct' && openedMeta.peer_avatar) paintAvatar(elements.chatAvatar, openedMeta.peer_avatar, name);
    else paintAvatar(elements.chatAvatar, avatar, name);
    elements.chatHeader.classList.remove('hidden');
    elements.messageInputContainer.classList.remove('hidden');
    elements.emptyState.classList.add('hidden');
    const view = reopening ? captureChatView() : chatViews.get(chatId);
    // Лента чата, из которого уходим, — в память (без анимаций и выбора).
    if (!reopening && lastLeftChat && elements.chatMessages.querySelector('.message')) {
        feedCache.set(lastLeftChat, [...elements.chatMessages.children]);
        if (feedCache.size > 8) feedCache.delete(feedCache.keys().next().value);
    }
    clearFeed();
    resetNewBelow();
    const cachedFeed = !reopening ? feedCache.get(chatId) : null;
    if (cachedFeed) {
        elements.chatMessages.append(...cachedFeed);
        restoreChatView(view) || (view && !view.bottom) || scrollToBottom();
    }
    if (!reopening) restoreDraft(chatId);
    showChatExpiry(null);
    showPlaintextNotice(null);
    applyRoomState();
    // Скелетон — только если история грузится заметно долго и показать нечего.
    const skeletonTimer = cachedFeed ? null : setTimeout(renderMessagesSkeleton, 150);

    // Что из этого чата лежит у нас расшифрованным — до запроса истории:
    // сообщение, пришедшее, пока она грузится, не должно попасть под чистку.
    const known = e2ee && e2ee.isReady() ? await e2ee.knownMessages({ id: chatId, room_id: roomId }) : [];
    undeliveredCache = e2ee && e2ee.isReady() ? await e2ee.undeliveredNotes() : {};
    resetPaging(chatId);
    quoteReturns.length = 0;
    if (!reopening) closeChatSearch();
    if (selecting()) stopSelection();
    seenIds.clear();
    // Есть непрочитанное — открываем на нём: срез вокруг последнего
    // прочитанного, а не последние 50 (иначе разделителя не было бы, и
    // человек оказывался внизу). Возврат в чат — вокруг места, где были.
    const meta = chatsMeta.get(Number(chatId));
    const lastRead = Number(meta && meta.last_read_id) || 0;
    const around = view && !view.bottom && view.id ? Number(view.id)
        : !reopening && meta && meta.unread > 0 && lastRead ? lastRead : null;
    Object.assign(readMarks, { baseRead: lastRead, baseUnread: Number(meta && meta.unread) || 0, localLeft: undefined });
    if (meta && meta.marked_unread) {
        meta.marked_unread = false;
        api(`/api/chats/${chatId}/flags`, { method: 'POST', body: JSON.stringify({ markedUnread: false }) })
            .then(() => scheduleChatsReload()).catch(() => {});
    }
    const url = `/api/messages/${chatId}?${around ? `around=${around}&` : ''}limit=${openPageSize()}`;
    const data = await ((takePrefetched(url) || api(url)).then(d => d || api(url)))
        .finally(() => clearTimeout(skeletonTimer));
    // Пока шёл запрос, показывали ленту из памяти — теперь сверенная.
    // Пришедшее по сокету за это время остаётся.
    if (cachedFeed) {
        for (const node of cachedFeed) node.remove();
        feedCache.delete(chatId);
    }
    if (currentChatId !== chatId) return;
    elements.chatMessages.querySelectorAll('.message-skeleton').forEach(el => el.remove());
    elements.chatMessages.removeAttribute('aria-busy');
    if (!data.success) return;
    const page = data.messages || [];
    showChatExpiry(data.expirySeconds);
    showPlaintextNotice(data.plaintextPurge);
    applyPageBounds(data, page);
    // Удалённое и исчезнувшее, пока устройство было не в сети, стираем и
    // отсюда: в истории его уже нет.
    if (e2ee) await e2ee.forgetMissing({ id: chatId, room_id: roomId }, known, await liveMessageIds(chatId, known, page));

    // Последовательно, а не Promise.all: у Double Ratchet состояние
    // сессии меняется на каждом сообщении, и параллельная расшифровка
    // двух сообщений одной сессии затирала бы состояние друг друга.
    // Ключи групп — до сообщений: без них групповые не расшифровать.
    if (e2ee && data.keyEnvelopes) await e2ee.processKeyEnvelopes(data.keyEnvelopes);
    // Во фрагмент и одной вставкой: раньше каждое сообщение вставлялось
    // отдельно и после каждого группировка обходила всю ленту.
    const batch = await decryptBatch(page, chatId);
    if (!batch) return;
    prependMessages(batch);
    // Превью в списке — по последнему сообщению, если оно в окне.
    await rememberLastPreview(page);
    if (!historyPaging.hasNewer) await renderPendingFor(chatId);
    showEmptyChat();
    await fillScreenWithHistory();
    observeFeedEdges();
    // Куда встать: туда, где были (возврат в чат), к «Непрочитанным» или вниз.
    const separator = reopening ? null : placeUnreadSeparator(Number(data.chat && data.chat.last_read_id) || 0);
    if (!restoreChatView(view)) {
        // Дата дня прилипает к верху ленты — разделитель встаёт под ней.
        if (separator) scrollToSeparator(separator);
        else if (!historyPaging.hasNewer) scrollToBottom();
    }
    scheduleReadMark();
    applyRoomState();
    if (!coarsePointer() && !mobileLayout.matches && !elements.messageInput.disabled && !document.querySelector('dialog[open]')
        && !elements.chatsList.contains(document.activeElement)) {
        elements.messageInput.focus({ preventScroll: true });
    }
}

/* --- Старый открытый текст ---------------------------------------------------
   Сообщения, написанные в комнате без шифрования (до него), сервер сотрёт
   в назначенный день (migrations/009, lib/plaintext-purge.js). До этого
   дня в чате — предупреждение: сохранить нужное можно только сейчас. */


function showPlaintextNotice(notice) {
    const box = elements.plaintextNotice;
    const date = notice ? new Date(notice.purgeAfter) : null;
    if (!notice || !notice.count || Number.isNaN(date.getTime())) {
        box.hidden = true;
        box.replaceChildren();
        return;
    }
    const n = notice.count;
    const words = ['старое сообщение', 'старых сообщения', 'старых сообщений'][pluralForm(n)];
    const when = date <= new Date() ? 'в ближайшее время' : dayWithYearFormat.format(date);
    box.replaceChildren(createIcon('i-alert'),
        `Здесь ${n} ${words} без шифрования. Они будут удалены с сервера ${when} — сохраните нужное.`);
    box.hidden = false;
}

/* --- Пустая группа ---------------------------------------------------------
   В группе, где пока только вы, писать нельзя: сервер такое не примет
   (lib/rooms.js), потому что шифровать не для кого. Вместо ленты — экран
   «Пригласите участников», поле ввода выключено. Если в чате уже есть
   история (все остальные вышли), она остаётся на месте, а приглашение
   встаёт полосой над полем. Кто-то вошёл — всё включается само. */

function currentRoomIsEmpty() {
    const chat = currentChatMeta();
    return Boolean(chat && chat.room_id && !chat.is_bot && !chat.peer_count);
}

// Чат, где ещё не написано ни слова: картинка и подсказка вместо пустоты.
function showEmptyChat() {
    const list = elements.chatMessages;
    // Строки «вошёл», «создал ссылку» — не переписка.
    const hasContent = list.querySelector('.message');
    let empty = list.querySelector(':scope > .chat-empty');
    if (hasContent) return empty?.remove();
    if (empty || currentRoomIsEmpty()) return;
    empty = document.createElement('div');
    empty.className = 'chat-empty';
    const text = document.createElement('p');
    text.textContent = currentChatIsBot ? 'Напишите боту что-нибудь' : 'Сообщений пока нет — напишите первым';
    empty.append(emptyArt('chat'), text);
    list.appendChild(empty);
}

function applyRoomState() {
    if (!currentChatId) return;
    const meta = currentChatMeta();
    elements.chatMessages.classList.toggle('is-group', Boolean(meta && meta.peer_count > 1));
    // Что можно в группе — по роли: ссылкой и запросами ведает администратор.
    const group = Boolean(meta && meta.kind === 'group');
    const admin = group && meta.my_role === 'admin';
    elements.getChatCodeBtn.hidden = !admin;
    elements.chatMenuInviteBtn.hidden = !admin;
    elements.roomEmptyInvite.hidden = !admin;
    elements.chatMenuMembersBtn.hidden = !group;
    elements.pinChatBtn.querySelector('span').textContent = meta && meta.pin_position ? 'Открепить' : 'Закрепить';
    elements.muteChatBtn.querySelector('span').textContent = meta && meta.muted ? 'Со звуком' : 'Без звука';
    elements.muteChatBtn.title = meta && meta.muted_until ? `Без звука до ${fullFormat.format(new Date(meta.muted_until))}` : '';
    elements.archiveChatBtn.querySelector('span').textContent = meta && meta.archived ? 'Из архива' : 'В архив';
    const direct = Boolean(meta && meta.kind === 'direct');
    elements.blockPeerBtn.hidden = !direct || !meta.peer_count;
    elements.blockPeerLabel.textContent = direct && meta.peer_blocked ? 'Разблокировать' : 'Заблокировать';
    elements.deleteChatLabel.textContent = group ? 'Выйти из группы' : 'Удалить чат';
    const pending = admin ? Number(meta.pending_requests) || 0 : 0;
    elements.joinRequestsBar.hidden = pending === 0;
    elements.joinRequestsBarText.textContent = pending
        ? `Ждут одобрения: ${pending} ${['человек', 'человека', 'человек'][pluralForm(pending)]}` : '';
    // Группу переименовали — шапка следом.
    if (meta && meta.name && elements.chatName.textContent !== meta.name) {
        elements.chatName.textContent = meta.name;
        if (!(meta.kind === 'direct' && meta.peer_avatar)) elements.chatAvatar.textContent = meta.name.charAt(0).toUpperCase();
    }
    const empty = currentRoomIsEmpty();
    const history = Boolean(elements.chatMessages.querySelector('.message'));
    elements.roomEmpty.hidden = !empty;
    elements.roomEmpty.classList.toggle('is-strip', history);
    elements.chatMessages.hidden = empty && !history;
    const blocked = Boolean(meta && meta.kind === 'direct' && meta.peer_blocked);
    for (const control of [elements.messageInput, elements.sendBtn]) control.disabled = empty || blocked;
    elements.messageInput.placeholder = empty ? 'Сначала пригласите участников'
        : blocked ? 'Вы заблокировали собеседника' : 'Введите сообщение';
    if (empty) {
        clearReply();
        editingMessageId = null;
        showEditBar(false);
    }
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
    chatViews.set(currentChatId, captureChatView());
    // Список — заново, только если у чата есть черновик (строка «Черновик:»).
    if (captureDraft()) scheduleChatsReload();
    persistDrafts();
    // Правка и ответ относятся к сообщению этого чата — в другой не переносятся.
    editingMessageId = null;
    showEditBar(false);
    clearReply();
}

/*
 * Черновики — не только в памяти: в IndexedDB рядом с расшифрованными
 * сообщениями (на сервер не уходят), вместе с ответом. Сохраняются при
 * смене чата, через 10 с после последней правки и когда уходят из вкладки.
 * В списке — «Черновик: …», и чат поднимается по времени черновика.
 */
let drafts = {};
let draftsLoadedFor = null;
let draftTimer = null;

async function loadDrafts() {
    if (!currentUser || draftsLoadedFor === currentUser.id || !e2ee || !e2ee.isReady()) return;
    draftsLoadedFor = currentUser.id;
    drafts = await e2ee.drafts.load().catch(() => ({}));
}

function persistDrafts() {
    clearTimeout(draftTimer);
    draftTimer = null;
    if (e2ee && e2ee.isReady() && draftsLoadedFor === (currentUser && currentUser.id)) e2ee.drafts.save(drafts).catch(() => {});
}

function captureDraft() {
    if (!currentChatId || editingMessageId) return false;
    const text = elements.messageInput.value;
    const chatId = String(currentChatId);
    const before = drafts[chatId];
    if (text.trim() || replyContext) {
        drafts[chatId] = { text, reply: replyContext ? { ...replyContext } : null,
            at: before && before.text === text ? before.at : Date.now() };
    } else {
        delete drafts[chatId];
    }
    return JSON.stringify(before || null) !== JSON.stringify(drafts[chatId] || null) || Boolean(drafts[chatId]);
}

function noteDraftEdit() {
    captureDraft();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(persistDrafts, 10_000);
}

function clearDraft(chatId) {
    if (!drafts[String(chatId)]) return;
    delete drafts[String(chatId)];
    persistDrafts();
}

function restoreDraft(chatId) {
    const saved = drafts[String(chatId)];
    setMessageInput(saved ? saved.text || '' : '');
    if (saved && saved.reply) {
        startReply({ id: saved.reply.id, author: saved.reply.author, text: saved.reply.text }, { focus: false });
    }
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
    elements.linkConfirmAge.textContent = age < 60 ? `Код показан ${age} с назад.` : `Код показан ${Math.round(age / 60)} мин назад.`;
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
// Долгое нажатие по реакции показало, кто её поставил, — отпускание пальца
// не должно тут же снять или поставить её.
let reactionWhoShownAt = 0;

function noteNewBelow() {
    newBelow++;
    elements.jumpDownCount.textContent = newBelow > 99 ? '99+' : String(newBelow);
    showJumpDown(true);
}

// «↓» показывается и прячется переходом, поэтому — классом, а не hidden.
function showJumpDown(show) {
    elements.jumpDown.classList.toggle('is-visible', show);
    elements.jumpDown.inert = !show;
}

function resetNewBelow() {
    newBelow = 0;
    showJumpDown(false);
    elements.jumpDownCount.textContent = '';
}

/*
 * «↓» — как в Telegram: с 45px от низа, через 100 мс (случайный сдвиг не
 * мигает), и не дёргается 350 мс после нового сообщения. Нужна и тогда,
 * когда новое за окном ленты или есть куда вернуться после цитаты.
 */
let jumpTimer = null;
let jumpQuietUntil = 0;
function refreshJumpDown(force = false) {
    const list = elements.chatMessages;
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    const want = newBelow > 0 || quoteReturns.length > 0 || historyPaging.hasNewer || distance > 45;
    if (!force && performance.now() < jumpQuietUntil) return;
    clearTimeout(jumpTimer);
    if (want === elements.jumpDown.classList.contains('is-visible')) return;
    if (want && !force) jumpTimer = setTimeout(() => showJumpDown(true), 100);
    else showJumpDown(want);
}

async function jumpDownClicked() {
    // Сначала — туда, откуда ушли по цитате.
    if (quoteReturns.length) {
        const back = quoteReturns.pop();
        await goToMessage(back);
        refreshJumpDown(true);
        return;
    }
    resetNewBelow();
    if (historyPaging.hasNewer) {
        await reloadFeed();
        scrollToBottom();
        return;
    }
    scrollToBottom({ smooth: true });
}

// Долгое нажатие на «↓» — отметить прочитанным весь чат.
async function markChatRead() {
    const chatId = currentChatId;
    const meta = currentChatMeta();
    const upTo = Math.max(Number(meta && meta.last_id) || 0, newestShownMessageId());
    if (!chatId || !upTo) return;
    readMarks.read = Math.max(readMarks.read, upTo);
    readMarks.localLeft = 0;
    await sendReadMark('read', chatId, upTo);
    showToast('Всё прочитано', 'success');
}

// У конца ли лента: когда экранная клавиатура сжимает окно, лента, что была
// у конца, у него и остаётся.
let stickToBottom = true;

function setupFeed() {
    // Касание или колёсико прерывают доезд ленты.
    for (const type of ['wheel', 'touchstart', 'pointerdown']) {
        elements.chatMessages.addEventListener(type, stopScrollAnimation, { passive: true });
    }
    setupFeedScroll();
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            if (stickToBottom && currentChatId) scrollToBottom();
        });
    }
    let jumpPress = null;
    let jumpLongPressed = false;
    elements.jumpDown.addEventListener('pointerdown', () => {
        jumpLongPressed = false;
        clearTimeout(jumpPress);
        jumpPress = setTimeout(() => {
            jumpLongPressed = true;
            haptic('medium');
            markChatRead();
        }, 500);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
        elements.jumpDown.addEventListener(type, () => clearTimeout(jumpPress));
    }
    elements.jumpDown.addEventListener('contextmenu', event => {
        event.preventDefault();
        if (!jumpLongPressed) markChatRead();
        jumpLongPressed = true;
    });
    elements.jumpDown.addEventListener('click', () => {
        if (jumpLongPressed) {
            jumpLongPressed = false;
            return;
        }
        jumpDownClicked();
    });
    elements.chatMessages.addEventListener('click', event => {
        const quote = event.target.closest('.reply-to[data-reply-id]');
        if (quote) goToMessage(Number(quote.dataset.replyId), { from: Number(quote.closest('.message')?.dataset.messageId) || null });
        const chip = event.target.closest('.reaction[data-emoji]');
        const bubble = chip && chip.closest('.message[data-message-id]');
        if (bubble && !currentChatIsBot) {
            if (Date.now() - reactionWhoShownAt < 800) return;
            toggleReaction(bubble.dataset.messageId, chip.dataset.emoji);
        }
    });
    elements.chatMessages.addEventListener('contextmenu', event => {
        const chip = event.target.closest && event.target.closest('.reaction[data-emoji]');
        if (!chip) return;
        event.preventDefault();
        showReactionWho(chip);
    });
    // «Кто поставил» открывается правым кликом или долгим нажатием — то
    // есть до того, как отпущена кнопка или палец. Светлое закрытие
    // popover="auto" сработало бы на этом же отпускании, поэтому окно
    // ручное: закрывается нажатием мимо, Esc и прокруткой.
    document.addEventListener('pointerdown', event => {
        if (!elements.reactionWho.contains(event.target)) hideReactionWho();
    }, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hideReactionWho(); });
    let whoTimer = null;
    elements.chatMessages.addEventListener('touchstart', event => {
        const chip = event.target.closest && event.target.closest('.reaction[data-emoji]');
        if (!chip) return;
        whoTimer = setTimeout(() => {
            reactionWhoShownAt = Date.now();
            haptic('medium');
            showReactionWho(chip);
        }, LONG_PRESS_MS);
    }, { passive: true });
    for (const type of ['touchend', 'touchmove', 'touchcancel']) {
        elements.chatMessages.addEventListener(type, () => clearTimeout(whoTimer), { passive: true });
    }
    elements.chatMessages.addEventListener('keydown', event => {
        const quote = event.target.closest && event.target.closest('.reply-to[data-reply-id]');
        if (quote && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            goToMessage(Number(quote.dataset.replyId));
        }
    });
    socket.on('presence', ({ user_id, online, last_seen, hidden }) => {
        const id = Number(user_id);
        peerOnline.set(id, Boolean(online) && !hidden);
        if (hidden) peerLastSeen.set(id, null);
        else if (!online && last_seen) peerLastSeen.set(id, last_seen);
        refreshPresenceDots();
        const chat = currentChatMeta();
        if (chat && (chat.peer_ids || []).map(Number).includes(id)) renderChatStatus(chat.is_bot);
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
// Когда собеседник был в сети; null — не видно (скрыл он или вы).
const peerLastSeen = new Map();
let presenceHidden = false;

const chatOnline = chat => Boolean(chat) && (chat.peer_ids || []).some(id => peerOnline.get(Number(id)));

// «был(а) в 14:05», «был(а) вчера в 14:05», «был(а) 5 сентября».
function lastSeenText(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return 'был(а) недавно';
    const today = new Date();
    const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate())
        - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
    if (days <= 0) return `был(а) в ${timeFormat.format(date)}`;
    if (days === 1) return `был(а) вчера в ${timeFormat.format(date)}`;
    return `был(а) ${(date.getFullYear() === today.getFullYear() ? dayFormat : dayWithYearFormat).format(date)}`;
}

// Зелёная точка на аватаре — в списке и в шапке.
function refreshPresenceDots() {
    for (const item of elements.chatsList.querySelectorAll('.chat-item')) {
        const chat = chatsMeta.get(Number(item.dataset.id));
        item.querySelector('.chat-avatar-small')?.classList.toggle('is-online', Boolean(chat && !chat.is_bot && chatOnline(chat)));
    }
    const current = currentChatMeta();
    elements.chatAvatar.classList.toggle('is-online', Boolean(current && !current.is_bot && chatOnline(current)));
}
const currentChatMeta = () => chatsMeta.get(currentChatId) || null;

/*
 * Смена подписи в шапке «в сети» ↔ «печатает…»: старая уходит вниз на 4px
 * и гаснет, новая приходит сверху, 200 мс. «в сети» ↔ «был(а)» — без
 * анимации (docs/motion.md).
 */
let statusWasTyping = false;
function animateStatusSwap(status, typing) {
    if (typing === statusWasTyping) return;
    statusWasTyping = typing;
    if (prefersReducedMotion() || !status.animate || !status.isConnected) return;
    const ghost = status.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.classList.add('status-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    status.after(ghost);
    ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(4px)' }], { duration: 200, easing: 'ease-out' })
        .finished.finally(() => ghost.remove());
    status.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' });
}

function renderChatStatus(isBot, online = false) {
    const chat = currentChatMeta();
    const status = elements.chatStatus;
    const typingNow = !isBot && Boolean(currentRoomId) && typingNames(currentRoomId).length > 0;
    animateStatusSwap(status, typingNow);
    // Нет связи — это важнее «в сети» собеседника: его статус сейчас неизвестен.
    if (connectionState !== 'ok') {
        status.textContent = connectionStateText();
        status.className = 'status offline is-connecting';
        return;
    }
    const typing = !isBot && currentRoomId ? typingNames(currentRoomId) : [];
    if (typing.length) {
        status.replaceChildren(typingElement(typing, Boolean(chat && chat.kind === 'direct')));
        status.className = 'status online is-typing';
        return;
    }
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
    const count = `${members} ${['участник', 'участника', 'участников'][pluralForm(members)]}`;
    if (members > 2) {
        status.textContent = online ? `${count} · в сети` : count;
    } else if (online) {
        status.textContent = 'в сети';
    } else {
        const peer = chat && chat.peer_ids && chat.peer_ids[0];
        status.textContent = presenceHidden || peer === undefined ? 'был(а) недавно' : lastSeenText(peerLastSeen.get(Number(peer)));
    }
    status.className = 'status ' + (online ? 'online' : 'offline');
    refreshPresenceDots();
}

// Откуда уходили по цитатам: «↓» сначала возвращает туда, потом вниз.
const quoteReturns = [];

async function goToMessage(id, { from = null } = {}) {
    let bubble = elements.chatMessages.querySelector(`.message[data-message-id="${id}"]`);
    // Исходное сообщение вне окна — берём срез вокруг него, а не листаем
    // всю историю страницами.
    if (!bubble && await reloadFeed(id)) {
        bubble = elements.chatMessages.querySelector(`.message[data-message-id="${id}"]`);
    }
    if (!bubble || bubble.hidden) {
        showToast('Исходное сообщение не найдено — возможно, его удалили', 'info');
        return;
    }
    if (from && from !== id) {
        quoteReturns.push(from);
        refreshJumpDown(true);
    }
    const list = elements.chatMessages;
    const rect = bubble.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    scrollToTarget(list, list.scrollTop + rect.top - box.top - (list.clientHeight - rect.height) / 2);
    bubble.classList.remove('is-highlighted');
    bubble.getBoundingClientRect();
    bubble.classList.add('is-highlighted');
    setTimeout(() => bubble.classList.remove('is-highlighted'), 1200);
    bubble.focus({ preventScroll: true });
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/*
 * Вибрация — одна функция на всё. Длительности: selection 5, light 8,
 * medium 12, heavy 18 мс; success и error — паттерны Telegram. Где:
 * порог свайпа-ответа — heavy, меню по долгому нажатию и полный свайп в
 * списке — medium. Выключается в настройках (Apple требует, чтобы было
 * можно).
 *
 * На iPhone navigator.vibrate нет. С iOS 18 системный тик даёт нажатие на
 * <input type="checkbox" switch> через его <label> — проверять на
 * устройстве, срабатывает ли это во время свайпа.
 */
const HAPTIC = { selection: 5, light: 8, medium: 12, heavy: 18, success: [14, 65, 14], error: [14, 48, 14, 48, 14, 48, 20] };
let iosTickLabel = null;
function haptic(kind) {
    if (!hapticsOn()) return;
    try {
        if (navigator.vibrate) {
            navigator.vibrate(HAPTIC[kind] || HAPTIC.light);
        } else if (isIOS) {
            if (!iosTickLabel) {
                iosTickLabel = document.createElement('label');
                iosTickLabel.className = 'ios-haptic';
                iosTickLabel.setAttribute('aria-hidden', 'true');
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.setAttribute('switch', '');
                input.tabIndex = -1;
                iosTickLabel.appendChild(input);
                document.body.appendChild(iosTickLabel);
            }
            iosTickLabel.click();
        }
    } catch {
        // Не умеет — и ладно.
    }
}
function hapticsOn() {
    try { return localStorage.getItem('nyxo-haptics') !== '0'; } catch { return true; }
}

// Подряд идущие сообщения одного автора в пределах 5 минут — группа:
// меньше отступ, без повторного имени.
const GROUP_GAP_MS = 5 * 60 * 1000;
// Первое в группе несёт имя автора (в группах), последнее — «хвостик» и
// аватар.
function regroupMessages() {
    let prev = null;
    for (const el of elements.chatMessages.querySelectorAll('.message, .message-system, .unread-separator, .day-separator')) {
        const bubble = el.classList.contains('message') && !el.hidden ? el : null;
        const same = bubble && prev && prev.dataset.senderKey === bubble.dataset.senderKey
            && Math.abs(Number(bubble.dataset.at) - Number(prev.dataset.at)) < GROUP_GAP_MS;
        if (bubble) {
            bubble.classList.toggle('is-continuation', Boolean(same));
            bubble.classList.add('group-end');
            if (same) prev.classList.remove('group-end');
        }
        if (!el.hidden) prev = bubble;
    }
    observeForRead();
}

// Разделитель «Непрочитанные» — перед первым чужим сообщением после
// прочитанного. Возвращает его или null.
function placeUnreadSeparator(lastReadId) {
    elements.chatMessages.querySelector('.unread-separator')?.remove();
    const first = [...elements.chatMessages.querySelectorAll('.message.received[data-message-id]')]
        .find(el => Number(el.dataset.messageId) > lastReadId);
    if (!first) return null;
    return insertUnreadSeparator(first);
}

/*
 * Пришло, пока окно не в фокусе: «Непрочитанные» перед первым новым. Если
 * прежний разделитель уже весь прочитан — он переезжает сюда.
 */
function markUnreadBefore(bubble) {
    const existing = elements.chatMessages.querySelector('.unread-separator');
    if (existing) {
        const next = existing.nextElementSibling;
        if (next && Number(next.dataset.messageId) > readMarks.read) return existing;
        existing.remove();
    }
    return insertUnreadSeparator(bubble);
}

// Прокрутить так, чтобы разделитель встал под плашкой дня, но не дальше конца.
function scrollToSeparator(separator) {
    const list = elements.chatMessages;
    const day = separator.closest('.day-group')?.querySelector('.day-separator');
    const offset = (day ? day.getBoundingClientRect().height : 0) + 12;
    const target = list.scrollTop + separator.getBoundingClientRect().top - list.getBoundingClientRect().top - offset;
    stopScrollAnimation();
    list.scrollTop = Math.min(target, list.scrollHeight - list.clientHeight);
}

function insertUnreadSeparator(first) {
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

/* --- Реакции -----------------------------------------------------------------
   Свой набор (public/emoji/set.json): картинки Twemoji лежат на нашем
   сервере, и на всех устройствах реакции выглядят одинаково. Под
   сообщением — значок и счётчик, своя реакция выделена; долгое нажатие
   или правый клик по реакции — кто её поставил. */

let EMOJI = { quick: ['👍', '❤️', '😂', '😮', '😢', '🔥'], all: [] };

// Имя файла — кодовые точки без селектора варианта (U+FE0F), как у Twemoji.
const emojiFile = emoji => [...emoji].map(c => c.codePointAt(0)).filter(cp => cp !== 0xfe0f)
    .map(cp => cp.toString(16)).join('-');

function emojiImage(emoji) {
    const img = document.createElement('img');
    img.className = 'emoji';
    img.src = `/emoji/${emojiFile(emoji)}.svg`;
    img.alt = emoji;
    img.draggable = false;
    return img;
}

async function loadEmojiSet() {
    try {
        const response = await fetch('/emoji/set.json');
        if (response.ok) EMOJI = await response.json();
    } catch {
        // Без набора остаются шесть основных.
    }
    renderReactionMenu();
}

function reactionButton(emoji, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.emoji = emoji;
    button.setAttribute('aria-label', `Реакция ${emoji}`);
    button.appendChild(emojiImage(emoji));
    return button;
}

function renderReactionMenu() {
    const quick = EMOJI.quick.map(emoji => {
        const button = reactionButton(emoji, 'menu-item reaction-choice');
        button.setAttribute('role', 'menuitem');
        return button;
    });
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'menu-item reaction-more';
    more.setAttribute('role', 'menuitem');
    more.setAttribute('aria-label', 'Все реакции');
    more.appendChild(createIcon('i-plus'));
    elements.reactionRow.replaceChildren(...quick, more);
    elements.reactionPicker.replaceChildren(...(EMOJI.all.length ? EMOJI.all : EMOJI.quick)
        .map(emoji => reactionButton(emoji, 'reaction-pick')));
}

const normalizeReactions = reactions => (reactions || []).map(r => (typeof r === 'string' ? { emoji: r, users: [] } : r));

// Реакции пузыря: новая всплывает с «переростом», счётчик меняется плавно.
function renderReactions(bubble, reactions) {
    const content = bubble.querySelector('.message-content');
    if (!content) return;
    reactions = normalizeReactions(reactions);
    let box = content.querySelector('.reactions');
    const before = new Map(box ? [...box.children].map(c => [c.dataset.emoji, Number(c.dataset.count)]) : []);
    if (!reactions.length) {
        box?.remove();
        updateInlineMeta(bubble);
        return;
    }
    if (!box) {
        box = document.createElement('div');
        box.className = 'reactions';
        content.appendChild(box);
    }
    box.replaceChildren(...reactions.map(r => reactionChip(r, {
        fresh: !before.has(r.emoji),
        bumped: before.has(r.emoji) && before.get(r.emoji) !== r.users.length
            ? (r.users.length > before.get(r.emoji) ? 'up' : 'down') : false,
    })));
    updateInlineMeta(bubble);
}

function reactionChip(reaction, { fresh = false, bumped = false } = {}) {
    const { emoji } = reaction;
    const users = reaction.users || [];
    const mine = Boolean(currentUser) && users.some(u => u.id === currentUser.id);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'reaction' + (fresh ? ' is-new' : '') + (mine ? ' mine' : '');
    chip.dataset.emoji = emoji;
    chip.dataset.count = String(users.length);
    chip.reactionUsers = users;
    const count = document.createElement('span');
    count.className = 'reaction-count' + (bumped ? ' count-bump' : '') + (bumped === 'down' ? ' is-down' : '');
    count.textContent = users.length ? String(users.length) : '';
    chip.append(emojiImage(emoji), count);
    const names = users.map(u => (currentUser && u.id === currentUser.id ? 'вы' : u.username)).join(', ');
    chip.title = names;
    chip.setAttribute('aria-pressed', String(mine));
    chip.setAttribute('aria-label', `${emoji}: ${users.length || ''}${names ? ` — ${names}` : ''}. ${mine ? 'Нажмите, чтобы снять свою' : 'Нажмите, чтобы поставить'}`);
    chip.tabIndex = -1;
    return chip;
}

// Кто поставил реакцию — всплывающий список у самой реакции.
function showReactionWho(chip) {
    const box = elements.reactionWho;
    const users = chip.reactionUsers || [];
    const title = document.createElement('div');
    title.className = 'reaction-who-title';
    title.append(emojiImage(chip.dataset.emoji), `${users.length}`);
    const list = document.createElement('ul');
    list.replaceChildren(...users.map(u => {
        const li = document.createElement('li');
        li.textContent = currentUser && u.id === currentUser.id ? 'Вы' : u.username;
        return li;
    }));
    box.replaceChildren(title, list);
    if (box.matches(':popover-open')) box.hidePopover();
    box.showPopover();
    const r = chip.getBoundingClientRect();
    const margin = 8;
    box.style.left = `${Math.max(margin, Math.min(r.left, window.innerWidth - box.offsetWidth - margin))}px`;
    box.style.top = `${Math.max(margin, Math.min(r.bottom + 6, window.innerHeight - box.offsetHeight - margin))}px`;
}

function openReactionPicker(messageId, x, y) {
    const picker = elements.reactionPicker;
    picker.dataset.forMessage = messageId;
    if (picker.matches(':popover-open')) picker.hidePopover();
    picker.showPopover();
    const margin = 8;
    picker.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - picker.offsetWidth - margin))}px`;
    picker.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - picker.offsetHeight - margin))}px`;
    picker.querySelector('button')?.focus();
}

// Поставить (если своей такой ещё нет) — для двойного тапа.
async function addReaction(messageId, emoji) {
    const chip = elements.chatMessages.querySelector(`.message[data-message-id="${messageId}"] .reaction.mine[data-emoji="${emoji}"]`);
    if (chip) return;
    const added = await api('/api/reactions', { method: 'POST', body: JSON.stringify({ messageId: Number(messageId), emoji }) });
    if (!added.success) showToast(added.message, 'error');
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

/*
 * Три состояния соединения, как у Telegram:
 *   «Ожидание сети…» — сразу по событию offline;
 *   «Подключение…»   — сокет отвалился и не вернулся за 400 мс;
 *   «Обновление…»    — подключились, догружаем то, что пропустили.
 * В открытом чате — в шапке вместо «в сети», без чата — плашкой. На
 * iPhone сокет в фоне умирает молча: на online и при возврате во вкладку
 * подключаемся сразу, не дожидаясь, пока Socket.IO заметит.
 */
let connectionState = 'ok';
function setConnectionState(state) {
    connectionState = state;
    const text = { offline: 'Ожидание сети…', connecting: 'Подключение…', updating: 'Обновление…' }[state] || '';
    elements.connectionStatusText.textContent = text;
    elements.connectionStatus.hidden = !text || Boolean(currentChatId);
    if (currentChatId) renderChatStatus(currentChatIsBot);
}
const connectionStateText = () => ({ offline: 'Ожидание сети…', connecting: 'Подключение…', updating: 'Обновление…' }[connectionState] || '');

function reconnectNow() {
    if (currentUser && !socket.connected) socket.connect();
}

function setupConnectionStatus() {
    window.addEventListener('offline', () => {
        clearTimeout(connectionTimer);
        setConnectionState('offline');
    });
    window.addEventListener('online', () => {
        if (connectionState === 'offline') setConnectionState(socket.connected ? 'ok' : 'connecting');
        reconnectNow();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reconnectNow();
    });
    window.addEventListener('pageshow', reconnectNow);
    socket.on('disconnect', reason => {
        // Разрыв по нашей же команде (после входа сокет переподключается
        // с новой сессией) — не обрыв.
        if (reason === 'io client disconnect') return;
        wasDisconnected = true;
        // Разрыв со стороны сервера (перезапуск, сессия сменилась) Socket.IO
        // сам не лечит — переподключаемся сами, если есть кем.
        // Приватный аккаунт мог истечь: сервер удалил его и отключил сокет.
        // Сначала узнаём (ответ ANON_EXPIRED сам всё сотрёт), потом — назад.
        if (reason === 'io server disconnect' && currentUser) {
            const check = currentUser.isAnonymous ? api('/api/user').catch(() => null) : Promise.resolve();
            check.then(() => { if (currentUser) socket.connect(); });
        }
        clearTimeout(connectionTimer);
        if (!navigator.onLine) return setConnectionState('offline');
        // Короткие переподключения не мигают.
        connectionTimer = setTimeout(() => {
            if (!socket.connected) setConnectionState(navigator.onLine ? 'connecting' : 'offline');
        }, 400);
    });
    socket.on('connect', async () => {
        clearTimeout(connectionTimer);
        if (!wasDisconnected || !currentUser) return setConnectionState('ok');
        wasDisconnected = false;
        setConnectionState('updating');
        try {
            await loadChats();
            if (lastOpenChat && currentChatId === lastOpenChat[0]) {
                const list = elements.chatMessages;
                const fromBottom = list.scrollHeight - list.scrollTop;
                const wasAtBottom = atChatBottom();
                await openChat(...lastOpenChat);
                if (!wasAtBottom) list.scrollTop = Math.max(0, list.scrollHeight - fromBottom);
            }
        } finally {
            if (socket.connected) setConnectionState('ok');
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
    sending: ['', 'Отправляется'],
    sent: ['○', 'Отправлено'],
    delivered: ['✓', 'Доставлено'],
    read: ['✓✓', 'Прочитано'],
};
const STATUS_RANK = { sending: -1, sent: 0, delivered: 1, read: 2 };

/*
 * Отметки: часы → ✓ — из половины размера с проявлением за 150 мс;
 * ✓ → ✓✓ — вторая галочка въезжает на 5px за 220 мс. При «уменьшить
 * движение» — только проявление.
 */
function setMessageStatus(span, status) {
    const [mark, label] = STATUS_VIEW[status] || STATUS_VIEW.sent;
    const prev = span.dataset.status;
    const changed = span.isConnected && prev && prev !== status;
    span.dataset.status = status in STATUS_VIEW ? status : 'sent';
    span.replaceChildren();
    if (status === 'sending') {
        span.appendChild(createIcon('i-timer'));
    } else if (mark.startsWith('✓')) {
        [...mark].forEach((tick, i) => {
            const el = document.createElement('span');
            el.className = i ? 'tick tick-2' : 'tick';
            el.textContent = tick;
            span.appendChild(el);
        });
    } else {
        span.textContent = mark;
    }
    if (changed) animateStatusChange(span, prev, status);
    span.title = label;
    span.setAttribute('aria-label', label);
}

function animateStatusChange(span, prev, status) {
    if (!span.animate) return;
    const reduced = prefersReducedMotion();
    if (prev === 'sending' && !reduced) {
        span.animate([{ opacity: 0, transform: 'scale(0.5)' }, { opacity: 1, transform: 'none' }], { duration: 150, easing: 'ease-out' });
    } else if (prev === 'delivered' && status === 'read' && !reduced) {
        span.querySelector('.tick-2')?.animate([{ opacity: 0, transform: 'translateX(-5px)' }, { opacity: 1, transform: 'none' }],
            { duration: 220, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' });
    } else {
        span.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
    }
}

const readMarks = { chatId: null, read: 0, delivered: 0, timer: null, baseRead: 0, baseUnread: 0 };

/*
 * Прочитано — то, что было на экране, а не «лента у самого низа»: кто
 * читает от разделителя вниз, тот и сбрасывает счётчик. Пузыри под
 * IntersectionObserver: видимым считается тот, что виден хотя бы наполовину
 * (или занял пол-экрана). Отметка — наибольший видимый id, через 500 мс
 * после последнего изменения, и только когда окно в фокусе.
 */
const seenIds = new Set();
let readObserver = null;
function observeForRead() {
    if (!('IntersectionObserver' in window)) return;
    if (!readObserver) {
        readObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                const id = Number(entry.target.dataset.messageId);
                const tall = entry.rootBounds && entry.intersectionRect.height >= entry.rootBounds.height * 0.5;
                if (entry.isIntersecting && (entry.intersectionRatio >= 0.5 || tall)) seenIds.add(id);
                else seenIds.delete(id);
            }
            scheduleReadMark();
        }, { root: elements.chatMessages, threshold: [0, 0.5, 1] });
    }
    for (const el of elements.chatMessages.querySelectorAll('.message[data-message-id]:not([data-read-watch]), .message-system[data-message-id]:not([data-read-watch])')) {
        el.dataset.readWatch = '1';
        readObserver.observe(el);
    }
}

// Счётчик в списке — сразу, не дожидаясь сервера: столько-то было, из них
// прочитали те, что между прежней отметкой и новой.
function decrementBadgeLocally(chatId, upTo) {
    const badge = elements.chatsList.querySelector(`.chat-item[data-id="${chatId}"] .chat-badge:not(.is-requests)`);
    if (!badge) return;
    const read = [...elements.chatMessages.querySelectorAll('.message.received[data-message-id]')]
        .filter(el => { const id = Number(el.dataset.messageId); return id > readMarks.baseRead && id <= upTo; }).length;
    const left = Math.max(0, readMarks.baseUnread - read);
    readMarks.localLeft = left;
    if (left === 0) badge.remove();
    else badge.textContent = String(left);
    updateTitleCounter();
}

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
        const badge = elements.chatsList.querySelector(`.chat-item[data-id="${chatId}"] .chat-badge:not(.is-requests)`);
        if (badge && data.unread === 0) badge.remove();
        else if (badge) badge.textContent = String(data.unread);
        if (data.unread === 0) closeChatNotifications(chatId);
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
        const newest = newestShownMessageId();
        if (!newest) return;
        // Прочитано — только то, что видели: вкладка на экране, окно в
        // фокусе (окно на втором мониторе за другим не считается) и само
        // сообщение было на экране.
        const focused = document.visibilityState === 'visible' && document.hasFocus();
        const seen = focused ? Math.max(0, ...[...seenIds].filter(id => shownMessageIds.has(id))) : 0;
        if (seen > readMarks.read) {
            readMarks.read = seen;
            readMarks.delivered = Math.max(readMarks.delivered, seen);
            decrementBadgeLocally(chatId, seen);
            sendReadMark('read', chatId, seen);
        }
        if (newest > readMarks.delivered) {
            readMarks.delivered = newest;
            sendReadMark('delivered', chatId, newest);
        }
    }, 500);
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
/*
 * Непрочитанное — в заголовке вкладки, на значке приложения (Chrome и Edge
 * на компьютере, iPhone с iOS 16.4+ из приложения на экране «Домой» с
 * разрешёнными уведомлениями; Android не умеет) и точкой на значке вкладки.
 * Всё прочитано — закрываются и уведомления, в том числе от push.
 */
let shownUnreadTotal = null;

/* Счётчик чата вырос — короткий «пульс» 1 → 1.1 → 1 за 240 мс. Цифры не катим. */
const badgeCounts = new Map();
function pulseGrownBadges() {
    const seen = new Set();
    for (const item of elements.chatsList.querySelectorAll('.chat-item[data-id]')) {
        const badge = item.querySelector('.chat-badge:not(.is-requests)');
        const count = badge ? Number(badge.textContent) || 0 : 0;
        const id = item.dataset.id;
        seen.add(id);
        const before = badgeCounts.get(id);
        badgeCounts.set(id, count);
        if (badge && before !== undefined && count > before && !prefersReducedMotion() && badge.animate) {
            badge.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }], { duration: 240, easing: 'ease-out' });
        }
    }
    for (const id of [...badgeCounts.keys()]) if (!seen.has(id)) badgeCounts.delete(id);
}
function updateTitleCounter() {
    const total = [...elements.chatsList.querySelectorAll('.chat-badge:not(.is-requests):not(.is-muted)')]
        .reduce((sum, badge) => sum + (Number(badge.textContent) || 0), 0);
    document.title = total ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
    if (total === shownUnreadTotal) return;
    const hadUnread = Boolean(shownUnreadTotal);
    shownUnreadTotal = total;
    if ('setAppBadge' in navigator) {
        (total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {});
    }
    setFaviconDot(total > 0);
    if (!total && hadUnread) closeChatNotifications(null);
}

// Значок вкладки: исходный SVG, а пока есть непрочитанное — он же с точкой.
let faviconOriginal = null;
function setFaviconDot(on) {
    const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]') || document.querySelector('link[rel="icon"]');
    if (!link) return;
    if (faviconOriginal === null) faviconOriginal = link.getAttribute('href');
    if (!on) {
        link.setAttribute('href', faviconOriginal);
        return;
    }
    const img = new Image();
    img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const g = canvas.getContext('2d');
        g.drawImage(img, 0, 0, 64, 64);
        g.beginPath();
        g.arc(50, 14, 12, 0, Math.PI * 2);
        g.fillStyle = '#ff3b30';
        g.fill();
        if (shownUnreadTotal) link.setAttribute('href', canvas.toDataURL('image/png'));
    };
    img.src = faviconOriginal;
}

function setupReadMarks() {
    socket.on('receipts', applyReceipts);
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
    checkExpiryOption(chatExpirySeconds || 0);
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
// Сколько сообщений брать при открытии чата и переходе к сообщению: 40,
// на высоком экране (от 900px) — 60. Тесты задают своё.
let historyOpenSize = null;
const openPageSize = () => historyOpenSize || (window.innerHeight >= 900 ? 60 : 40);
/*
 * В ленте — окно истории: от oldestId до newestId. hasMore — есть что-то
 * раньше, hasNewer — позже (открыли на непрочитанном или перешли по
 * цитате). В DOM держим не больше FEED_MAX сообщений: догрузили с одного
 * края — лишнее уходит с другого.
 */
const FEED_MAX = 150;
const historyPaging = { chatId: null, oldestId: null, newestId: null, hasMore: false, hasNewer: false, loading: false, loadingNewer: false };

function resetPaging(chatId) {
    Object.assign(historyPaging, { chatId, oldestId: null, newestId: null, hasMore: false, hasNewer: false, loading: false, loadingNewer: false });
}

// Границы окна после загрузки страницы.
function applyPageBounds(data, page) {
    historyPaging.hasMore = Boolean(data.hasMore);
    historyPaging.hasNewer = Boolean(data.hasNewer);
    historyPaging.oldestId = page.length ? page[0].id : null;
    historyPaging.newestId = page.length ? page[page.length - 1].id : null;
}

// Окно дошло до конца переписки — превью в списке по последнему сообщению.
async function rememberLastPreview(page) {
    const last = page[page.length - 1];
    if (historyPaging.hasNewer || !last || !last.preview || !e2ee) return;
    await e2ee.rememberPreview(last, last.preview);
    updateChatPreviewInList(last, last.preview);
}

// Расшифровать страницу во фрагмент: вставка и группировка — один раз.
async function decryptBatch(page, chatId) {
    const batch = document.createElement('div');
    for (const msg of page) await appendMessageDecrypted(msg, { container: batch });
    return currentChatId === chatId ? batch : null;
}

// Первое сообщение, видимое сверху, и где оно сейчас: после вставки или
// выгрузки сверху экран возвращается к нему, а не к отступу от низа.
function feedAnchor() {
    const list = elements.chatMessages;
    const top = list.getBoundingClientRect().top;
    const el = visibleMessages().find(m => m.getBoundingClientRect().bottom > top) || null;
    return el ? { el, top: el.getBoundingClientRect().top } : null;
}
function keepAnchor(anchor) {
    if (!anchor || !anchor.el.isConnected) return;
    const delta = anchor.el.getBoundingClientRect().top - anchor.top;
    elements.chatMessages.scrollTop += delta;
    shiftScrollAnimation(delta);
}

// Лишнее сверх FEED_MAX — с края side ('top' или 'bottom').
function trimFeed(side) {
    const bubbles = [...elements.chatMessages.querySelectorAll('.message[data-message-id], .message-system[data-message-id]')];
    const extra = bubbles.length - FEED_MAX;
    if (extra <= 0) return;
    const anchor = feedAnchor();
    const drop = side === 'top' ? bubbles.slice(0, extra) : bubbles.slice(bubbles.length - extra);
    const rest = side === 'top' ? bubbles.slice(extra) : bubbles.slice(0, bubbles.length - extra);
    for (const el of drop) {
        shownMessageIds.delete(Number(el.dataset.messageId));
        const group = el.closest('.day-group');
        el.remove();
        if (group && !group.querySelector('.message, .message-system')) group.remove();
    }
    if (side === 'top') {
        historyPaging.hasMore = true;
        historyPaging.oldestId = Number(rest[0].dataset.messageId);
    } else {
        historyPaging.hasNewer = true;
        historyPaging.newestId = Number(rest[rest.length - 1].dataset.messageId);
    }
    keepAnchor(anchor);
    refreshMessageTabStop();
    regroupMessages();
}

/*
 * Догрузка по краям — по IntersectionObserver с запасом 750px, не чаще
 * раза в секунду: крайнее сообщение подошло к экрану — грузим следующую
 * страницу. Раньше — по событию scroll, на каждый пиксель.
 */
let edgeObservers = null;
let lastEdgeLoad = 0;
let edgeTimer = null;
function observeFeedEdges() {
    if (!('IntersectionObserver' in window)) return;
    if (!edgeObservers) {
        const make = side => new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) feedEdgeReached(side);
        }, { root: elements.chatMessages, rootMargin: '750px 0px' });
        edgeObservers = { top: make('top'), bottom: make('bottom') };
    }
    edgeObservers.top.disconnect();
    edgeObservers.bottom.disconnect();
    const bubbles = elements.chatMessages.querySelectorAll('.message[data-message-id], .message-system[data-message-id]');
    if (!bubbles.length) return;
    if (historyPaging.hasMore) edgeObservers.top.observe(bubbles[0]);
    if (historyPaging.hasNewer) edgeObservers.bottom.observe(bubbles[bubbles.length - 1]);
}
function feedEdgeReached(side) {
    const wait = 1000 - (performance.now() - lastEdgeLoad);
    if (wait > 0) {
        clearTimeout(edgeTimer);
        // Переподписка сама скажет, если край всё ещё у экрана.
        edgeTimer = setTimeout(observeFeedEdges, wait);
        return;
    }
    lastEdgeLoad = performance.now();
    if (side === 'top') loadOlderMessages();
    else loadNewerMessages();
}

/* Сообщения новее окна — в конец ленты. День на стыке — один. */
function appendMessagesBatch(batch) {
    const list = elements.chatMessages;
    const firstNew = batch.firstElementChild;
    const groups = list.querySelectorAll(':scope > .day-group');
    const lastShown = groups[groups.length - 1];
    if (firstNew && lastShown && firstNew.dataset.day && firstNew.dataset.day === lastShown.dataset.day) {
        for (const child of [...firstNew.children]) {
            if (!child.classList.contains('day-separator')) lastShown.appendChild(child);
        }
        firstNew.remove();
    }
    list.append(...batch.children);
    refreshMessageTabStop();
    regroupMessages();
}

async function loadNewerMessages() {
    const chatId = currentChatId;
    if (historyPaging.loadingNewer || !historyPaging.hasNewer || historyPaging.chatId !== chatId) return;
    historyPaging.loadingNewer = true;
    try {
        const data = await api(`/api/messages/${chatId}?limit=${historyPageSize}&after=${historyPaging.newestId}`);
        if (!data.success || currentChatId !== chatId) return;
        const page = data.messages || [];
        if (e2ee && data.keyEnvelopes) await e2ee.processKeyEnvelopes(data.keyEnvelopes);
        const batch = await decryptBatch(page, chatId);
        if (!batch) return;
        const anchor = feedAnchor();
        appendMessagesBatch(batch);
        keepAnchor(anchor);
        historyPaging.hasNewer = Boolean(data.hasNewer);
        if (page.length) historyPaging.newestId = page[page.length - 1].id;
        // Дошли до конца — ждущие и неотправленные этого чата снова в ленте.
        if (!historyPaging.hasNewer) {
            await rememberLastPreview(page);
            await renderPendingFor(chatId);
        }
        trimFeed('top');
    } finally {
        historyPaging.loadingNewer = false;
        observeFeedEdges();
    }
}

/*
 * Окно вокруг сообщения (around) или последние (без него): лента
 * собирается заново. Для перехода по цитате и «↓», когда новое за окном.
 */
async function reloadFeed(aroundId = null) {
    const chatId = currentChatId;
    const query = aroundId ? `around=${aroundId}&limit=${openPageSize()}` : `limit=${openPageSize()}`;
    const data = await api(`/api/messages/${chatId}?${query}`).catch(() => null);
    if (!data || !data.success || currentChatId !== chatId) return false;
    const page = data.messages || [];
    if (e2ee && data.keyEnvelopes) await e2ee.processKeyEnvelopes(data.keyEnvelopes);
    shownMessageIds.clear();
    const batch = await decryptBatch(page, chatId);
    if (!batch) return false;
    elements.chatMessages.replaceChildren();
    seenIds.clear();
    prependMessages(batch);
    applyPageBounds(data, page);
    await rememberLastPreview(page);
    if (!historyPaging.hasNewer) await renderPendingFor(chatId);
    showEmptyChat();
    observeFeedEdges();
    return true;
}


/*
 * Какие из сообщений, что лежат у нас расшифрованными, ещё есть на
 * сервере. Про новые скажет сама страница истории, про те, что старше
 * неё, спрашиваем отдельно. Не получилось спросить — считаем, что есть:
 * стереть по ошибке хуже, чем стереть позже.
 */
async function liveMessageIds(chatId, known, page) {
    const live = page.map(m => m.id);
    const outside = known.map(Number).filter(id =>
        (historyPaging.hasMore && id < historyPaging.oldestId) || (historyPaging.hasNewer && id > historyPaging.newestId));
    for (let i = 0; i < outside.length; i += 1000) {
        const chunk = outside.slice(i, i + 1000);
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
    // Заготовки пузырей сверху, пока грузится страница постарше; экран при
    // этом не прыгает.
    const list = elements.chatMessages;
    const placeholder = historySkeleton();
    list.prepend(placeholder);
    list.scrollTop += placeholder.offsetHeight;
    const dropPlaceholder = () => {
        if (!placeholder.isConnected) return;
        const height = placeholder.offsetHeight;
        placeholder.remove();
        list.scrollTop -= height;
    };
    try {
        const data = await api(`/api/messages/${chatId}?limit=${historyPageSize}&before=${historyPaging.oldestId}`);
        if (!data.success || currentChatId !== chatId) return;
        const page = data.messages || [];
        if (e2ee && data.keyEnvelopes) await e2ee.processKeyEnvelopes(data.keyEnvelopes);
        const batch = await decryptBatch(page, chatId);
        if (!batch) return;
        dropPlaceholder();
        // Экран не должен прыгать: сообщение, что было сверху, остаётся на
        // своём месте (якорь, а не отступ от низа — низ тоже может меняться).
        const anchor = feedAnchor();
        prependMessages(batch);
        keepAnchor(anchor);
        historyPaging.hasMore = Boolean(data.hasMore);
        if (page.length) historyPaging.oldestId = page[0].id;
        trimFeed('bottom');
    } finally {
        dropPlaceholder();
        historyPaging.loading = false;
        elements.chatMessages.removeAttribute('aria-busy');
        observeFeedEdges();
    }
}

function historySkeleton() {
    const box = document.createElement('div');
    box.className = 'history-skeleton';
    box.setAttribute('aria-hidden', 'true');
    for (const [side, width] of [['received', 55], ['sent', 40], ['received', 65]]) {
        const bubble = document.createElement('div');
        bubble.className = `message-skeleton ${side}`;
        bubble.style.setProperty('--w', `${width}%`);
        box.appendChild(bubble);
    }
    return box;
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

function hideReactionWho() {
    if (elements.reactionWho.matches(':popover-open')) elements.reactionWho.hidePopover();
}

/*
 * Один обработчик прокрутки ленты вместо шести, раз в кадр: сначала все
 * чтения размеров, потом все изменения — без вынужденных пересчётов
 * раскладки между ними.
 *
 * Плавающая дата (прилипшая к верху плашка дня) видна, пока крутят, и
 * 500 мс после, потом гаснет за 150 мс. Плашки в потоке видны всегда.
 */
let feedScrollFrame = 0;
let feedScrollingTimer = null;
let stuckSeparator = null;
function setupFeedScroll() {
    elements.chatMessages.addEventListener('scroll', () => {
        if (!feedScrollFrame) feedScrollFrame = requestAnimationFrame(onFeedScrollFrame);
    }, { passive: true });
}

function onFeedScrollFrame() {
    feedScrollFrame = 0;
    const list = elements.chatMessages;
    // Чтения.
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    const edge = list.getBoundingClientRect().top + (parseFloat(getComputedStyle(list).paddingTop) || 0);
    let stuck = null;
    for (const group of list.querySelectorAll(':scope > .day-group')) {
        const rect = group.getBoundingClientRect();
        if (rect.bottom <= edge) continue;
        if (rect.top < edge - 1) stuck = group.querySelector(':scope > .day-separator');
        break;
    }
    // Изменения.
    hideMessageMenu();
    hideReactionWho();
    stickToBottom = distance < 80;
    if (distance < 80 && !historyPaging.hasNewer) {
        if (newBelow) resetNewBelow();
        quoteReturns.length = 0;
    }
    refreshJumpDown();
    list.classList.add('is-scrolling');
    clearTimeout(feedScrollingTimer);
    feedScrollingTimer = setTimeout(() => list.classList.remove('is-scrolling'), 500);
    if (stuck !== stuckSeparator) {
        stuckSeparator?.classList.remove('is-stuck');
        stuck?.classList.add('is-stuck');
        stuckSeparator = stuck;
    }
}

function setupHistoryPaging() {
    // Догрузка — по краям ленты (observeFeedEdges).
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

// Время в списке чатов: сегодня — часы, вчера — «вчера», на этой неделе —
// день недели, раньше — дата.
const weekdayFormat = new Intl.DateTimeFormat(UI_LOCALE, { weekday: 'short' });
const shortDateFormat = new Intl.DateTimeFormat(UI_LOCALE, { day: '2-digit', month: '2-digit', year: '2-digit' });
function listTimeLabel(date) {
    const today = new Date();
    const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate())
        - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
    if (days <= 0) return timeFormat.format(date);
    if (days === 1) return 'вчера';
    if (days < 7) return weekdayFormat.format(date);
    return shortDateFormat.format(date);
}

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
    if (message.id) shownMessageIds.add(message.id);
    // Уже показанный пузырь с тем же id — или своё «отправляемое» с тем же
    // clientId — заменяется, а не повторяется.
    const existing = (message.id && elements.chatMessages.querySelector(`.message[data-message-id="${message.id}"], .message-system[data-message-id="${message.id}"]`))
        || (message.client_id && sendingBubble(message.client_id));
    if (existing && container === elements.chatMessages) {
        // Своё «отправляемое» уже появилось с анимацией — принятое встаёт на
        // его место новым, но второй раз не въезжает.
        if (existing.classList.contains('is-new')) el.classList.add('is-new', 'is-settled');
        const wasSending = existing.querySelector('.message-status[data-status="sending"]');
        existing.replaceWith(el);
        const status = el.querySelector('.message-status');
        if (wasSending && status && status.dataset.status !== 'sending') animateStatusChange(status, 'sending', status.dataset.status);
        refreshMessageTabStop();
        regroupMessages();
        return;
    }
    if (container === elements.chatMessages) elements.chatMessages.querySelector(':scope > .chat-empty')?.remove();
    // Новое въезжает, если это не поток и вкладка на экране.
    if (fresh && !arrivalBurst() && document.visibilityState === 'visible') el.classList.add('is-new');
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
/*
 * Удаление: пузырь гаснет и уменьшается к центру до 0.8 за 150 мс, потом
 * лента смыкается за 250 мс. Не на экране или «уменьшить движение» — сразу.
 * Убираем по окончании анимаций (getAnimations().finished), а не по
 * transitionend — прерванная анимация его не присылает.
 */
function removeMessageElement(el) {
    if (!el.isConnected || el.classList.contains('is-removing')) return;
    const list = elements.chatMessages;
    const rect = el.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    const onScreen = rect.bottom > box.top && rect.top < box.bottom;
    if (!onScreen || prefersReducedMotion() || document.visibilityState !== 'visible' || !el.animate) return dropMessageElement(el);
    el.classList.add('is-removing');
    el.inert = true;
    el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.8)' }],
        { duration: 150, easing: 'ease-out', fill: 'forwards' });
    Promise.all(el.getAnimations().map(a => a.finished)).then(() => {
        const style = getComputedStyle(el);
        el.animate([
            { height: `${el.offsetHeight}px`, marginTop: style.marginTop, marginBottom: style.marginBottom },
            { height: '0px', marginTop: '0px', marginBottom: '0px' },
        ], { duration: 250, easing: SLIDE_EASE, fill: 'forwards' });
        el.style.overflow = 'hidden';
        return Promise.all(el.getAnimations().map(a => a.finished));
    }).catch(() => {}).finally(() => dropMessageElement(el));
}

function dropMessageElement(el) {
    if (!el.isConnected) return;
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
/*
 * Вложение качается и расшифровывается, только когда до экрана осталось
 * 300px (на компьютере — 500px). Раньше — сразу при создании пузыря, и
 * каждая страница истории тянула все свои файлы.
 */
let attachmentObserver = null;
const attachmentLoaders = new WeakMap();
function whenNearScreen(el, load) {
    if (!('IntersectionObserver' in window)) return load();
    if (!attachmentObserver) {
        attachmentObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                attachmentObserver.unobserve(entry.target);
                const run = attachmentLoaders.get(entry.target);
                attachmentLoaders.delete(entry.target);
                if (run) run();
            }
        }, { root: elements.chatMessages, rootMargin: `${mobileLayout.matches ? 300 : 500}px 0px` });
    }
    attachmentLoaders.set(el, load);
    attachmentObserver.observe(el);
}

/**
 * Зашифрованное вложение: сначала заглушка, потом — по мере скачивания и
 * расшифровки — картинка, видео или ссылка на скачивание.
 */
function createEncryptedAttachmentElement(p) {
    const holder = document.createElement('div');
    holder.className = 'encrypted-attachment';
    const loading = document.createElement('div');
    loading.className = 'skeleton attachment-skeleton';
    if (p.w && p.h) {
        loading.classList.add('is-sized');
        loading.style.width = `${p.w}px`;
        loading.style.aspectRatio = `${p.w} / ${p.h}`;
    }
    // Миниатюра из сообщения — сразу, размытой, пока фото качается.
    if (p.thumb && !p.doc) {
        const thumb = document.createElement('img');
        thumb.className = 'attachment-thumb';
        thumb.src = p.thumb;
        thumb.alt = '';
        loading.classList.remove('skeleton');
        loading.appendChild(thumb);
    }
    holder.appendChild(loading);

    whenNearScreen(holder, () => e2ee.openAttachment(p).then(({ url, kind }) => {
        holder.replaceChildren();
        if (kind === 'image') {
            const img = document.createElement('img');
            img.src = url;
            img.alt = p.name;
            img.className = 'message-image';
            if (p.w && p.h) {
                img.width = p.w;
                img.height = p.h;
            }
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
    }));
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

/*
 * Системная строка пишется сервером в третьем лице («alice включил(а)…»).
 * О себе — «Вы включили…».
 */
// Сервер пишет строку в третьем лице с родом через скобки («alice
// включил(а)…»). Человеку — без «(а)»: о других — событие и имя через
// точку, о себе — «Вы включили…».
const SYSTEM_LINES = [
    // Группы: вход по ссылке, запросы, роли, название. Второе имя (кто
    // впустил, кого назначили) сравнивается с собой — «впустили вы».
    [/^(.+) вошёл\(ла\) в группу по ссылке, впустил\(а\) (.+)$/,
        (name, self, admin, me) => (self ? `Вы в группе · по ссылке · одобрено: ${admin}`
            : admin === me ? `${name} в группе · по ссылке, впустили вы` : `${name} в группе · по ссылке · одобрено: ${admin}`)],
    [/^(.+) вошёл\(ла\) в группу по ссылке$/, (name, self) => (self ? 'Вы в группе · по ссылке' : `${name} в группе · по ссылке`)],
    [/^(.+) просится в группу по ссылке$/, (name, self) => (self ? 'Вы попросились в группу' : `${name} просится в группу`)],
    [/^(.+) создал\(а\) ссылку-приглашение$/, (name, self) => (self ? 'Вы создали ссылку-приглашение' : `Ссылка-приглашение создана · ${name}`)],
    [/^(.+) сменил\(а\) ссылку-приглашение$/, (name, self) => (self ? 'Вы сменили ссылку-приглашение' : `Ссылка-приглашение изменена · ${name}`)],
    [/^(.+) отключил\(а\) ссылку-приглашение$/, (name, self) => (self ? 'Вы отключили ссылку-приглашение' : `Ссылка-приглашение отключена · ${name}`)],
    [/^(.+) назначил\(а\) администратором: (.+)$/,
        (name, self, target, me) => (self ? `Вы назначили администратором: ${target}`
            : target === me ? `Вы теперь администратор · назначение: ${name}` : `${target} — администратор · назначение: ${name}`)],
    [/^(.+) снял\(а\) права администратора: (.+)$/,
        (name, self, target, me) => (self && target === me ? 'Вы больше не администратор'
            : self ? `Вы сняли права администратора: ${target}`
                : target === me ? `Вы больше не администратор · ${name}` : `${target} больше не администратор · ${name}`)],
    [/^(.+) удалил\(а\) из группы: (.+)$/,
        (name, self, target) => (self ? `Вы удалили из группы: ${target}` : `${target} больше не в группе · удаление: ${name}`)],
    [/^(.+) теперь администратор$/, (name, self) => (self ? 'Вы теперь администратор' : `${name} теперь администратор`)],
    [/^(.+) переименовал\(а\) группу: (.+)$/,
        (name, self, title) => (self ? `Вы переименовали группу: «${title}»` : `Группа переименована: «${title}» · ${name}`)],
    [/^(.+) вошёл\(ла\) в чат по коду приглашения$/,
        (name, self) => (self ? 'Вы вошли в чат по коду приглашения' : `${name} в чате · по коду приглашения`)],
    [/^(.+) вышел\(ла\) из чата$/, (name, self) => (self ? 'Вы вышли из чата' : `${name} больше не в чате`)],
    [/^(.+) сменил\(а\) код приглашения$/, (name, self) => (self ? 'Вы сменили код приглашения' : `Код приглашения изменён · ${name}`)],
    [/^(.+) отключил\(а\) приглашение$/, (name, self) => (self ? 'Вы отключили приглашение' : `Приглашение отключено · ${name}`)],
    [/^(.+) включил\(а\) исчезающие сообщения: (.+)$/,
        (name, self, term) => (self ? `Вы включили исчезающие сообщения · ${term}` : `Исчезающие сообщения включены · ${term} · ${name}`)],
    [/^(.+) изменил\(а\) срок исчезающих сообщений: (.+)$/,
        (name, self, term) => (self ? `Вы изменили срок исчезающих сообщений · ${term}` : `Срок исчезающих сообщений · ${term} · ${name}`)],
    [/^(.+) выключил\(а\) исчезающие сообщения$/,
        (name, self) => (self ? 'Вы выключили исчезающие сообщения' : `Исчезающие сообщения выключены · ${name}`)],
];

// «1 день», «5 минут» — не рвутся между числом и словом.
const keepNumbersTogether = text => text.replace(/(\d) (?=\S)/g, '$1\u00a0');

function systemLineText(text) {
    const me = currentUser && currentUser.username;
    for (const [pattern, render] of SYSTEM_LINES) {
        const match = pattern.exec(text);
        if (match) return keepNumbersTogether(render(match[1], match[1] === me, match[2], me));
    }
    return keepNumbersTogether(text);
}

// Ширина строки времени — в --meta-w пузыря (для распорки). Меняется сама:
// ✓ → ✓✓, таймер исчезающего сообщения.
const metaWidthObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
        const bubble = entry.target.closest('.message');
        if (bubble) bubble.style.setProperty('--meta-w', `${Math.ceil(entry.target.getBoundingClientRect().width) + 6}px`);
    }
});

// Время в строке текста — только пока текст последний в пузыре: реакции и
// пометки под ним сдвигают время вниз.
function updateInlineMeta(bubble) {
    const content = bubble.querySelector('.message-content');
    const last = content && content.lastElementChild;
    bubble.classList.toggle('inline-meta', Boolean(last && last.classList.contains('message-text') && last.querySelector('.meta-spacer')));
}

// Сообщение из одного–трёх эмодзи (и ничего больше) — крупно и без пузыря.
const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function emojiOnlyCount(text) {
    if (!graphemes || !text) return 0;
    const parts = [...graphemes.segment(text.trim())].map(p => p.segment).filter(g => g.trim());
    if (!parts.length || parts.length > 3) return 0;
    return parts.every(g => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g) && !/[\p{L}\p{N}]/u.test(g)) ? parts.length : 0;
}

function createMessageElement(message) {
    // Событие чата (вошёл, вышел, сменил код) — строкой, без меню.
    if (message.message_type === 'system') {
        const line = document.createElement('div');
        line.className = 'message-system';
        line.dataset.messageId = message.id;
        const text = systemLineText(message.text || '');
        if (/исчезающ/i.test(text)) line.appendChild(createIcon('i-timer'));
        line.append(text);
        return line;
    }
    const isMine = isOwnMessage(message);
    const div = document.createElement('div');
    div.className = `message ${isMine ? 'sent' : 'received'}`;
    if (message.id) div.dataset.messageId = message.id;
    if (message.client_id && isMine) div.dataset.clientId = message.client_id;
    if (message.status === 'sending') div.classList.add('is-sending');
    if (message.sender_username) div.dataset.sender = message.sender_username;
    div.dataset.senderKey = `${isMine ? 'me' : message.user_id}:${Number(message.sent) ? 1 : 0}`;
    const at = messageDate(message);
    div.dataset.at = String(at ? at.getTime() : 0);
    div.tabIndex = -1;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    // В группе у чужих: имя — над первым в группе, аватар — у последнего
    // (что показывать, решают классы группы и .is-group у ленты).
    if (!isMine && message.sender_username) {
        const author = document.createElement('div');
        author.className = 'message-author';
        author.dir = 'auto';
        author.textContent = message.sender_username;
        contentDiv.appendChild(author);
        const face = document.createElement('div');
        face.className = 'message-avatar';
        face.setAttribute('aria-hidden', 'true');
        paintAvatar(face, message.sender_avatar, message.sender_username);
        div.appendChild(face);
    }

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
            textDiv.dir = 'auto';
            renderMessageText(textDiv, message.text || '');
            contentDiv.appendChild(textDiv);
            const emojis = !message.reply_to && !message.encryptedFile && !message.file_url ? emojiOnlyCount(message.text) : 0;
            if (emojis) {
                div.classList.add('is-emoji');
                div.dataset.emojiCount = String(emojis);
            }
        }

        if (message.edited_at) {
            const editedDiv = document.createElement('div');
            editedDiv.className = 'edited-label';
            editedDiv.textContent = 'изменено';
            contentDiv.appendChild(editedDiv);
        }
        const undelivered = isMine && undeliveredCache[message.id];
        if (undelivered) {
            const note = document.createElement('div');
            note.className = 'message-undelivered';
            note.append(createIcon('i-alert'), undeliveredText(undelivered));
            contentDiv.appendChild(note);
        }
        if (message.reactions && message.reactions.length > 0) {
            const reactionsDiv = document.createElement('div');
            reactionsDiv.className = 'reactions';
            reactionsDiv.append(...normalizeReactions(message.reactions).map(r => reactionChip(r)));
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
    // Время — в конце последней строки текста, если помещается: место под
    // него держит невидимая распорка шириной со строку времени.
    const lastText = contentDiv.lastElementChild;
    if (lastText && lastText.classList.contains('message-text') && !div.classList.contains('is-emoji')) {
        const spacer = document.createElement('span');
        spacer.className = 'meta-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        lastText.appendChild(spacer);
        div.classList.add('inline-meta');
        metaWidthObserver.observe(metaDiv);
    }

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
        if (message.deleted || e.target.closest('.reaction')) return;
        if (Date.now() - longPressShownAt < 1000) return;
        showMessageMenu(e.clientX, e.clientY, message, null, div);
    });

    // Долгое нажатие (400 мс, лёгкая вибрация) — меню; свайп влево — ответ
    // (вправо — «назад» к списку).
    let swipe = null;
    div.addEventListener('touchstart', (e) => {
        if (e.touches.length > 1) {
            // Второй палец — не жест.
            if (swipe && swipe.active) releaseSwipe(false);
            swipe = null;
            clearTimeout(longPressTimer);
            return;
        }
        if (div.classList.contains('is-selectable') || e.target.closest('.reaction')) return;
        const touch = e.touches[0];
        swipe = { x: touch.clientX, y: touch.clientY, d: 0, active: false, moved: false, ready: false,
            at: Date.now(), target: e.target, menu: false };
        clearTimeout(longPressTimer);
        clearTimeout(squeezeTimer);
        // Сигнал до меню: через 120 мс пузырь начинает сжиматься — за 200 мс
        // теряет ~15px ширины. Отпустил раньше — возвращается.
        squeezeTimer = setTimeout(() => {
            if (!swipe || swipe.moved || message.deleted || prefersReducedMotion()) return;
            const w = div.offsetWidth || 1;
            const scale = Math.max(0.7, (w - 15) / w);
            squeeze = div.animate([{ transform: 'none' }, { transform: `scale(${scale})` }], { duration: 200, easing: 'linear', fill: 'forwards' });
        }, 120);
        longPressTimer = setTimeout(() => {
            if (message.deleted || !swipe || swipe.active) return;
            longPressShownAt = Date.now();
            haptic('medium');
            releaseSqueeze(false);
            swipe.menu = true;
            showMessageMenu(touch.clientX, touch.clientY, message, null, div, { lift: true });
        }, MESSAGE_PRESS_MS);
    }, { passive: true });
    let squeeze = null;
    let squeezeTimer = null;
    const releaseSqueeze = (animate = true) => {
        clearTimeout(squeezeTimer);
        if (!squeeze) return;
        const current = squeeze;
        squeeze = null;
        if (!animate) return current.cancel();
        current.commitStyles?.();
        current.cancel();
        div.animate([{ transform: div.style.transform || 'none' }, { transform: 'none' }], { duration: 200, easing: 'ease-out' })
            .finished.finally(() => { if (!swipe || !swipe.active) div.style.transform = ''; });
    };
    // Свайп-ответ — только по расстоянию (как в Telegram): 48px. Дальше —
    // плавное сопротивление, без жёсткого предела. Вокруг значка — кольцо,
    // дорисовывается к порогу; на пороге значок подскакивает.
    const SWIPE_FIRE = 48;
    const RING = 2 * Math.PI * 15;
    let swipeIcon = null;
    div.addEventListener('touchmove', (e) => {
        if (!swipe || e.touches.length > 1) return;
        const touch = e.touches[0];
        // Меню открыто долгим нажатием — палец выбирает пункт, не отрываясь.
        if (swipe.menu) {
            pointMenuItem(touch.clientX, touch.clientY);
            return;
        }
        const dx = touch.clientX - swipe.x;
        const dy = touch.clientY - swipe.y;
        if (Math.hypot(dx, dy) > 10) {
            clearTimeout(longPressTimer);
            releaseSqueeze();
            swipe.moved = true;
        }
        if (!swipe.active && !message.deleted && message.id && dx < -12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            swipe.active = true;
            div.style.transition = 'none';
            swipeIcon = document.createElement('span');
            swipeIcon.className = 'swipe-reply-icon';
            const svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('class', 'swipe-ring');
            svg.setAttribute('viewBox', '0 0 36 36');
            svg.setAttribute('aria-hidden', 'true');
            const circle = document.createElementNS(SVG_NS, 'circle');
            circle.setAttribute('cx', '18');
            circle.setAttribute('cy', '18');
            circle.setAttribute('r', '15');
            circle.style.strokeDasharray = String(RING);
            circle.style.strokeDashoffset = String(RING);
            svg.appendChild(circle);
            swipeIcon.append(svg, createIcon('i-reply'));
            div.appendChild(swipeIcon);
        }
        if (!swipe.active) return;
        const pull = Math.max(0, -dx);
        swipe.d = pull <= SWIPE_FIRE ? pull : SWIPE_FIRE + (1 - 1 / (0.004 * (pull - SWIPE_FIRE) + 1)) * 100;
        div.style.transform = `translateX(${-swipe.d}px)`;
        const progress = Math.min(1, swipe.d / SWIPE_FIRE);
        swipeIcon.style.opacity = String(progress);
        swipeIcon.querySelector('circle').style.strokeDashoffset = String(RING * (1 - progress));
        const ready = swipe.d >= SWIPE_FIRE;
        if (ready && !swipe.ready) {
            haptic('heavy');
            if (!prefersReducedMotion()) {
                swipeIcon.querySelector('.icon').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.1)', offset: 0.57 }, { transform: 'scale(1)' }],
                    { duration: 350, easing: 'ease-out' });
            }
        }
        swipe.ready = ready;
        swipeIcon.classList.toggle('is-ready', ready);
    }, { passive: true });
    // Возврат — без перелёта, за 300 мс; при «уменьшить движение» — сразу.
    const releaseSwipe = fire => {
        const icon = swipeIcon;
        swipeIcon = null;
        div.style.transition = prefersReducedMotion() ? 'none' : 'transform 300ms cubic-bezier(0.38, 0.7, 0.125, 1)';
        div.style.transform = '';
        setTimeout(() => { div.style.transition = ''; icon?.remove(); }, 300);
        if (icon) icon.style.opacity = '0';
        if (fire) startReply(message);
    };
    const endSwipe = () => {
        clearTimeout(longPressTimer);
        releaseSqueeze();
        // Меню, открытое долгим нажатием: отпустил на пункте — действие.
        if (swipe && swipe.menu) {
            const item = pointedMenuItem;
            pointMenuItem(-1, -1);
            swipe = null;
            if (item) item.click();
            return;
        }
        // Двойной тап по пузырю — ❤️ (не по ссылке, цитате, вложению).
        if (swipe && !swipe.active && !swipe.moved && Date.now() - swipe.at < 250 && !message.deleted && !currentChatIsBot
            && !swipe.target.closest('a, button, video, img, .reply-to')) {
            const now = Date.now();
            if (lastTap && lastTap.bubble === div && now - lastTap.at < 300) {
                lastTap = null;
                haptic('light');
                addReaction(message.id, '❤️');
            } else {
                lastTap = { bubble: div, at: now };
            }
        }
        if (swipe && swipe.active) releaseSwipe(swipe.d >= SWIPE_FIRE);
        swipe = null;
    };
    div.addEventListener('touchend', endSwipe);
    div.addEventListener('touchcancel', endSwipe);

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

// Палец ведут по открытому меню — пункт под ним подсвечен (touchmove +
// elementFromPoint); отпустили — действие.
let pointedMenuItem = null;
function pointMenuItem(x, y) {
    const el = x < 0 ? null : document.elementFromPoint(x, y);
    const item = el && el.closest('#message-menu .menu-item:not([hidden]), #message-menu .reaction-quick-btn');
    if (item === pointedMenuItem) return;
    pointedMenuItem?.classList.remove('is-pointed');
    pointedMenuItem = item || null;
    if (pointedMenuItem) {
        pointedMenuItem.classList.add('is-pointed');
        haptic('selection');
    }
}

function menuItems() {
    return [...elements.messageMenu.querySelectorAll('.menu-item')].filter(b => !b.hidden);
}

/**
 * Показать меню у точки (x, y) в координатах окна. trigger — сообщение,
 * если меню открыли кнопкой «⋯» или с клавиатуры: фокус уходит в меню и
 * потом возвращается на сообщение.
 */
let menuBubble = null;

function showMessageMenu(x, y, message, trigger = null, bubble = trigger, { lift = false } = {}) {
    // Пока сообщение не принято сервером, делать с ним нечего.
    if (!message.id) return;
    const menu = elements.messageMenu;
    lowerMessage();
    menuBubble = bubble;
    // Не data-message-id: по этому атрибуту ищут пузыри сообщений, и после
    // удаления пузыря находилось бы само меню.
    menu.dataset.forMessage = message.id;
    menu.dataset.forMessageText = message.text || '';
    menu.dataset.forMessageAuthor = isOwnMessage(message) ? 'Вы' : (message.sender_username || '');
    const isMine = isOwnMessage(message);
    // Правка зашифрованного сообщения ушла бы на сервер открытым текстом,
    // поэтому её нет вовсе — удалить и отправить заново можно.
    elements.editMessageBtn.hidden = !(isMine && !message.encrypted);
    elements.deleteMessageBtn.hidden = !isMine;
    elements.selectTextBtn.hidden = !(coarsePointer() && message.text && !message.deleted && bubble);
    // С ботом реакции ни к чему: ответить некому.
    elements.reactionRow.hidden = currentChatIsBot;

    menuTrigger = trigger;
    if (menu.matches(':popover-open')) menu.hidePopover();
    menu.showPopover();
    watchMenuClose(hideMessageMenu);
    // Размер известен только после показа: прижимаем меню к краям окна.
    const margin = 8;
    if (lift && bubble) {
        // Телефон, долгое нажатие: пузырь приподнят, остальное гаснет, меню —
        // у пузыря (под ним, а если места нет — над), по краю со стороны
        // автора и раскрывается из его угла.
        liftMessage(bubble);
        const r = bubble.getBoundingClientRect();
        const sent = bubble.classList.contains('sent');
        const below = r.bottom + 8 + menu.offsetHeight <= window.innerHeight - margin;
        const top = below ? r.bottom + 8 : Math.max(margin, r.top - 8 - menu.offsetHeight);
        const left = Math.max(margin, Math.min(sent ? r.right - menu.offsetWidth : r.left, window.innerWidth - menu.offsetWidth - margin));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.style.transformOrigin = `${sent ? '100%' : '0%'} ${below ? '0%' : '100%'}`;
    } else {
        const left = Math.max(margin, Math.min(x, window.innerWidth - menu.offsetWidth - margin));
        const top = Math.max(margin, Math.min(y, window.innerHeight - menu.offsetHeight - margin));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        // Раскрывается из точки нажатия, даже если меню пришлось сдвинуть от края.
        menu.style.transformOrigin = `${x - left}px ${y - top}px`;
    }
    if (trigger) (menuItems().find(item => item.id) || menuItems()[0])?.focus();
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
        progress: true,
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

// Открыт ли чат, к которому относится событие. У сообщения комнаты chat_id —
// строка чата отправителя, с открытым чатом получателя его не сравнить:
// номер мог совпасть, например, с его чатом с ботом.
function isForOpenChat({ chat_id, room_id }) {
    if (room_id) return Boolean(currentRoomId) && Number(room_id) === Number(currentRoomId);
    return Number(chat_id) === Number(currentChatId);
}

async function handleNewMessage(message) {
    if (message.room_id && message.user_id) stopTyping(message.room_id, message.user_id);
    if (!isOwnMessage(message) && message.message_type !== 'system' && Number(message.sent) !== 0) {
        const chat = chatOfMessage(message);
        if ((!chat || !chat.muted) && shouldRing(message)) playSound('receive');
    }
    if (isForOpenChat(message) && historyPaging.hasNewer) {
        // Окно ленты не дошло до конца: новое — за ним. Вставлять нельзя
        // (была бы дыра), только счётчик на «↓».
        if (!isOwnMessage(message) && message.message_type !== 'system') noteNewBelow();
        refreshOpenChatItem(message);
        notifyNewMessage(message, '');
    } else if (isForOpenChat(message)) {
        // Читают историю — не выдёргиваем вниз, а показываем «↓» со
        // счётчиком. У конца переписки — одним движением: мгновенно в
        // конец, а содержимое доезжает снизу.
        const list = elements.chatMessages;
        const wasAtBottom = atChatBottom();
        const own = isOwnMessage(message);
        const unfocused = document.visibilityState !== 'visible' || !document.hasFocus();
        const burst = arrivalBurst();
        const heightBefore = list.scrollHeight;
        await appendMessageDecrypted(message, { fresh: !wasAtBottom && !own });
        const bubble = message.id ? list.querySelector(`.message[data-message-id="${message.id}"]`) : null;
        // Пришло, пока окно не в фокусе, — «Непрочитанные» перед первым
        // новым, и дальше него лента не уезжает.
        const separator = unfocused && !own && bubble && message.message_type !== 'system' ? markUnreadBefore(bubble) : null;
        if (wasAtBottom || own) {
            if (separator) scrollToSeparator(separator);
            else revealAtBottom(heightBefore, { burst, fresh: bubble });
            jumpQuietUntil = performance.now() + 350;
            trimFeed('top');
        } else {
            noteNewBelow();
        }
        scheduleReadMark();
        // Строка «вошёл» или «вышел» меняет состав: может быть, теперь есть
        // кому писать (или уже нет).
        if (message.message_type === 'system') {
            await loadChats();
            renderChatStatus(currentChatIsBot);
            applyRoomState();
            // Состав сменился — и то, для кого шифровать.
            refreshEncryptionBadge(currentChatId, currentChatIsBot);
        } else {
            refreshOpenChatItem(message);
        }
        notifyNewMessage(message, message.preview || (message.encrypted ? '' : message.text || ''));
    } else {
        // Чужой чат: расшифровываем ради превью в списке, рисовать
        // нечего.
        let preview = message.encrypted ? '' : message.text || '';
        if (message.encrypted && e2ee) {
            const raw = await resolveMessageText(message);
            if (raw !== null) {
                preview = e2ee.payloadPreview(e2ee.decodePayload(raw));
                await e2ee.rememberPreview(message, preview);
            }
        }
        notifyNewMessage(message, preview);
        scheduleChatsReload();
    }
}

// Ответ на сообщение: из меню и свайпом. Курсор — сразу в поле: ответ
// начинают печатать тут же.
let replyContext = null;
function startReply(message, { focus = true } = {}) {
    if (!message || !message.id) return;
    replyToMessageId = message.id;
    const author = isOwnMessage(message) ? 'Вы' : (message.sender_username || message.author || '');
    replyContext = { id: Number(message.id), author, text: message.text || '' };
    elements.replyPreviewAuthor.textContent = author;
    elements.replyPreviewAuthor.hidden = !author;
    elements.replyPreviewText.textContent = (message.text || 'Сообщение').substring(0, 100);
    elements.replyPreview.classList.remove('hidden');
    if (focus) elements.messageInput.focus({ preventScroll: true });
    captureDraft();
}

function checkExpiryOption(seconds) {
    const option = elements.chatExpiryOptions.querySelector(`input[name="chat-expiry"][value="${Number(seconds) || 0}"]`);
    if (option) option.checked = true;
}

/*
 * Меню — popover="manual", и системное «Назад» на Android его не видело:
 * выходило из чата при открытом меню. CloseWatcher перехватывает «Назад»
 * (и Esc): сначала закрывается меню.
 */
let menuWatcher = null;
function watchMenuClose(hide) {
    menuWatcher?.destroy();
    menuWatcher = null;
    if (!('CloseWatcher' in window)) return;
    try {
        menuWatcher = new CloseWatcher();
        menuWatcher.onclose = () => {
            menuWatcher = null;
            hide();
        };
    } catch {
        // Без жеста пользователя браузер может отказать — тогда как раньше.
    }
}
function unwatchMenuClose() {
    menuWatcher?.destroy();
    menuWatcher = null;
}

function hideMessageMenu() {
    if (elements.messageMenu.matches(':popover-open')) elements.messageMenu.hidePopover();
    unwatchMenuClose();
    lowerMessage();
}

let liftedMessage = null;
function liftMessage(bubble) {
    let dim = elements.mainContent.querySelector(':scope > .message-dim');
    if (!dim) {
        dim = document.createElement('div');
        dim.className = 'message-dim';
        elements.mainContent.appendChild(dim);
    }
    dim.classList.add('is-shown');
    bubble.classList.remove('is-lowering');
    bubble.classList.add('is-lifted');
    liftedMessage = bubble;
}
function lowerMessage() {
    elements.mainContent.querySelector(':scope > .message-dim')?.classList.remove('is-shown');
    if (!liftedMessage) return;
    const bubble = liftedMessage;
    liftedMessage = null;
    bubble.classList.remove('is-lifted');
    bubble.classList.add('is-lowering');
    setTimeout(() => bubble.classList.remove('is-lowering'), 120);
}

function clearReply() {
    replyToMessageId = null;
    replyContext = null;
    elements.replyPreview.classList.add('hidden');
    elements.replyPreviewText.textContent = '';
}

/*
 * Отправка. Своё сообщение появляется сразу: поле и плашка ответа
 * очищаются по нажатию, пузырь «отправляется» (⏲) встаёт в ленту, а
 * шифрование и запрос идут в фоне. Раньше текст висел в поле, пока шли
 * шифрование, запрос и запись в IndexedDB, — и второй Enter отправлял его
 * ещё раз с новым clientId.
 *
 * Дальше пузырь либо получает id и галочку, либо становится «Не
 * отправлено · Повторить · Удалить» (повтор — с тем же clientId: сервер
 * не заведёт второе сообщение), либо — «Ждёт ключей собеседника».
 */
/*
 * Ссылки в тексте нажимаются: только http(s), в новой вкладке, без
 * передачи адреса Nyxo (noreferrer). Адрес с punycode (xn--, мог
 * притворяться знакомым сайтом) или с логином и паролем внутри — через
 * подтверждение. Превью ссылок нет: его сделал бы либо сервер (узнал бы
 * ссылку), либо браузер (сайт узнал бы IP человека).
 */
const URL_RE = /\bhttps?:\/\/[^\s<>"'«»]+/gi;
function renderMessageText(el, text) {
    el.replaceChildren();
    let last = 0;
    for (const match of String(text || '').matchAll(URL_RE)) {
        let raw = match[0];
        // Точка или скобка в конце предложения — не часть адреса.
        while (/[.,!?:;]$/.test(raw) || (raw.endsWith(')') && (raw.match(/\(/g) || []).length < (raw.match(/\)/g) || []).length)) raw = raw.slice(0, -1);
        let url;
        try { url = new URL(raw); } catch { continue; }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
        if (match.index > last) el.append(text.slice(last, match.index));
        const a = document.createElement('a');
        a.href = url.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'message-link';
        a.textContent = raw;
        if (url.hostname.split('.').some(part => part.startsWith('xn--')) || url.username || url.password) {
            a.dataset.suspicious = '1';
            a.addEventListener('click', event => {
                const why = url.username || url.password ? 'в адресе спрятаны логин и пароль' : 'в адресе есть буквы других алфавитов';
                if (!confirm(`Открыть ${url.hostname}?\n\nОсторожно: ${why} — ссылка может притворяться другим сайтом.`)) event.preventDefault();
            });
        }
        el.appendChild(a);
        last = match.index + raw.length;
    }
    if (last < String(text || '').length) el.append(String(text).slice(last));
}

// Текст пузыря без служебной распорки под время.
function messageTextOf(el) {
    if (!el) return '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll('.meta-spacer').forEach(s => s.remove());
    return copy.textContent;
}

/*
 * Одно сообщение — до MESSAGE_LIMIT знаков. Раньше поле обрезало
 * вставленное молча (maxlength). Теперь длиннее — уходит несколькими
 * сообщениями, разрезанными по пробелам; на кнопке — «×2», а когда до
 * предела меньше 100 знаков — остаток.
 */
const MESSAGE_LIMIT = 4000;

function splitMessage(text, limit = MESSAGE_LIMIT) {
    const parts = [];
    let rest = text;
    // Предел — в единицах UTF-16 (так считает сервер), а режем по целым
    // символам: эмодзи пополам не делятся.
    while (rest.length > limit) {
        let cut = '';
        for (const char of rest) {
            if (cut.length + char.length > limit) break;
            cut += char;
        }
        const space = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
        if (space > limit * 0.5) cut = cut.slice(0, space);
        parts.push(cut.trimEnd());
        rest = rest.slice(cut.length).trimStart();
    }
    if (rest) parts.push(rest);
    return parts;
}

function updateMessageCounter() {
    const length = elements.messageInput.value.trim().length;
    const counter = document.getElementById('message-counter');
    const parts = length > MESSAGE_LIMIT ? splitMessage(elements.messageInput.value.trim()).length : 1;
    const left = MESSAGE_LIMIT - length;
    counter.hidden = !(left < 100 && left >= 0) || Boolean(editingMessageId);
    counter.textContent = counter.hidden ? '' : String(left);
    elements.sendBtn.dataset.parts = parts > 1 && !editingMessageId ? `×${parts}` : '';
    elements.sendBtn.setAttribute('aria-label', parts > 1 && !editingMessageId
        ? `Отправить ${parts} сообщениями` : SEND_BUTTON[elements.sendBtn.dataset.mode] || 'Отправить');
}

async function sendMessage() {
    const text = elements.messageInput.value.trim();
    if (!text) return;
    if (!currentChatId) {
        showToast('Выберите чат', 'error');
        return;
    }
    if (editingMessageId) {
        if (text.length > MESSAGE_LIMIT) return showToast(`В исправленном сообщении — не больше ${MESSAGE_LIMIT} знаков`, 'error');
        return saveEdit(editingMessageId, text);
    }

    const chatId = currentChatId;
    const isBot = currentChatIsBot;
    const reply = replyContext;
    // Откуда «вылетит» пузырь — поле, пока в нём ещё текст.
    const from = elements.messageInput.getBoundingClientRect();
    setMessageInput('');
    clearReply();
    // Лента открыта не на конце (непрочитанное, цитата) — сначала в конец.
    if (historyPaging.hasNewer) await reloadFeed();
    // Отправил — следующий набор снова «печатает» сразу.
    typingSentAt = 0;
    clearDraft(chatId);
    const parts = splitMessage(text).map(part => ({ text: part, clientId: newClientId() }));
    parts.forEach((part, i) => appendSendingBubble(chatId, { clientId: part.clientId, text: part.text, reply: i === 0 ? reply : null, from: i === 0 ? from : null }));
    updateChatPreviewInList({ chat_id: chatId, room_id: currentRoomId, user_id: currentUser.id, sent: 1,
        created_at: new Date().toISOString() }, parts[parts.length - 1].text);
    // По очереди: порядок частей должен сохраниться.
    for (const [i, part] of parts.entries()) {
        await deliverText({ chatId, isBot, text: part.text, replyToId: i === 0 && reply ? reply.id : null, clientId: part.clientId });
    }
}

// Плашка «Редактирование» над полем — как у ответа.
function showEditBar(show, text = '') {
    elements.editPreview.classList.toggle('hidden', !show);
    elements.editPreviewText.textContent = text.substring(0, 100);
    updateSendButton();
}

function cancelEdit() {
    editingMessageId = null;
    setMessageInput('');
    showEditBar(false);
}

// Правка: новый текст — сразу в пузыре; не удалось — прежний возвращается.
async function saveEdit(messageId, text) {
    const el = elements.chatMessages.querySelector(`[data-message-id="${messageId}"] .message-text`);
    const before = el ? messageTextOf(el) : null;
    const setText = value => {
        if (!el) return;
        const spacer = el.querySelector('.meta-spacer');
        renderMessageText(el, value);
        if (spacer) el.appendChild(spacer);
    };
    editingMessageId = null;
    setMessageInput('');
    showEditBar(false);
    setText(text);
    const data = await api(`/api/messages/${messageId}`, { method: 'PUT', body: JSON.stringify({ text }) });
    if (!data.success) {
        if (before !== null) setText(before);
        showToast(data.message || 'Не удалось изменить сообщение', 'error');
    }
}

// Свой пузырь, пока сообщение не принято сервером.
function appendSendingBubble(chatId, { clientId, text, reply, from = null }) {
    if (chatId !== currentChatId) return;
    const local = {
        client_id: clientId, user_id: currentUser.id, sent: 1, text, message_type: 'text',
        created_at: new Date().toISOString(), status: 'sending', encrypted: !currentChatIsBot,
        reply_to: reply ? { id: reply.id, sender_username: reply.author, text: reply.text } : null,
    };
    const heightBefore = elements.chatMessages.scrollHeight;
    appendMessage(local);
    revealAtBottom(heightBefore, { bubble: sendingBubble(clientId), from });
    jumpQuietUntil = performance.now() + 350;
}

const sendingBubble = clientId => elements.chatMessages.querySelector(`.message[data-client-id="${CSS.escape(clientId)}"]`);

function setBubbleSending(clientId) {
    const bubble = sendingBubble(clientId);
    if (!bubble) return;
    bubble.classList.remove('is-failed');
    bubble.classList.add('is-sending');
    bubble.querySelector('.message-failed')?.remove();
    updateInlineMeta(bubble);
}

// Не отправлено: в пузыре — «Повторить» (тот же clientId) и «Удалить».
function markSendFailed(clientId, retry) {
    const bubble = sendingBubble(clientId);
    if (!bubble) return;
    bubble.classList.remove('is-sending');
    bubble.classList.add('is-failed');
    bubble.querySelector('.message-failed')?.remove();
    const row = document.createElement('div');
    row.className = 'message-failed';
    const label = document.createElement('span');
    label.append(createIcon('i-alert'), 'Не отправлено');
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'link-inline';
    again.textContent = 'Повторить';
    again.addEventListener('click', () => retry());
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'link-inline';
    drop.textContent = 'Удалить';
    drop.addEventListener('click', () => removeMessageElement(bubble));
    row.append(label, ' · ', again, ' · ', drop);
    bubble.querySelector('.message-content')?.appendChild(row);
    updateInlineMeta(bubble);
}

async function deliverText({ chatId, isBot, text, replyToId, clientId }) {
    setBubbleSending(clientId);
    const retry = () => deliverText({ chatId, isBot, text, replyToId, clientId });
    if (isBot) {
        // Бот отвечает на текст, который видит, — единственный чат без
        // шифрования.
        const data = await api('/api/messages', { method: 'POST', body: JSON.stringify({ chatId, text, replyToId, clientId }) })
            .catch(() => ({ success: false, message: 'Нет связи с сервером' }));
        if (!data.success) {
            markSendFailed(clientId, retry);
            return showToast(data.message || 'Сообщение не отправлено', 'error');
        }
        if (chatId === currentChatId) appendMessage({ ...data.message, client_id: clientId });
        playSound('send');
        return;
    }
    // Открытым текстом не уходит никогда.
    if (!e2ee || !e2ee.isReady()) {
        // «Повторить» сначала поднимает шифрование заново.
        const again = async () => {
            if (!e2ee || !e2ee.isReady()) await setupE2EE();
            if (currentChatId) refreshEncryptionBadge(currentChatId, currentChatIsBot);
            retry();
        };
        markSendFailed(clientId, again);
        return reportE2eeUnavailable('Сообщение не отправлено', again);
    }
    const encoded = e2ee.encodeText(text);
    // Нет сети — не «Не отправлено», а часики: сообщение ждёт в той же
    // очереди на устройстве и уходит на connect/online. Дублей не будет:
    // повтор идёт с тем же clientId.
    if (isOffline()) return queueOffline(chatId, encoded, replyToId, clientId);
    try {
        const result = await sendEncryptedPayload(chatId, encoded, { replyToId, clientId });
        if (result.waiting) await queuePending(chatId, encoded, replyToId, result.missing, clientId);
        else playSound('send');
    } catch (error) {
        if (error.network || isOffline()) return queueOffline(chatId, encoded, replyToId, clientId, 1);
        markSendFailed(clientId, retry);
        reportEncryptedSendError('Сообщение не отправлено', chatId, error, retry);
    }
}

const isOffline = () => !navigator.onLine || !socket.connected;

// Сколько раз пробуем дослать без сети, прежде чем сказать «Не отправлено»
// (как в Telegram Web A).
const OFFLINE_ATTEMPTS = 5;

async function queueOffline(chatId, encoded, replyToId, clientId, attempts = 0) {
    const item = {
        localId: `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        chatId, encoded, replyToId, clientId, createdAt: new Date().toISOString(), offline: true, attempts,
    };
    await withPendingLock(async () => e2ee.pending.save([...(await e2ee.pending.list()), item]));
    setBubbleSending(clientId);
}

// Не дослали за OFFLINE_ATTEMPTS или сервер отказал — теперь «Не отправлено».
function giveUpOffline(item, error) {
    const content = e2ee.decodePayload(item.encoded);
    const text = content && content.t === 'text' ? content.body : '';
    const retry = () => deliverText({ chatId: item.chatId, isBot: false, text, replyToId: item.replyToId, clientId: item.clientId });
    markSendFailed(item.clientId, retry);
    if (item.chatId === currentChatId) reportEncryptedSendError('Сообщение не отправлено', item.chatId, error, retry);
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
/*
 * Зашифровать и отправить. { sent: true } — ушло; { waiting: true, missing }
 * — прочитать не сможет ни один собеседник (ни у кого нет устройства с
 * ключами), и сообщение должно подождать на устройстве. Подменённые ключи —
 * исключение: ждать тут нечего, это повод сверить ключи.
 */
// id сообщения, который назначает клиент: повтор отправки (сеть оборвалась,
// «Повторить», ждущее) приходит с тем же id, и сервер отдаёт уже
// сохранённое сообщение вместо второго (migrations/010).
function newClientId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendEncryptedPayload(chatId, encoded, { replyToId = null, blobIds = [], clientId = newClientId() } = {}) {
    const encrypted = await e2ee.encryptForChat(chatId, encoded);
    const { rejected, info } = encrypted;
    const { others } = peersOf(info);
    if (others.length === 0) throw new Error('в чате пока никого нет — сначала пригласите участников');
    const readerUsers = new Set(info.devices
        .filter(d => encrypted.readerIds.includes(d.device_id)).map(d => d.user_id));
    const missingUsers = others.filter(p => !readerUsers.has(p.user_id));
    if (missingUsers.length === others.length) {
        if (rejected.length > 0) throw new Error('ключи устройств собеседника не совпадают с известными');
        return { sent: false, waiting: true, missing: missingUsers };
    }

    // Попарно — конверт с содержимым на каждое устройство; в группе —
    // один шифротекст на всех и ключ только тем, у кого его ещё нет.
    const body = encrypted.mode === 'group'
        ? { chatId, replyToId, blobIds, clientId, group: encrypted.group, keyEnvelopes: encrypted.keyEnvelopes }
        : { chatId, replyToId, blobIds, clientId, envelopes: encrypted.envelopes };
    const data = await api('/api/messages/encrypted', { method: 'POST', body: JSON.stringify(body) });
    if (!data || !data.success) {
        const error = new Error((data && data.message) || 'сервер не принял сообщение');
        error.network = Boolean(data && data.unreachable);
        throw error;
    }
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
        const local = { ...data.message, client_id: clientId };
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
    // Кому из людей не дойдёт совсем — пометка под сообщением, а не
    // молчаливый пропуск. Отдельные устройства без ключей у тех, кому
    // дойдёт, — тостом, как раньше.
    if (missingUsers.length > 0) {
        const names = missingUsers.map(u => u.username);
        await e2ee.rememberUndelivered(data.message.id, names);
        markUndelivered(data.message.id, names);
    } else {
        const missing = [...(data.missingDeviceIds || []), ...encrypted.undelivered]
            .filter(id => id !== e2eeDeviceId && !rejected.includes(id));
        if (missing.length > 0) {
            showToast(`Сообщение не дойдёт до ${devicesGenitive(missing.length)}: нет ключей`, 'error');
        }
    }
    return { sent: true };
}

/* --- Не доставлено и ждущие сообщения ---------------------------------------
   Кому в группе сообщение не ушло (нет ни одного устройства с ключами) —
   видно под ним: «Не доставлено: Пётр — нет ключей». Если не может прочитать
   никто, сообщение ждёт на устройстве («Ждёт ключей собеседника», его можно
   отменить) и уходит само, когда у собеседника появятся ключи: об этом
   сервер сообщает событием peerKeysReady. */

let undeliveredCache = {};

function undeliveredText(names) {
    return `Не доставлено: ${names.join(', ')} — нет ключей`;
}

function markUndelivered(messageId, names) {
    const bubble = elements.chatMessages.querySelector(`.message[data-message-id="${messageId}"]`);
    if (!bubble || bubble.querySelector('.message-undelivered')) return;
    const note = document.createElement('div');
    note.className = 'message-undelivered';
    note.append(createIcon('i-alert'), undeliveredText(names));
    bubble.querySelector('.message-content')?.appendChild(note);
    updateInlineMeta(bubble);
}

async function queuePending(chatId, encoded, replyToId, missing, clientId = newClientId()) {
    const item = {
        localId: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        chatId, encoded, replyToId, clientId, createdAt: new Date().toISOString(),
        waitingFor: missing.map(u => u.username),
    };
    await withPendingLock(async () => e2ee.pending.save([...(await e2ee.pending.list()), item]));
    if (chatId === currentChatId) {
        appendPendingElement(item);
        if (!sendingBubble(clientId)) scrollToBottom();
    }
    showToast(`Нет ключей у ${namesList(missing)} — сообщение отправится, когда они появятся`, 'info');
}

// Две вкладки не должны отправить одно и то же ждущее сообщение дважды.
function withPendingLock(fn) {
    return navigator.locks ? navigator.locks.request('nyxo-pending', fn) : fn();
}

function appendPendingElement(item) {
    if (item.offline) {
        if (item.clientId && sendingBubble(item.clientId)) return;
        const content = e2ee.decodePayload(item.encoded);
        appendMessage({ client_id: item.clientId, user_id: currentUser.id, sent: 1, message_type: 'text', encrypted: true,
            text: content && content.t === 'text' ? content.body : '', created_at: item.createdAt, status: 'sending' });
        return;
    }
    if (elements.chatMessages.querySelector(`[data-pending-id="${item.localId}"]`)) return;
    const content = e2ee.decodePayload(item.encoded);
    const div = document.createElement('div');
    div.className = 'message sent is-pending';
    div.dataset.pendingId = item.localId;
    div.dataset.senderKey = 'me:1';
    div.dataset.at = String(Date.parse(item.createdAt) || 0);
    const body = document.createElement('div');
    body.className = 'message-content';
    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = content && content.t === 'text' ? content.body : '';
    const meta = document.createElement('div');
    meta.className = 'message-meta message-pending';
    const label = document.createElement('span');
    label.append(createIcon('i-timer'), pendingCaption(item.waitingFor || []));
    label.title = item.waitingFor && item.waitingFor.length ? `Нет ключей у ${item.waitingFor.join(', ')}` : '';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'link-inline pending-cancel';
    cancel.textContent = 'Отменить';
    cancel.addEventListener('click', () => cancelPending(item.localId));
    meta.append(label, cancel);
    body.append(text, meta);
    div.appendChild(body);
    const sending = item.clientId && sendingBubble(item.clientId);
    if (sending) sending.replaceWith(div);
    else dayGroup(new Date(item.createdAt), elements.chatMessages).appendChild(div);
    regroupMessages();
}

// Сообщение уходит, когда у собеседника появятся ключи, — то есть когда он
// откроет Nyxo. Отправляет его открытая вкладка: закроешь — уйдёт при
// следующем открытии.
function pendingCaption(names) {
    if (!names.length) return 'Ждёт ключей собеседника. Не закрывайте вкладку';
    return `Уйдёт, когда ${names.join(', ')} ${names.length === 1 ? 'откроет' : 'откроют'} Nyxo. Не закрывайте вкладку`;
}

async function cancelPending(localId) {
    await withPendingLock(async () =>
        e2ee.pending.save((await e2ee.pending.list()).filter(p => p.localId !== localId)));
    const el = elements.chatMessages.querySelector(`[data-pending-id="${localId}"]`);
    if (el) removeMessageElement(el);
    showToast('Сообщение отменено', 'info');
}

async function renderPendingFor(chatId) {
    if (!e2ee || !e2ee.isReady()) return;
    for (const item of await e2ee.pending.list()) {
        if (item.chatId === chatId && currentChatId === chatId) appendPendingElement(item);
    }
}

let flushing = false;
async function flushPending() {
    if (!e2ee || !e2ee.isReady() || flushing) return;
    flushing = true;
    try {
        await withPendingLock(async () => {
            for (const item of await e2ee.pending.list()) {
                if (item.offline && isOffline()) continue;
                let result;
                try {
                    result = await sendEncryptedPayload(item.chatId, item.encoded,
                        { replyToId: item.replyToId, clientId: item.clientId || item.localId.padEnd(16, '0') });
                } catch (error) {
                    if (item.offline) {
                        // Сервер отказал или пятая попытка — «Не отправлено».
                        const attempts = (item.attempts || 0) + 1;
                        const rest = (await e2ee.pending.list()).filter(p => p.localId !== item.localId);
                        if (!error.network || attempts >= OFFLINE_ATTEMPTS) {
                            await e2ee.pending.save(rest);
                            giveUpOffline(item, error);
                        } else {
                            await e2ee.pending.save([...rest, { ...item, attempts }]);
                        }
                        continue;
                    }
                    // Чат удалён, ключи подменены, сеть — сообщение остаётся ждать.
                    console.warn('[E2EE] ждущее сообщение пока не отправлено:', error.message);
                    continue;
                }
                if (item.offline && result.waiting) {
                    // Дошло до сервера, но читать некому — дальше как ждущее ключей.
                    await e2ee.pending.save((await e2ee.pending.list()).filter(p => p.localId !== item.localId));
                    await queuePending(item.chatId, item.encoded, item.replyToId, result.missing, item.clientId);
                    continue;
                }
                if (result.waiting) continue;
                await e2ee.pending.save((await e2ee.pending.list()).filter(p => p.localId !== item.localId));
                const el = elements.chatMessages.querySelector(`[data-pending-id="${item.localId}"]`);
                if (el) removeMessageElement(el);
            }
        });
    } finally {
        flushing = false;
    }
}

function setupPending() {
    socket.on('peerKeysReady', () => {
        flushPending();
        if (currentChatId) refreshEncryptionBadge(currentChatId, currentChatIsBot);
    });
    socket.on('connect', () => flushPending());
    window.addEventListener('online', () => flushPending());
    // Страховка на случай пропущенного события: раз в минуту.
    setInterval(async () => {
        if (e2ee && e2ee.isReady() && (await e2ee.pending.list()).length) flushPending();
    }, 60000);
}

/** «до 1 устройства», «до 5 устройств», «до 21 устройства». */
function devicesGenitive(n) {
    const one = n % 10 === 1 && n % 100 !== 11;
    return `${n} ${one ? 'устройства' : 'устройств'}`;
}

function reportE2eeUnavailable(prefix, retry) {
    showToast(`${prefix}: шифрование на этом устройстве не работает — ${e2eeFailure || 'причина неизвестна'}`,
        'error', { action: retry ? { label: 'Повторить', onClick: retry } : null });
}

function reportEncryptedSendError(prefix, chatId, error, retry = null) {
    console.error('[E2EE] отправка не удалась:', error);
    if (error.code === 'KEY_SERVER_UNAVAILABLE') {
        const code = error.errorId ? `\nКод ошибки: ${error.errorId}` : '';
        showToast(`Шифрование на сервере временно недоступно — ${prefix.toLowerCase()}${code}`, 'error',
            { action: retry ? { label: 'Повторить', onClick: retry } : null });
        return;
    }
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
async function sendEncryptedFile(chatId, file, progress = silentProgress) {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('файл больше 50 МБ');

    progress.phase('шифруем…');
    progress.note('Автор и дата из файла удалены, шифруется');
    const quality = document.querySelector('input[name="photo-quality"]:checked')?.value || 'normal';
    const { ciphertext, meta } = await e2ee.encryptAttachment(file, { quality });
    progress.check();

    const { status, data: uploaded } = await uploadWithProgress(`/api/blobs?chatId=${encodeURIComponent(chatId)}`,
        ciphertext, { 'Content-Type': 'application/octet-stream' }, progress);
    if (!uploaded || !uploaded.success) {
        throw new Error((uploaded && uploaded.message) || `загрузка не удалась (${status})`);
    }

    // Байты уже на сервере — дальше отменять нечего.
    progress.phase('отправляем…', { cancellable: false });
    const result = await sendEncryptedPayload(chatId, e2ee.encodeFile({ blob: uploaded.blobId, ...meta }), {
        blobIds: [uploaded.blobId],
    });
    // Между проверкой и отправкой ключи собеседника могли пропасть. Файл при
    // этом уже загружен — его уберёт уборщик, а пользователю говорим прямо.
    if (!result.sent) throw new Error('в чате больше не для кого шифровать');
}

/*
 * Загрузка с прогрессом. У fetch нет событий отправки тела, поэтому здесь
 * XMLHttpRequest. Отмена — через progress (кнопка у полоски).
 */
async function uploadWithProgress(url, body, headers, progress) {
    const token = await csrfToken();
    progress.check();
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.setRequestHeader('X-CSRF-Token', token);
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
        xhr.responseType = 'json';
        xhr.upload.addEventListener('progress', event => {
            if (event.lengthComputable) progress.set(event.loaded / event.total);
        });
        xhr.addEventListener('load', () => resolve({ status: xhr.status, data: xhr.response }));
        xhr.addEventListener('error', () => reject(new Error('нет соединения с сервером')));
        xhr.addEventListener('abort', () => reject(new DOMException('отменено', 'AbortError')));
        progress.onCancel(() => xhr.abort());
        xhr.send(body);
    });
}

/* --- Полоска отправки файла --------------------------------------------
   Появляется, только если отправка заметно долгая: у маленького файла она
   бы мигнула. */

let activeUpload = null;
const silentProgress = { set() {}, phase() {}, note() {}, onCancel() {}, check() {}, done() {} };

function startUploadStatus(label) {
    let cancelled = false;
    let cancel = null;
    elements.uploadStatusName.textContent = label;
    elements.uploadStatusNote.textContent = '';
    elements.uploadProgress.removeAttribute('value');
    elements.uploadStatusPercent.textContent = '';
    elements.uploadCancelBtn.hidden = false;
    const timer = setTimeout(() => { elements.uploadStatus.hidden = false; }, 250);
    activeUpload = { cancel() { cancelled = true; if (cancel) cancel(); } };
    return {
        set(fraction) {
            const percent = Math.round(fraction * 100);
            elements.uploadProgress.value = percent;
            elements.uploadStatusPercent.textContent = `${percent}%`;
        },
        phase(text, { cancellable = true } = {}) {
            elements.uploadProgress.removeAttribute('value');
            elements.uploadStatusPercent.textContent = text;
            elements.uploadCancelBtn.hidden = !cancellable;
        },
        note(text) {
            elements.uploadStatusNote.textContent = text;
        },
        onCancel(fn) {
            cancel = fn;
            if (cancelled) fn();
        },
        check() {
            if (cancelled) throw new DOMException('отменено', 'AbortError');
        },
        done() {
            clearTimeout(timer);
            elements.uploadStatus.hidden = true;
            activeUpload = null;
        },
    };
}

const MAX_FILES_AT_ONCE = 10;
let sendingFiles = Promise.resolve();

function handleFileUpload() {
    const files = [...elements.fileInput.files];
    elements.fileInput.value = '';
    sendFiles(files);
}

// Файлы уходят по одному, в том порядке, в каком их выбрали. Отмена
// останавливает и те, что ещё ждут очереди.
function sendFiles(files) {
    const chatId = currentChatId;
    if (!files.length || !chatId) return sendingFiles;
    if (files.length > MAX_FILES_AT_ONCE) {
        showToast(`За раз — не больше ${MAX_FILES_AT_ONCE} файлов`, 'error');
        return sendingFiles;
    }
    sendingFiles = sendingFiles.then(async () => {
        for (const [i, file] of files.entries()) {
            const label = files.length > 1 ? `${file.name} (${i + 1} из ${files.length})` : file.name;
            if (!(await sendFile(chatId, file, label))) break;
        }
    }).catch(error => console.error('Ошибка отправки файла:', error));
    return sendingFiles;
}

// false — отправку отменили.
async function sendFile(chatId, file, label) {
    const progress = startUploadStatus(label);
    const cancelled = error => {
        if (error && error.name !== 'AbortError') return false;
        showToast('Отправка отменена', 'info');
        return true;
    };
    try {
        // Открытый путь — только у бота. Во всех остальных чатах файл
        // уходит зашифрованным или не уходит вовсе.
        const meta = chatsMeta.get(chatId);
        if (!(meta ? meta.is_bot : currentChatIsBot)) {
            if (!e2ee || !e2ee.isReady()) {
                reportE2eeUnavailable('Файл не отправлен', null);
                return true;
            }
            // Файл не ждёт ключей, как текст: он уже был бы загружен на
            // сервер. Прочитать некому — не отправляем.
            const { others, withoutDevices } = peersOf(await chatDevices(chatId));
            if (others.length > 0 && withoutDevices.length === others.length) {
                showToast(`Файл не отправлен. ${noKeysText(withoutDevices)}`, 'error');
                return true;
            }
            try {
                await sendEncryptedFile(chatId, file, progress);
            } catch (error) {
                if (cancelled(error)) return false;
                reportEncryptedSendError('Файл не отправлен', chatId, error);
            }
            return true;
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
                return true;
            }
        }

        const formData = new FormData();
        formData.append('file', upload, uploadName);
        formData.append('chatId', chatId);
        try {
            const { data } = await uploadWithProgress('/api/messages/file', formData, {}, progress);
            if (!data || !data.success) showToast((data && data.message) || 'Файл не отправлен', 'error');
        } catch (error) {
            if (cancelled(error)) return false;
            showToast(`Файл не отправлен: ${error.message}`, 'error');
        }
        return true;
    } finally {
        progress.done();
    }
}

/* --- Вставка и перетаскивание файлов ------------------------------------
   Вставленное из буфера и брошенное в окно отправляется после
   подтверждения: скриншот, вставленный по ошибке, не должен улететь сам. */

let filesToConfirm = [];

function confirmFiles(files) {
    if (!currentChatId || !files.length) return;
    if (currentRoomIsEmpty()) return showToast('В чате пока никого нет — сначала пригласите участников', 'error');
    filesToConfirm = files;
    elements.sendFilesTitle.textContent = files.length === 1 ? 'Отправить файл?'
        : `Отправить ${files.length} ${['файл', 'файла', 'файлов'][pluralForm(files.length)]}?`;
    elements.sendFilesList.replaceChildren(...files.map(file => {
        const li = document.createElement('li');
        li.textContent = `${file.name || 'Файл'} · ${formatSize(file.size)}`;
        return li;
    }));
    // Выбор сжатия — если есть фото и чат шифрованный (боту файл уходит как есть).
    document.getElementById('send-files-quality').hidden = currentChatIsBot
        || !files.some(f => /^image\/(jpeg|png|webp|heic|heif|avif)$/.test(f.type));
    openModal(elements.sendFilesModal);
    elements.sendFilesConfirm.focus();
}

function setupComposer() {
    elements.messageInput.addEventListener('input', autosizeMessageInput);
    elements.messageInput.enterKeyHint = coarsePointer() ? 'enter' : 'send';
    elements.uploadCancelBtn.addEventListener('click', () => { if (activeUpload) activeUpload.cancel(); });

    elements.sendFilesConfirm.addEventListener('click', () => {
        const files = filesToConfirm;
        filesToConfirm = [];
        closeModal(elements.sendFilesModal);
        sendFiles(files);
    });
    elements.sendFilesCancel.addEventListener('click', () => closeModal(elements.sendFilesModal));
    elements.sendFilesModal.addEventListener('close', () => { filesToConfirm = []; });

    elements.messageInput.addEventListener('paste', event => {
        const files = [...((event.clipboardData && event.clipboardData.files) || [])];
        if (!files.length) return;
        event.preventDefault();
        confirmFiles(files);
    });

    const hasFiles = event => Boolean(event.dataTransfer) && [...event.dataTransfer.types].includes('Files');
    const area = elements.mainContent;
    let depth = 0;
    area.addEventListener('dragenter', event => {
        if (!hasFiles(event) || !currentChatId) return;
        event.preventDefault();
        depth++;
        // Имена файлов до броска браузер не показывает — только сколько их.
        const count = [...event.dataTransfer.items].filter(item => item.kind === 'file').length;
        elements.dropZoneCount.textContent = count > 1
            ? `Отпустите, чтобы отправить ${count} ${['файл', 'файла', 'файлов'][pluralForm(count)]}`
            : 'Отпустите, чтобы отправить';
        elements.dropZone.hidden = false;
    });
    area.addEventListener('dragover', event => {
        if (!hasFiles(event) || !currentChatId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    });
    area.addEventListener('dragleave', event => {
        if (!hasFiles(event)) return;
        depth = Math.max(0, depth - 1);
        if (!depth) elements.dropZone.hidden = true;
    });
    area.addEventListener('drop', event => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth = 0;
        elements.dropZone.hidden = true;
        confirmFiles([...event.dataTransfer.files]);
    });
    // Брошенный мимо файл браузер открыл бы вместо мессенджера.
    window.addEventListener('dragover', event => { if (hasFiles(event)) event.preventDefault(); });
    window.addEventListener('drop', event => { if (hasFiles(event)) event.preventDefault(); });
}

// Поле растёт вместе с текстом — до шести строк, дальше прокручивается.
function autosizeMessageInput() {
    const input = elements.messageInput;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight + 2, 168)}px`;
}

function setMessageInput(value) {
    elements.messageInput.value = value;
    autosizeMessageInput();
    updateSendButton();
    updateMessageCounter();
}

const SEND_BUTTON = {
    attach: 'Прикрепить файл',
    send: 'Отправить',
    save: 'Сохранить изменения',
};
function updateSendButton() {
    const mode = editingMessageId ? 'save' : elements.messageInput.value.trim() ? 'send' : 'attach';
    const button = elements.sendBtn;
    if (button.dataset.mode === mode) return;
    button.dataset.mode = mode;
    button.title = SEND_BUTTON[mode];
    button.setAttribute('aria-label', SEND_BUTTON[mode]);
    updateMessageCounter();
}

/* --- Ширина списка чатов ------------------------------------------------
   Границу тянут мышью или стрелками (Shift — шагом крупнее), Home — самый
   узкий, End — самый широкий, Enter и двойной щелчок — по умолчанию. Уже
   160px список сворачивается в компактный: 76px, только аватары.
   Ширина запоминается в этом браузере. На телефоне списка сбоку нет. */

const SIDEBAR = { compact: 76, snap: 160, min: 240, max: 480, fallback: 340, key: 'nyxo-sidebar-width' };

function applySidebarWidth(width, { save = true } = {}) {
    const compact = width < SIDEBAR.snap;
    const value = compact ? SIDEBAR.compact : Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, Math.round(width)));
    elements.sidebar.classList.toggle('is-compact', compact);
    elements.sidebar.style.setProperty('--sidebar-w', `${value}px`);
    elements.sidebarResizer.setAttribute('aria-valuenow', String(value));
    elements.sidebarResizer.setAttribute('aria-valuetext', compact ? 'Компактный список' : `${value} пикселей`);
    if (!compact) elements.compactTip.hidden = true;
    if (save) {
        try { localStorage.setItem(SIDEBAR.key, String(value)); } catch { /* не запомнится — не беда */ }
    }
}

/* --- Список чатов с клавиатуры и подсказка узкого списка -----------------
   Весь список — одна остановка Tab: фокус на открытом (или первом) чате,
   стрелки ходят по чатам, Enter и пробел открывают. В узком списке у чата
   под мышью или в фокусе — подсказка «Название · время». */

function refreshChatListTabStop() {
    const items = [...elements.chatsList.querySelectorAll('.chat-item')];
    const focused = items.find(item => item === document.activeElement);
    const target = focused || items.find(item => item.classList.contains('active')) || items[0];
    for (const item of items) item.tabIndex = item === target ? 0 : -1;
}

function showCompactTip(item) {
    const tip = elements.compactTip;
    if (!elements.sidebar.classList.contains('is-compact') || !item) {
        tip.hidden = true;
        return;
    }
    const name = item.querySelector('.chat-name')?.textContent || '';
    const time = item.querySelector('.chat-time')?.textContent || '';
    tip.textContent = time ? `${name} · ${time}` : name;
    tip.hidden = false;
    const r = item.getBoundingClientRect();
    tip.style.left = `${Math.round(r.right + 8)}px`;
    tip.style.top = `${Math.round(r.top + r.height / 2 - tip.offsetHeight / 2)}px`;
}

function setupChatListKeyboard() {
    const list = elements.chatsList;
    list.addEventListener('keydown', event => {
        const item = event.target.closest && event.target.closest('.chat-item');
        if (!item) return;
        const items = [...list.querySelectorAll('.chat-item')];
        const index = items.indexOf(item);
        let next = null;
        if (event.key === 'ArrowDown') next = items[index + 1];
        else if (event.key === 'ArrowUp') next = items[index - 1];
        else if (event.key === 'Home') next = items[0];
        else if (event.key === 'End') next = items[items.length - 1];
        else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            item.click();
            return;
        } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const r = item.getBoundingClientRect();
            openChatItemMenu(item, r.left + 24, r.bottom - 8);
            return;
        }
        // Alt+Shift+↑/↓ — переставить закреплённый (Alt+↑/↓ — соседний чат).
        if (event.altKey && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && item.classList.contains('is-pinned')) {
            event.preventDefault();
            movePinned(Number(item.dataset.id), event.key === 'ArrowUp' ? -1 : 1);
            return;
        }
        if (!next) return;
        event.preventDefault();
        item.tabIndex = -1;
        next.tabIndex = 0;
        next.focus();
    });
    list.addEventListener('mouseover', event => showCompactTip(event.target.closest && event.target.closest('.chat-item')));
    list.addEventListener('mouseleave', () => { elements.compactTip.hidden = true; });
    list.addEventListener('focusin', event => showCompactTip(event.target.closest && event.target.closest('.chat-item')));
    list.addEventListener('focusout', () => { elements.compactTip.hidden = true; });
    list.addEventListener('scroll', () => { elements.compactTip.hidden = true; }, { passive: true });
}

function setupSidebarResize() {
    const handle = elements.sidebarResizer;
    let saved = null;
    try { saved = Number(localStorage.getItem(SIDEBAR.key)) || null; } catch { /* хранилище недоступно */ }
    if (saved) applySidebarWidth(saved, { save: false });
    const current = () => Number(handle.getAttribute('aria-valuenow')) || SIDEBAR.fallback;

    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        const left = elements.sidebar.getBoundingClientRect().left;
        document.body.classList.add('is-resizing');
        const move = e => applySidebarWidth(e.clientX - left, { save: false });
        const stop = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', stop);
            handle.removeEventListener('pointercancel', stop);
            document.body.classList.remove('is-resizing');
            applySidebarWidth(current());
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', stop);
        handle.addEventListener('pointercancel', stop);
    });
    handle.addEventListener('dblclick', () => applySidebarWidth(SIDEBAR.fallback));
    handle.addEventListener('keydown', event => {
        const now = current();
        const step = event.shiftKey ? 64 : 16;
        let next = null;
        if (event.key === 'ArrowLeft') next = now <= SIDEBAR.min ? 0 : Math.max(SIDEBAR.min, now - step);
        else if (event.key === 'ArrowRight') next = now < SIDEBAR.min ? SIDEBAR.min : now + step;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = SIDEBAR.max;
        else if (event.key === 'Enter') next = SIDEBAR.fallback;
        if (next === null) return;
        event.preventDefault();
        applySidebarWidth(next);
    });
}

/* --- Уведомления --------------------------------------------------------
   Через service worker (registration.showNotification): Chrome на Android
   и Safari на iPhone по-другому не показывают. У каждого чата свой tag
   (chat:<id>) — новое сообщение другого чата не затирает прежнее, а
   renotify звенит и при замене. Прочитали чат — его уведомления
   закрываются. Что показывать — выбирает человек: ничего («Новое
   сообщение»), имя или имя и текст; по умолчанию — ничего: уведомление
   видно на заблокированном экране.

   Когда Nyxo закрыт — Web Push (lib/push.js): пустой, без текста и чата,
   service worker показывает «Новое сообщение». Включается тем же
   переключателем; на iPhone — только из приложения на экране «Домой». */

const NOTIFY_KEY = 'nyxo-notify';
const NOTIFY_CONTENT_KEY = 'nyxo-notify-content';

function notificationsOn() {
    try {
        return 'Notification' in window && Notification.permission === 'granted' && localStorage.getItem(NOTIFY_KEY) === '1';
    } catch {
        return false;
    }
}

function notifyContent() {
    try {
        const value = localStorage.getItem(NOTIFY_CONTENT_KEY);
        return ['name', 'full'].includes(value) ? value : 'none';
    } catch {
        return 'none';
    }
}

// iPhone и iPad (iPadOS выдаёт себя за Mac, но у Mac нет касаний).
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const SEND_KEY = 'nyxo-send-key';
function sendKey() {
    try { return localStorage.getItem(SEND_KEY) === 'ctrl' ? 'ctrl' : 'enter'; } catch { return 'enter'; }
}

/*
 * Клавиатура на компьютере:
 *   - открыли чат — фокус в поле (на телефоне — нет: открылась бы
 *     клавиатура);
 *   - буква, набранная вне поля, попадает в поле;
 *   - Ctrl/Cmd+↑/↓ в пустом поле — ответ на предыдущее / следующее;
 *   - Ctrl/Cmd+K или «/» — поиск чатов;
 *   - Alt+↑/↓ — соседний чат (закреплённые переставляются Alt+Shift+↑/↓);
 *   - «Отправка: Enter / Ctrl+Enter» — в настройках.
 */
const isEditable = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
function setupKeyboardShortcuts() {
    for (const radio of document.querySelectorAll('input[name="send-key"]')) {
        radio.checked = radio.value === sendKey();
        radio.addEventListener('change', () => {
            try { localStorage.setItem(SEND_KEY, radio.value); } catch { /* не сохранится */ }
        });
    }
    document.addEventListener('keydown', event => {
        if (!currentUser || event.defaultPrevented || event.isComposing) return;
        const target = event.target;
        const mod = event.ctrlKey || event.metaKey;
        const modalOpen = document.querySelector('dialog[open]');
        if (mod && !event.altKey && event.key.toLowerCase() === 'k' || (!mod && !event.altKey && event.key === '/' && !isEditable(target) && !modalOpen)) {
            event.preventDefault();
            elements.searchInput.focus();
            elements.searchInput.select();
            return;
        }
        if (mod && !event.altKey && event.key.toLowerCase() === 'f' && currentChatId && !modalOpen) {
            event.preventDefault();
            openChatSearch();
            return;
        }
        if (event.altKey && !event.shiftKey && !mod && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && !modalOpen) {
            const items = [...elements.chatsList.querySelectorAll('.chat-item[data-id]')];
            const index = items.findIndex(i => Number(i.dataset.id) === Number(currentChatId));
            const next = items[index === -1 ? 0 : index + (event.key === 'ArrowUp' ? -1 : 1)];
            if (next) {
                event.preventDefault();
                next.click();
            }
            return;
        }
        // Буква вне поля — в поле.
        if (currentChatId && !modalOpen && !mod && !event.altKey && event.key.length === 1 && !isEditable(target)
            && !(event.key === ' ' && target.closest && target.closest('button, [role="button"], .chat-item, .message'))
            && !elements.messageInputContainer.classList.contains('hidden') && !elements.messageInput.disabled
            && !document.querySelector('.context-menu:popover-open') && !coarsePointer()) {
            elements.messageInput.focus();
        }
    });
}

// Ответить на соседнее: step −1 — старше, +1 — новее; дальше последнего — без ответа.
function stepReply(step) {
    const bubbles = [...elements.chatMessages.querySelectorAll('.message[data-message-id]')].filter(b => !b.hidden && !b.classList.contains('is-removing'));
    if (!bubbles.length) return;
    const index = replyToMessageId ? bubbles.findIndex(b => Number(b.dataset.messageId) === Number(replyToMessageId)) : bubbles.length;
    const next = bubbles[index + step];
    if (!next) {
        if (step > 0) clearReply();
        return;
    }
    const message = messageFromBubble(next);
    startReply(message);
    next.scrollIntoView({ block: 'nearest' });
}

function messageFromBubble(bubble) {
    const own = bubble.classList.contains('sent');
    return {
        id: Number(bubble.dataset.messageId),
        user_id: own ? currentUser.id : null,
        author: own ? 'Вы' : bubble.dataset.sender || '',
        sender_username: own ? currentUser.username : bubble.dataset.sender || '',
        text: messageTextOf(bubble.querySelector('.message-text')),
    };
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        showToast('Скопировано', 'success');
    } catch {
        showToast('Браузер не дал скопировать', 'error');
    }
}

/*
 * Выбор нескольких: «Выбрать» в меню сообщения, дальше касание или щелчок
 * отмечают сообщения; внизу — «Удалить N» и «Копировать». На компьютере
 * Shift+щелчок — диапазон, Ctrl/Cmd+C — копировать с именами, Delete —
 * удалить, Esc — выйти.
 */
const selectedIds = new Set();
let selectionAnchor = null;
const selecting = () => elements.chatMessages.classList.contains('is-selecting');

function startSelection(bubble) {
    elements.chatMessages.classList.add('is-selecting');
    selectedIds.clear();
    toggleSelected(bubble, true);
}

function stopSelection() {
    elements.chatMessages.classList.remove('is-selecting');
    for (const el of elements.chatMessages.querySelectorAll('.message.is-selected')) el.classList.remove('is-selected');
    selectedIds.clear();
    selectionAnchor = null;
    renderSelectionBar();
}

function toggleSelected(bubble, on = !bubble.classList.contains('is-selected')) {
    const id = Number(bubble.dataset.messageId);
    if (!id) return;
    bubble.classList.toggle('is-selected', on);
    bubble.setAttribute('aria-selected', String(on));
    if (on) selectedIds.add(id);
    else selectedIds.delete(id);
    selectionAnchor = bubble;
    renderSelectionBar();
}

function renderSelectionBar() {
    const bar = document.getElementById('selection-bar');
    const n = selectedIds.size;
    bar.hidden = !selecting();
    elements.messageInputContainer.classList.toggle('is-covered', selecting());
    document.getElementById('selection-count').textContent = `${n} ${['сообщение', 'сообщения', 'сообщений'][pluralForm(n)]}`;
    const own = selectedBubbles().filter(b => b.classList.contains('sent')).length;
    const del = document.getElementById('selection-delete');
    del.textContent = own ? `Удалить ${own}` : 'Удалить';
    del.disabled = own === 0;
    if (selecting() && n === 0) stopSelection();
}

function selectedBubbles() {
    return [...elements.chatMessages.querySelectorAll('.message.is-selected[data-message-id]')];
}

function selectionText() {
    return selectedBubbles().map(b => {
        const time = b.querySelector('.message-time')?.textContent || '';
        const who = b.classList.contains('sent') ? (currentUser && currentUser.username) || 'Вы' : b.dataset.sender || '';
        return `[${time}] ${who}: ${messageTextOf(b.querySelector('.message-text')) || (b.querySelector('.encrypted-attachment, .message-image') ? '[вложение]' : '')}`;
    }).join('\n');
}

function deleteSelected() {
    const own = selectedBubbles().filter(b => b.classList.contains('sent')).map(b => b.dataset.messageId);
    const others = selectedIds.size - own.length;
    stopSelection();
    for (const id of own) scheduleDelete(id);
    if (others) showToast('Чужие сообщения удалить нельзя — удалены только ваши', 'info');
}

function setupSelection() {
    elements.chatMessages.addEventListener('click', event => {
        if (!selecting()) return;
        const bubble = event.target.closest('.message[data-message-id]');
        if (!bubble) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey && selectionAnchor) {
            const all = [...elements.chatMessages.querySelectorAll('.message[data-message-id]')];
            const [a, b] = [all.indexOf(selectionAnchor), all.indexOf(bubble)].sort((x, y) => x - y);
            for (const el of all.slice(a, b + 1)) toggleSelected(el, true);
            return;
        }
        toggleSelected(bubble);
    }, true);
    document.getElementById('selection-cancel').addEventListener('click', stopSelection);
    document.getElementById('selection-copy').addEventListener('click', async () => {
        await copyText(selectionText());
        stopSelection();
    });
    document.getElementById('selection-delete').addEventListener('click', deleteSelected);
    document.addEventListener('keydown', event => {
        if (!selecting()) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            stopSelection();
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !String(window.getSelection())) {
            event.preventDefault();
            copyText(selectionText());
        } else if (event.key === 'Delete' && !isEditable(event.target)) {
            event.preventDefault();
            deleteSelected();
        }
    });
}

/*
 * Поиск по сообщениям — на устройстве, в расшифрованном (сервер по
 * зашифрованному искать не может). Результаты листаются ↑/↓ и Enter,
 * каждый открывается срезом вокруг найденного (around).
 */
const chatSearch = { results: [], index: -1, timer: null };
function openChatSearch() {
    const box = document.getElementById('chat-search');
    box.hidden = false;
    const input = document.getElementById('chat-search-input');
    input.focus();
    input.select();
}
function closeChatSearch() {
    document.getElementById('chat-search').hidden = true;
    document.getElementById('chat-search-input').value = '';
    Object.assign(chatSearch, { results: [], index: -1 });
    document.getElementById('chat-search-count').textContent = '';
}
async function runChatSearch() {
    const query = document.getElementById('chat-search-input').value;
    const count = document.getElementById('chat-search-count');
    const chat = currentChatMeta();
    if (!query.trim() || !chat || !e2ee || !e2ee.isReady()) {
        Object.assign(chatSearch, { results: [], index: -1 });
        count.textContent = '';
        return;
    }
    const results = await e2ee.searchChat(chat, query);
    if (document.getElementById('chat-search-input').value !== query) return;
    Object.assign(chatSearch, { results, index: results.length ? 0 : -1 });
    showSearchResult();
}
function showSearchResult() {
    const count = document.getElementById('chat-search-count');
    const { results, index } = chatSearch;
    count.textContent = results.length ? `${index + 1} из ${results.length}` : 'Ничего';
    if (index >= 0) goToMessage(results[index]);
}
function stepSearch(step) {
    if (!chatSearch.results.length) return;
    // ↑ — раньше (дальше в прошлое), ↓ — позже.
    chatSearch.index = Math.min(chatSearch.results.length - 1, Math.max(0, chatSearch.index + (step < 0 ? 1 : -1)));
    showSearchResult();
}
function setupChatSearch() {
    const input = document.getElementById('chat-search-input');
    document.getElementById('chat-search-btn').addEventListener('click', openChatSearch);
    document.getElementById('chat-search-close').addEventListener('click', closeChatSearch);
    document.getElementById('chat-search-up').addEventListener('click', () => stepSearch(-1));
    document.getElementById('chat-search-down').addEventListener('click', () => stepSearch(1));
    input.addEventListener('input', () => {
        clearTimeout(chatSearch.timer);
        chatSearch.timer = setTimeout(runChatSearch, 250);
    });
    input.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeChatSearch();
            elements.messageInput.focus({ preventScroll: true });
        } else if (event.key === 'ArrowUp' || (event.key === 'Enter' && !event.shiftKey)) {
            event.preventDefault();
            stepSearch(-1);
        } else if (event.key === 'ArrowDown' || (event.key === 'Enter' && event.shiftKey)) {
            event.preventDefault();
            stepSearch(1);
        }
    });
}

/*
 * Экран приватности (по желанию): свернули Nyxo — ленту закрывает
 * сплошная плашка со знаком. Попадёт ли она в снимок переключателя
 * приложений, решает система: iOS снимает экран при уходе, и плашка
 * успевает; проверять на устройстве.
 */
const PRIVACY_KEY = 'nyxo-privacy-cover';
function privacyCoverOn() {
    try { return localStorage.getItem(PRIVACY_KEY) === '1'; } catch { return false; }
}
function setupPrivacyCover() {
    const cover = document.getElementById('privacy-cover');
    const toggle = document.getElementById('privacy-cover-toggle');
    toggle.checked = privacyCoverOn();
    toggle.addEventListener('change', () => {
        try { localStorage.setItem(PRIVACY_KEY, toggle.checked ? '1' : '0'); } catch { /* не сохранится */ }
    });
    const hide = () => { cover.hidden = true; };
    const show = () => { if (privacyCoverOn() && currentUser) cover.hidden = false; };
    document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? show() : hide()));
    window.addEventListener('pagehide', show);
    window.addEventListener('pageshow', hide);
    // На компьютере окно без фокуса — тоже закрыто (переключение Alt+Tab).
    window.addEventListener('blur', () => { if (mobileLayout.matches) show(); });
    window.addEventListener('focus', hide);
}

function setupHapticsToggle() {
    const toggle = document.getElementById('haptics-toggle');
    toggle.addEventListener('change', () => {
        try { localStorage.setItem('nyxo-haptics', toggle.checked ? '1' : '0'); } catch { /* не сохранится */ }
        if (toggle.checked) haptic('light');
    });
}

function setupStorageWarnings() {
    document.getElementById('storage-persist-btn').addEventListener('click', requestPersistentStorage);
    window.addEventListener('nyxo-db-blocked', () =>
        showToast('Закройте другие вкладки Nyxo — они мешают обновить хранилище ключей', 'error'));
    window.addEventListener('nyxo-db-outdated', () =>
        showToast('Nyxo обновился в другой вкладке', 'info', { duration: 60_000, action: { label: 'Перезагрузить', onClick: () => location.reload() } }));
}

function setupNotifications() {
    const toggle = elements.notifyToggle;
    if (!('Notification' in window)) {
        toggle.disabled = true;
        // На iPhone в Safari уведомлений нет вовсе — только у приложения на
        // экране «Домой».
        if (isIOS && !isStandalone()) showPushStatus('На iPhone уведомления работают только в приложении: «Поделиться» → «На экран „Домой“», потом откройте Nyxo оттуда.');
    }
    toggle.addEventListener('change', async () => {
        // Разрешение — только по нажатию: Safari иначе не спросит.
        if (toggle.checked && await Notification.requestPermission() !== 'granted') {
            toggle.checked = false;
            return showToast('Браузер не разрешил уведомления — это меняется в настройках сайта', 'error');
        }
        try {
            localStorage.setItem(NOTIFY_KEY, toggle.checked ? '1' : '0');
        } catch {
            toggle.checked = false;
            return showToast('Браузер не даёт сохранить настройку', 'error');
        }
        if (toggle.checked) await subscribePush();
        else await unsubscribePush();
        showToast(toggle.checked ? 'Уведомления включены' : 'Уведомления выключены', 'success');
    });
    for (const radio of document.querySelectorAll('input[name="notify-content"]')) {
        radio.checked = radio.value === notifyContent();
        radio.addEventListener('change', () => {
            try { localStorage.setItem(NOTIFY_CONTENT_KEY, radio.value); } catch { /* хранилище недоступно */ }
        });
    }
}

function showPushStatus(text) {
    const line = document.getElementById('push-status');
    line.textContent = text || '';
    line.hidden = !text;
}

/* Web Push: подписка браузера → адрес его службы уведомлений на сервер. */
async function subscribePush() {
    const registration = await serviceWorkerReady();
    if (!registration || !('PushManager' in window)) {
        showPushStatus(isIOS && !isStandalone()
            ? 'Когда Nyxo закрыт, уведомлений не будет: на iPhone это работает только в приложении на экране «Домой».'
            : 'Когда Nyxo закрыт, уведомлений не будет: этот браузер не умеет push.');
        return false;
    }
    try {
        const key = await api('/api/push/key');
        if (!key.success) throw new Error(key.message);
        const applicationServerKey = Uint8Array.from(atob(key.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        let subscription = await registration.pushManager.getSubscription();
        // Подписка на другой ключ сервера (ключ сменили) — не годится.
        if (subscription && subscription.options.applicationServerKey
            && btoa(String.fromCharCode(...new Uint8Array(subscription.options.applicationServerKey))) !== btoa(String.fromCharCode(...applicationServerKey))) {
            await subscription.unsubscribe();
            subscription = null;
        }
        subscription = subscription || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        const saved = await api('/api/push/subscription', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) });
        if (!saved.success) throw new Error(saved.message);
        showPushStatus('');
        return true;
    } catch (error) {
        console.warn('Push не включился:', error);
        showPushStatus('Когда Nyxo закрыт, уведомлений не будет: push не включился.');
        return false;
    }
}

async function unsubscribePush() {
    try {
        const registration = await serviceWorkerReady();
        const subscription = registration && await registration.pushManager?.getSubscription();
        if (!subscription) return;
        await api('/api/push/subscription', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => {});
        await subscription.unsubscribe();
    } catch {
        // Не вышло — сервер забудет подписку, когда служба ответит 410.
    }
}

function chatOfMessage(message) {
    return [...chatsMeta.values()].find(c => (message.room_id ? Number(c.room_id) === Number(message.room_id)
        : c.id === Number(message.chat_id)));
}

/**
 * Уведомление о новом сообщении. preview — расшифрованный текст (если
 * есть). На компьютере — когда окно не в фокусе; открытый чат на экране —
 * без уведомления.
 */
async function notifyNewMessage(message, preview = '') {
    if (!notificationsOn() || isOwnMessage(message) || message.message_type === 'system') return;
    const chat = chatOfMessage(message);
    if (!chat || chat.muted) return;
    if (isForOpenChat(message) && document.visibilityState === 'visible' && document.hasFocus()) return;
    const content = notifyContent();
    const author = message.sender_username || '';
    let title = 'Nyxo';
    let body = 'Новое сообщение';
    if (content !== 'none') {
        title = chat.name || author || 'Nyxo';
        if (content === 'full' && preview) body = chat.kind === 'group' && author ? `${author}: ${preview}` : preview;
    }
    const options = { body, tag: `chat:${chat.id}`, renotify: true, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { chatId: chat.id } };
    const registration = await serviceWorkerReady();
    if (registration) {
        try {
            await registration.showNotification(title, options);
            return;
        } catch {
            // Не дали — пробуем по-старому, из страницы.
        }
    }
    try {
        const notification = new Notification(title, options);
        notification.addEventListener('click', () => {
            window.focus();
            openChatById(chat.id);
            notification.close();
        });
    } catch {
        // Без service worker тут уведомления не умеют — ничего не поделать.
    }
}

/** Чат прочитан — его уведомления больше не нужны; прочитано всё — и push. */
async function closeChatNotifications(chatId) {
    const registration = await serviceWorkerReady();
    if (!registration || !registration.getNotifications) return;
    const list = await registration.getNotifications(chatId ? { tag: `chat:${chatId}` } : {}).catch(() => []);
    for (const n of list) n.close();
}

function openChatById(chatId) {
    const item = elements.chatsList.querySelector(`.chat-item[data-id="${Number(chatId)}"]`);
    if (item && Number(currentChatId) !== Number(chatId)) item.click();
}

/* --- Service worker -----------------------------------------------------------
   public/sw.js — уведомления, push и «Поделиться»; ничего не кэширует.
   Новая версия ждёт: тост «Обновить», и только по нажатию она включается
   и страница перезагружается. Без HTTPS (например, .onion по HTTP в
   обычном браузере) service worker'а нет — уведомления тогда по-старому. */

let swRegistrationPromise = null;
function serviceWorkerReady() {
    return swRegistrationPromise || Promise.resolve(null);
}

function setupServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    let acceptedUpdate = false;
    const offerUpdate = worker => showToast('Вышла новая версия Nyxo', 'info', {
        duration: 60_000,
        action: { label: 'Обновить', onClick: () => {
            acceptedUpdate = true;
            worker.postMessage({ type: 'skip-waiting' });
        } },
    });
    swRegistrationPromise = navigator.serviceWorker.register('/sw.js').then(registration => {
        if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
        registration.addEventListener('updatefound', () => {
            const worker = registration.installing;
            worker?.addEventListener('statechange', () => {
                // Первая установка (контроллера ещё не было) — не обновление.
                if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
            });
        });
        // Вкладку держат открытой днями — проверяем, не вышло ли новое.
        setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000);
        return registration;
    }).catch(error => {
        console.warn('Service worker не установился:', error);
        return null;
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (acceptedUpdate) location.reload();
    });
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data && event.data.type === 'open-chat') openChatById(event.data.chatId);
    });
}

/* --- Запуск по адресу ---------------------------------------------------------
   ?chat=<id> — из уведомления, когда окна не было; ?share=1 — «Поделиться»
   из другого приложения; ?action=new-chat — ярлык приложения. В
   установленном приложении с launch_handler «focus-existing» адрес приходит
   в уже открытое окно через launchQueue. */

async function handleLaunchUrl(href) {
    const url = new URL(href, location.origin);
    const params = url.searchParams;
    if (params.has('chat')) openChatById(params.get('chat'));
    if (params.get('action') === 'new-chat') elements.newChatBtn?.click();
    if (params.get('share') === '1') await receiveShare();
    else if (params.get('share') === 'unavailable') showToast('Не получилось принять — поделитесь ещё раз', 'error');
    if ([...params.keys()].some(k => ['chat', 'action', 'share'].includes(k))) {
        history.replaceState(history.state, '', location.pathname + location.hash);
    }
}

/* «Поделиться»: service worker положил присланное в кэш на один раз
   (public/sw.js). Забираем, стираем и спрашиваем, в какой чат. Текст и
   ссылка встают в поле ввода, файлы — в обычное окно отправки. */
async function receiveShare() {
    let shared = null;
    try {
        const cache = await caches.open('nyxo-share');
        const meta = await cache.match('/__share/meta');
        if (meta) {
            shared = await meta.json();
            shared.files = await Promise.all(shared.files.map(async (f, i) => {
                const blob = await (await cache.match(`/__share/file/${i}`)).blob();
                return new File([blob], f.name || `файл-${i + 1}`, { type: f.type || blob.type });
            }));
        }
        await caches.delete('nyxo-share');
    } catch (error) {
        console.warn('«Поделиться» не прочиталось:', error);
    }
    if (!shared) return;
    const text = [shared.title, shared.text, shared.url].filter(Boolean)
        .filter((part, i, all) => !all.slice(0, i).some(prev => prev.includes(part))).join('\n');
    const chats = [...chatsMeta.values()].filter(c => !c.is_bot && !c.archived);
    if (!chats.length) return showToast('Сначала начните чат — тогда будет куда отправить', 'info');
    const files = shared.files.length;
    document.getElementById('share-summary').textContent = [
        text ? `Текст: «${text.length > 80 ? text.slice(0, 80) + '…' : text}»` : '',
        files ? `${files} ${['файл', 'файла', 'файлов'][pluralForm(files)]}` : '',
    ].filter(Boolean).join(' · ');
    const list = document.getElementById('share-chats');
    list.replaceChildren(...chats.map(chat => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'share-chat';
        const avatar = document.createElement('span');
        avatar.className = 'chat-avatar-small';
        avatar.setAttribute('aria-hidden', 'true');
        paintAvatar(avatar, chat.kind === 'direct' ? chat.peer_avatar : chat.avatar, chat.name);
        const name = document.createElement('span');
        name.textContent = chat.name;
        button.append(avatar, name);
        button.addEventListener('click', async () => {
            closeModal(elements.shareModal);
            openChatById(chat.id);
            // Чат открывается асинхронно — ждём, пока он станет текущим.
            for (let i = 0; i < 50 && Number(currentChatId) !== Number(chat.id); i++) await new Promise(r => setTimeout(r, 50));
            if (text) {
                setMessageInput(text);
                elements.messageInput.focus();
            }
            if (shared.files.length) confirmFiles(shared.files);
        });
        li.appendChild(button);
        return li;
    }));
    openModal(elements.shareModal);
}

let launchHandled = false;
let pushSyncedFor = null;
function handleLaunchOnce() {
    // Push включён — напоминаем серверу адрес подписки: он мог смениться, а
    // в этом браузере мог войти другой аккаунт.
    if (currentUser && pushSyncedFor !== currentUser.id && notificationsOn()) {
        pushSyncedFor = currentUser.id;
        subscribePush();
    }
    if (launchHandled) return;
    launchHandled = true;
    handleLaunchUrl(location.href);
    if ('launchQueue' in window) {
        window.launchQueue.setConsumer(params => { if (params.targetURL) handleLaunchUrl(params.targetURL); });
    }
}

/* --- Новый чат: три пути ----------------------------------------------------
   Сначала выбор — личный чат, группа или вход по приглашению, — потом шаг
   выбранного пути. «Назад» возвращает к выбору. */

const NEW_CHAT_TITLES = {
    choice: 'Новый чат', direct: 'Личный чат', group: 'Новая группа', join: 'Вход по приглашению', sent: 'Вход по приглашению',
};

function showNewChatPane(pane) {
    for (const el of elements.newChatModal.querySelectorAll('[data-pane]')) el.hidden = el.dataset.pane !== pane;
    elements.newChatBack.hidden = pane === 'choice' || pane === 'sent';
    elements.newChatTitle.textContent = NEW_CHAT_TITLES[pane];
    clearFieldErrors(elements.newChatModal);
    const focus = pane === 'direct' ? elements.directCode : pane === 'group' ? elements.newChatName
        : pane === 'join' ? elements.joinChatCode
            : pane === 'sent' ? elements.joinSentClose
                : elements.newChatModal.querySelector('.choice-card:not([hidden])');
    if (focus) focus.focus();
}

function openNewChat(pane = 'choice') {
    resetJoinPreview();
    resetDirectLookup();
    openModal(elements.newChatModal);
    showNewChatPane(pane);
}

// Открыть чат по id — после loadChats(), когда всё о нём уже известно.
function openChatById(chatId) {
    const chat = chatsMeta.get(Number(chatId));
    if (chat) openChat(chat.id, chat.room_id, chat.name, chat.avatar, chat.online, chat.is_bot);
}

async function createChat() {
    clearFieldErrors(elements.newChatModal);
    const input = elements.newChatName;
    const name = input.value.trim();
    if (!name) return setFieldError('new-chat-name', 'Введите название группы');

    const data = await api('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ name }),
    });
    if (data.success) {
        input.value = '';
        closeModal(elements.newChatModal);
        showToast('Группа создана. Теперь позовите участников по ссылке', 'success');
        await loadChats();
        openChatById(data.chat.id);
    } else {
        setFieldError('new-chat-name', data.message);
    }
}

/* --- Вход по ссылке --------------------------------------------------------
   Сначала — куда ведёт ссылка (название, сколько участников, нужно ли
   одобрение), и только вторым нажатием — вход или запрос. Ссылку
   /join#код, открытую в браузере, приложение подставляет само. */

// Код, для которого показан предпросмотр; другой текст в поле — новый предпросмотр.
let joinPreviewFor = null;

function resetJoinPreview() {
    joinPreviewFor = null;
    elements.joinPreview.hidden = true;
    elements.joinChatBtn.textContent = 'Продолжить';
}

function showJoinPreview(preview) {
    const members = `${preview.members} ${['участник', 'участника', 'участников'][pluralForm(preview.members)]}`;
    elements.joinPreviewAvatar.textContent = preview.name.charAt(0).toUpperCase();
    elements.joinPreviewName.textContent = preview.name;
    elements.joinPreviewMeta.textContent = preview.member ? `${members} · вы уже в группе`
        : `${members} · ${preview.require_approval ? 'вход после одобрения администратора' : 'вход сразу'}`;
    elements.joinPreview.hidden = false;
    elements.joinChatBtn.textContent = preview.member ? 'Открыть' : preview.require_approval ? 'Попросить войти' : 'Войти';
}

async function joinChat() {
    clearFieldErrors(elements.newChatModal);
    const input = elements.joinChatCode;
    const code = input.value.trim();
    if (!code) return setFieldError('join-chat-code', 'Вставьте ссылку-приглашение');

    if (joinPreviewFor !== code) {
        const data = await api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code, preview: true }) });
        if (!data.success) return setFieldError('join-chat-code', data.message);
        joinPreviewFor = code;
        showJoinPreview(data.preview);
        return;
    }
    const data = await api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code }) });
    if (!data.success) {
        resetJoinPreview();
        return setFieldError('join-chat-code', data.message);
    }
    input.value = '';
    resetJoinPreview();
    if (data.pending) {
        showJoinSent(data.request);
        loadMyRequests();
        return;
    }
    closeModal(elements.newChatModal);
    await loadChats();
    const chat = chatsMeta.get(Number(data.chat.id));
    showToast(chat ? `Вы в группе «${chat.name}»` : 'Вы в группе', 'success');
    openChatById(data.chat.id);
}

// Ссылка-приглашение, с которой открыли приложение (/join#код). Код
// забирается сразу и из адресной строки убирается: в истории браузера
// ему делать нечего.
const joinCodeFromUrl = location.pathname === '/join' && location.hash.length > 1
    ? decodeURIComponent(location.hash.slice(1)) : '';
if (location.pathname === '/join') history.replaceState(history.state, '', '/');
let joinCodeFromUrlUsed = false;

function offerJoinFromUrl() {
    if (!joinCodeFromUrl || joinCodeFromUrlUsed) return;
    joinCodeFromUrlUsed = true;
    openNewChat('join');
    elements.joinChatCode.value = joinCodeFromUrl;
    withBusy(elements.joinChatBtn, joinChat);
}

/* --- Запрос отправлен ------------------------------------------------------
   Свои ждущие запросы видны над списком чатов, пока их не решат: там же
   их можно отменить. Решение приходит событием joinRequestDecided. */

let sentRequestId = null;
let myRequests = [];

function showJoinSent(request) {
    sentRequestId = request.id;
    elements.joinSentText.textContent = `Вы войдёте в «${request.room_name}», когда администратор группы одобрит запрос. `
        + 'Окно можно закрыть: запрос виден над списком чатов, там же его можно отменить.';
    showNewChatPane('sent');
}

async function loadMyRequests() {
    const data = await api('/api/join-requests');
    if (!data.success) return;
    myRequests = data.requests;
    renderMyRequests();
}

function renderMyRequests() {
    const box = elements.myRequests;
    const rows = [
        ...directRequests.incoming.map(request => requestRowElement('i-user-plus', request.username, 'хочет переписываться', [
            { label: 'Принять', aria: `Принять запрос: ${request.username}`, kind: 'btn-primary', run: () => decideDirectRequest(request, 'accept') },
            { label: 'Отклонить', aria: `Отклонить запрос: ${request.username}`, run: () => decideDirectRequest(request, 'decline') },
            { label: 'Заблокировать', aria: `Заблокировать: ${request.username}`, run: () => decideDirectRequest(request, 'block') },
        ])),
        ...directRequests.outgoing.map(request => requestRowElement('i-timer', request.username, 'запрос на переписку отправлен', [
            { label: 'Отменить', aria: `Отменить запрос: ${request.username}`, run: () => cancelDirectRequest(request) },
        ])),
        ...myRequests.map(request => requestRowElement('i-timer', request.room_name, 'ждёт одобрения', [
            { label: 'Отменить', aria: `Отменить запрос в «${request.room_name}»`, run: () => cancelJoinRequest(request.id) },
        ])),
    ];
    box.hidden = rows.length === 0;
    const title = document.createElement('h4');
    title.className = 'my-requests-title';
    title.textContent = 'Запросы';
    box.replaceChildren(title, ...rows);
}

async function cancelJoinRequest(id) {
    const data = await api(`/api/join-requests/${id}`, { method: 'DELETE' });
    if (!data.success) return showToast(data.message, 'error');
    myRequests = myRequests.filter(r => r.id !== id);
    renderMyRequests();
    showToast('Запрос отменён', 'success');
    return true;
}

async function onJoinRequestDecided({ request_id: requestId, status, room_name: roomName, chat }) {
    myRequests = myRequests.filter(r => r.id !== requestId);
    renderMyRequests();
    const waiting = elements.newChatModal.open && sentRequestId === requestId
        && !elements.newChatModal.querySelector('[data-pane="sent"]').hidden;
    if (waiting) closeModal(elements.newChatModal);
    if (status !== 'approved') {
        showToast(`Запрос в «${roomName}» отклонён`, 'info');
        return;
    }
    await loadChats();
    if (waiting && chat) openChatById(chat.id);
    showToast(`Вас впустили в «${roomName}»`, 'success', chat && !waiting ? {
        duration: 8000, action: { label: 'Открыть', onClick: () => openChatById(chat.id) },
    } : {});
}

/* --- Личный чат: код пользователя ------------------------------------------
   Личный чат начинается с запроса по коду человека (K7Q2-MX9A-4TZB) или по
   QR при встрече. Сначала «Найти» — показать, кто это, — потом «Отправить
   запрос». Если чат с ним уже есть, он просто открывается. */

let directLookupFor = null;

function resetDirectLookup() {
    directLookupFor = null;
    elements.directPreview.hidden = true;
    elements.directFindBtn.textContent = 'Найти';
}

async function findDirect() {
    clearFieldErrors(elements.newChatModal);
    const code = elements.directCode.value.trim();
    if (!code) return setFieldError('direct-code', 'Введите код пользователя');
    if (directLookupFor !== code) {
        const data = await api('/api/contacts/lookup', { method: 'POST', body: JSON.stringify({ code }) });
        if (!data.success) return setFieldError('direct-code', data.message);
        directLookupFor = code;
        elements.directPreviewAvatar.textContent = data.user.username.charAt(0).toUpperCase();
        elements.directPreviewName.textContent = data.user.username;
        elements.directPreviewMeta.textContent = data.chat ? 'чат с ним уже есть' : 'запрос уйдёт без текста — только ваше имя';
        elements.directPreview.hidden = false;
        elements.directFindBtn.textContent = data.chat ? 'Открыть чат' : 'Отправить запрос';
        return;
    }
    const data = await sendDirectRequest(code);
    if (!data) return;
    elements.directCode.value = '';
    resetDirectLookup();
}

// Запрос по коду. Возвращает ответ сервера или null при ошибке (она уже
// показана). Чат, который уже есть (или появился сразу: человек сам
// просил о том же), открывается.
async function sendDirectRequest(code, { fieldId = 'direct-code' } = {}) {
    const data = await api('/api/direct-requests', { method: 'POST', body: JSON.stringify({ code }) });
    if (!data.success) {
        if (fieldId && elements.newChatModal.open) setFieldError(fieldId, data.message);
        else showToast(data.message, 'error');
        return null;
    }
    closeModal(elements.newChatModal);
    if (data.chat) {
        await loadChats();
        openChatById(data.chat.id);
        return data;
    }
    showToast(`Запрос отправлен: ${data.request.username} увидит его в списке чатов`, 'success');
    loadDirectRequests();
    return data;
}

/* --- Запросы над списком чатов ---------------------------------------------
   Входящие запросы на переписку — с кнопками «Принять», «Отклонить»,
   «Заблокировать»; свои — «ждёт ответа» с «Отменить»; свои запросы на
   вход в группы — «ждёт одобрения». Отклонённый свой запрос выглядит так
   же, как ждущий: отправитель не узнаёт, видели ли его. */

let directRequests = { incoming: [], outgoing: [] };

async function loadDirectRequests() {
    const data = await api('/api/direct-requests');
    if (!data.success) return;
    directRequests = { incoming: data.incoming, outgoing: data.outgoing };
    renderMyRequests();
}

function requestRowElement(icon, title, note, buttons) {
    const row = document.createElement('div');
    row.className = 'my-request';
    const text = document.createElement('span');
    text.className = 'my-request-text';
    const name = document.createElement('strong');
    name.textContent = title;
    const small = document.createElement('span');
    small.textContent = note;
    text.append(name, small);
    const actions = document.createElement('span');
    actions.className = 'my-request-actions';
    for (const { label, aria, kind = 'btn-ghost', run } of buttons) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `btn btn-sm ${kind}`;
        button.textContent = label;
        button.setAttribute('aria-label', aria);
        button.addEventListener('click', () => withBusy(button, run));
        actions.appendChild(button);
    }
    row.append(createIcon(icon), text, actions);
    return row;
}

async function decideDirectRequest(request, action) {
    if (action === 'block' && !confirm(`Заблокировать ${request.username}? Он не сможет присылать вам ни запросы, ни сообщения.`)) return;
    const data = await api(`/api/direct-requests/${request.id}`, { method: 'POST', body: JSON.stringify({ action }) });
    if (!data.success) return showToast(data.message, 'error');
    directRequests.incoming = directRequests.incoming.filter(r => r.id !== request.id);
    renderMyRequests();
    if (action === 'accept') {
        await loadChats();
        openChatById(data.chat.id);
    } else {
        showToast(action === 'block' ? `${request.username} заблокирован(а)` : 'Запрос отклонён', 'success');
    }
}

async function cancelDirectRequest(request) {
    const data = await api(`/api/direct-requests/${request.id}`, { method: 'DELETE' });
    if (!data.success) return showToast(data.message, 'error');
    directRequests.outgoing = directRequests.outgoing.filter(r => r.id !== request.id);
    renderMyRequests();
    showToast('Запрос отменён', 'success');
}

async function onDirectRequestAccepted({ request_id: requestId, chat }) {
    const request = directRequests.outgoing.find(r => r.id === requestId);
    directRequests.outgoing = directRequests.outgoing.filter(r => r.id !== requestId);
    renderMyRequests();
    await loadChats();
    if (request) {
        showToast(`${request.username} принял(а) запрос — можно писать`, 'success', chat ? {
            duration: 8000, action: { label: 'Открыть', onClick: () => openChatById(chat.id) },
        } : {});
    }
}

/* --- Блокировка ------------------------------------------------------------ */

async function setBlocked(userId, username, blocked) {
    if (blocked && !confirm(`Заблокировать ${username}? Он не сможет присылать вам ни запросы, ни сообщения.`)) return false;
    const data = blocked
        ? await api('/api/blocks', { method: 'POST', body: JSON.stringify({ userId }) })
        : await api(`/api/blocks/${userId}`, { method: 'DELETE' });
    if (!data.success) {
        showToast(data.message, 'error');
        return false;
    }
    showToast(blocked ? `${username} заблокирован(а)` : `${username} разблокирован(а)`, 'success');
    await loadChats();
    applyRoomState();
    return true;
}

async function renderBlocked() {
    const data = await api('/api/blocks').catch(() => null);
    if (!data || !data.success) return false;
    const list = data.blocked;
    elements.blockedSection.hidden = list.length === 0;
    elements.blockedList.replaceChildren(...list.map(user => {
        const li = document.createElement('li');
        li.className = 'device-item';
        const info = document.createElement('div');
        info.className = 'device-info';
        const name = document.createElement('div');
        name.className = 'device-name';
        name.textContent = user.username;
        info.appendChild(name);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-secondary';
        button.textContent = 'Разблокировать';
        button.addEventListener('click', () => withBusy(button, async () => {
            if (await setBlocked(user.user_id, user.username, false)) await renderBlocked();
        }));
        li.append(info, button);
        return li;
    }));
    return true;
}

/* --- Свой код в профиле ---------------------------------------------------- */

async function renderUserCode() {
    const data = await api('/api/user/code').catch(() => null);
    if (!data || !data.success) return false;
    elements.userCodeDisplay.parentElement.classList.remove('is-loading');
    elements.userCodeDisplay.textContent = data.code;
    elements.codeRequestsToggle.checked = data.requestsEnabled;
    return true;
}

/* --- QR при встрече ---------------------------------------------------------
   В QR — код пользователя и отпечаток ключей всех его устройств:
   NYXOUSER1:<код>:<30 цифр>. Второй сканирует его камерой (только камерой:
   снимок могли прислать через тот же сервер, который подменяет ключи),
   находит человека по коду, считает отпечаток по ключам, которые отдал
   сервер, и сравнивает. Совпал — собеседник сразу помечен «ключи сверены
   при встрече»; не совпал — предупреждение, и отметки нет. */

const MEET_QR_PREFIX = 'NYXOUSER1:';

async function openMeetModal() {
    if (!e2ee || !e2ee.isReady()) return showToast('Шифрование на этом устройстве не работает — QR не построить', 'error');
    elements.meetResult.hidden = true;
    elements.meetScan.hidden = true;
    elements.meetScanBtn.hidden = !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    openModal(elements.meetModal);
    try {
        const [code, fingerprint] = await Promise.all([api('/api/user/code'), e2ee.ownFingerprint()]);
        elements.meetCode.textContent = code.code;
        await drawQr(elements.meetQr, [[`${MEET_QR_PREFIX}${code.code.replace(/-/g, '')}:${fingerprint}`, 'Alphanumeric']]);
        elements.meetQr.hidden = false;
    } catch {
        elements.meetQr.hidden = true;
        showToast('Не удалось построить QR', 'error');
    }
}

function showMeetResult(kind, text) {
    elements.meetResult.className = `meet-result is-${kind}`;
    elements.meetResult.replaceChildren(createIcon(kind === 'ok' ? 'i-shield-check' : 'i-alert'), text);
    elements.meetResult.hidden = false;
}

async function scanMeetQr() {
    let value;
    try {
        value = await scanWithCamera(elements.meetScan);
    } catch {
        return showMeetResult('warn', 'Камера недоступна. Сканировать QR при встрече можно только камерой.');
    }
    if (value === null) return;
    const match = /^NYXOUSER1:([A-Z0-9]{12}):(\d{30})$/.exec(value || '');
    if (!match) return showMeetResult('warn', 'Это не QR пользователя Nyxo.');
    const lookup = await api('/api/contacts/lookup', { method: 'POST', body: JSON.stringify({ code: match[1] }) });
    if (!lookup.success) return showMeetResult('warn', lookup.message);
    // Сначала запрос (или чат, если он уже есть): ключи человека сервер
    // отдаёт только тем, с кем у него чат или запрос на переписку.
    const request = await api('/api/direct-requests', { method: 'POST', body: JSON.stringify({ code: match[1] }) });
    if (!request.success) return showMeetResult('warn', request.message);
    const name = lookup.user.username;
    const result = await e2ee.checkMeetingFingerprint(lookup.user.id, match[2]).catch(() => ({ match: false }));
    if (request.pending) loadDirectRequests();
    if (!result.match) {
        return showMeetResult('warn', result.reason === 'no-devices'
            ? `У ${name} пока нет устройства с шифрованием — сверить нечего. Запрос на переписку отправлен.`
            : `Ключи ${name} не совпали с тем, что отдал сервер. Отметки «сверено» нет: не пишите ничего важного, пока не разберётесь.`);
    }
    closeModal(elements.meetModal);
    if (request.chat) {
        await loadChats();
        openChatById(request.chat.id);
    }
    showToast(request.chat ? `Ключи сверены при встрече: ${name}` : `Ключи сверены при встрече, запрос отправлен: ${name}`, 'success');
}

/* --- Ссылка-приглашение ----------------------------------------------------
   Только у администраторов: создать, сменить (старая сразу перестаёт
   действовать), отключить, показать QR. Условия — срок, лимит участников и
   одобрение — задаются при создании и смене. */

let inviteChatId = null;
const inviteUrl = code => `${location.origin}/join#${code}`;

function linkTerms(link) {
    const parts = [
        link.expires_at ? `действует до ${fullFormat.format(new Date(link.expires_at))}` : 'бессрочная',
        link.member_limit ? `в группе до ${link.member_limit} ${['участника', 'участников', 'участников'][pluralForm(link.member_limit)]}` : null,
        link.require_approval ? 'вход после одобрения' : 'вход без одобрения',
    ].filter(Boolean).join(' · ');
    return parts.charAt(0).toUpperCase() + parts.slice(1);
}

async function showInviteLink(link) {
    elements.inviteCodeBox.hidden = !link;
    elements.inviteCodeDisplay.textContent = link ? inviteUrl(link.code) : '';
    elements.inviteText.textContent = link
        ? 'Отправьте ссылку тем, кого хотите позвать, или покажите QR-код.'
        : 'Ссылки нет. Создайте её, чтобы позвать участников: по ссылке входят в группу или просят об этом.';
    elements.resetInviteBtn.textContent = link ? 'Сменить ссылку' : 'Создать ссылку';
    elements.disableInviteBtn.hidden = !link;
    if (!link) return;
    elements.inviteTerms.textContent = linkTerms(link);
    // Новая ссылка по умолчанию — на тех же условиях.
    const left = link.expires_at ? (new Date(link.expires_at) - Date.now()) / 1000 : 0;
    elements.inviteExpiry.value = !link.expires_at ? '0' : left > 86400 * 1.5 ? '604800' : left > 3600 * 1.5 ? '86400' : '3600';
    elements.inviteLimit.value = link.member_limit || '';
    elements.inviteApproval.checked = link.require_approval;
    elements.inviteQr.hidden = false;
    drawQr(elements.inviteQr, [[inviteUrl(link.code), 'Byte']]).catch(() => { elements.inviteQr.hidden = true; });
}

// Окно — сразу, ссылка и QR — как придут.
async function openInviteModal(chatId = currentChatId) {
    if (!chatId) return;
    inviteChatId = chatId;
    elements.inviteCodeBox.hidden = true;
    elements.disableInviteBtn.hidden = true;
    elements.resetInviteBtn.disabled = true;
    elements.inviteText.replaceChildren(Object.assign(document.createElement('span'), {
        className: 'skeleton invite-skeleton', ariaHidden: 'true' }));
    openModal(elements.inviteModal);
    const data = await api(`/api/chats/${chatId}/link`).catch(() => null);
    if (inviteChatId !== chatId || !elements.inviteModal.open) return;
    elements.resetInviteBtn.disabled = false;
    if (!data || !data.success) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'link-inline';
        retry.textContent = 'Повторить';
        retry.addEventListener('click', () => openInviteModal(chatId));
        elements.inviteText.replaceChildren(`${(data && data.message) || 'Не удалось загрузить'} · `, retry);
        return;
    }
    await showInviteLink(data.link);
}

async function saveInviteLink() {
    const limitText = elements.inviteLimit.value.trim();
    const limit = limitText ? Number(limitText) : null;
    if (limit !== null && (!Number.isInteger(limit) || limit < 2 || limit > 1000)) {
        elements.inviteLimit.focus();
        return showToast('Лимит участников — от 2 до 1000, или оставьте поле пустым', 'error');
    }
    const replacing = !elements.inviteCodeBox.hidden;
    const data = await api(`/api/chats/${inviteChatId}/link`, { method: 'POST', body: JSON.stringify({
        expiresIn: Number(elements.inviteExpiry.value), memberLimit: limit, requireApproval: elements.inviteApproval.checked,
    }) });
    if (!data.success) return showToast(data.message, 'error');
    await showInviteLink(data.link);
    showToast(replacing ? 'Ссылка сменена, старая больше не действует' : 'Ссылка создана', 'success');
}

async function disableInviteLink() {
    const data = await api(`/api/chats/${inviteChatId}/link`, { method: 'DELETE' });
    if (!data.success) return showToast(data.message, 'error');
    await showInviteLink(null);
    showToast('Ссылка отключена: по ней больше не войти', 'success');
}

/* --- Группа: название, запросы, участники ----------------------------------
   Название меняет любой участник. Администратор впускает и отклоняет,
   назначает и снимает администраторов, удаляет участников. У каждого —
   отметка «ключи сверены», если собеседник сверен на этом устройстве. */

let membersChatId = null;

async function openMembersModal(chatId = currentChatId) {
    if (!chatId) return;
    membersChatId = chatId;
    const loading = document.createElement('li');
    loading.className = 'skeleton members-skeleton';
    elements.membersList.replaceChildren(loading);
    elements.requestsSection.hidden = true;
    openModal(elements.membersModal);
    await renderMembers();
}

async function renderMembers() {
    const chatId = membersChatId;
    const data = await api(`/api/chats/${chatId}/members`);
    if (membersChatId !== chatId || !elements.membersModal.open) return;
    if (!data.success) {
        closeModal(elements.membersModal);
        return showToast(data.message, 'error');
    }
    const admin = data.my_role === 'admin';
    if (document.activeElement !== elements.groupNameInput) elements.groupNameInput.value = data.name;
    elements.membersTitle.textContent = `Участники · ${data.members.length}`;
    elements.membersInviteBtn.hidden = !admin;

    let states = new Map();
    if (e2ee && e2ee.isReady()) {
        const info = await chatDevices(chatId);
        if (info) states = await e2ee.verificationStatus(info.devices.filter(d => d.user_id !== currentUser.id));
    }
    const admins = data.members.filter(m => m.role === 'admin').length;
    elements.membersList.replaceChildren(...data.members.map(m => memberRow(chatId, m, { admin, admins, state: states.get(m.user_id) })));

    const requests = admin ? await api(`/api/chats/${chatId}/requests`) : null;
    if (membersChatId !== chatId) return;
    const pending = (requests && requests.success && requests.requests) || [];
    elements.requestsSection.hidden = pending.length === 0;
    elements.requestsList.replaceChildren(...pending.map(r => requestRow(chatId, r)));
}

function personRow(name, metaText) {
    const li = document.createElement('li');
    li.className = 'member-row';
    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar-small';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = name.charAt(0).toUpperCase();
    const text = document.createElement('div');
    text.className = 'member-text';
    const strong = document.createElement('strong');
    strong.textContent = name;
    const meta = document.createElement('span');
    meta.className = 'member-meta';
    meta.textContent = metaText;
    text.append(strong, meta);
    li.append(avatar, text);
    return li;
}

function memberRow(chatId, member, { admin, admins, state }) {
    const me = member.user_id === currentUser.id;
    const verified = state === 'verified';
    const li = personRow(me ? `${member.username} (вы)` : member.username,
        [member.role === 'admin' ? 'администратор' : 'участник', verified ? 'ключи сверены' : null].filter(Boolean).join(' · '));
    li.dataset.userId = member.user_id;
    paintAvatar(li.querySelector('.chat-avatar-small'), member.avatar, member.username);
    if (verified) {
        const mark = createIcon('i-shield-check');
        mark.classList.add('member-verified');
        li.appendChild(mark);
    }

    const actions = [];
    if (!me) actions.push(['Сверить ключи', () => { closeModal(elements.membersModal); openSafetyModal(chatId); }]);
    if (admin && member.role === 'member') actions.push(['Сделать администратором', () => setMemberRole(chatId, member, 'admin')]);
    // Себя снять можно, только если останется другой администратор.
    if (admin && member.role === 'admin' && (!me || admins > 1)) {
        actions.push([me ? 'Отказаться от прав администратора' : 'Снять права администратора', () => setMemberRole(chatId, member, 'member')]);
    }
    if (admin && !me) actions.push(['Удалить из группы', () => removeMember(chatId, member), 'danger']);
    if (!actions.length) return li;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'icon-btn icon-btn-sm icon-btn-quiet member-menu-btn';
    toggle.setAttribute('aria-label', `Действия: ${member.username}`);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.appendChild(createIcon('i-more'));
    const menu = document.createElement('div');
    menu.className = 'member-actions';
    menu.hidden = true;
    for (const [label, run, kind] of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `btn btn-sm ${kind === 'danger' ? 'btn-danger' : 'btn-secondary'}`;
        button.textContent = label;
        button.addEventListener('click', () => withBusy(button, run));
        menu.appendChild(button);
    }
    toggle.addEventListener('click', () => {
        menu.hidden = !menu.hidden;
        toggle.setAttribute('aria-expanded', String(!menu.hidden));
        if (!menu.hidden) menu.querySelector('button').focus();
    });
    li.append(toggle, menu);
    return li;
}

function requestRow(chatId, request) {
    const li = personRow(request.username, `просится с ${listTimeLabel(new Date(request.created_at))}`);
    const buttons = document.createElement('div');
    buttons.className = 'request-actions';
    for (const [label, action, kind] of [['Впустить', 'approve', 'btn-primary'], ['Отклонить', 'decline', 'btn-ghost']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `btn btn-sm ${kind}`;
        button.textContent = label;
        button.setAttribute('aria-label', `${label}: ${request.username}`);
        button.addEventListener('click', () => withBusy(button, async () => {
            const data = await api(`/api/chats/${chatId}/requests/${request.id}`, { method: 'POST', body: JSON.stringify({ action }) });
            if (!data.success) showToast(data.message, 'error');
            else showToast(action === 'approve' ? `${request.username} в группе` : `Запрос ${request.username} отклонён`, 'success');
            await renderMembers();
        }));
        buttons.appendChild(button);
    }
    li.appendChild(buttons);
    return li;
}

async function setMemberRole(chatId, member, role) {
    const data = await api(`/api/chats/${chatId}/members/${member.user_id}/role`, { method: 'POST', body: JSON.stringify({ role }) });
    if (!data.success) showToast(data.message, 'error');
    await renderMembers();
}

async function removeMember(chatId, member) {
    if (!confirm(`Удалить ${member.username} из группы? Новые сообщения группы до него доходить перестанут.`)) return;
    const data = await api(`/api/chats/${chatId}/members/${member.user_id}`, { method: 'DELETE' });
    if (!data.success) showToast(data.message, 'error');
    else showToast(`${member.username} больше не в группе`, 'success');
    await renderMembers();
}

async function renameGroup() {
    clearFieldErrors(elements.membersModal);
    const name = elements.groupNameInput.value.trim();
    if (!name) return setFieldError('group-name-input', 'Введите название группы');
    const data = await api(`/api/chats/${membersChatId}/name`, { method: 'POST', body: JSON.stringify({ name }) });
    if (!data.success) return setFieldError('group-name-input', data.message);
    elements.groupNameInput.value = data.name;
    showToast('Название изменено', 'success');
}

// Удалили из группы: её больше нет в списке, открытая — закрывается.
async function onRemovedFromChat({ chat_id: chatId, room_id: roomId, name }) {
    if (e2ee && chatId) await e2ee.forgetConversation({ id: chatId, room_id: roomId });
    if (currentRoomId && Number(currentRoomId) === Number(roomId)) {
        for (const modal of [elements.membersModal, elements.inviteModal, elements.chatMenuModal]) closeModal(modal);
        closeCurrentChat();
    }
    showToast(`Вас удалили из группы «${name}»`, 'info');
    loadChats();
}

function onMembersChanged({ room_id: roomId }) {
    const chat = chatsMeta.get(Number(membersChatId));
    if (elements.membersModal.open && chat && Number(chat.room_id) === Number(roomId)) renderMembers();
}

async function onJoinRequestsChanged({ room_id: roomId, pending }) {
    for (const chat of chatsMeta.values()) {
        if (Number(chat.room_id) === Number(roomId)) chat.pending_requests = pending;
    }
    onMembersChanged({ room_id: roomId });
    await loadChats();
    applyRoomState();
}

async function deleteChat() {
    if (!currentChatId) return;
    const group = Boolean(currentChatMeta() && currentChatMeta().kind === 'group');
    if (!confirm(group ? 'Выйти из группы? Вернуться можно будет только по новой ссылке.' : 'Удалить чат?')) return;
    const leaving = { id: currentChatId, room_id: currentRoomId };
    const data = await api(`/api/chats/${currentChatId}`, { method: 'DELETE' });
    if (data.success) {
        if (e2ee) await e2ee.forgetConversation(leaving);
        // Ждущим ключей сообщениям этого чата больше некуда уходить.
        if (e2ee && e2ee.isReady()) {
            await withPendingLock(async () =>
                e2ee.pending.save((await e2ee.pending.list()).filter(p => p.chatId !== leaving.id)));
        }
        showToast(group ? 'Вы вышли из группы' : 'Чат удалён', 'success');
        closeModal(elements.chatMenuModal);
        closeCurrentChat();
        loadChats();
    } else {
        showToast(data.message, 'error');
    }
}

// Открытого чата больше нет (удалён, вышли, удалили из группы).
function closeCurrentChat() {
    chatViews.delete(currentChatId);
    clearDraft(currentChatId);
    setMessageInput('');
    currentChatId = null;
    currentRoomId = null;
    elements.chatHeader.classList.add('hidden');
    elements.messageInputContainer.classList.add('hidden');
    elements.joinRequestsBar.hidden = true;
    elements.roomEmpty.hidden = true;
    elements.chatMessages.hidden = false;
    elements.emptyState.classList.remove('hidden');
    clearFeed();
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
// Вторая строка чата в списке: своё — «Вы:» и отметка ✓/✓✓, в группе
// чужое — «Имя:», дальше текст.
function fillChatLast(last, chat, previewText) {
    last.replaceChildren();
    const draft = drafts[String(chat.id)];
    if (draft && draft.text && draft.text.trim() && chat.id !== currentChatId) {
        const label = document.createElement('span');
        label.className = 'chat-draft-label';
        label.textContent = 'Черновик: ';
        last.append(label, draft.text.replace(/\s+/g, ' ').trim());
        return;
    }
    // Своё — «Вы:» и отметка ✓/✓✓; в группе чужое — «Имя:».
    const own = Boolean(currentUser) && chat.last_user_id === currentUser.id && Number(chat.last_sent) !== 0
        && chat.last_type !== 'system';
    if (own && chat.last_status && STATUS_VIEW[chat.last_status] && chat.last_status !== 'sent') {
        const mark = document.createElement('span');
        mark.className = `chat-last-status is-${chat.last_status}`;
        mark.textContent = STATUS_VIEW[chat.last_status][0];
        mark.title = STATUS_VIEW[chat.last_status][1];
        last.appendChild(mark);
    }
    const prefix = own ? 'Вы: '
        : chat.peer_count > 1 && chat.last_sender && chat.last_type !== 'system' && chat.last_message !== undefined
            ? `${chat.last_sender}: ` : '';
    if (prefix && previewText !== 'Нет сообщений') {
        const who = document.createElement('span');
        who.className = 'chat-last-author';
        who.textContent = prefix;
        last.appendChild(who);
    }
    last.append(previewText);
}

function chatItemElement(chat, previewText) {
    const div = document.createElement('div');
    div.className = 'chat-item';
    div.dataset.id = chat.id;
    div.setAttribute('role', 'button');
    div.tabIndex = -1;
    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar-small';
    if (chat.is_bot) paintBotAvatar(avatar);
    else paintAvatar(avatar, chat.kind === 'direct' ? chat.peer_avatar : chat.avatar, chat.name);
    const info = document.createElement('div');
    info.className = 'chat-info';
    const name = document.createElement('div');
    name.className = 'chat-name';
    name.dir = 'auto';
    name.textContent = chat.name;
    const top = document.createElement('div');
    top.className = 'chat-top';
    top.appendChild(name);
    // Закреплён, без звука: значком и словами для экранного диктора.
    const marks = [chat.pin_position && ['i-pin', 'закреплён'], chat.muted && ['i-bell-off', 'без звука']].filter(Boolean);
    if (marks.length) {
        const box = document.createElement('span');
        box.className = 'chat-marks';
        for (const [icon, label] of marks) {
            const mark = createIcon(icon);
            mark.setAttribute('role', 'img');
            mark.setAttribute('aria-label', label);
            mark.removeAttribute('aria-hidden');
            box.appendChild(mark);
        }
        top.appendChild(box);
    }
    const at = chat.last_at ? new Date(chat.last_at) : null;
    if (at && !Number.isNaN(at.getTime())) {
        const time = document.createElement('time');
        // Есть непрочитанное — время акцентным цветом.
        time.className = 'chat-time' + (chat.unread > 0 ? ' has-unread' : '');
        time.dateTime = at.toISOString();
        time.textContent = listTimeLabel(at);
        time.title = fullFormat.format(at);
        top.appendChild(time);
    }
    info.appendChild(top);
    if (previewText !== null) {
        const last = document.createElement('div');
        last.className = 'chat-last';
        last.dir = 'auto';
        fillChatLast(last, chat, previewText);
        info.appendChild(last);
    }
    div.append(avatar, info);
    if (chat.unread > 0) {
        const badge = document.createElement('div');
        badge.className = chat.muted ? 'chat-badge is-muted' : 'chat-badge';
        badge.textContent = String(chat.unread);
        badge.setAttribute('aria-label', `${chat.unread} ${['непрочитанное', 'непрочитанных', 'непрочитанных'][pluralForm(chat.unread)]}`);
        div.appendChild(badge);
    } else if (chat.marked_unread) {
        // «Отметить непрочитанным» — пустой счётчик-точка.
        const badge = document.createElement('div');
        badge.className = chat.muted ? 'chat-badge is-marked is-muted' : 'chat-badge is-marked';
        badge.setAttribute('aria-label', 'отмечен непрочитанным');
        div.appendChild(badge);
    }
    // Администратору: кто-то просится в группу.
    if (chat.pending_requests > 0) {
        const badge = document.createElement('div');
        badge.className = 'chat-badge is-requests';
        badge.title = `Ждут одобрения: ${chat.pending_requests}`;
        badge.setAttribute('aria-label', badge.title);
        badge.append(createIcon('i-user-plus'), String(chat.pending_requests));
        div.appendChild(badge);
    }
    return div;
}

/* --- Прокрутка ----------------------------------------------------------------
   Доезд своей кривой через rAF: длительность растёт с расстоянием (250–600
   мс), короткое — 1 − (1 − t)^3.5, длинное — 1 − (1 − t)^5. Любое касание
   или колёсико прерывает. Дальше полутора экранов — сначала мгновенно на
   полтора экрана до цели, потом доезд. «Уменьшить движение» — мгновенно. */

let scrollAnimation = null;

function stopScrollAnimation() {
    if (scrollAnimation) cancelAnimationFrame(scrollAnimation);
    scrollAnimation = null;
}

// Сдвиг идущей прокрутки: сверху вставили или убрали сообщения, пока лента
// доезжала, — и старт, и цель сдвигаются вместе с содержимым.
let scrollShift = 0;
function shiftScrollAnimation(delta) {
    if (scrollAnimation) scrollShift += delta;
}

function animateScroll(list, target) {
    stopScrollAnimation();
    const start = list.scrollTop;
    const distance = target - start;
    if (prefersReducedMotion() || Math.abs(distance) < 2) {
        list.scrollTop = target;
        return;
    }
    const abs = Math.abs(distance);
    const duration = Math.min(600, Math.max(250, 250 + abs / 1500 * 350));
    const power = abs <= 500 ? 3.5 : 5;
    const began = performance.now();
    scrollShift = 0;
    const step = now => {
        const t = Math.min(1, (now - began) / duration);
        list.scrollTop = start + scrollShift + distance * (1 - Math.pow(1 - t, power));
        scrollAnimation = t < 1 ? requestAnimationFrame(step) : null;
    };
    scrollAnimation = requestAnimationFrame(step);
}

function scrollToTarget(list, target) {
    const max = list.scrollHeight - list.clientHeight;
    target = Math.max(0, Math.min(max, target));
    const far = list.clientHeight * 1.5;
    if (!prefersReducedMotion() && Math.abs(target - list.scrollTop) > far) {
        stopScrollAnimation();
        list.scrollTop = target - Math.sign(target - list.scrollTop) * far;
    }
    animateScroll(list, target);
}

function scrollToBottom({ smooth = false } = {}) {
    const list = elements.chatMessages;
    if (smooth) return scrollToTarget(list, list.scrollHeight - list.clientHeight);
    stopScrollAnimation();
    list.scrollTop = list.scrollHeight;
}

/*
 * Новое внизу — одним движением, как в Telegram: мгновенно в конец, а
 * видимое содержимое ленты сдвигается снизу на высоту нового за 250 мс.
 * Своё сообщение при этом «вылетает» из поля ввода: по вертикали — той же
 * кривой, по горизонтали — своей, за 300 мс. Плавная прокрутка
 * 250–600 мс — только для дальних прыжков.
 */
const SLIDE_EASE = 'cubic-bezier(0.199, 0.011, 0.279, 0.910)';
function revealAtBottom(heightBefore, { burst = false, bubble = null, from = null, fresh = null } = {}) {
    const list = elements.chatMessages;
    stopScrollAnimation();
    const shift = list.scrollHeight - heightBefore;
    list.scrollTop = list.scrollHeight;
    // «Уменьшить движение»: вместо сдвига — короткое проявление (is-new
    // при reduced motion — затухание 150 мс).
    const arrived = fresh || bubble;
    if (prefersReducedMotion() && !burst && arrived && document.visibilityState === 'visible') arrived.classList.add('is-new');
    if (burst || prefersReducedMotion() || document.visibilityState !== 'visible') return;
    const top = list.getBoundingClientRect().top;
    const target = bubble && from ? bubble.getBoundingClientRect() : null;
    if (shift > 0) {
        const groups = [...list.querySelectorAll(':scope > .day-group')].filter(g => g.getBoundingClientRect().bottom > top);
        for (const group of groups) {
            group.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], { duration: 250, easing: SLIDE_EASE });
        }
    }
    if (target) {
        // Сдвиг дня уже везёт пузырь на shift — своё движение без него.
        const dy = from.top - target.top - Math.max(0, shift);
        const dx = from.right - target.right;
        bubble.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 300, easing: SLIDE_EASE });
        bubble.animate([{ translate: `${dx}px 0` }, { translate: '0 0' }], { duration: 300, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    } else if (shift <= 0 && arrived) {
        arrived.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: SLIDE_EASE });
    }
}

// Больше трёх за 300 мс — поток: без въезда пузырей и без доезда.
const recentArrivals = [];
function arrivalBurst() {
    const now = performance.now();
    recentArrivals.push(now);
    while (recentArrivals.length && now - recentArrivals[0] > 300) recentArrivals.shift();
    return recentArrivals.length > 3;
}


init();
