const socket = io();
let currentChatId = null;
let currentRoomId = null;
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
    chatName: document.getElementById('chat-name'),
    chatStatus: document.getElementById('chat-status'),
    chatAvatar: document.getElementById('chat-avatar'),
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
    overlay: document.getElementById('overlay'),
    profileUsername: document.getElementById('profile-username'),
    profileEmail: document.getElementById('profile-email'),
    profileCode: document.getElementById('profile-code'),
    profileAvatar: document.getElementById('profile-avatar'),
    profileAnonBadge: document.getElementById('profile-anon-badge'),
    emptyNewChatBtn: document.getElementById('empty-new-chat-btn'),
};

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

function showToast(message, type = 'info') {
    elements.toast.textContent = message;
    elements.toast.className = `toast ${type}`;
    elements.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 3200);
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

    elements.loginBtn.addEventListener('click', async () => {
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
            loadChats();
        } else {
            setFieldError('login-password', data.message);
        }
    });

    elements.registerBtn.addEventListener('click', async () => {
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
            loadChats();
        } else {
            setFieldError('register-email', data.message);
        }
    });

    elements.anonymousLoginBtn.addEventListener('click', async () => {
        const data = await api('/api/register/anonymous', { method: 'POST' });
        if (data.success) {
            currentUser = data.user;
            showToast('Приватный режим активирован', 'success');
            showApp();
            loadChats();
        } else {
            showToast(data.message, 'error');
        }
    });

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
    elements.messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    elements.attachBtn.addEventListener('click', () => elements.fileInput.click());
    elements.fileInput.addEventListener('change', handleFileUpload);
    elements.cancelReplyBtn.addEventListener('click', clearReply);

    elements.replyMessageBtn.addEventListener('click', () => {
        replyToMessageId = elements.messageMenu.dataset.messageId;
        const text = elements.messageMenu.dataset.messageText;
        elements.replyPreviewText.textContent = text.substring(0, 100);
        elements.replyPreview.classList.remove('hidden');
        hideMessageMenu();
    });

    elements.editMessageBtn.addEventListener('click', () => {
        editingMessageId = elements.messageMenu.dataset.messageId;
        const text = elements.messageMenu.dataset.messageText;
        elements.messageInput.value = text;
        elements.messageInput.focus();
        hideMessageMenu();
    });

    elements.deleteMessageBtn.addEventListener('click', async () => {
        const messageId = elements.messageMenu.dataset.messageId;
        const data = await api(`/api/messages/${messageId}`, { method: 'DELETE' });
        if (data.success) {
            showToast('Сообщение удалено', 'success');
            const el = document.querySelector(`[data-message-id="${messageId}"]`);
            if (el) el.remove();
        } else {
            showToast(data.message, 'error');
        }
        hideMessageMenu();
    });

    let searchTimeout;
    elements.searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(performSearch, 300);
    });

    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.modal').forEach(m => closeModal(m));
        });
    });

    elements.overlay.addEventListener('click', () => {
        document.querySelectorAll('.modal').forEach(m => closeModal(m));
        hideMessageMenu();
    });

    socket.on('newMessage', (message) => {
        if (message.chat_id == currentChatId || message.room_id == currentRoomId) {
            appendMessage(message);
            scrollToBottom();
        } else {
            loadChats();
        }
    });

    socket.on('messageEdited', ({ id, text, chat_id, room_id }) => {
        if (chat_id == currentChatId || room_id == currentRoomId) {
            const bubble = document.querySelector(`[data-message-id="${id}"]`);
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
            const bubble = document.querySelector(`[data-message-id="${id}"]`);
            if (bubble) bubble.remove();
        }
    });

    document.addEventListener('click', () => hideMessageMenu());
    document.addEventListener('scroll', () => hideMessageMenu(), true);
}

function openModal(modal) {
    modal.classList.remove('hidden');
    elements.overlay.classList.remove('hidden');
}

function closeModal(modal) {
    clearFieldErrors(modal);
    modal.classList.add('hidden');
    if (!document.querySelector('.modal:not(.hidden)')) {
        elements.overlay.classList.add('hidden');
    }
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

    data.chats.forEach(chat => {
        const div = document.createElement('div');
        div.className = 'chat-item';
        div.dataset.id = chat.id;
        div.dataset.roomId = chat.room_id || '';
        div.innerHTML = `
            <div class="chat-avatar-small" style="background:${chat.avatar && chat.avatar.startsWith('#') ? chat.avatar : DEFAULT_AVATAR}">${chat.name.charAt(0).toUpperCase()}</div>
            <div class="chat-info">
                <div class="chat-name">${escapeHtml(chat.name)}</div>
                <div class="chat-last">${chat.last_message ? escapeHtml(chat.last_message.substring(0, 30)) : 'Нет сообщений'}</div>
            </div>
            ${chat.unread > 0 ? `<div class="chat-badge">${chat.unread}</div>` : ''}
        `;
        div.addEventListener('click', () => openChat(chat.id, chat.room_id, chat.name, chat.avatar, chat.online, chat.is_bot));
        elements.chatsList.appendChild(div);
    });
}

async function openChat(chatId, roomId, name, avatar, online, isBot) {
    currentChatId = chatId;
    currentRoomId = roomId;
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
        data.messages.forEach(msg => appendMessage(msg));
        scrollToBottom();
    }

    const roomKey = roomId ? `room:${roomId}` : `chat:${chatId}`;
    socket.emit('joinChat', roomKey);
}

function appendMessage(message) {
    const el = createMessageElement(message);
    elements.chatMessages.appendChild(el);
}

// Элементы с файлом (img/video/audio/a) собираются через DOM API, а не через
// шаблонную строку с сырым message.file_url — см. п.2 аудита. file_url сейчас
// всегда безопасен (имя генерируется сервером из Date.now()+random), но даже
// если бы в нём оказались произвольные символы, .src/.href — это присвоение
// свойства, а не вставка HTML-текста, так что вырваться из атрибута нельзя.
// Заодно клик по картинке навешан через addEventListener, а не инлайновый
// onclick, который CSP (script-src без 'unsafe-inline') всё равно блокирует.
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

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    if (message.deleted) {
        const em = document.createElement('em');
        em.textContent = 'Сообщение удалено';
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
            quoted.textContent = (message.reply_to.text || '').substring(0, 60);
            replyDiv.append(author, quoted);
            contentDiv.appendChild(replyDiv);
        }
        if (message.file_url) {
            contentDiv.appendChild(createFileAttachmentElement(message));
        }
        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        textDiv.textContent = message.text || '';
        contentDiv.appendChild(textDiv);

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
    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    timeSpan.textContent = message.time || '';
    metaDiv.appendChild(timeSpan);
    if (isMine) {
        const statusSpan = document.createElement('span');
        statusSpan.className = 'message-status';
        statusSpan.textContent = message.status === 'read' ? '✓✓' : (message.status === 'delivered' ? '✓' : '○');
        metaDiv.appendChild(statusSpan);
    }

    div.appendChild(contentDiv);
    div.appendChild(metaDiv);

    div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (message.deleted) return;
        showMessageMenu(e.pageX, e.pageY, message);
    });

    div.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showMessageMenu(touch.pageX, touch.pageY, message);
        }, 600);
    }, { passive: true });

    div.addEventListener('touchend', () => clearTimeout(longPressTimer));
    div.addEventListener('touchmove', () => clearTimeout(longPressTimer));

    return div;
}

function showMessageMenu(x, y, message) {
    elements.messageMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
    elements.messageMenu.style.top = Math.min(y, window.innerHeight - 150) + 'px';
    elements.messageMenu.classList.remove('hidden');
    elements.messageMenu.dataset.messageId = message.id;
    elements.messageMenu.dataset.messageText = message.text || '';
    const isMine = message.user_id === (currentUser ? currentUser.id : 0);
    elements.editMessageBtn.style.display = isMine ? 'block' : 'none';
    elements.deleteMessageBtn.style.display = isMine ? 'block' : 'none';
}

function hideMessageMenu() {
    elements.messageMenu.classList.add('hidden');
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
            const el = document.querySelector(`[data-message-id="${editingMessageId}"] .message-text`);
            if (el) el.textContent = text;
        }
        editingMessageId = null;
    } else {
        await api('/api/messages', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    }

    elements.messageInput.value = '';
    clearReply();
}

async function handleFileUpload() {
    const file = elements.fileInput.files[0];
    if (!file || !currentChatId) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('chatId', currentChatId);

    const res = await fetch('/api/messages/file', {
        method: 'POST',
        headers: { 'X-CSRF-Token': getCsrfToken() },
        body: formData,
    });
    const data = await res.json();
    if (!data.success) {
        showToast(data.message, 'error');
    }
    elements.fileInput.value = '';
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
