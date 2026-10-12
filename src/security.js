// Password hashing (scrypt), API key encryption (AES-256-GCM), session handling.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('./db');

// ---- Encryption secret: APP_SECRET env var, or a generated file in data/ (back it up!) ----
function loadSecret() {
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
const SECRET = loadSecret();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, enc] = blob.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', SECRET, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---- Passwords ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

// ---- Sessions ----
const SESSION_DAYS = 14;
const COOKIE = 'cc_session';

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_DAYS * 86400000);
  return token;
}
function destroySession(token) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// Attaches req.user if the session is valid.
function sessionMiddleware(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = db.prepare(`SELECT u.*, s.token AS session_token FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token = ? AND s.expires_at > ?`).get(token, Date.now());
    if (row && row.active) req.user = row;
  }
  next();
}
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  next();
}

// Basic CSRF guard: state-changing requests must be JSON (cookies are also SameSite=Strict).
function csrfGuard(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const ct = req.headers['content-type'] || '';
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
    // Body-less DELETEs are allowed (SameSite=Strict cookies already block cross-site requests).
    if (req.method === 'DELETE' && !hasBody) return next();
    if (!ct.includes('application/json')) return res.status(415).json({ error: 'Requests must be JSON.' });
  }
  next();
}

// Simple in-memory login throttle: 8 failed attempts per username+IP per 15 minutes.
const attempts = new Map();
function loginThrottled(key) {
  const a = attempts.get(key);
  if (!a) return false;
  if (Date.now() - a.first > 15 * 60000) { attempts.delete(key); return false; }
  return a.count >= 8;
}
function recordFailedLogin(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > 15 * 60000) attempts.set(key, { first: Date.now(), count: 1 });
  else a.count++;
}
function clearLoginAttempts(key) { attempts.delete(key); }

// Housekeeping
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600000).unref();

module.exports = {
  encrypt, decrypt, hashPassword, verifyPassword,
  createSession, destroySession, setSessionCookie, clearSessionCookie,
  sessionMiddleware, requireUser, requireAdmin, csrfGuard,
  loginThrottled, recordFailedLogin, clearLoginAttempts,
};
