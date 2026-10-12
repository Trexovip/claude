// Database layer: SQLite via Node's built-in node:sqlite (Node 22.13+), no native build needed.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// On Railway, a mounted volume sets RAILWAY_VOLUME_MOUNT_PATH automatically.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'console.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  active INTEGER NOT NULL DEFAULT 1,
  limit_mode TEXT NOT NULL DEFAULT 'none' CHECK (limit_mode IN ('none','cost','tokens','both')),
  daily_cost_limit REAL, monthly_cost_limit REAL,
  daily_token_limit INTEGER, monthly_token_limit INTEGER,
  allowed_models TEXT NOT NULL DEFAULT '[]',
  allow_web_search INTEGER NOT NULL DEFAULT 1,
  allow_thinking INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  key_enc TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  endpoint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_used_at INTEGER,
  request_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  input_price REAL NOT NULL DEFAULT 0,
  output_price REAL NOT NULL DEFAULT 0,
  max_tokens INTEGER NOT NULL DEFAULT 16000,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  system_prompt TEXT NOT NULL DEFAULT '',
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, updated_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  key_label TEXT,
  stopped INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  chat_id INTEGER,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  web_searches INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  key_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage(user_id, created_at);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = shared by admin
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Default settings and models (prices are placeholders: edit them in Admin > Models).
const defaults = {
  default_endpoint: 'https://api.tokenhot.ai/v1/messages',
  openai_endpoint: 'https://api.tokenhot.ai/v1/chat/completions',
  anthropic_version: '2023-06-01',
  auth_header: 'bearer', // Tokenhot docs: Authorization: Bearer. Options: 'x-api-key' | 'bearer' | 'both'
  key_cooldown_seconds: '300',
  web_search_price_per_1000: '10',
  staff_notice: 'Chats on this workspace are visible to administrators.',
  default_system_prompt: '',
};
// Migration: per-model API format ('anthropic' = /v1/messages, 'openai' = /v1/chat/completions).
if (!db.prepare("PRAGMA table_info(models)").all().some(c => c.name === 'api_format'))
  db.exec("ALTER TABLE models ADD COLUMN api_format TEXT NOT NULL DEFAULT 'anthropic'");

const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) insSetting.run(k, v);

const modelCount = db.prepare('SELECT COUNT(*) AS n FROM models').get().n;
if (modelCount === 0) {
  const ins = db.prepare('INSERT INTO models (id,label,input_price,output_price,max_tokens,enabled,sort) VALUES (?,?,?,?,?,?,?)');
  // Tokenhot uses dotted model IDs (e.g. claude-sonnet-4.6). Check their model list and adjust in Admin > Models.
  ins.run('claude-sonnet-4.6', 'Claude Sonnet 4.6', 3, 15, 32000, 1, 1);
  ins.run('claude-opus-5.5', 'Claude Opus 5.5', 5, 25, 32000, 1, 2);
  ins.run('claude-sonnet-5.5', 'Claude Sonnet 5.5', 3, 15, 32000, 1, 3);
  ins.run('claude-haiku-5.5', 'Claude Haiku 5.5', 1, 5, 16000, 1, 4);
  ins.run('claude-fable-5.1', 'Claude Fable 5.1', 15, 75, 32000, 0, 5);
  db.prepare("INSERT INTO models (id,label,input_price,output_price,max_tokens,enabled,sort,api_format) VALUES ('gpt-4o','GPT-4o',2.5,10,16000,1,6,'openai')").run();
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Small helper so route code stays readable.
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, DATA_DIR, getSetting, setSetting, tx };
