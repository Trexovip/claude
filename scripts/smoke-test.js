#!/usr/bin/env node
// Production smoke test: signs in, sends a sample chat to each model, and reports what works.
// Usage:
//   node scripts/smoke-test.js https://your-app.up.railway.app admin 'your-password'
//   node scripts/smoke-test.js https://your-app.up.railway.app admin 'your-password' claude-fable-5.1
// Needs Node 18+. Creates one test chat and deletes it afterwards.

const [, , BASE_RAW, USER, PASS, ...ONLY] = process.argv;
if (!BASE_RAW || !USER || !PASS) {
  console.log("Usage: node scripts/smoke-test.js <app-url> <username> <password> [model-id ...]");
  process.exit(1);
}
const BASE = BASE_RAW.replace(/\/+$/, '');
let cookie = '';
const green = (s) => `\x1b[32m${s}\x1b[0m`, red = (s) => `\x1b[31m${s}\x1b[0m`, dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function call(path, { method, body } = {}) {
  const res = await fetch(BASE + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res;
}

// Send one message and read the streamed reply.
async function chat(chatId, payload) {
  const t0 = Date.now();
  const res = await call(`/api/chats/${chatId}/send`, { body: payload });
  if (!res.ok) { const j = await res.json().catch(() => ({})); return { ok: false, error: j.error || `HTTP ${res.status}`, ms: Date.now() - t0 }; }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', text = '', thinking = '', key = '', sources = 0, done = null, error = null, firstTokenMs = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!line.startsWith('data:')) continue;
      const ev = JSON.parse(line.slice(5));
      if (ev.type === 'text') { if (firstTokenMs == null) firstTokenMs = Date.now() - t0; text += ev.delta; }
      if (ev.type === 'thinking') thinking += ev.delta;
      if (ev.type === 'key') key = ev.label;
      if (ev.type === 'sources') sources += ev.items.length;
      if (ev.type === 'done') done = ev.message;
      if (ev.type === 'error') error = ev.message;
    }
  }
  return { ok: !error && !!text, error, text, thinking, key, sources, done, ms: Date.now() - t0, firstTokenMs };
}

(async () => {
  console.log(`\nTesting ${BASE}\n`);
  let chatId = null;
  const results = [];
  try {
    const h = await call('/healthz');
    console.log(h.ok ? green('✓ Server is up') : red(`✗ Health check failed (HTTP ${h.status})`));
    if (!h.ok) process.exit(1);

    const login = await call('/api/login', { body: { username: USER, password: PASS } });
    const lj = await login.json();
    if (!login.ok) { console.log(red(`✗ Sign-in failed: ${lj.error}`)); process.exit(1); }
    console.log(green(`✓ Signed in as ${USER} (${lj.role})`));

    const me = await (await call('/api/me')).json();
    let models = me.models;
    if (ONLY.length) models = models.filter(m => ONLY.includes(m.id));
    if (!models.length) { console.log(red('✗ No matching enabled models. Check Admin › Models.')); process.exit(1); }
    console.log(dim(`  Models to test: ${models.map(m => m.id).join(', ')}`));

    if (lj.role === 'admin') {
      const k = await (await call('/api/admin/keys')).json();
      const ready = k.keys.filter(x => x.enabled && x.cooldown_until <= Date.now());
      console.log((ready.length ? green('✓') : red('✗')) + ` API keys ready: ${ready.length} of ${k.keys.length}` +
        dim(` (${k.keys.map(x => `${x.label} → ${x.endpoint || k.default_endpoint}`).join('; ')})`));
    }

    chatId = (await (await call('/api/chats', { body: { system_prompt: 'You are a test assistant. Keep answers very short.' } })).json()).id;
    console.log(green(`✓ Created test chat #${chatId}`) + '\n');

    for (const m of models) {
      process.stdout.write(`  ${m.id.padEnd(28)} `);
      const r = await chat(chatId, { model: m.id, content: [{ type: 'text', text: 'Reply with exactly: smoke test ok' }] });
      results.push({ model: m.id, ...r });
      if (r.ok) console.log(green('✓ ') + `"${r.text.trim().slice(0, 40)}"` + dim(`  ${r.ms} ms · first token ${r.firstTokenMs} ms · key ${r.key} · ${r.done?.input_tokens || 0} in / ${r.done?.output_tokens || 0} out · $${(r.done?.cost || 0).toFixed(5)}`));
      else console.log(red('✗ ') + (r.error || 'No reply text').slice(0, 220));
    }

    // Follow-up on the first working model: checks that chat history is sent correctly.
    const working = results.find(r => r.ok);
    if (working) {
      const m = models.find(x => x.id === working.model);
      process.stdout.write(`\n  Follow-up (history) on ${m.id}… `);
      const r = await chat(chatId, { model: m.id, content: [{ type: 'text', text: 'What exact phrase did I ask you to reply with before? Answer in five words or fewer.' }] });
      console.log(r.ok ? green('✓ ') + `"${r.text.trim().slice(0, 60)}"` : red('✗ ') + r.error);

      if (m.api_format !== 'openai') {
        process.stdout.write(`  Extended thinking on ${m.id}… `);
        const t = await chat(chatId, { model: m.id, thinking: true, thinkingBudget: 2048, content: [{ type: 'text', text: 'What is 17 × 23? Answer with just the number.' }] });
        console.log(t.ok ? green('✓ ') + `"${t.text.trim()}"` + dim(t.thinking ? ` (thinking: ${t.thinking.length} chars)` : ' (no thinking returned)') : red('✗ ') + t.error);

        process.stdout.write(`  Web search on ${m.id}… `);
        const w = await chat(chatId, { model: m.id, webSearch: true, content: [{ type: 'text', text: "Search the web: what is today's top technology headline? One sentence." }] });
        console.log(w.ok ? green('✓ ') + dim(`${w.sources} sources · $${(w.done?.cost || 0).toFixed(5)}`) : red('✗ ') + w.error);
      }
    }
  } catch (e) {
    console.log(red(`\n✗ Test stopped: ${e.message}`));
  } finally {
    if (chatId) { await call(`/api/chats/${chatId}`, { method: 'DELETE' }).catch(() => {}); console.log(dim(`\n  Deleted test chat #${chatId}`)); }
  }
  const ok = results.filter(r => r.ok).length;
  console.log(`\n${ok === results.length ? green('All models answered.') : `${ok} of ${results.length} models answered.`}`);
  if (results.some(r => /No available channel/i.test(r.error || '')))
    console.log(dim('  "No available channel" = your provider has not enabled that model for the key\'s group. Contact the provider.'));
  console.log('');
  process.exit(ok ? 0 : 2);
})();
