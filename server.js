// Claude Console: a self-hosted team chat for Anthropic-format APIs (Tokenhot by default).
const path = require('node:path');
const express = require('express');
const { db, getSetting, setSetting, tx } = require('./src/db');
const sec = require('./src/security');
const { authHeaders, endpointFor, readJsonReply, readOpenAIStream, toOpenAIMessages, openStream, readStream, finalizeBlocks, newStreamState } = require('./src/upstream');

const ON_RAILWAY = !!(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (ON_RAILWAY ? '0.0.0.0' : '127.0.0.1');
const SETUP_TOKEN = process.env.SETUP_TOKEN || '';
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === '1' || ON_RAILWAY);

// ---------- Built-in default API key ----------
// Added once on first start (Tokenhot endpoint). Edit, replace or delete it in Admin > API keys;
// once removed it is not re-added. Set the DEFAULT_API_KEY variable to override this value.
const BUILT_IN_KEY = 'sk-2XlV77FHYySmp2caifBX6NrK3EWNzNR4x22tI71KtXS0f5Cc';
(function seedDefaultKey() {
  const key = (process.env.DEFAULT_API_KEY || BUILT_IN_KEY).trim();
  if (!key || getSetting('default_key_seeded') === '1') return;
  const existing = db.prepare('SELECT id, key_enc FROM api_keys').all();
  const already = existing.some(k => { try { return sec.decrypt(k.key_enc) === key; } catch { return false; } });
  if (!already) {
    tx(() => {
      db.prepare('UPDATE api_keys SET priority = priority + 1').run();
      db.prepare('INSERT INTO api_keys (label, key_enc, key_hint, endpoint, priority, created_at) VALUES (?,?,?,?,?,?)')
        .run('Default (Tokenhot)', sec.encrypt(key), `…${key.slice(-4)}`, null, 0, Date.now());
    });
    console.log('  Added the default API key (Tokenhot). Manage it in Admin > API keys.');
  }
  setSetting('default_key_seeded', '1');
})();

// Read a variable tolerantly: trims spaces and stray surrounding quotes from pasted values.
const envVal = (name) => {
  const v = process.env[name] ?? process.env[name.toLowerCase()];
  return v == null ? '' : String(v).trim().replace(/^(['"])(.*)\1$/, '$2').trim();
};
const ADMIN_USERNAME = envVal('ADMIN_USERNAME');
const ADMIN_PASSWORD = envVal('ADMIN_PASSWORD');

// What the server can see (booleans only, never values) to help diagnose hosted installs.
function envReport() {
  return {
    railway: ON_RAILWAY,
    service: process.env.RAILWAY_SERVICE_NAME || null,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
    ADMIN_USERNAME: !!ADMIN_USERNAME,
    ADMIN_PASSWORD: !!ADMIN_PASSWORD,
    passwordLongEnough: ADMIN_PASSWORD.length >= 10,
    usernameValid: /^[a-zA-Z0-9._-]{3,32}$/.test(ADMIN_USERNAME),
    SETUP_TOKEN: !!SETUP_TOKEN,
    APP_SECRET: !!process.env.APP_SECRET,
    volume: process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
    adminLikeVars: Object.keys(process.env).filter(k => /admin|setup/i.test(k)),
  };
}

// Create the first admin from environment variables (safest for hosted installs).
let bootstrapProblem = null;
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  const r = envReport();
  console.log('\n  Startup check:', JSON.stringify(r));
  if (ADMIN_USERNAME || ADMIN_PASSWORD) {
    if (!ADMIN_USERNAME) bootstrapProblem = 'ADMIN_PASSWORD is set but ADMIN_USERNAME is missing.';
    else if (!ADMIN_PASSWORD) bootstrapProblem = 'ADMIN_USERNAME is set but ADMIN_PASSWORD is missing.';
    else if (!r.usernameValid) bootstrapProblem = 'ADMIN_USERNAME must be 3-32 letters, numbers, dots, dashes or underscores (no spaces).';
    else if (!r.passwordLongEnough) bootstrapProblem = 'ADMIN_PASSWORD must be at least 10 characters.';
    else {
      db.prepare('INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?)')
        .run(ADMIN_USERNAME, ADMIN_USERNAME, sec.hashPassword(ADMIN_PASSWORD), 'admin', Date.now());
      console.log(`  Created admin account "${ADMIN_USERNAME}" from environment variables.`);
    }
    if (bootstrapProblem) console.error('  Admin not created: ' + bootstrapProblem);
  }
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.json({ limit: '40mb' }));
app.use(sec.sessionMiddleware);
app.use('/api', sec.csrfGuard);

// Front-end libraries served from node_modules (works offline).
const nm = (p) => path.join(__dirname, 'node_modules', p);
app.get('/vendor/marked.js', (req, res) => res.sendFile(nm('marked/lib/marked.umd.js')));
app.get('/vendor/purify.js', (req, res) => res.sendFile(nm('dompurify/dist/purify.min.js')));
app.get('/vendor/highlight.js', (req, res) => res.sendFile(nm('@highlightjs/cdn-assets/highlight.min.js')));
app.get('/vendor/highlight.css', (req, res) => res.sendFile(nm('@highlightjs/cdn-assets/styles/github-dark-dimmed.min.css')));

// Page routing by role.
const page = (f) => path.join(__dirname, 'public', f);
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/', (req, res) => res.redirect(req.user ? '/chat' : '/login'));
app.get('/login', (req, res) => req.user ? res.redirect('/chat') : res.sendFile(page('login.html')));
app.get('/chat', (req, res) => req.user ? res.sendFile(page('chat.html')) : res.redirect('/login'));
app.get('/admin', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') return res.redirect('/chat');
  res.sendFile(page('admin.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---------- helpers ----------
const now = () => Date.now();
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const J = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

function publicUser(u) {
  return {
    id: u.id, username: u.username, display_name: u.display_name, role: u.role, active: !!u.active,
    limit_mode: u.limit_mode, daily_cost_limit: u.daily_cost_limit, monthly_cost_limit: u.monthly_cost_limit,
    daily_token_limit: u.daily_token_limit, monthly_token_limit: u.monthly_token_limit,
    allowed_models: J(u.allowed_models, []), allow_web_search: !!u.allow_web_search, allow_thinking: !!u.allow_thinking,
    created_at: u.created_at, last_login_at: u.last_login_at,
  };
}

function periodStarts() {
  const d = new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return { day, month };
}

function usageTotals(userId) {
  const { day, month } = periodStarts();
  const q = db.prepare(`SELECT COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(input_tokens + output_tokens),0) AS tokens
                        FROM usage WHERE user_id = ? AND created_at >= ?`);
  return { today: q.get(userId, day), month: q.get(userId, month) };
}

const money = (n) => n >= 1 ? n.toFixed(2) : n.toFixed(4);
function limitProblem(user) {
  if (user.role === 'admin' || user.limit_mode === 'none') return null;
  const t = usageTotals(user.id);
  const checkCost = user.limit_mode === 'cost' || user.limit_mode === 'both';
  const checkTokens = user.limit_mode === 'tokens' || user.limit_mode === 'both';
  if (checkCost && user.daily_cost_limit != null && t.today.cost >= user.daily_cost_limit)
    return `You've reached your daily limit of $${money(user.daily_cost_limit)}. It resets at midnight.`;
  if (checkCost && user.monthly_cost_limit != null && t.month.cost >= user.monthly_cost_limit)
    return `You've reached your monthly limit of $${money(user.monthly_cost_limit)}. Ask an admin to raise it.`;
  if (checkTokens && user.daily_token_limit != null && t.today.tokens >= user.daily_token_limit)
    return `You've reached your daily limit of ${user.daily_token_limit.toLocaleString()} tokens. It resets at midnight.`;
  if (checkTokens && user.monthly_token_limit != null && t.month.tokens >= user.monthly_token_limit)
    return `You've reached your monthly limit of ${user.monthly_token_limit.toLocaleString()} tokens. Ask an admin to raise it.`;
  return null;
}

function modelsFor(user) {
  const all = db.prepare('SELECT * FROM models WHERE enabled = 1 ORDER BY sort, label').all();
  if (user.role === 'admin') return all;
  const allowed = J(user.allowed_models, []);
  return allowed.length ? all.filter(m => allowed.includes(m.id)) : all;
}

function computeCost(model, usage) {
  const inP = model?.input_price || 0, outP = model?.output_price || 0;
  const wsP = Number(getSetting('web_search_price_per_1000') || 10);
  return ((usage.input_tokens + usage.cache_write * 1.25 + usage.cache_read * 0.1) * inP
        + usage.output_tokens * outP) / 1e6 + usage.web_searches * wsP / 1000;
}

function ownChat(req, res) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(Number(req.params.id));
  if (!chat || chat.user_id !== req.user.id) { bad(res, 'Chat not found.', 404); return null; }
  return chat;
}

function cleanBlocks(content) {
  if (!Array.isArray(content) || content.length === 0) return null;
  const out = [];
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text, ...(b.filename ? { filename: String(b.filename) } : {}) });
    else if (b?.type === 'image' && b.source?.type === 'base64' && /^image\/(png|jpeg|gif|webp)$/.test(b.source.media_type))
      out.push({ type: 'image', source: { type: 'base64', media_type: b.source.media_type, data: String(b.source.data) }, ...(b.filename ? { filename: String(b.filename) } : {}) });
    else if (b?.type === 'document' && b.source?.type === 'base64' && b.source.media_type === 'application/pdf')
      out.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: String(b.source.data) }, ...(b.filename ? { filename: String(b.filename) } : {}) });
  }
  return out.length ? out : null;
}

// Build API messages from stored history: strip our extra fields, keep only text for assistant turns,
// and merge back-to-back user turns (left behind by failed requests).
function buildApiMessages(chatId) {
  const rows = db.prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id').all(chatId);
  const msgs = [];
  for (const r of rows) {
    const blocks = J(r.content, []);
    let content;
    if (r.role === 'user') {
      content = blocks.map(b => {
        if (b.type === 'text') return { type: 'text', text: b.filename ? `<file name="${b.filename}">\n${b.text}\n</file>` : b.text };
        const { filename, ...rest } = b; return rest;
      });
    } else {
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      if (!text) continue; // skip empty/stopped replies
      content = [{ type: 'text', text }];
    }
    const last = msgs[msgs.length - 1];
    if (last && last.role === r.role) last.content.push(...content);
    else msgs.push({ role: r.role, content });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  // Text-only turns as plain strings, exactly like the provider's curl example.
  for (const m of msgs) if (m.content.every(b => b.type === 'text')) m.content = m.content.map(b => b.text).join('\n\n');
  return msgs;
}

// ---------- setup & auth ----------
app.get('/api/setup-status', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res.json({ needsSetup: n === 0, tokenRequired: n === 0 && (!!SETUP_TOKEN || ON_RAILWAY), notice: getSetting('staff_notice') || '',
    ...(n === 0 ? { env: envReport(), problem: bootstrapProblem } : {}) });
});

app.post('/api/setup', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return bad(res, 'Setup is already done.', 409);
  const { username, password, display_name, setup_token } = req.body || {};
  // On a public host, the setup page must not be open to whoever finds the URL first.
  if (ON_RAILWAY && !SETUP_TOKEN) return bad(res, 'Set the ADMIN_USERNAME and ADMIN_PASSWORD (or SETUP_TOKEN) variables in Railway, then redeploy.', 403);
  if (SETUP_TOKEN && setup_token !== SETUP_TOKEN) return bad(res, 'The setup token is wrong.', 403);
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username || '')) return bad(res, 'Username must be 3–32 letters, numbers, dots, dashes or underscores.');
  if (!password || password.length < 10) return bad(res, 'Password must be at least 10 characters.');
  const r = db.prepare('INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?)')
    .run(username, display_name || username, sec.hashPassword(password), 'admin', now());
  sec.setSessionCookie(req, res, sec.createSession(Number(r.lastInsertRowid)));
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const throttleKey = `${String(username).toLowerCase()}|${req.ip}`;
  if (sec.loginThrottled(throttleKey)) return bad(res, 'Too many failed attempts. Wait 15 minutes and try again.', 429);
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!u || !sec.verifyPassword(String(password || ''), u.password_hash)) {
    sec.recordFailedLogin(throttleKey);
    return bad(res, 'Wrong username or password.', 401);
  }
  if (!u.active) return bad(res, 'This account is disabled. Contact your admin.', 403);
  sec.clearLoginAttempts(throttleKey);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), u.id);
  sec.setSessionCookie(req, res, sec.createSession(u.id));
  res.json({ ok: true, role: u.role });
});

app.post('/api/logout', (req, res) => {
  if (req.user) sec.destroySession(req.user.session_token);
  sec.clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- current user ----------
app.get('/api/me', sec.requireUser, (req, res) => {
  res.json({
    user: publicUser(req.user),
    models: modelsFor(req.user).map(m => ({ id: m.id, label: m.label, input_price: m.input_price, output_price: m.output_price, max_tokens: m.max_tokens, api_format: m.api_format })),
    default_system_prompt: getSetting('default_system_prompt') || '',
    notice: getSetting('staff_notice') || '',
  });
});

app.post('/api/me/password', sec.requireUser, (req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!sec.verifyPassword(String(current || ''), u.password_hash)) return bad(res, 'Your current password is wrong.');
  if (!next || next.length < 10) return bad(res, 'New password must be at least 10 characters.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(sec.hashPassword(next), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(u.id, req.user.session_token);
  res.json({ ok: true });
});

app.get('/api/me/usage', sec.requireUser, (req, res) => {
  const t = usageTotals(req.user.id);
  const since = now() - 30 * 86400000;
  const daily = db.prepare(`SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch', 'localtime') AS day,
      SUM(cost) AS cost, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, COUNT(*) AS requests
      FROM usage WHERE user_id = ? AND created_at >= ? GROUP BY day ORDER BY day`).all(req.user.id, since);
  const byModel = db.prepare(`SELECT model, SUM(cost) AS cost, SUM(input_tokens + output_tokens) AS tokens, COUNT(*) AS requests
      FROM usage WHERE user_id = ? AND created_at >= ? GROUP BY model ORDER BY cost DESC`).all(req.user.id, since);
  res.json({ totals: t, daily, byModel, user: publicUser(req.user) });
});

// ---------- chats ----------
app.get('/api/chats', sec.requireUser, (req, res) => {
  const q = String(req.query.q || '').trim();
  let rows;
  if (q) {
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
    rows = db.prepare(`SELECT DISTINCT c.id, c.title, c.updated_at FROM chats c
        LEFT JOIN messages m ON m.chat_id = c.id
        WHERE c.user_id = ? AND (c.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')
        ORDER BY c.updated_at DESC LIMIT 200`).all(req.user.id, like, like);
  } else {
    rows = db.prepare('SELECT id, title, updated_at FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500').all(req.user.id);
  }
  res.json({ chats: rows });
});

app.post('/api/chats', sec.requireUser, (req, res) => {
  const { model, system_prompt } = req.body || {};
  const r = db.prepare('INSERT INTO chats (user_id, title, system_prompt, model, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(req.user.id, 'New chat', String(system_prompt ?? getSetting('default_system_prompt') ?? ''), model || null, now(), now());
  res.json({ id: Number(r.lastInsertRowid) });
});

app.get('/api/chats/:id', sec.requireUser, (req, res) => {
  const chat = ownChat(req, res); if (!chat) return;
  const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id').all(chat.id)
    .map(m => ({ ...m, content: J(m.content, []) }));
  res.json({ chat, messages });
});

app.patch('/api/chats/:id', sec.requireUser, (req, res) => {
  const chat = ownChat(req, res); if (!chat) return;
  const { title, system_prompt, model } = req.body || {};
  db.prepare('UPDATE chats SET title = ?, system_prompt = ?, model = ? WHERE id = ?').run(
    title != null ? String(title).slice(0, 120) || 'Untitled' : chat.title,
    system_prompt != null ? String(system_prompt) : chat.system_prompt,
    model != null ? String(model) : chat.model, chat.id);
  res.json({ ok: true });
});

app.delete('/api/chats/:id', sec.requireUser, (req, res) => {
  const chat = ownChat(req, res); if (!chat) return;
  db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
  res.json({ ok: true });
});

// The main event: send a message (or regenerate / edit) and stream the reply.
app.post('/api/chats/:id/send', sec.requireUser, async (req, res) => {
  const chat = ownChat(req, res); if (!chat) return;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const body = req.body || {};

  const model = modelsFor(user).find(m => m.id === body.model);
  if (!model) return bad(res, 'That model is not available to you. Pick another from the menu.');
  const limit = limitProblem(user);
  if (limit) return bad(res, limit, 429);
  const wantThinking = !!body.thinking && (user.role === 'admin' || user.allow_thinking);
  const wantSearch = !!body.webSearch && (user.role === 'admin' || user.allow_web_search);

  // Apply the history change: edit, regenerate, or append.
  try {
    tx(() => {
      if (body.editMessageId) {
        const m = db.prepare('SELECT id, role FROM messages WHERE id = ? AND chat_id = ?').get(Number(body.editMessageId), chat.id);
        if (!m || m.role !== 'user') throw new Error('That message cannot be edited.');
        db.prepare('DELETE FROM messages WHERE chat_id = ? AND id >= ?').run(chat.id, m.id);
      }
      if (body.regenerate) {
        const lastUser = db.prepare("SELECT id FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(chat.id);
        if (!lastUser) throw new Error('There is nothing to regenerate yet.');
        db.prepare('DELETE FROM messages WHERE chat_id = ? AND id > ?').run(chat.id, lastUser.id);
      } else {
        const blocks = cleanBlocks(body.content);
        if (!blocks) throw new Error('Type a message or attach a file first.');
        db.prepare('INSERT INTO messages (chat_id, role, content, created_at) VALUES (?,?,?,?)')
          .run(chat.id, 'user', JSON.stringify(blocks), now());
        if (chat.title === 'New chat') {
          const t = blocks.find(b => b.type === 'text' && !b.filename)?.text || blocks.find(b => b.filename)?.filename || 'New chat';
          db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(t.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat', chat.id);
        }
      }
      db.prepare('UPDATE chats SET updated_at = ?, model = ? WHERE id = ?').run(now(), model.id, chat.id);
    });
  } catch (e) { return bad(res, e.message); }

  const messages = buildApiMessages(chat.id);
  if (!messages.length) return bad(res, 'There is no message to send.');

  const isOpenAI = model.api_format === 'openai';
  const budget = Math.max(1024, Math.min(Number(body.thinkingBudget) || 8000, 64000));
  const system = chat.system_prompt?.trim();
  let payload;
  if (isOpenAI) {
    // OpenAI chat/completions: max tokens left to the provider's default (parameter names differ by model family).
    payload = { model: model.id, messages: toOpenAIMessages(messages, system) };
  } else {
    payload = { model: model.id, max_tokens: wantThinking ? Math.max(model.max_tokens, budget + 4096) : model.max_tokens, messages };
    if (system) payload.system = system;
    if (wantThinking) payload.thinking = { type: 'enabled', budget_tokens: budget };
    if (wantSearch) payload.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }

  // Stream to the browser as Server-Sent Events.
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const emit = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const controller = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) controller.abort(); });

  let key = null, stopped = false, errorMsg = null, started = false;
  const state = newStreamState();
  try {
    const opened = await openStream(payload, controller.signal, (label) => emit({ type: 'key', label, switched: true }), isOpenAI ? 'openai' : 'anthropic', !!model.stream);
    key = opened.key; started = true;
    emit({ type: 'key', label: key.label });
    if (isOpenAI && (wantSearch || wantThinking)) emit({ type: 'notice', message: 'Web search and the thinking budget only apply to Claude models on the Anthropic format.' });
    if (opened.nonStream) await readJsonReply(opened.response, emit, state);
    else await (isOpenAI ? readOpenAIStream : readStream)(opened.response, emit, state);
  } catch (e) {
    if (controller.signal.aborted) stopped = true;
    else errorMsg = e.message || 'The request failed.';
  }

  // Save whatever we got (partial replies are kept and marked as stopped).
  let saved = null;
  if (started) {
    const blocks = finalizeBlocks(state.blocks);
    const usage = state.usage;
    const cost = computeCost(model, usage);
    const hasText = blocks.some(b => b.type === 'text' && b.text);
    if (hasText || usage.input_tokens || usage.output_tokens) {
      const r = db.prepare(`INSERT INTO messages (chat_id, role, content, model, input_tokens, output_tokens, cost, key_label, stopped, created_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(chat.id, 'assistant', JSON.stringify(blocks), model.id,
        usage.input_tokens + usage.cache_read + usage.cache_write, usage.output_tokens, cost, key?.label || null, (stopped || errorMsg) ? 1 : 0, now());
      db.prepare(`INSERT INTO usage (user_id, chat_id, model, input_tokens, output_tokens, web_searches, cost, key_id, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?)`).run(user.id, chat.id, model.id, usage.input_tokens + usage.cache_read + usage.cache_write,
        usage.output_tokens, usage.web_searches, cost, key?.id || null, now());
      saved = { id: Number(r.lastInsertRowid), input_tokens: usage.input_tokens + usage.cache_read + usage.cache_write, output_tokens: usage.output_tokens,
                cost, stop_reason: state.stopReason, stopped: stopped || !!errorMsg };
    }
  }
  finished = true;
  if (errorMsg) emit({ type: 'error', message: errorMsg });
  else emit({ type: 'done', message: saved });
  res.end();
});

// ---------- templates (custom button) ----------
app.get('/api/templates', sec.requireUser, (req, res) => {
  const rows = db.prepare('SELECT id, user_id, name, body FROM templates WHERE user_id = ? OR user_id IS NULL ORDER BY user_id IS NOT NULL, name')
    .all(req.user.id).map(t => ({ ...t, shared: t.user_id == null }));
  res.json({ templates: rows });
});
app.post('/api/templates', sec.requireUser, (req, res) => {
  const { name, body, shared } = req.body || {};
  if (!name?.trim() || !body?.trim()) return bad(res, 'Give the template a name and some text.');
  const owner = shared && req.user.role === 'admin' ? null : req.user.id;
  const r = db.prepare('INSERT INTO templates (user_id, name, body, created_at) VALUES (?,?,?,?)').run(owner, name.trim().slice(0, 80), body, now());
  res.json({ id: Number(r.lastInsertRowid) });
});
function editableTemplate(req, res) {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(req.params.id));
  if (!t) { bad(res, 'Template not found.', 404); return null; }
  if (t.user_id == null ? req.user.role !== 'admin' : t.user_id !== req.user.id) { bad(res, 'Only an admin can change shared templates.', 403); return null; }
  return t;
}
app.put('/api/templates/:id', sec.requireUser, (req, res) => {
  const t = editableTemplate(req, res); if (!t) return;
  const { name, body } = req.body || {};
  if (!name?.trim() || !body?.trim()) return bad(res, 'Give the template a name and some text.');
  db.prepare('UPDATE templates SET name = ?, body = ? WHERE id = ?').run(name.trim().slice(0, 80), body, t.id);
  res.json({ ok: true });
});
app.delete('/api/templates/:id', sec.requireUser, (req, res) => {
  const t = editableTemplate(req, res); if (!t) return;
  db.prepare('DELETE FROM templates WHERE id = ?').run(t.id);
  res.json({ ok: true });
});

// ---------- admin: users ----------
const admin = express.Router();
admin.use(sec.requireAdmin);

function readLimits(b) {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const mode = ['none', 'cost', 'tokens', 'both'].includes(b.limit_mode) ? b.limit_mode : 'none';
  return {
    limit_mode: mode,
    daily_cost_limit: num(b.daily_cost_limit), monthly_cost_limit: num(b.monthly_cost_limit),
    daily_token_limit: num(b.daily_token_limit), monthly_token_limit: num(b.monthly_token_limit),
    allowed_models: JSON.stringify(Array.isArray(b.allowed_models) ? b.allowed_models.map(String) : []),
    allow_web_search: b.allow_web_search === false ? 0 : 1,
    allow_thinking: b.allow_thinking === false ? 0 : 1,
  };
}

admin.get('/users', (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY role, username').all().map(u => ({ ...publicUser(u), usage: usageTotals(u.id) }));
  res.json({ users });
});
admin.post('/users', (req, res) => {
  const b = req.body || {};
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(b.username || '')) return bad(res, 'Username must be 3–32 letters, numbers, dots, dashes or underscores.');
  if (!b.password || b.password.length < 10) return bad(res, 'Password must be at least 10 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(b.username)) return bad(res, 'That username is taken.');
  const role = b.role === 'admin' ? 'admin' : 'staff';
  const L = readLimits(b);
  const r = db.prepare(`INSERT INTO users (username, display_name, password_hash, role, limit_mode, daily_cost_limit, monthly_cost_limit,
      daily_token_limit, monthly_token_limit, allowed_models, allow_web_search, allow_thinking, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.username, b.display_name || b.username, sec.hashPassword(b.password), role,
      L.limit_mode, L.daily_cost_limit, L.monthly_cost_limit, L.daily_token_limit, L.monthly_token_limit, L.allowed_models,
      L.allow_web_search, L.allow_thinking, now());
  res.json({ id: Number(r.lastInsertRowid) });
});
admin.put('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) return bad(res, 'User not found.', 404);
  const b = req.body || {};
  const role = b.role === 'admin' ? 'admin' : b.role === 'staff' ? 'staff' : u.role;
  const active = b.active === false ? 0 : b.active === true ? 1 : u.active;
  if (u.id === req.user.id && (role !== 'admin' || !active)) return bad(res, "You can't remove your own admin access or disable yourself.");
  if (u.role === 'admin' && (role !== 'admin' || !active)) {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
    if (admins <= 1) return bad(res, 'Keep at least one active admin.');
  }
  const L = readLimits(b);
  db.prepare(`UPDATE users SET display_name = ?, role = ?, active = ?, limit_mode = ?, daily_cost_limit = ?, monthly_cost_limit = ?,
      daily_token_limit = ?, monthly_token_limit = ?, allowed_models = ?, allow_web_search = ?, allow_thinking = ? WHERE id = ?`)
    .run(b.display_name || u.display_name, role, active, L.limit_mode, L.daily_cost_limit, L.monthly_cost_limit,
      L.daily_token_limit, L.monthly_token_limit, L.allowed_models, L.allow_web_search, L.allow_thinking, u.id);
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  if (b.password) {
    if (b.password.length < 10) return bad(res, 'Password must be at least 10 characters.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(sec.hashPassword(b.password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  }
  res.json({ ok: true });
});
admin.delete('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) return bad(res, 'User not found.', 404);
  if (u.id === req.user.id) return bad(res, "You can't delete your own account.");
  if (u.role === 'admin' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n <= 1) return bad(res, 'Keep at least one admin.');
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id); // usage rows stay for reports
  res.json({ ok: true });
});

// ---------- admin: API keys ----------
const publicKey = (k) => ({ id: k.id, label: k.label, key_hint: k.key_hint, endpoint: k.endpoint, enabled: !!k.enabled, priority: k.priority,
  cooldown_until: k.cooldown_until, last_error: k.last_error, last_used_at: k.last_used_at, request_count: k.request_count, fail_count: k.fail_count });

admin.get('/keys', (req, res) => {
  const keys = db.prepare('SELECT * FROM api_keys ORDER BY priority, id').all().map(publicKey);
  const spend = db.prepare(`SELECT key_id, SUM(cost) AS cost, COUNT(*) AS requests FROM usage WHERE created_at >= ? GROUP BY key_id`).all(periodStarts().month);
  res.json({ keys, spend, default_endpoint: getSetting('default_endpoint') });
});
admin.post('/keys', (req, res) => {
  const { label, key, endpoint } = req.body || {};
  if (!label?.trim() || !key?.trim()) return bad(res, 'Add a label and the key itself.');
  const k = key.trim();
  const max = db.prepare('SELECT COALESCE(MAX(priority), -1) AS m FROM api_keys').get().m;
  const r = db.prepare('INSERT INTO api_keys (label, key_enc, key_hint, endpoint, priority, created_at) VALUES (?,?,?,?,?,?)')
    .run(label.trim().slice(0, 60), sec.encrypt(k), `…${k.slice(-4)}`, endpoint?.trim() || null, max + 1, now());
  res.json({ id: Number(r.lastInsertRowid) });
});
admin.put('/keys/:id', (req, res) => {
  const k = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(Number(req.params.id));
  if (!k) return bad(res, 'Key not found.', 404);
  const b = req.body || {};
  db.prepare('UPDATE api_keys SET label = ?, endpoint = ?, enabled = ? WHERE id = ?')
    .run((b.label ?? k.label).trim() || k.label, b.endpoint === undefined ? k.endpoint : (b.endpoint?.trim() || null),
      b.enabled === undefined ? k.enabled : (b.enabled ? 1 : 0), k.id);
  if (b.key?.trim()) db.prepare('UPDATE api_keys SET key_enc = ?, key_hint = ? WHERE id = ?').run(sec.encrypt(b.key.trim()), `…${b.key.trim().slice(-4)}`, k.id);
  res.json({ ok: true });
});
admin.post('/keys/order', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
  tx(() => ids.forEach((id, i) => db.prepare('UPDATE api_keys SET priority = ? WHERE id = ?').run(i, id)));
  res.json({ ok: true });
});
admin.post('/keys/:id/reset', (req, res) => {
  db.prepare('UPDATE api_keys SET cooldown_until = 0, last_error = NULL WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
admin.post('/keys/:id/test', async (req, res) => {
  const k = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(Number(req.params.id));
  if (!k) return bad(res, 'Key not found.', 404);
  const model = (req.body?.model && db.prepare('SELECT * FROM models WHERE id = ?').get(String(req.body.model)))
    || db.prepare('SELECT * FROM models WHERE enabled = 1 ORDER BY sort, label LIMIT 1').get();
  if (!model) return bad(res, 'Enable at least one model first.');
  try {
    const secret = sec.decrypt(k.key_enc);
    const isOpenAI = model.api_format === 'openai';
    const url = endpointFor(k, isOpenAI ? 'openai' : 'anthropic');
    const headers = isOpenAI ? { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }
                             : { ...authHeaders(secret, url), 'content-type': 'application/json' };
    // Same body as the provider's curl example.
    const reqBody = { model: model.id, messages: [{ role: 'user', content: 'What can you do?' }], max_tokens: 500 };
    var sent = `curl --location '${url}' \\\n` + Object.entries(headers).map(([h, v]) => `--header '${h}: ${/^(authorization|x-api-key)$/i.test(h) ? v.replace(secret, `<key ${k.key_hint}>`) : v}' \\`).join('\n')
      + `\n--data '${JSON.stringify(reqBody, null, 4)}'`;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(reqBody), signal: AbortSignal.timeout(60000) });
    const text = await r.text();
    if (!r.ok) return res.json({ ok: false, message: `HTTP ${r.status} ${text.slice(0, 300)}`, sent, response: text.slice(0, 2000) });
    db.prepare('UPDATE api_keys SET cooldown_until = 0, last_error = NULL WHERE id = ?').run(k.id);
    const reply = (J(text, {}).content || []).filter(b => b.type === 'text').map(b => b.text).join('') || J(text, {}).choices?.[0]?.message?.content || '';
    res.json({ ok: true, message: `Works. Model ${model.id} answered.`, sent, response: text.slice(0, 2000), reply });
  } catch (e) { res.json({ ok: false, message: e.message, sent: typeof sent === 'string' ? sent : '' }); }
});
admin.delete('/keys/:id', (req, res) => {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- admin: models & settings ----------
admin.get('/models', (req, res) => res.json({ models: db.prepare('SELECT * FROM models ORDER BY sort, label').all() }));
admin.post('/models', (req, res) => {
  const b = req.body || {};
  if (!b.id?.trim() || !b.label?.trim()) return bad(res, 'A model needs an ID and a display name.');
  if (db.prepare('SELECT 1 FROM models WHERE id = ?').get(b.id.trim())) return bad(res, 'That model ID already exists.');
  const max = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM models').get().m;
  const fmtIn = b.api_format === 'openai' ? 'openai' : b.api_format === 'anthropic' ? 'anthropic' : (/claude/i.test(b.id) ? 'anthropic' : 'openai');
  db.prepare('INSERT INTO models (id, label, input_price, output_price, max_tokens, enabled, sort, api_format) VALUES (?,?,?,?,?,?,?,?)')
    .run(b.id.trim(), b.label.trim(), Number(b.input_price) || 0, Number(b.output_price) || 0, Number(b.max_tokens) || 16000, b.enabled === false ? 0 : 1, max + 1, fmtIn);
  res.json({ ok: true });
});
admin.put('/models/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
  if (!m) return bad(res, 'Model not found.', 404);
  const b = req.body || {};
  db.prepare('UPDATE models SET label = ?, input_price = ?, output_price = ?, max_tokens = ?, enabled = ?, sort = ?, api_format = ?, stream = ? WHERE id = ?')
    .run(b.label?.trim() || m.label, b.input_price ?? m.input_price, b.output_price ?? m.output_price, b.max_tokens ?? m.max_tokens,
      b.enabled === undefined ? m.enabled : (b.enabled ? 1 : 0), b.sort ?? m.sort, ['anthropic', 'openai'].includes(b.api_format) ? b.api_format : m.api_format,
      b.stream === undefined ? m.stream : (b.stream ? 1 : 0), m.id);
  res.json({ ok: true });
});
// Ask the provider which models this key can use (Tokenhot is OpenAI-compatible: GET /v1/models).
admin.get('/models/remote', async (req, res) => {
  const k = db.prepare('SELECT * FROM api_keys WHERE enabled = 1 ORDER BY priority, id LIMIT 1').get();
  if (!k) return bad(res, 'Add an API key first.');
  const endpoint = k.endpoint || getSetting('default_endpoint');
  const url = endpoint.replace(/\/messages\/?$/, '/models');
  try {
    const r = await fetch(url, { headers: authHeaders(sec.decrypt(k.key_enc), endpoint), signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    if (!r.ok) return bad(res, `The provider didn't return a model list (HTTP ${r.status}). Check its website for model names instead.`);
    const j = J(text, {});
    const list = (Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : []).map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean);
    const existing = new Set(db.prepare('SELECT id FROM models').all().map(m => m.id));
    res.json({ url, models: [...new Set(list)].sort().map(id => ({ id, claude: /claude/i.test(id), format: /claude/i.test(id) ? 'anthropic' : 'openai', added: existing.has(id) })) });
  } catch (e) { bad(res, `Couldn't reach ${url}: ${e.message}`); }
});
admin.delete('/models/:id', (req, res) => { db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

const SETTING_KEYS = ['default_endpoint', 'openai_endpoint', 'anthropic_version', 'auth_header', 'key_cooldown_seconds', 'web_search_price_per_1000', 'staff_notice', 'default_system_prompt'];
admin.get('/settings', (req, res) => res.json(Object.fromEntries(SETTING_KEYS.map(k => [k, getSetting(k)]))));
admin.put('/settings', (req, res) => {
  const b = req.body || {};
  for (const f of ['default_endpoint', 'openai_endpoint'])
    if (b[f] !== undefined && !/^https?:\/\/\S+$/.test(b[f])) return bad(res, 'Endpoints must be full URLs starting with https://');
  if (b.auth_header !== undefined && !['x-api-key', 'bearer', 'both'].includes(b.auth_header)) return bad(res, 'Pick a valid auth header option.');
  SETTING_KEYS.forEach(k => { if (b[k] !== undefined) setSetting(k, b[k]); });
  res.json({ ok: true });
});

// ---------- admin: reports & chat review ----------
function rangeFrom(req) {
  const from = req.query.from ? new Date(req.query.from + 'T00:00:00').getTime() : now() - 30 * 86400000;
  const to = req.query.to ? new Date(req.query.to + 'T23:59:59.999').getTime() : now();
  return { from, to };
}
admin.get('/usage', (req, res) => {
  const { from, to } = rangeFrom(req);
  const byUser = db.prepare(`SELECT u.user_id, COALESCE(us.username, '(deleted #' || u.user_id || ')') AS username, us.display_name,
      SUM(u.cost) AS cost, SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens, SUM(u.web_searches) AS web_searches, COUNT(*) AS requests
      FROM usage u LEFT JOIN users us ON us.id = u.user_id WHERE u.created_at BETWEEN ? AND ? GROUP BY u.user_id ORDER BY cost DESC`).all(from, to);
  const byModel = db.prepare(`SELECT model, SUM(cost) AS cost, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, COUNT(*) AS requests
      FROM usage WHERE created_at BETWEEN ? AND ? GROUP BY model ORDER BY cost DESC`).all(from, to);
  const byKey = db.prepare(`SELECT COALESCE(k.label, '(removed key)') AS label, SUM(u.cost) AS cost, COUNT(*) AS requests
      FROM usage u LEFT JOIN api_keys k ON k.id = u.key_id WHERE u.created_at BETWEEN ? AND ? GROUP BY u.key_id ORDER BY cost DESC`).all(from, to);
  const daily = db.prepare(`SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch', 'localtime') AS day, SUM(cost) AS cost,
      SUM(input_tokens + output_tokens) AS tokens, COUNT(*) AS requests FROM usage WHERE created_at BETWEEN ? AND ? GROUP BY day ORDER BY day`).all(from, to);
  res.json({ from, to, byUser, byModel, byKey, daily });
});
admin.get('/usage.csv', (req, res) => {
  const { from, to } = rangeFrom(req);
  const rows = db.prepare(`SELECT u.created_at, COALESCE(us.username, '#' || u.user_id) AS username, u.model, u.input_tokens, u.output_tokens,
      u.web_searches, u.cost, COALESCE(k.label, '') AS key_label, u.chat_id
      FROM usage u LEFT JOIN users us ON us.id = u.user_id LEFT JOIN api_keys k ON k.id = u.key_id
      WHERE u.created_at BETWEEN ? AND ? ORDER BY u.created_at`).all(from, to);
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = ['time,user,model,input_tokens,output_tokens,web_searches,cost_usd,key,chat_id',
    ...rows.map(r => [new Date(r.created_at).toISOString(), r.username, r.model, r.input_tokens, r.output_tokens, r.web_searches, r.cost.toFixed(6), r.key_label, r.chat_id].map(esc).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="usage-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});
admin.get('/chats', (req, res) => {
  const userId = req.query.user ? Number(req.query.user) : null;
  const q = String(req.query.q || '').trim();
  const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
  const rows = db.prepare(`SELECT c.id, c.title, c.updated_at, c.user_id, u.username, u.display_name,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
      (SELECT COALESCE(SUM(cost),0) FROM messages m WHERE m.chat_id = c.id) AS cost
      FROM chats c JOIN users u ON u.id = c.user_id
      WHERE (? IS NULL OR c.user_id = ?) AND (? = '' OR c.title LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.content LIKE ? ESCAPE '\\'))
      ORDER BY c.updated_at DESC LIMIT 300`).all(userId, userId, q, like, like);
  res.json({ chats: rows });
});
admin.get('/chats/:id', (req, res) => {
  const chat = db.prepare('SELECT c.*, u.username, u.display_name FROM chats c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(Number(req.params.id));
  if (!chat) return bad(res, 'Chat not found.', 404);
  const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id').all(chat.id).map(m => ({ ...m, content: J(m.content, []) }));
  res.json({ chat, messages });
});
admin.get('/overview', (req, res) => {
  const { day, month } = periodStarts();
  const sum = db.prepare('SELECT COALESCE(SUM(cost),0) AS cost, COUNT(*) AS requests, COALESCE(SUM(input_tokens+output_tokens),0) AS tokens FROM usage WHERE created_at >= ?');
  res.json({
    today: sum.get(day), month: sum.get(month),
    staff: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'staff' AND active = 1").get().n,
    keys: db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 AND cooldown_until <= ? THEN 1 ELSE 0 END) AS ready FROM api_keys').get(now()),
    activeToday: db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM usage WHERE created_at >= ?').get(day).n,
  });
});

app.use('/api/admin', admin);

app.use('/api', (req, res) => bad(res, 'Not found.', 404));
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.too.large') return bad(res, 'That upload is too large. Keep attachments under about 30 MB in total.', 413);
  if (!res.headersSent) bad(res, 'Something went wrong on the server. Check the server log.', 500);
});

app.listen(PORT, HOST, () => {
  if (ON_RAILWAY && !process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH)
    console.warn('\n  WARNING: No Railway volume is attached. All data will be lost on the next deploy. Add a volume mounted at /data.\n');
  console.log(`\n  Claude Console is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) console.log('  First run: open the link above to create your admin account.\n');
});
