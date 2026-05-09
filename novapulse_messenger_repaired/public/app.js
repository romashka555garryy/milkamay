const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function safeJson(raw, fallback) {
  try {
    if (raw == null || raw === '') return fallback;
    const value = JSON.parse(raw);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

const state = {
  token: localStorage.getItem('novapulse_token') || '',
  me: null,
  peer: null,
  users: [],
  messages: [],
  ws: null,
  activeMode: 'chat',
  replyTo: null,
  typingTimer: null,
  musicOn: false,
  audioCtx: null,
  musicGain: null,
  sfxGain: null,
  selectedTheme: localStorage.getItem('novapulse_theme') || 'dark-blue',
  settings: safeJson(localStorage.getItem('novapulse_settings'), { soundVolume: 0.18, musicVolume: 0.12, motion: true, density: 'comfortable' })
};

const loader = $('.loader');
const app = $('#app');
const authScreen = $('#authScreen');
const workspace = $('#workspace');
const loginForm = $('#loginForm');
const registerForm = $('#registerForm');
const searchInput = $('#searchInput');
const searchResults = $('#searchResults');
const userList = $('#userList');
const messages = $('#messages');
const messageInput = $('#messageInput');
const typingLine = $('#typingLine');
const peerName = $('#peerName');
const peerMeta = $('#peerMeta');
const peerAvatar = $('#peerAvatar');
const meAvatar = $('#meAvatar');
const meName = $('#meName');
const meStatus = $('#meStatus');
const profileAvatar = $('#profileAvatar');
const profileName = $('#profileName');
const profileBio = $('#profileBio');
const profileModal = $('#profileModal');
const addUserModal = $('#addUserModal');
const googleModal = $('#googleModal');
const voiceBtn = $('#voiceBtn');

function api(path, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  if (!(options.body instanceof FormData) && options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return fetch(path, { ...options, headers }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    return data;
  });
}

function safeText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setTheme(theme) {
  document.body.classList.remove('theme-red-neon', 'theme-green-matrix', 'theme-sunlight-day', 'theme-moon-night');
  if (theme && theme !== 'dark-blue') document.body.classList.add(`theme-${theme}`);
  localStorage.setItem('novapulse_theme', theme);
  state.selectedTheme = theme;
}

function applySettings() {
  $('#musicVolume').value = state.settings.musicVolume ?? 0.12;
  $('#sfxVolume').value = state.settings.soundVolume ?? 0.18;
  $('#muteMusic').checked = !(state.settings.musicVolume > 0);
}

function initAudio() {
  if (state.audioCtx) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  state.audioCtx = new AudioContext();
  state.musicGain = state.audioCtx.createGain();
  state.sfxGain = state.audioCtx.createGain();
  state.musicGain.connect(state.audioCtx.destination);
  state.sfxGain.connect(state.audioCtx.destination);
  state.musicGain.gain.value = state.settings.musicVolume ?? 0.12;
  state.sfxGain.gain.value = state.settings.soundVolume ?? 0.18;
  startAmbientMusic();
}

function tone(freq = 320, duration = 0.08, type = 'sine', gainNode = state.sfxGain) {
  if (!state.audioCtx || !gainNode) return;
  const osc = state.audioCtx.createOscillator();
  const gain = state.audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = 0.0001;
  osc.connect(gain);
  gain.connect(gainNode);
  const now = state.audioCtx.currentTime;
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.start();
  osc.stop(now + duration + 0.02);
}

let ambientNodes = [];
function startAmbientMusic() {
  if (!state.audioCtx) return;
  stopAmbientMusic();
  const baseFreqs = [110, 138.6, 164.8];
  baseFreqs.forEach((freq, idx) => {
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    osc.type = idx === 1 ? 'triangle' : 'sine';
    osc.frequency.value = freq;
    gain.gain.value = 0.012 + idx * 0.004;
    osc.connect(gain);
    gain.connect(state.musicGain);
    osc.start();
    ambientNodes.push({ osc, gain });
  });
  const filter = state.audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 480;
  ambientNodes.push({ filter });
  tone(220, 0.05, 'sine', state.musicGain);
}

function stopAmbientMusic() {
  ambientNodes.forEach(node => {
    try { node.osc && node.osc.stop(); } catch {}
    try { node.osc && node.osc.disconnect(); } catch {}
    try { node.gain && node.gain.disconnect(); } catch {}
  });
  ambientNodes = [];
}

function setMusicVolume(v) {
  if (state.musicGain) state.musicGain.gain.value = Number(v);
  state.settings.musicVolume = Number(v);
  localStorage.setItem('novapulse_settings', JSON.stringify(state.settings));
}

function setSfxVolume(v) {
  if (state.sfxGain) state.sfxGain.gain.value = Number(v);
  state.settings.soundVolume = Number(v);
  localStorage.setItem('novapulse_settings', JSON.stringify(state.settings));
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function avatarFor(user) {
  if (user.avatar) return user.avatar;
  const label = encodeURIComponent((user.displayName || user.username || '?').slice(0,1).toUpperCase());
  return `data:image/svg+xml;utf8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
      <defs>
        <linearGradient id="g" x1="0" x2="1">
          <stop offset="0%" stop-color="${user.accent || '#7c5cff'}"/>
          <stop offset="100%" stop-color="#26d0ff"/>
        </linearGradient>
      </defs>
      <rect width="256" height="256" rx="64" fill="url(#g)"/>
      <text x="50%" y="54%" font-size="104" text-anchor="middle" fill="white" font-family="Arial" font-weight="700">${label}</text>
    </svg>
  `)}`;
}

function renderPresence() {
  const list = state.users.filter(u => u.username !== state.me?.username);
  userList.innerHTML = '';
  if (!list.length) {
    userList.innerHTML = '<div class="user-item"><div class="user-item__meta">Пока нет найденных пользователей. Используй поиск или добавление.</div></div>';
    return;
  }
  list.forEach(user => {
    const item = document.createElement('div');
    item.className = 'user-item';
    item.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px">
        <span class="user-status" style="background:${user.online ? 'var(--success)' : 'rgba(255,255,255,.2)'}"></span>
        <img class="avatar avatar--small" src="${avatarFor(user)}" alt="">
        <div>
          <div class="user-item__name">${user.displayName || user.username}</div>
          <div class="user-item__meta">@${user.username} ${user.online ? '• онлайн' : '• офлайн'}</div>
        </div>
      </div>
      <div class="user-item__meta">Открыть</div>
    `;
    item.addEventListener('click', () => openChat(user.username));
    userList.appendChild(item);
  });
}

function renderSearchResults(users) {
  searchResults.innerHTML = '';
  if (!users.length) {
    searchResults.classList.remove('is-open');
    return;
  }
  users.forEach(user => {
    const el = document.createElement('div');
    el.className = 'result-item';
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px">
        <img class="avatar avatar--small" src="${avatarFor(user)}" alt="">
        <div>
          <div class="user-item__name">${user.displayName || user.username}</div>
          <div class="user-item__meta">@${user.username}</div>
        </div>
      </div>
      <span class="user-item__meta">${user.online ? 'онлайн' : 'офлайн'}</span>
    `;
    el.addEventListener('click', () => {
      searchResults.classList.remove('is-open');
      openChat(user.username);
    });
    searchResults.appendChild(el);
  });
  searchResults.classList.add('is-open');
}

function clearMessages() {
  messages.innerHTML = '';
}

function renderEmpty() {
  if (state.activeMode === 'ai') {
    const last = Array.isArray(state.aiThread) && state.aiThread.length ? state.aiThread[state.aiThread.length - 1].content : '';
    messages.innerHTML = `
      <div class="empty-state">
        <div>
          <div class="empty-state__icon">🤖</div>
          <h2>AI-режим готов</h2>
          <p>Отправь запрос на русском — ответ придёт из реального API и сохранится в истории диалога.</p>
          ${last ? `<div class="empty-state__hint">Последний запрос: ${safeText(last)}</div>` : ''}
        </div>
      </div>
    `;
    return;
  }
  messages.innerHTML = `
    <div class="empty-state">
      <div>
        <div class="empty-state__icon">✦</div>
        <h2>Выбери собеседника</h2>
        <p>Найди пользователя в поиске или добавь его по юзернейму.</p>
      </div>
    </div>
  `;
}

function messageBubble(msg) {
  const wrap = document.createElement('div');
  wrap.className = `message ${msg.from === state.me.username ? 'message--me' : msg.kind === 'ai' ? 'message--ai' : ''}`;
  wrap.dataset.id = msg.id;
  const content = document.createElement('div');

  if (msg.deleted) {
    content.textContent = 'Сообщение удалено';
    content.style.opacity = '.7';
  } else if (msg.kind === 'voice' && msg.voice) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = msg.voice;
    content.className = 'message__voice';
    content.appendChild(audio);
    if (msg.text) {
      const text = document.createElement('div');
      text.className = 'message__text';
      text.style.marginTop = '10px';
      text.textContent = msg.text;
      content.appendChild(text);
    }
  } else {
    content.className = 'message__text';
    content.textContent = msg.text;
  }

  const meta = document.createElement('div');
  meta.className = 'message__meta';
  meta.innerHTML = `
    <span>${formatTime(msg.ts)}${msg.edited ? ' • изменено' : ''}</span>
    <span class="message__tools">
      ${msg.from === state.me.username ? '<button class="message__tool" data-act="edit">Ред.</button><button class="message__tool" data-act="delete">Удал.</button>' : ''}
    </span>
  `;
  wrap.appendChild(content);
  wrap.appendChild(meta);

  if (msg.from === state.me.username) {
    meta.querySelector('[data-act="edit"]')?.addEventListener('click', () => editMessage(msg));
    meta.querySelector('[data-act="delete"]')?.addEventListener('click', () => deleteMessage(msg));
  }
  return wrap;
}

function renderMessages() {
  if (!state.peer) return renderEmpty();
  clearMessages();
  if (!state.messages.length) {
    messages.innerHTML = `
      <div class="empty-state">
        <div>
          <div class="empty-state__icon">☍</div>
          <h2>Чат пуст</h2>
          <p>Напиши первое сообщение, чтобы начать диалог.</p>
        </div>
      </div>
    `;
    return;
  }
  state.messages.forEach(msg => messages.appendChild(messageBubble(msg)));
  messages.scrollTop = messages.scrollHeight;
}

function appendMessage(msg) {
  if (!state.peer) return;
  if (msg.from !== state.me.username && msg.from !== state.peer.username) return;
  const empty = messages.querySelector('.empty-state');
  if (empty) empty.remove();
  messages.appendChild(messageBubble(msg));
  messages.scrollTop = messages.scrollHeight;
}

function patchMessage(msg) {
  const node = messages.querySelector(`[data-id="${msg.id}"]`);
  if (!node) return;
  const replacement = messageBubble(msg);
  node.replaceWith(replacement);
}

function aiStream(answer) {
  const bubble = document.createElement('div');
  bubble.className = 'message message--ai';
  const text = document.createElement('div');
  text.className = 'message__text';
  bubble.appendChild(text);
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;

  let i = 0;
  const tick = () => {
    i += Math.max(1, Math.ceil(answer.length / 24));
    text.textContent = answer.slice(0, i);
    messages.scrollTop = messages.scrollHeight;
    if (i < answer.length) requestAnimationFrame(() => setTimeout(tick, 28));
  };
  tick();
}

async function openChat(username) {
  const user = state.users.find(u => u.username === username);
  if (!user) return;
  state.peer = user;
  peerName.textContent = user.displayName || user.username;
  peerMeta.textContent = `@${user.username} ${user.online ? '• онлайн' : '• офлайн'}`;
  peerAvatar.src = avatarFor(user);
  try {
    const data = await api(`/api/chats?with=${encodeURIComponent(username)}`);
    state.messages = data.messages;
    renderMessages();
  } catch (err) {
    state.messages = [];
    renderMessages();
  }
}

function setTyping(text) {
  typingLine.textContent = text || '';
}

function sendTyping(active) {
  if (!state.ws || !state.peer) return;
  state.ws.send(JSON.stringify({ type: 'typing', to: state.peer.username, active }));
}

function connectWS() {
  if (state.ws) {
    try { state.ws.close(); } catch {}
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws.addEventListener('open', () => {
    if (state.token) state.ws.send(JSON.stringify({ type: 'auth', token: state.token }));
  });
  state.ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'auth-ok') {
      state.me = msg.user;
      renderMe();
      return;
    }
    if (msg.type === 'presence') {
      state.users = msg.users || [];
      renderPresence();
      syncPeerMeta();
      return;
    }
    if (msg.type === 'message') {
      const m = msg.message;
      if (state.peer && (m.from === state.peer.username || m.to === state.peer.username || m.from === state.me.username)) {
        if (!state.messages.length || state.messages[0].threadId === m.threadId) {
          const exists = state.messages.find(x => x.id === m.id);
          if (!exists) {
            state.messages.push(m);
            appendMessage(m);
          }
        }
      }
      if (m.from !== state.me.username) playReceiveSound();
      return;
    }
    if (msg.type === 'message-updated') {
      const m = msg.message;
      const idx = state.messages.findIndex(x => x.id === m.id);
      if (idx >= 0) {
        state.messages[idx] = m;
        patchMessage(m);
      }
      return;
    }
    if (msg.type === 'typing') {
      if (state.peer && msg.from === state.peer.username) {
        setTyping(msg.active ? `${state.peer.displayName || state.peer.username} печатает…` : '');
      }
      return;
    }
    if (msg.type === 'error') {
      toast(msg.message);
    }
  });
  state.ws.addEventListener('close', () => {
    setTimeout(() => {
      if (state.token) connectWS();
    }, 1000);
  });
}

function syncPeerMeta() {
  if (!state.peer) return;
  const peer = state.users.find(u => u.username === state.peer.username);
  if (!peer) return;
  state.peer = peer;
  peerName.textContent = peer.displayName || peer.username;
  peerMeta.textContent = `@${peer.username} ${peer.online ? '• онлайн' : '• офлайн'}`;
  peerAvatar.src = avatarFor(peer);
}

function toast(text) {
  setTyping(text);
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => setTyping(''), 2600);
}

function saveAiThread() {
  try {
    const limit = 24;
    if (!Array.isArray(state.aiThread)) state.aiThread = [];
    if (state.aiThread.length > limit) state.aiThread = state.aiThread.slice(-limit);
    localStorage.setItem('novapulse_ai_thread', JSON.stringify(state.aiThread));
  } catch {}
}

function buildAiMessages(prompt) {
  const history = Array.isArray(state.aiThread) ? state.aiThread.slice(-18) : [];
  return [
    { role: 'system', content: 'Отвечай строго на русском языке.' },
    ...history,
    { role: 'user', content: prompt }
  ];
}

async function loadMe() {
  const data = await api('/api/me');
  state.me = data.user;
  renderMe();
}

function renderMe() {
  if (!state.me) return;
  meAvatar.src = avatarFor(state.me);
  meName.textContent = state.me.displayName || state.me.username;
  meStatus.textContent = state.me.online ? 'онлайн' : 'офлайн';
  profileAvatar.src = avatarFor(state.me);
  profileName.textContent = state.me.displayName || state.me.username;
  profileBio.textContent = state.me.bio || 'Био пока не заполнено.';
  $('#editDisplayName').value = state.me.displayName || '';
  $('#editBio').value = state.me.bio || '';
  $('#accentColor').value = state.me.accent || '#7c5cff';
  setTheme(state.me.theme || state.selectedTheme || 'dark-blue');
  applySettings();
}

function showApp() {
  authScreen.classList.add('hidden');
  workspace.classList.remove('hidden');
  setTimeout(() => app.classList.add('is-ready'), 10);
}

function hideApp() {
  workspace.classList.add('hidden');
  authScreen.classList.remove('hidden');
  app.classList.remove('is-ready');
}

async function afterAuth(token) {
  state.token = token;
  localStorage.setItem('novapulse_token', token);
  showApp();
  try {
    await loadMe();
    connectWS();
    await refreshUsers();
    if (state.me && !state.peer && state.users.length) {
      const first = state.users.find(u => u.username !== state.me.username);
      if (first) openChat(first.username);
      else renderEmpty();
    }
  } catch (err) {
    localStorage.removeItem('novapulse_token');
    state.token = '';
    state.me = null;
    state.peer = null;
    hideApp();
    throw err;
  }
}

async function refreshUsers(query = '') {
  if (!state.token) return;
  const data = await api(`/api/users?query=${encodeURIComponent(query)}`);
  state.users = data.users || [];
  renderPresence();
  syncPeerMeta();
}

async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;

  if (state.activeMode === 'ai') {
    messageInput.value = '';

    const localMsg = {
      role: 'user',
      content: text
    };
    state.aiThread.push(localMsg);
    saveAiThread();

    const bubble = document.createElement('div');
    bubble.className = 'message message--me';
    bubble.dataset.pendingAi = '1';
    const textNode = document.createElement('div');
    textNode.className = 'message__text';
    textNode.textContent = text;
    bubble.appendChild(textNode);
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
    playSendSound();

    const aiBubble = document.createElement('div');
    aiBubble.className = 'message message--ai';
    const aiText = document.createElement('div');
    aiText.className = 'message__text';
    aiText.textContent = '';
    aiBubble.appendChild(aiText);
    messages.appendChild(aiBubble);
    messages.scrollTop = messages.scrollHeight;

    try {
      setTyping('ИИ набирает ответ…');
      const response = await api('/api/ai', {
        method: 'POST',
        body: JSON.stringify({ messages: buildAiMessages(text) })
      });
      const answer = response?.choices?.[0]?.message?.content;
      if (typeof answer !== 'string' || !answer.trim()) {
        throw new Error('API вернул пустой ответ.');
      }

      state.aiThread.push({ role: 'assistant', content: answer });
      saveAiThread();

      let i = 0;
      const step = Math.max(1, Math.ceil(answer.length / 24));
      const tick = () => {
        i = Math.min(answer.length, i + step);
        aiText.textContent = answer.slice(0, i);
        messages.scrollTop = messages.scrollHeight;
        if (i < answer.length) {
          requestAnimationFrame(() => setTimeout(tick, 28));
        } else {
          setTyping('');
          playReceiveSound();
        }
      };
      tick();
    } catch (err) {
      setTyping('');
      aiText.textContent = `Ошибка AI: ${err?.message || 'неизвестная ошибка'}`;
      aiBubble.classList.add('message--error');
      messages.scrollTop = messages.scrollHeight;
      playReceiveSound();
    }
    return;
  }

  if (!state.peer) return;
  const payload = {
    type: 'message',
    to: state.peer.username,
    text,
    kind: 'text',
    replyTo: state.replyTo
  };
  state.ws?.send(JSON.stringify(payload));
  messageInput.value = '';
  state.replyTo = null;
  playSendSound();
}

function addLocalMeMessage(text) {
  const msg = {
    id: `local-${Date.now()}`,
    from: state.me.username,
    to: state.me.username,
    kind: 'text',
    text,
    ts: new Date().toISOString(),
    edited: false,
    deleted: false
  };
  state.messages.push(msg);
  appendMessage(msg);
}

function editMessage(msg) {
  const text = prompt('Редактировать сообщение', msg.text || '');
  if (text === null) return;
  state.ws?.send(JSON.stringify({ type: 'edit-message', id: msg.id, text }));
  playSendSound();
}

function deleteMessage(msg) {
  if (!confirm('Удалить сообщение?')) return;
  state.ws?.send(JSON.stringify({ type: 'delete-message', id: msg.id }));
  playSendSound();
}

function playSendSound() { tone(520, 0.08, 'triangle'); }
function playReceiveSound() { tone(320, 0.08, 'sine'); }
function playHoverSound() { tone(220, 0.04, 'sine'); }

async function startVoiceNote() {
  try {
    initAudio();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onload = () => {
        const payload = {
          type: 'message',
          to: state.peer.username,
          kind: 'voice',
          text: 'Голосовое сообщение',
          voice: reader.result
        };
        state.ws?.send(JSON.stringify(payload));
        playSendSound();
      };
      reader.readAsDataURL(blob);
    };
    recorder.start();
    voiceBtn.textContent = '⏹';
    setTyping('Идёт запись голосового…');
    setTimeout(() => {
      if (recorder.state !== 'inactive') {
        recorder.stop();
        voiceBtn.textContent = '🎙';
        setTyping('');
      }
    }, 6000);
  } catch {
    toast('Не удалось получить доступ к микрофону.');
  }
}

messageInput.addEventListener('input', () => {
  if (!state.peer || state.activeMode === 'ai') return;
  clearTimeout(state.typingTimer);
  sendTyping(true);
  state.typingTimer = setTimeout(() => sendTyping(false), 700);
});

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

$('#sendBtn').addEventListener('click', sendMessage);
$('#voiceBtn').addEventListener('click', startVoiceNote);
$('#addUserBtn').addEventListener('click', () => { addUserModal.classList.remove('hidden'); $('#addUserInput').focus(); });
$('#closeAddUserModal').addEventListener('click', () => addUserModal.classList.add('hidden'));
$('#addUserConfirm').addEventListener('click', async () => {
  const value = $('#addUserInput').value.trim();
  if (!value) return;
  addUserModal.classList.add('hidden');
  await refreshUsers(value);
  const user = state.users.find(u => u.username === value.toLowerCase() || u.displayName.toLowerCase() === value.toLowerCase());
  if (user) openChat(user.username);
  else toast('Пользователь не найден.');
});
$('#openAiBtn').addEventListener('click', () => {
  state.activeMode = 'ai';
  $('#aiModeBtn').classList.add('is-active');
  $('#textModeBtn').classList.remove('is-active');
  peerName.textContent = 'AI Ассистент';
  peerMeta.textContent = 'Русский режим • без автоспама';
  peerAvatar.src = avatarFor({ username: 'ai', displayName: 'AI', accent: '#26d0ff' });
  renderEmpty();
});
$('#textModeBtn').addEventListener('click', () => {
  state.activeMode = 'chat';
  $('#textModeBtn').classList.add('is-active');
  $('#aiModeBtn').classList.remove('is-active');
  if (state.peer) openChat(state.peer.username);
});
$('#aiModeBtn').addEventListener('click', () => $('#openAiBtn').click());

$('#settingsToggle').addEventListener('click', () => $('#profileModal').classList.remove('hidden'));
$('#openProfileBtn').addEventListener('click', () => $('#profileModal').classList.remove('hidden'));
$('#closeProfileModal').addEventListener('click', () => $('#profileModal').classList.add('hidden'));
$('#saveProfileBtn').addEventListener('click', async () => {
  const payload = {
    displayName: $('#editDisplayName').value.trim(),
    bio: $('#editBio').value.trim(),
    accent: $('#accentColor').value,
    theme: state.selectedTheme
  };
  const res = await api('/api/me', { method: 'PATCH', body: JSON.stringify(payload) });
  state.me = res.user;
  renderMe();
  $('#profileModal').classList.add('hidden');
});

$('#avatarInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const dataUrl = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  const res = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ avatar: dataUrl }) });
  state.me = res.user;
  renderMe();
});

$$('.theme-chip').forEach(btn => btn.addEventListener('click', async () => {
  const theme = btn.dataset.theme;
  setTheme(theme);
  if (state.me) {
    const res = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ theme }) });
    state.me = res.user;
    renderMe();
  }
}));

$('#logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('novapulse_token');
  state.token = '';
  state.me = null;
  state.peer = null;
  if (state.ws) state.ws.close();
  hideApp();
});

$('#refreshUsersBtn').addEventListener('click', () => refreshUsers(searchInput.value.trim()));
$('#searchInput').addEventListener('input', async () => {
  const q = searchInput.value.trim();
  const data = await api(`/api/users?query=${encodeURIComponent(q)}`).catch(() => ({ users: [] }));
  renderSearchResults(data.users || []);
});
$('#searchInput').addEventListener('focus', () => {
  const q = searchInput.value.trim();
  if (q) $('#searchInput').dispatchEvent(new Event('input'));
});
document.addEventListener('click', (e) => {
  if (!searchResults.contains(e.target) && e.target !== searchInput) {
    searchResults.classList.remove('is-open');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchInput.focus();
  }
  if (e.key === 'Escape') {
    searchResults.classList.remove('is-open');
    $('.modal:not(.hidden)')?.classList.add('hidden');
  }
});
$('#attachBtn').addEventListener('click', () => toast('Вложения подключаются через серверный API.'));
$('#musicVolume').addEventListener('input', e => setMusicVolume(e.target.value));
$('#sfxVolume').addEventListener('input', e => setSfxVolume(e.target.value));
$('#muteMusic').addEventListener('change', e => setMusicVolume(e.target.checked ? 0 : (state.settings.musicVolume || 0.12)));

$$('.auth__tab').forEach(tab => tab.addEventListener('click', () => {
  $$('.auth__tab').forEach(x => x.classList.remove('is-active'));
  tab.classList.add('is-active');
  const mode = tab.dataset.authTab;
  loginForm.classList.toggle('is-active', mode === 'login');
  registerForm.classList.toggle('is-active', mode === 'register');
}));

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  initAudio();
  const form = new FormData(loginForm);
  const data = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({
      username: form.get('username'),
      password: form.get('password')
    })
  });
  if (form.get('remember')) localStorage.setItem('novapulse_token', data.token);
  await afterAuth(data.token);
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  initAudio();
  const form = new FormData(registerForm);
  const data = await api('/api/register', {
    method: 'POST',
    body: JSON.stringify({
      username: form.get('username'),
      password: form.get('password'),
      displayName: form.get('displayName'),
      bio: form.get('bio')
    })
  });
  localStorage.setItem('novapulse_token', data.token);
  await afterAuth(data.token);
});

$('#googleBtn').addEventListener('click', () => {
  googleModal.classList.remove('hidden');
});
$('#closeGoogleModal').addEventListener('click', () => googleModal.classList.add('hidden'));
$('#confirmGoogleLogin').addEventListener('click', async () => {
  googleModal.classList.add('hidden');
  initAudio();
  const fakeName = `google_${Math.random().toString(36).slice(2, 7)}`;
  const data = await api('/api/register', {
    method: 'POST',
    body: JSON.stringify({
      username: fakeName,
      password: `G-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      displayName: 'Google Пользователь',
      bio: 'Вход через имитацию OAuth.'
    })
  });
  localStorage.setItem('novapulse_token', data.token);
  await afterAuth(data.token);
});

async function boot() {
  applySettings();
  setTheme(state.selectedTheme);
  app.classList.add('is-ready');
  try {
    const rawAi = localStorage.getItem('novapulse_ai_thread');
    state.aiThread = safeJson(rawAi, []);
    if (!Array.isArray(state.aiThread)) state.aiThread = [];
  } catch {
    state.aiThread = [];
  }
  setTimeout(() => {
    loader.classList.add('hide');
    setTimeout(() => loader.remove(), 800);
  }, 2000);

  try {
    if (state.token) {
      showApp();
      await loadMe();
      connectWS();
      await refreshUsers();
      if (state.users.length) {
        const first = state.users.find(u => u.username !== state.me.username);
        if (first) openChat(first.username);
      }
    }
  } catch {
    localStorage.removeItem('novapulse_token');
    state.token = '';
    state.me = null;
    state.peer = null;
    hideApp();
  }
}

boot();
