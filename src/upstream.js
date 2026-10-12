// Calls the messages endpoint (Tokenhot by default) with key auto-switching,
// and turns the upstream SSE stream into simple events for the browser.
const { db, getSetting } = require('./db');
const { decrypt } = require('./security');

// Errors that mean "this key can't serve right now, try the next one".
function isKeyProblem(status, bodyText) {
  if ([401, 402, 403, 429, 529].includes(status)) return true;
  if (status >= 500) return true; // gateway/upstream outage: worth trying another key
  if (status === 400 && /credit|balance|quota|insufficient|billing/i.test(bodyText)) return true;
  return false;
}

// Builds auth headers per the admin setting. Tokenhot's docs use x-api-key; some gateways want Bearer.
function authHeaders(secret) {
  const mode = getSetting('auth_header') || 'both';
  const h = {};
  if (mode === 'x-api-key' || mode === 'both') h['x-api-key'] = secret;
  if (mode === 'bearer' || mode === 'both') h['authorization'] = `Bearer ${secret}`;
  return h;
}

function usableKeys() {
  const now = Date.now();
  return db.prepare(`SELECT * FROM api_keys WHERE enabled = 1 AND cooldown_until <= ?
                     ORDER BY priority ASC, id ASC`).all(now);
}

function shortError(status, text) {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message || j?.message || j?.error;
    if (m) return `HTTP ${status}: ${typeof m === 'string' ? m : JSON.stringify(m)}`.slice(0, 300);
  } catch { /* not JSON */ }
  return `HTTP ${status}: ${text}`.slice(0, 300);
}

/**
 * Open a streaming request, trying each usable key in priority order.
 * Returns { response, key } with a 2xx streaming response, or throws.
 */
async function openStream(payload, signal, onKeySwitch) {
  const keys = usableKeys();
  if (keys.length === 0) {
    const any = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE enabled = 1').get().n;
    throw new Error(any ? 'All API keys are cooling down after errors. Try again in a few minutes, or add another key in Admin > API keys.'
                        : 'No API keys are set up. An admin needs to add one in Admin > API keys.');
  }
  const defaultEndpoint = getSetting('default_endpoint');
  const version = getSetting('anthropic_version') || '2023-06-01';
  const cooldownMs = Number(getSetting('key_cooldown_seconds') || 300) * 1000;
  const errors = [];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let secret;
    try { secret = decrypt(key.key_enc); }
    catch { errors.push(`${key.label}: could not decrypt (secret.key changed?)`); continue; }

    if (i > 0 && onKeySwitch) onKeySwitch(key.label);
    let res;
    try {
      res = await fetch(key.endpoint || defaultEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders(secret),
          'anthropic-version': version,
          'accept': 'text/event-stream',
        },
        body: JSON.stringify({ ...payload, stream: true }),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      const msg = `Network error: ${e.message}`;
      db.prepare('UPDATE api_keys SET cooldown_until = ?, last_error = ?, fail_count = fail_count + 1 WHERE id = ?')
        .run(Date.now() + cooldownMs, msg, key.id);
      errors.push(`${key.label}: ${msg}`);
      continue;
    }

    if (res.ok) {
      db.prepare('UPDATE api_keys SET last_used_at = ?, request_count = request_count + 1, last_error = NULL WHERE id = ?')
        .run(Date.now(), key.id);
      return { response: res, key };
    }

    const text = await res.text().catch(() => '');
    const msg = shortError(res.status, text);
    if (isKeyProblem(res.status, text)) {
      // Honour retry-after when the gateway gives one.
      const ra = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? Math.max(ra * 1000, 15000) : cooldownMs;
      db.prepare('UPDATE api_keys SET cooldown_until = ?, last_error = ?, fail_count = fail_count + 1 WHERE id = ?')
        .run(Date.now() + wait, msg, key.id);
      errors.push(`${key.label}: ${msg}`);
      continue;
    }
    // A request problem (bad model name, unsupported tool, etc.): switching keys won't help.
    db.prepare('UPDATE api_keys SET last_error = ? WHERE id = ?').run(msg, key.id);
    const err = new Error(msg);
    err.requestError = true;
    throw err;
  }
  throw new Error(`Every API key failed. ${errors.join(' | ')}`);
}

/**
 * Read an Anthropic-format SSE stream. Calls emit(event) for the browser and
 * returns the assembled result: blocks for storage plus usage numbers.
 */
function newStreamState() {
  return { blocks: {}, usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, web_searches: 0 }, stopReason: null };
}

// Fills `state` as it goes, so a stopped stream still has its partial text and usage.
async function readStream(response, emit, state = newStreamState()) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const { blocks, usage } = state;

  const takeUsage = (u) => {
    if (!u) return;
    if (u.input_tokens != null) usage.input_tokens = Math.max(usage.input_tokens, u.input_tokens);
    if (u.output_tokens != null) usage.output_tokens = Math.max(usage.output_tokens, u.output_tokens);
    if (u.cache_read_input_tokens != null) usage.cache_read = Math.max(usage.cache_read, u.cache_read_input_tokens);
    if (u.cache_creation_input_tokens != null) usage.cache_write = Math.max(usage.cache_write, u.cache_creation_input_tokens);
    const ws = u.server_tool_use?.web_search_requests;
    if (ws != null) usage.web_searches = Math.max(usage.web_searches, ws);
  };

  const handle = (evt) => {
    switch (evt.type) {
      case 'message_start': takeUsage(evt.message?.usage); break;
      case 'content_block_start': {
        const b = evt.content_block || {};
        const work = { type: b.type };
        if (b.type === 'text') work.text = b.text || '';
        else if (b.type === 'thinking') work.thinking = b.thinking || '';
        else if (b.type === 'server_tool_use') { work.name = b.name; work.inputJson = ''; }
        else if (b.type === 'web_search_tool_result') {
          const items = Array.isArray(b.content) ? b.content.filter(r => r.url).map(r => ({ url: r.url, title: r.title || r.url })) : [];
          work.items = items;
          if (items.length) emit({ type: 'sources', items });
          else if (b.content?.error_code) emit({ type: 'notice', message: `Web search error: ${b.content.error_code}` });
        }
        blocks[evt.index] = work;
        if (b.type === 'text' && b.text) emit({ type: 'text', delta: b.text });
        break;
      }
      case 'content_block_delta': {
        const work = blocks[evt.index]; const d = evt.delta || {};
        if (!work) break;
        if (d.type === 'text_delta') { work.text += d.text; emit({ type: 'text', delta: d.text }); }
        else if (d.type === 'thinking_delta') { work.thinking += d.thinking; emit({ type: 'thinking', delta: d.thinking }); }
        else if (d.type === 'input_json_delta') work.inputJson = (work.inputJson || '') + (d.partial_json || '');
        else if (d.type === 'citations_delta' && d.citation?.url) {
          work.citations = work.citations || [];
          work.citations.push({ url: d.citation.url, title: d.citation.title || d.citation.url });
        }
        break;
      }
      case 'content_block_stop': {
        const work = blocks[evt.index];
        if (work?.type === 'server_tool_use' && work.name === 'web_search') {
          try { const q = JSON.parse(work.inputJson || '{}').query; if (q) { work.query = q; emit({ type: 'search', query: q }); } } catch { /* partial */ }
        }
        break;
      }
      case 'message_delta':
        takeUsage(evt.usage);
        if (evt.delta?.stop_reason) state.stopReason = evt.delta.stop_reason;
        break;
      case 'error':
        throw new Error(evt.error?.message || 'The model stream reported an error.');
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
      const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      let evt; try { evt = JSON.parse(data); } catch { continue; }
      handle(evt);
    }
  }
  return state;
}

// Turn working blocks into what we store and show.
function finalizeBlocks(blocks) {
  const out = [];
  const sources = [];
  const searches = [];
  const ordered = Object.keys(blocks).map(Number).sort((a, b) => a - b).map(k => blocks[k]);
  let text = '';
  let thinking = '';
  for (const b of ordered) {
    if (b.type === 'thinking' && b.thinking) thinking += (thinking ? '\n\n' : '') + b.thinking;
    if (b.type === 'text') { text += b.text || ''; (b.citations || []).forEach(c => sources.push(c)); }
    if (b.type === 'web_search_tool_result') (b.items || []).forEach(i => sources.push(i));
    if (b.type === 'server_tool_use' && b.query) searches.push(b.query);
  }
  if (thinking) out.push({ type: 'thinking', thinking });
  if (searches.length) out.push({ type: 'searches', queries: searches });
  out.push({ type: 'text', text });
  const seen = new Set();
  const uniq = sources.filter(s => !seen.has(s.url) && seen.add(s.url));
  if (uniq.length) out.push({ type: 'sources', items: uniq.slice(0, 20) });
  return out;
}

module.exports = { authHeaders, openStream, readStream, finalizeBlocks, newStreamState };
