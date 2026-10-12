// Calls the messages endpoint (Tokenhot by default) with key auto-switching,
// and turns the upstream SSE stream into simple events for the browser.
const { db, getSetting } = require('./db');
const { decrypt } = require('./security');

// Errors that mean "this key can't serve right now, try the next one".
// The gateway doesn't offer this model: another key on the same gateway won't help, and the key isn't broken.
function isModelProblem(bodyText) {
  return /no available channel|model[^.]{0,40}(not found|not exist|does not exist|not supported|unsupported|unavailable|not available)|invalid model|unknown model|model_not_found/i.test(bodyText);
}

function isKeyProblem(status, bodyText) {
  if (isModelProblem(bodyText)) return false;
  if ([401, 402, 403, 429, 529].includes(status)) return true;
  if (status >= 500) return true; // gateway/upstream outage: worth trying another key
  if (status === 400 && /credit|balance|quota|insufficient|billing/i.test(bodyText)) return true;
  return false;
}

// The official Anthropic API needs x-api-key + anthropic-version, whatever the gateway setting says.
const isAnthropicOfficial = (url) => { try { return new URL(url).hostname.endsWith('anthropic.com'); } catch { return false; } };

// Auth + version headers for an Anthropic-format request to `url`.
function authHeaders(secret, url = '') {
  const version = (getSetting('anthropic_version') ?? '2023-06-01').trim();
  if (isAnthropicOfficial(url)) return { 'x-api-key': secret, 'anthropic-version': version || '2023-06-01' };
  const mode = getSetting('auth_header') || 'bearer';
  const h = {};
  if (mode === 'x-api-key' || mode === 'both') h['x-api-key'] = secret;
  if (mode === 'bearer' || mode === 'both') h['authorization'] = `Bearer ${secret}`;
  if (version) h['anthropic-version'] = version;
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
// Where a key sends a request for a given format.
function endpointFor(key, format) {
  if (format === 'openai') {
    if (key.endpoint && /\/messages\/?$/.test(key.endpoint)) return key.endpoint.replace(/\/messages\/?$/, '/chat/completions');
    return getSetting('openai_endpoint') || 'https://api.tokenhot.ai/v1/chat/completions';
  }
  return key.endpoint || getSetting('default_endpoint');
}

async function openStream(payload, signal, onKeySwitch, format = 'anthropic') {
  const keys = usableKeys();
  if (keys.length === 0) {
    const any = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE enabled = 1').get().n;
    throw new Error(any ? 'All API keys are cooling down after errors. Try again in a few minutes, or add another key in Admin > API keys.'
                        : 'No API keys are set up. An admin needs to add one in Admin > API keys.');
  }
  const cooldownMs = Number(getSetting('key_cooldown_seconds') || 300) * 1000;
  const errors = [];
  const modelErrors = [];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let secret;
    try { secret = decrypt(key.key_enc); }
    catch { errors.push(`${key.label}: could not decrypt (secret.key changed?)`); continue; }

    if (i > 0 && onKeySwitch) onKeySwitch(key.label);
    let res, headers, body;
    try {
      headers = format === 'openai'
        ? { 'content-type': 'application/json', authorization: `Bearer ${secret}`, accept: 'text/event-stream' }
        : { 'content-type': 'application/json', ...authHeaders(secret, endpointFor(key, format)), accept: 'text/event-stream' };
      body = format === 'openai'
        ? { ...payload, stream: true, stream_options: { include_usage: true } }
        : { ...payload, stream: true };
      res = await fetch(endpointFor(key, format), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
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
    // Some gateway channels only serve non-streaming requests: retry once without streaming.
    if (isModelProblem(text)) {
      try {
        const nsHeaders = { ...headers, accept: 'application/json' };
        const nsBody = { ...body }; delete nsBody.stream; delete nsBody.stream_options;
        const r2 = await fetch(endpointFor(key, format), { method: 'POST', headers: nsHeaders, body: JSON.stringify(nsBody), signal });
        if (r2.ok) {
          db.prepare('UPDATE api_keys SET last_used_at = ?, request_count = request_count + 1, last_error = NULL WHERE id = ?').run(Date.now(), key.id);
          return { response: r2, key, nonStream: true };
        }
      } catch (e) { if (signal?.aborted) throw e; }
    }
    // Model not offered for this key's group: try the next key (it may be in another group), no cooldown.
    if (isModelProblem(text)) {
      modelErrors.push(`${key.label}: ${msg}`);
      continue;
    }
    db.prepare('UPDATE api_keys SET last_error = ? WHERE id = ?').run(msg, key.id);
    const err = new Error(msg);
    err.requestError = true;
    throw err;
  }
  if (modelErrors.length && !errors.length) {
    const err = new Error(`This model isn't available on any of your API keys (${payload.model}). Your provider has no working channel for it on these keys' groups. Try another model, or add a key from a group that includes it. Details: ${modelErrors.join(' | ')}`);
    err.requestError = true;
    throw err;
  }
  throw new Error(`Every API key failed. ${[...modelErrors, ...errors].join(' | ')}`);
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

// OpenAI-style stream (chat/completions). Fills the same state shape: block 0 = reasoning, block 1 = text.
async function readOpenAIStream(response, emit, state = newStreamState()) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const think = state.blocks[0] = { type: 'thinking', thinking: '' };
  const text = state.blocks[1] = { type: 'text', text: '', citations: [] };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buffer.slice(0, idx); buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = raw.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (!data || data === '[DONE]') continue;
      let evt; try { evt = JSON.parse(data); } catch { continue; }
      if (evt.error) throw new Error(evt.error.message || JSON.stringify(evt.error));
      const ch = evt.choices?.[0];
      const d = ch?.delta || {};
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) { think.thinking += r; emit({ type: 'thinking', delta: r }); }
      if (typeof d.content === 'string' && d.content) { text.text += d.content; emit({ type: 'text', delta: d.content }); }
      (d.annotations || ch?.message?.annotations || []).forEach(a => { const u = a.url_citation; if (u?.url) text.citations.push({ url: u.url, title: u.title || u.url }); });
      if (ch?.finish_reason) state.stopReason = ch.finish_reason === 'length' ? 'max_tokens' : ch.finish_reason;
      if (evt.usage) {
        const cached = evt.usage.prompt_tokens_details?.cached_tokens || 0;
        state.usage.input_tokens = Math.max(0, (evt.usage.prompt_tokens || 0) - cached);
        state.usage.cache_read = cached;
        state.usage.output_tokens = evt.usage.completion_tokens || 0;
      }
    }
  }
  return state;
}

// A complete (non-streamed) JSON reply in either format, emitted as if it had streamed.
async function readJsonReply(response, emit, state = newStreamState()) {
  const j = await response.json();
  const think = state.blocks[0] = { type: 'thinking', thinking: '' };
  const text = state.blocks[1] = { type: 'text', text: '', citations: [] };
  if (Array.isArray(j.content)) { // Anthropic
    for (const b of j.content) {
      if (b.type === 'thinking' && b.thinking) think.thinking += b.thinking;
      if (b.type === 'text' && b.text) { text.text += b.text; (b.citations || []).forEach(c => c.url && text.citations.push({ url: c.url, title: c.title || c.url })); }
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach(r => r.url && text.citations.push({ url: r.url, title: r.title || r.url }));
    }
    const u = j.usage || {};
    state.usage.input_tokens = u.input_tokens || 0; state.usage.output_tokens = u.output_tokens || 0;
    state.usage.cache_read = u.cache_read_input_tokens || 0; state.usage.cache_write = u.cache_creation_input_tokens || 0;
    state.usage.web_searches = u.server_tool_use?.web_search_requests || 0;
    state.stopReason = j.stop_reason || null;
  } else if (Array.isArray(j.choices)) { // OpenAI
    const msg = j.choices[0]?.message || {};
    think.thinking = msg.reasoning_content || msg.reasoning || '';
    text.text = typeof msg.content === 'string' ? msg.content : (msg.content || []).map(p => p.text || '').join('');
    const u = j.usage || {}; const cached = u.prompt_tokens_details?.cached_tokens || 0;
    state.usage.input_tokens = Math.max(0, (u.prompt_tokens || 0) - cached); state.usage.cache_read = cached; state.usage.output_tokens = u.completion_tokens || 0;
    const fr = j.choices[0]?.finish_reason; state.stopReason = fr === 'length' ? 'max_tokens' : fr || null;
  } else {
    throw new Error('The provider returned a reply in an unknown format.');
  }
  if (think.thinking) emit({ type: 'thinking', delta: think.thinking });
  if (text.citations.length) emit({ type: 'sources', items: text.citations });
  if (text.text) emit({ type: 'text', delta: text.text });
  return state;
}

// Convert stored Anthropic-format messages into OpenAI chat messages.
function toOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'assistant') { out.push({ role: 'assistant', content: m.content.map(b => b.text || '').join('') }); continue; }
    const parts = m.content.map(b => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'image') return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
      if (b.type === 'document') return { type: 'file', file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${b.source.data}` } };
      return null;
    }).filter(Boolean);
    out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
  }
  return out;
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

module.exports = { authHeaders, endpointFor, readJsonReply, readOpenAIStream, toOpenAIMessages, openStream, readStream, finalizeBlocks, newStreamState };
