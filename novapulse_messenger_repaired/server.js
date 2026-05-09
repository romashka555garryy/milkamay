const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env'));

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data', 'store.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

function ensureStore() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [], sessions: {}, messages: [], meta: { createdAt: new Date().toISOString() } }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { users: [], sessions: {}, messages: [], meta: { createdAt: new Date().toISOString() } };
  }
}

let store = readStore();
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  }, 50);
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function normalizeUsername(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '');
}

function displayName(name) {
  return String(name || '').trim().slice(0, 32);
}

function slugifyThread(a, b) {
  return [normalizeUsername(a), normalizeUsername(b)].sort().join('__');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const calc = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
}

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio || '',
    avatar: user.avatar || '',
    theme: user.theme || 'dark-blue',
    accent: user.accent || '#7c5cff',
    online: !!user.online,
    lastSeen: user.lastSeen || null,
    settings: user.settings || {}
  };
}

function authFromReq(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const userId = store.sessions[token];
  if (!userId) return null;
  const user = store.users.find(u => u.id === userId);
  return user || null;
}

function currentChat(withUser, self) {
  const threadId = slugifyThread(withUser.username, self.username);
  return store.messages
    .filter(m => m.threadId === threadId)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
    .slice(-500)
    .map(m => ({
      id: m.id,
      threadId: m.threadId,
      from: m.from,
      to: m.to,
      kind: m.kind,
      text: m.text,
      voice: m.voice || '',
      replyTo: m.replyTo || null,
      edited: !!m.edited,
      deleted: !!m.deleted,
      ts: m.ts
    }));
}

function setOnline(userId, online) {
  const user = store.users.find(u => u.id === userId);
  if (user) {
    user.online = online;
    user.lastSeen = online ? null : new Date().toISOString();
    saveStore();
  }
}

function safeSearch(q) {
  const query = normalizeUsername(q);
  return store.users
    .filter(u => normalizeUsername(u.username).includes(query) || normalizeUsername(u.displayName).includes(query))
    .slice(0, 30)
    .map(publicUser);
}

async function callAI(messages) {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('Не настроен API-ключ AI. Добавь OPENROUTER_API_KEY в .env.');
    err.statusCode = 500;
    throw err;
  }

  const provider = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();
  const model = process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL || 'openai/gpt-4o-mini';
  const url = provider === 'openai'
    ? 'https://api.openai.com/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };

  if (provider !== 'openai') {
    headers['HTTP-Referer'] = process.env.APP_URL || `http://localhost:${PORT}`;
    headers['X-Title'] = 'NovaPulse Messenger';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      stream: false
    })
  });

  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { error: { message: raw || 'Пустой ответ AI API.' } };
  }

  if (!response.ok) {
    const err = new Error(data?.error?.message || `AI API вернул ошибку ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    const err = new Error('AI API вернул неожиданный формат ответа.');
    err.statusCode = 502;
    throw err;
  }

  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content
        }
      }
    ],
    usage: data.usage || null,
    raw: data
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/') {
    const file = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/public/')) {
    const filePath = path.join(ROOT, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    json(res, 200, { ok: true, now: new Date().toISOString() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/register') {
    try {
      const body = await readBody(req);
      const username = normalizeUsername(body.username);
      const password = String(body.password || '');
      const display = displayName(body.displayName || body.username);
      if (username.length < 3) return json(res, 400, { error: 'Слишком короткий юзернейм.' });
      if (password.length < 6) return json(res, 400, { error: 'Пароль должен быть не короче 6 символов.' });
      if (store.users.some(u => normalizeUsername(u.username) === username)) {
        return json(res, 409, { error: 'Пользователь уже существует.' });
      }
      const { salt, hash } = hashPassword(password);
      const user = {
        id: uuid(),
        username,
        displayName: display,
        salt,
        passwordHash: hash,
        bio: body.bio ? String(body.bio).slice(0, 180) : '',
        avatar: body.avatar || '',
        theme: body.theme || 'dark-blue',
        accent: body.accent || '#7c5cff',
        online: true,
        lastSeen: null,
        settings: {
          soundVolume: 0.18,
          musicVolume: 0.12,
          motion: true,
          density: 'comfortable'
        },
        createdAt: new Date().toISOString()
      };
      store.users.push(user);
      const token = createToken();
      store.sessions[token] = user.id;
      saveStore();
      json(res, 200, { token, user: publicUser(user) });
    } catch (err) {
      json(res, 500, { error: 'Не удалось зарегистрировать пользователя.' });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    try {
      const body = await readBody(req);
      const username = normalizeUsername(body.username);
      const password = String(body.password || '');
      const user = store.users.find(u => normalizeUsername(u.username) === username);
      if (!user) return json(res, 404, { error: 'Пользователь не найден.' });
      if (!verifyPassword(password, user.salt, user.passwordHash)) {
        return json(res, 401, { error: 'Неверный пароль.' });
      }
      const token = createToken();
      store.sessions[token] = user.id;
      user.online = true;
      user.lastSeen = null;
      saveStore();
      json(res, 200, { token, user: publicUser(user) });
    } catch (err) {
      json(res, 500, { error: 'Не удалось войти.' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    const user = authFromReq(req);
    if (!user) return json(res, 401, { error: 'Не авторизован.' });
    json(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === 'PATCH' && pathname === '/api/me') {
    const user = authFromReq(req);
    if (!user) return json(res, 401, { error: 'Не авторизован.' });
    try {
      const body = await readBody(req);
      if (body.displayName !== undefined) user.displayName = displayName(body.displayName);
      if (body.bio !== undefined) user.bio = String(body.bio).slice(0, 180);
      if (body.avatar !== undefined) user.avatar = String(body.avatar);
      if (body.theme !== undefined) user.theme = String(body.theme);
      if (body.accent !== undefined) user.accent = String(body.accent);
      if (body.settings !== undefined) {
        user.settings = { ...user.settings, ...body.settings };
      }
      saveStore();
      json(res, 200, { user: publicUser(user) });
    } catch {
      json(res, 500, { error: 'Не удалось сохранить профиль.' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/users') {
    const user = authFromReq(req);
    if (!user) return json(res, 401, { error: 'Не авторизован.' });
    const q = url.searchParams.get('query') || '';
    json(res, 200, { users: safeSearch(q).filter(u => u.username !== user.username) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/chats') {
    const user = authFromReq(req);
    if (!user) return json(res, 401, { error: 'Не авторизован.' });
    const withName = normalizeUsername(url.searchParams.get('with') || '');
    const withUser = store.users.find(u => normalizeUsername(u.username) === withName);
    if (!withUser) return json(res, 404, { error: 'Собеседник не найден.' });
    json(res, 200, { messages: currentChat(withUser, user), peer: publicUser(withUser) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/ai') {
    const user = authFromReq(req);
    if (!user) return json(res, 401, { error: 'Не авторизован.' });
    try {
      const body = await readBody(req).catch(() => ({}));
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length) {
        return json(res, 400, { error: 'Пустой AI-запрос.' });
      }
      const data = await callAI(messages);
      json(res, 200, data);
    } catch (err) {
      json(res, err.statusCode || 500, { error: err.message || 'Не удалось получить ответ AI.' });
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Map(); // ws -> user
function broadcast(payload, onlyUsernames = null) {
  const data = JSON.stringify(payload);
  for (const [ws, user] of clients.entries()) {
    if (ws.readyState !== 1 || !user) continue;
    if (onlyUsernames && !onlyUsernames.includes(user.username)) continue;
    ws.send(data);
  }
}

function sendPresence() {
  const presence = store.users.map(publicUser);
  broadcast({ type: 'presence', users: presence });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', (raw) => {
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || !msg.type) return;

    if (msg.type === 'auth') {
      const userId = store.sessions[msg.token];
      const user = store.users.find(u => u.id === userId);
      if (!user) {
        ws.send(JSON.stringify({ type: 'error', message: 'Не удалось авторизоваться по токену.' }));
        return;
      }
      clients.set(ws, user);
      user.online = true;
      user.lastSeen = null;
      saveStore();
      ws.send(JSON.stringify({ type: 'auth-ok', user: publicUser(user), token: msg.token }));
      sendPresence();
      return;
    }

    const user = clients.get(ws);
    if (!user) {
      ws.send(JSON.stringify({ type: 'error', message: 'Нужно войти в аккаунт.' }));
      return;
    }

    if (msg.type === 'message') {
      const toName = normalizeUsername(msg.to || '');
      const toUser = store.users.find(u => normalizeUsername(u.username) === toName);
      if (!toUser) {
        ws.send(JSON.stringify({ type: 'error', message: 'Собеседник не найден.' }));
        return;
      }
      const text = String(msg.text || '').slice(0, 8000);
      const threadId = slugifyThread(user.username, toUser.username);
      const item = {
        id: uuid(),
        threadId,
        from: user.username,
        to: toUser.username,
        kind: msg.kind === 'voice' ? 'voice' : 'text',
        text,
        voice: msg.voice || '',
        replyTo: msg.replyTo || null,
        edited: false,
        deleted: false,
        ts: new Date().toISOString()
      };
      store.messages.push(item);
      saveStore();

      const payload = { type: 'message', message: item };
      broadcast(payload, [user.username, toUser.username]);
      return;
    }

    if (msg.type === 'typing') {
      const toName = normalizeUsername(msg.to || '');
      const toUser = store.users.find(u => normalizeUsername(u.username) === toName);
      if (toUser) {
        broadcast({ type: 'typing', from: user.username, to: toUser.username, active: !!msg.active }, [toUser.username]);
      }
      return;
    }

    if (msg.type === 'edit-message') {
      const item = store.messages.find(m => m.id === msg.id && m.from === user.username);
      if (!item) return;
      item.text = String(msg.text || '').slice(0, 8000);
      item.edited = true;
      saveStore();
      broadcast({ type: 'message-updated', message: item }, [item.from, item.to]);
      return;
    }

    if (msg.type === 'delete-message') {
      const item = store.messages.find(m => m.id === msg.id && m.from === user.username);
      if (!item) return;
      item.deleted = true;
      item.text = '';
      item.voice = '';
      saveStore();
      broadcast({ type: 'message-updated', message: item }, [item.from, item.to]);
      return;
    }
  });

  ws.on('close', () => {
    const user = clients.get(ws);
    if (user) {
      clients.delete(ws);
      setOnline(user.id, false);
      sendPresence();
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      const user = clients.get(ws);
      if (user) {
        clients.delete(ws);
        setOnline(user.id, false);
      }
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`NovaPulse запущен: http://localhost:${PORT}`);
});
