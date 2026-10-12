// Chat page: streaming chat, uploads, templates, artifacts, usage.
const S = {
  me: null, models: [], chats: [], templates: [],
  chat: null,          // current chat row (null = unsaved new chat)
  messages: [],
  draftSystem: '',     // system prompt for a chat not yet saved
  pending: [],         // attachments waiting to send
  streaming: false, abort: null,
  activeKey: null,
  prefs: JSON.parse(localStorage.getItem('cc_prefs') || '{}'),
  artifact: null,
};
const savePrefs = () => localStorage.setItem('cc_prefs', JSON.stringify(S.prefs));

// ---------- static icons ----------
$('#newChat').innerHTML = `${icon('plus')} New chat`;
$('#userMenuBtn').innerHTML = icon('more');
$('#menuToggle').innerHTML = icon('menu');
$('#systemBtn').innerHTML = icon('sliders');
$('#attachBtn').innerHTML = icon('paperclip');
$('#tplBtn').innerHTML = icon('zap');
$('#thinkBtn').innerHTML = icon('brain');
$('#searchBtn').innerHTML = icon('globe');
$('#sendBtn').innerHTML = icon('send');
$('#artCopy').innerHTML = icon('copy');
$('#artDownload').innerHTML = icon('download');
$('#artClose').innerHTML = icon('x');

// ---------- boot ----------
(async function init() {
  const me = await api('/api/me');
  S.me = me.user; S.models = me.models; S.defaultSystem = me.default_system_prompt; S.notice = me.notice;
  S.draftSystem = S.defaultSystem;
  $('#avatar').textContent = (S.me.display_name || S.me.username).slice(0, 1).toUpperCase();
  $('#whoName').textContent = S.me.display_name || S.me.username;
  $('#whoRole').textContent = S.me.role === 'admin' ? 'Admin' : 'Staff';
  buildUserMenu();
  buildModelSelect();
  applyToggles();
  await Promise.all([loadChats(), loadTemplates()]);
  const id = Number(location.hash.replace('#', ''));
  if (id && S.chats.some(c => c.id === id)) await openChat(id); else newChat();
})().catch(e => toast(e.message, 'error'));

function buildUserMenu() {
  const items = [
    ['chart', 'My usage', showUsage],
    ['template', 'Manage templates', manageTemplates],
    ['lock', 'Change password', changePassword],
  ];
  const m = $('#userMenu');
  m.innerHTML = (S.me.role === 'admin' ? `<a href="/admin" role="menuitem">${icon('shield')}Admin panel</a>` : '')
    + items.map(([ic, label], i) => `<button role="menuitem" data-i="${i}">${icon(ic)}${label}</button>`).join('')
    + `<button role="menuitem" id="logoutBtn">${icon('logout')}Sign out</button>`;
  $$('button[data-i]', m).forEach(b => b.onclick = () => { m.classList.add('hidden'); items[b.dataset.i][2](); });
  $('#logoutBtn').onclick = async () => { await api('/api/logout', { body: {} }); location.href = '/login'; };
}
$('#userMenuBtn').onclick = (e) => { e.stopPropagation(); $('#userMenu').classList.toggle('hidden'); };
document.addEventListener('click', (e) => {
  if (!e.target.closest('#userMenu')) $('#userMenu').classList.add('hidden');
  if (!e.target.closest('#tplPop') && !e.target.closest('#tplBtn')) $('#tplPop').classList.add('hidden');
});
$('#menuToggle').onclick = () => $('#sidebar').classList.toggle('open');

function buildModelSelect() {
  const sel = $('#modelSelect');
  if (!S.models.length) { sel.innerHTML = '<option>No models available</option>'; sel.disabled = true; return; }
  sel.innerHTML = S.models.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
  sel.value = S.models.some(m => m.id === S.prefs.model) ? S.prefs.model : S.models[0].id;
  sel.onchange = () => { S.prefs.model = sel.value; savePrefs(); renderStatus(); };
}
const currentModel = () => S.models.find(m => m.id === $('#modelSelect').value);

function applyToggles() {
  const canThink = S.me.role === 'admin' || S.me.allow_thinking;
  const canSearch = S.me.role === 'admin' || S.me.allow_web_search;
  $('#thinkBtn').classList.toggle('hidden', !canThink);
  $('#searchBtn').classList.toggle('hidden', !canSearch);
  if (!canThink) S.prefs.thinking = false;
  if (!canSearch) S.prefs.webSearch = false;
  $('#thinkBtn').classList.toggle('on', !!S.prefs.thinking);
  $('#thinkBtn').setAttribute('aria-pressed', !!S.prefs.thinking);
  $('#searchBtn').classList.toggle('on', !!S.prefs.webSearch);
  $('#searchBtn').setAttribute('aria-pressed', !!S.prefs.webSearch);
  $('#budgetWrap').classList.toggle('show', !!S.prefs.thinking);
  $('#budget').value = S.prefs.budget || 8192;
  $('#budgetVal').textContent = Math.round($('#budget').value / 1024) + 'k';
}
$('#thinkBtn').onclick = () => { S.prefs.thinking = !S.prefs.thinking; savePrefs(); applyToggles(); };
$('#searchBtn').onclick = () => { S.prefs.webSearch = !S.prefs.webSearch; savePrefs(); applyToggles(); };
$('#budget').oninput = () => { S.prefs.budget = Number($('#budget').value); $('#budgetVal').textContent = Math.round(S.prefs.budget / 1024) + 'k'; savePrefs(); };

// ---------- sidebar ----------
async function loadChats(q = '') {
  const r = await api('/api/chats' + (q ? '?q=' + encodeURIComponent(q) : ''));
  S.chats = r.chats; renderChatList(!!q);
}
let searchTimer;
$('#chatSearch').oninput = (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadChats(e.target.value.trim()), 250); };

function renderChatList(isSearch) {
  const list = $('#chatList');
  if (!S.chats.length) { list.innerHTML = `<div class="chat-group">${isSearch ? 'No chats match that search.' : 'Your chats will show up here.'}</div>`; return; }
  const today = new Date().setHours(0, 0, 0, 0);
  const groups = [['Today', c => c.updated_at >= today], ['Previous 7 days', c => c.updated_at >= today - 7 * 864e5], ['Previous 30 days', c => c.updated_at >= today - 30 * 864e5], ['Older', () => true]];
  const used = new Set();
  list.innerHTML = groups.map(([name, test]) => {
    const items = S.chats.filter(c => !used.has(c.id) && test(c));
    items.forEach(c => used.add(c.id));
    if (!items.length) return '';
    return `<div class="chat-group">${name}</div>` + items.map(c => `
      <div class="chat-item ${S.chat?.id === c.id ? 'active' : ''}" data-id="${c.id}" tabindex="0">
        <span class="t">${esc(c.title)}</span>
        <button class="icon-btn" data-act="rename" title="Rename" aria-label="Rename">${icon('edit')}</button>
        <button class="icon-btn" data-act="delete" title="Delete" aria-label="Delete">${icon('trash')}</button>
      </div>`).join('');
  }).join('');
  $$('.chat-item', list).forEach(el => {
    const id = Number(el.dataset.id);
    el.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'rename') return renameChat(id);
      if (act === 'delete') return deleteChat(id);
      openChat(id); $('#sidebar').classList.remove('open');
    };
    el.onkeydown = (e) => { if (e.key === 'Enter') el.click(); };
  });
}

async function renameChat(id) {
  const c = S.chats.find(x => x.id === id) || S.chat;
  openModal(`<h2>Rename chat</h2><div class="field" style="margin-top:14px"><input class="input" id="rn" value="${esc(c.title)}" autofocus></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="rnSave">Save</button></div>`, {
    onMount: (el, close) => {
      const save = async () => { await api(`/api/chats/${id}`, { method: 'PATCH', body: { title: $('#rn', el).value } }); close(); if (S.chat?.id === id) { S.chat.title = $('#rn', el).value || 'Untitled'; $('#chatTitle').textContent = S.chat.title; } loadChats(); };
      $('#rnSave', el).onclick = save; $('#rn', el).onkeydown = (e) => { if (e.key === 'Enter') save(); };
    },
  });
}
async function deleteChat(id) {
  if (!await confirmBox('Delete this chat?', 'The chat and its messages will be removed. Usage records stay in reports.')) return;
  await api(`/api/chats/${id}`, { method: 'DELETE' });
  if (S.chat?.id === id) newChat();
  loadChats();
}
$('#chatTitle').onclick = () => { if (S.chat) renameChat(S.chat.id); };

// ---------- open / new ----------
function newChat() {
  if (S.streaming) stopStream();
  S.chat = null; S.messages = []; S.draftSystem = S.defaultSystem || '';
  history.replaceState(null, '', '/chat');
  $('#chatTitle').textContent = 'New chat';
  closeArtifact();
  renderThread(); renderChatList(); renderStatus();
  $('#input').focus();
}
$('#newChat').onclick = () => { newChat(); $('#sidebar').classList.remove('open'); };

async function openChat(id) {
  if (S.streaming) stopStream();
  const r = await api(`/api/chats/${id}`);
  S.chat = r.chat; S.messages = r.messages;
  if (r.chat.model && S.models.some(m => m.id === r.chat.model)) $('#modelSelect').value = r.chat.model;
  history.replaceState(null, '', `/chat#${id}`);
  $('#chatTitle').textContent = r.chat.title;
  closeArtifact();
  renderThread(); renderChatList(); renderStatus();
  scrollBottom(true);
}

// ---------- thread rendering ----------
function renderThread() {
  const inner = $('#threadInner');
  if (!S.messages.length) {
    const name = (S.me.display_name || S.me.username).split(' ')[0];
    const starters = S.templates.slice(0, 4);
    inner.innerHTML = `<div class="empty"><h1>What are we working on, ${esc(name)}?</h1>
      <p>Pick a model above, attach files, or start from one of your templates.</p>
      ${starters.length ? `<div class="starts">${starters.map(t => `<button data-tpl="${t.id}">${esc(t.name)}</button>`).join('')}</div>` : ''}</div>`;
    $$('[data-tpl]', inner).forEach(b => b.onclick = () => useTemplate(S.templates.find(t => t.id === Number(b.dataset.tpl))));
    return;
  }
  inner.innerHTML = S.messages.map((m, i) => messageHTML(m, i === S.messages.length - 1)).join('');
  wireMessages(inner);
}

function messageHTML(m, isLast) {
  const body = renderMessageHTML(m, { artifacts: true });
  if (m.role === 'user') {
    return `<div class="msg user" data-id="${m.id}">${body}
      <div class="msg-actions">
        <button class="icon-btn" data-act="copy" title="Copy" aria-label="Copy">${icon('copy')}</button>
        <button class="icon-btn" data-act="edit" title="Edit and resend" aria-label="Edit and resend">${icon('edit')}</button>
      </div></div>`;
  }
  const meta = m.output_tokens || m.input_tokens
    ? `<span class="msg-meta" title="Input / output tokens and estimated cost">${fmt.tok(m.input_tokens)} in · ${fmt.tok(m.output_tokens)} out · <span class="c">${fmt.costFine(m.cost)}</span>${m.key_label ? ` · ${esc(m.key_label)}` : ''}</span>` : '';
  return `<div class="msg assistant" data-id="${m.id}">${body}
    <div class="msg-actions">
      <button class="icon-btn" data-act="copy" title="Copy" aria-label="Copy">${icon('copy')}</button>
      ${isLast ? `<button class="icon-btn" data-act="regen" title="Regenerate" aria-label="Regenerate">${icon('refresh')}</button>` : ''}
      ${meta}
    </div></div>`;
}

function wireMessages(root) {
  $$('.msg', root).forEach(el => {
    const m = S.messages.find(x => String(x.id) === el.dataset.id);
    if (!m) return;
    $$('[data-act]', el).forEach(b => b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'copy') {
        const text = m.content.filter(c => c.type === 'text' && !c.filename).map(c => c.text).join('\n');
        navigator.clipboard.writeText(text).then(() => toast('Copied'));
      }
      if (act === 'regen') runStream({ regenerate: true });
      if (act === 'edit') startEdit(el, m);
    });
  });
}

// Previews from code blocks and artifact cards
$('#threadInner').addEventListener('click', (e) => {
  const p = e.target.closest('[data-preview]');
  if (!p) return;
  openArtifact(p.dataset.preview, decodeURIComponent(p.dataset.code), p.dataset.title);
});

function startEdit(el, m) {
  if (S.streaming) return;
  const text = m.content.filter(c => c.type === 'text' && !c.filename).map(c => c.text).join('\n');
  const kept = m.content.filter(c => c.type !== 'text' || c.filename);
  el.innerHTML = `<div style="width:100%;max-width:85%">
    ${kept.length ? `<div class="muted" style="font-size:13px;margin-bottom:6px">${kept.length} attachment(s) will be kept.</div>` : ''}
    <textarea class="textarea" style="min-height:110px">${esc(text)}</textarea>
    <div class="row" style="justify-content:flex-end;margin-top:8px">
      <button class="btn sm" data-x>Cancel</button><button class="btn sm primary" data-s>Save and send</button></div></div>`;
  const ta = $('textarea', el); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  $('[data-x]', el).onclick = renderThread;
  $('[data-s]', el).onclick = () => {
    const t = ta.value.trim();
    const content = [...kept, ...(t ? [{ type: 'text', text: t }] : [])];
    if (!content.length) return toast('Type a message first.', 'error');
    runStream({ editMessageId: m.id, content });
  };
}

function scrollBottom(force) {
  const t = $('#thread');
  if (force || t.scrollHeight - t.scrollTop - t.clientHeight < 160) t.scrollTop = t.scrollHeight;
}

function renderStatus() {
  const m = currentModel();
  const total = S.messages.reduce((a, x) => a + (x.cost || 0), 0);
  $('#chatCost').textContent = total ? fmt.costFine(total) : '';
  const parts = [];
  if (S.activeKey) parts.push(`<span class="key-on">key: ${esc(S.activeKey)}</span>`);
  if (m) parts.push(`<span>${esc(m.id)} · $${m.input_price}/$${m.output_price} per M tokens</span>`);
  const sys = S.chat ? S.chat.system_prompt : S.draftSystem;
  if (sys?.trim()) parts.push('<span>system prompt on</span>');
  $('#statusLine').innerHTML = parts.join('');
}

// ---------- composer ----------
const input = $('#input');
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 260) + 'px'; updateSend(); }
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!S.streaming) send(); }
});
function updateSend() {
  const b = $('#sendBtn');
  if (S.streaming) { b.disabled = false; b.classList.add('stop'); b.innerHTML = icon('stop'); b.setAttribute('aria-label', 'Stop'); return; }
  b.classList.remove('stop'); b.innerHTML = icon('send'); b.setAttribute('aria-label', 'Send');
  b.disabled = !(input.value.trim() || S.pending.length) || !currentModel();
}
$('#sendBtn').onclick = () => S.streaming ? stopStream() : send();

// Attachments
$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
const composer = $('#composer');
['dragenter', 'dragover'].forEach(ev => composer.addEventListener(ev, (e) => { e.preventDefault(); composer.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => composer.addEventListener(ev, (e) => { e.preventDefault(); composer.classList.remove('drag'); }));
composer.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
input.addEventListener('paste', (e) => {
  const files = [...e.clipboardData.items].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); addFiles(files); }
});

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|toml|ini|log|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|r|lua|pl|vue|svelte|dart|scala|env|gitignore|dockerfile)$/i;
const readAs = (file, how) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r[how](file); });

async function addFiles(files) {
  for (const f of files) {
    try {
      if (/^image\/(png|jpeg|gif|webp)$/.test(f.type)) {
        const { data, media_type } = await prepImage(f);
        S.pending.push({ type: 'image', source: { type: 'base64', media_type, data }, filename: f.name, preview: `data:${media_type};base64,${data}` });
      } else if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        if (f.size > 30 * 1024 * 1024) { toast(`${f.name} is over 30 MB.`, 'error'); continue; }
        const url = await readAs(f, 'readAsDataURL');
        S.pending.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: url.split(',')[1] }, filename: f.name });
      } else if (f.type.startsWith('text/') || TEXT_EXT.test(f.name) || f.type === 'application/json') {
        if (f.size > 2 * 1024 * 1024) { toast(`${f.name} is over 2 MB of text.`, 'error'); continue; }
        S.pending.push({ type: 'text', text: await readAs(f, 'readAsText'), filename: f.name });
      } else toast(`${f.name}: attach images, PDFs, or text and code files.`, 'error');
    } catch (e) { toast(`Couldn't read ${f.name}.`, 'error'); }
  }
  renderPending(); updateSend();
}

// Downscale big images so they stay within API limits.
async function prepImage(file) {
  const url = await readAs(file, 'readAsDataURL');
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const max = 1568;
  if (img.width <= max && img.height <= max && file.size < 3.5 * 1024 * 1024) return { data: url.split(',')[1], media_type: file.type };
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const out = c.toDataURL('image/jpeg', 0.88);
  return { data: out.split(',')[1], media_type: 'image/jpeg' };
}

function renderPending() {
  const p = $('#pending');
  p.classList.toggle('hidden', !S.pending.length);
  p.innerHTML = S.pending.map((a, i) => `<div class="p">${a.type === 'image' ? `<img src="${a.preview}" alt="${esc(a.filename)}">` : `<span class="file-chip">${icon('file')}${esc(a.filename)}</span>`}
    <button class="x" data-i="${i}" aria-label="Remove ${esc(a.filename)}">×</button></div>`).join('');
  $$('.x', p).forEach(b => b.onclick = () => { S.pending.splice(Number(b.dataset.i), 1); renderPending(); updateSend(); });
}

// ---------- sending & streaming ----------
async function send() {
  const text = input.value.trim();
  if (!text && !S.pending.length) return;
  if (!currentModel()) return toast('No model is available. Ask an admin to enable one.', 'error');
  const content = [...S.pending.map(({ preview, ...b }) => b), ...(text ? [{ type: 'text', text }] : [])];
  if (!S.chat) {
    try {
      const r = await api('/api/chats', { body: { model: currentModel().id, system_prompt: S.draftSystem } });
      S.chat = { id: r.id, title: 'New chat', system_prompt: S.draftSystem };
      history.replaceState(null, '', `/chat#${r.id}`);
    } catch (e) { return toast(e.message, 'error'); }
  }
  input.value = ''; S.pending = []; renderPending(); autosize();
  runStream({ content });
}

async function runStream(opts) {
  if (S.streaming) return;
  // Optimistic view: apply edit/regenerate locally, add the user turn and a live assistant turn.
  if (opts.editMessageId) S.messages = S.messages.slice(0, S.messages.findIndex(m => m.id === opts.editMessageId));
  if (opts.regenerate) { while (S.messages.length && S.messages[S.messages.length - 1].role === 'assistant') S.messages.pop(); }
  if (opts.content) S.messages.push({ id: 'pending-user', role: 'user', content: opts.content });
  renderThread();
  const inner = $('#threadInner');
  const live = document.createElement('div');
  live.className = 'msg assistant';
  live.innerHTML = `<div class="live-think"></div><div class="live-search searching"></div><div class="md live-text cursor"></div><div class="live-sources"></div>`;
  inner.appendChild(live);
  scrollBottom(true);

  S.streaming = true; updateSend();
  S.abort = new AbortController();
  let text = '', thinking = '', sources = [], doneMsg = null, error = null;
  let rafPending = false;
  const paint = () => {
    rafPending = false;
    if (thinking) $('.live-think', live).innerHTML = `<details class="thinking" ${text ? '' : 'open'}><summary>${text ? 'Thought process' : 'Thinking…'}</summary><div class="body">${esc(thinking)}</div></details>`;
    const t = $('.live-text', live);
    t.innerHTML = text ? renderMarkdown(text, { streaming: true }) : (thinking ? '' : '<span class="muted">…</span>');
    if (sources.length) $('.live-sources', live).innerHTML = `<div class="sources">${sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>`).join('')}</div>`;
    const tb = $('.thinking .body', live); if (tb && !text) tb.scrollTop = tb.scrollHeight;
    scrollBottom();
  };
  const schedule = () => { if (!rafPending) { rafPending = true; requestAnimationFrame(paint); } };

  try {
    const res = await fetch(`/api/chats/${S.chat.id}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', signal: S.abort.signal,
      body: JSON.stringify({ ...opts, model: currentModel().id, thinking: !!S.prefs.thinking, thinkingBudget: S.prefs.budget || 8192, webSearch: !!S.prefs.webSearch }),
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Request failed (${res.status})`); }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'text') { text += ev.delta; schedule(); }
        else if (ev.type === 'thinking') { thinking += ev.delta; schedule(); }
        else if (ev.type === 'search') { $('.live-search', live).insertAdjacentHTML('beforeend', `<span>Searching: ${esc(ev.query)}</span>`); scrollBottom(); }
        else if (ev.type === 'sources') { ev.items.forEach(s => { if (!sources.some(x => x.url === s.url)) sources.push(s); }); schedule(); }
        else if (ev.type === 'notice') { $('.live-search', live).insertAdjacentHTML('beforeend', `<span class="notice-line">${esc(ev.message)}</span>`); }
        else if (ev.type === 'key') { S.activeKey = ev.label; renderStatus(); if (ev.switched) toast(`Switched to key "${ev.label}"`); }
        else if (ev.type === 'done') doneMsg = ev.message;
        else if (ev.type === 'error') error = ev.message;
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') error = e.message;
  }
  S.streaming = false; S.abort = null; updateSend();

  // Reload the saved chat so ids, costs and stored blocks are exact.
  try {
    const r = await api(`/api/chats/${S.chat.id}`);
    S.chat = r.chat; S.messages = r.messages;
    $('#chatTitle').textContent = r.chat.title;
  } catch { /* keep local view */ }
  renderThread();
  if (error) {
    const box = document.createElement('div');
    box.className = 'msg';
    box.innerHTML = `<div class="err-box"><div style="flex:1">${esc(error)}</div><button class="btn sm">Retry</button></div>`;
    $('button', box).onclick = () => { box.remove(); runStream({ regenerate: true }); };
    $('#threadInner').appendChild(box);
  } else if (doneMsg?.stop_reason === 'max_tokens') {
    $('#threadInner').insertAdjacentHTML('beforeend', '<div class="notice-line">The reply hit the model\'s length limit. Ask it to continue, or raise max tokens in Admin › Models.</div>');
  }
  scrollBottom(true); renderStatus(); loadChats($('#chatSearch').value.trim());
  input.focus();
}

function stopStream() { S.abort?.abort(); }

// ---------- system prompt ----------
$('#systemBtn').onclick = () => {
  const cur = S.chat ? S.chat.system_prompt : S.draftSystem;
  openModal(`<h2>System prompt</h2><p class="sub">Instructions Claude follows for this whole chat, like a role, tone, or rules.</p>
    <textarea class="textarea" id="sysTa" style="min-height:180px" placeholder="You are a helpful assistant for our support team…" autofocus>${esc(cur || '')}</textarea>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="sysSave">Save</button></div>`, {
    onMount: (el, close) => {
      $('#sysSave', el).onclick = async () => {
        const v = $('#sysTa', el).value;
        if (S.chat) { await api(`/api/chats/${S.chat.id}`, { method: 'PATCH', body: { system_prompt: v } }); S.chat.system_prompt = v; }
        else S.draftSystem = v;
        close(); renderStatus(); toast('System prompt saved');
      };
    },
  });
};

// ---------- templates (custom button) ----------
async function loadTemplates() { S.templates = (await api('/api/templates')).templates; }

$('#tplBtn').onclick = (e) => {
  e.stopPropagation();
  const pop = $('#tplPop');
  if (!pop.classList.contains('hidden')) return pop.classList.add('hidden');
  const mine = S.templates.filter(t => !t.shared), shared = S.templates.filter(t => t.shared);
  const list = (arr) => arr.map(t => `<button class="item" data-id="${t.id}"><b>${esc(t.name)}</b><small>${esc(t.body.slice(0, 90))}</small></button>`).join('');
  pop.innerHTML = (S.templates.length ? '' : '<div class="h">No templates yet.</div>')
    + (shared.length ? `<div class="h">Shared by admin</div>${list(shared)}` : '')
    + (mine.length ? `<div class="h">Mine</div>${list(mine)}` : '')
    + `<div class="foot"><button class="item" id="tplNew"><b>New template</b></button><button class="item" id="tplManage"><b>Manage templates</b></button></div>`;
  pop.classList.remove('hidden');
  $$('[data-id]', pop).forEach(b => b.onclick = () => { pop.classList.add('hidden'); useTemplate(S.templates.find(t => t.id === Number(b.dataset.id))); });
  $('#tplNew', pop).onclick = () => { pop.classList.add('hidden'); editTemplate(); };
  $('#tplManage', pop).onclick = () => { pop.classList.add('hidden'); manageTemplates(); };
};

// Fill {{variables}}, then drop the result into the input box for tweaking.
function useTemplate(t) {
  if (!t) return;
  const vars = [...new Set([...t.body.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map(m => m[1]))];
  const insert = (body) => {
    input.value = input.value ? input.value.replace(/\s*$/, '\n\n') + body : body;
    autosize(); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  };
  if (!vars.length) return insert(t.body);
  openModal(`<h2>${esc(t.name)}</h2><p class="sub">Fill in the blanks. The finished prompt goes into the message box so you can adjust it.</p>
    ${vars.map((v, i) => `<div class="field"><label for="tv${i}">${esc(v)}</label><textarea class="textarea" id="tv${i}" style="min-height:60px" ${i === 0 ? 'autofocus' : ''}></textarea></div>`).join('')}
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="tvOk">Insert prompt</button></div>`, {
    onMount: (el, close) => {
      $('#tvOk', el).onclick = () => {
        let body = t.body;
        vars.forEach((v, i) => { body = body.replace(new RegExp(`\\{\\{\\s*${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g'), $(`#tv${i}`, el).value); });
        close(); insert(body);
      };
    },
  });
}

function editTemplate(t, after) {
  const canShare = S.me.role === 'admin' && !t;
  openModal(`<h2>${t ? 'Edit template' : 'New template'}</h2>
    <p class="sub">Use <span class="mono">{{name}}</span> for blanks you fill in each time, like <span class="mono">{{customer name}}</span>.</p>
    <div class="field"><label for="tn">Name</label><input class="input" id="tn" value="${esc(t?.name || '')}" autofocus></div>
    <div class="field"><label for="tb">Prompt</label><textarea class="textarea" id="tb" style="min-height:180px">${esc(t?.body || '')}</textarea></div>
    ${canShare ? '<label class="check"><input type="checkbox" id="tsh"> Share with all staff</label>' : ''}
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="tSave">Save template</button></div>`, {
    onMount: (el, close) => {
      $('#tSave', el).onclick = async () => {
        const body = { name: $('#tn', el).value, body: $('#tb', el).value, shared: !!$('#tsh', el)?.checked };
        try {
          if (t) await api(`/api/templates/${t.id}`, { method: 'PUT', body }); else await api('/api/templates', { body });
          close(); await loadTemplates(); toast('Template saved'); if (!S.messages.length) renderThread(); after?.();
        } catch (e) { toast(e.message, 'error'); }
      };
    },
  });
}

function manageTemplates() {
  const render = (el) => {
    const editable = S.templates.filter(t => !t.shared || S.me.role === 'admin');
    $('#tlist', el).innerHTML = editable.length ? `<table class="data"><tbody>${editable.map(t => `<tr>
      <td><b style="font-weight:500">${esc(t.name)}</b> ${t.shared ? '<span class="tag accent">shared</span>' : ''}<div class="muted" style="font-size:13px;max-width:440px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.body)}</div></td>
      <td class="actions"><button class="btn sm" data-e="${t.id}">Edit</button> <button class="btn sm danger" data-d="${t.id}">Delete</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty-row">No templates yet. Create one to reuse prompts with a click.</div>';
    $$('[data-e]', el).forEach(b => b.onclick = () => editTemplate(S.templates.find(t => t.id === Number(b.dataset.e)), () => render(el)));
    $$('[data-d]', el).forEach(b => b.onclick = async () => {
      if (!await confirmBox('Delete template?', 'This removes it for everyone who can see it.')) return;
      await api(`/api/templates/${b.dataset.d}`, { method: 'DELETE' }); await loadTemplates(); render(el);
    });
  };
  openModal(`<div class="row"><h2 style="flex:1">Templates</h2><button class="btn sm primary" id="tAdd">${icon('plus')} New template</button></div>
    <p class="sub">Templates appear under the ⚡ button next to the message box.</p><div class="table-wrap" id="tlist"></div>
    <div class="modal-actions"><button class="btn" data-close>Done</button></div>`, {
    wide: true, onMount: (el) => { render(el); $('#tAdd', el).onclick = () => editTemplate(null, () => render(el)); },
  });
}

// ---------- usage ----------
async function showUsage() {
  const r = await api('/api/me/usage');
  const u = r.user;
  const meter = (used, lim, money) => {
    if (lim == null) return `<div class="muted" style="font-size:13px">${money ? fmt.costFine(used) : fmt.num(used) + ' tokens'} used · no limit</div>`;
    const pct = Math.min(100, used / lim * 100);
    return `<div class="row" style="justify-content:space-between;font-size:13px;margin-bottom:5px"><span>${money ? fmt.costFine(used) : fmt.num(used)} of ${money ? fmt.cost(lim) : fmt.num(lim)}</span><span class="muted">${pct.toFixed(0)}%</span></div>
      <div class="meter"><i class="${pct >= 100 ? 'bad' : pct > 80 ? 'warn' : ''}" style="width:${pct}%"></i></div>`;
  };
  const showCost = u.limit_mode === 'cost' || u.limit_mode === 'both' || u.limit_mode === 'none';
  const showTok = u.limit_mode === 'tokens' || u.limit_mode === 'both';
  const maxDay = Math.max(0.0001, ...r.daily.map(d => d.cost));
  openModal(`<h2>My usage</h2><p class="sub">${u.limit_mode === 'none' || u.role === 'admin' ? 'You have no usage limits.' : 'Your limits reset at midnight (daily) and on the 1st (monthly).'}</p>
    <div class="grid-2">
      ${showCost ? `<div class="panel" style="margin:0"><div class="panel-body"><div class="muted" style="font-size:13px;margin-bottom:8px">Today, cost</div>${meter(r.totals.today.cost, u.limit_mode === 'none' ? null : u.daily_cost_limit, true)}</div></div>
      <div class="panel" style="margin:0"><div class="panel-body"><div class="muted" style="font-size:13px;margin-bottom:8px">This month, cost</div>${meter(r.totals.month.cost, u.limit_mode === 'none' ? null : u.monthly_cost_limit, true)}</div></div>` : ''}
      ${showTok ? `<div class="panel" style="margin:0"><div class="panel-body"><div class="muted" style="font-size:13px;margin-bottom:8px">Today, tokens</div>${meter(r.totals.today.tokens, u.daily_token_limit, false)}</div></div>
      <div class="panel" style="margin:0"><div class="panel-body"><div class="muted" style="font-size:13px;margin-bottom:8px">This month, tokens</div>${meter(r.totals.month.tokens, u.monthly_token_limit, false)}</div></div>` : ''}
    </div>
    <div class="section-title">Last 30 days</div>
    ${r.daily.length ? `<div class="bar-chart">${r.daily.map(d => `<div class="b" style="height:${Math.max(2, d.cost / maxDay * 100)}%" data-tip="${d.day}: ${fmt.costFine(d.cost)} · ${d.requests} req"></div>`).join('')}</div>
      <div class="bar-axis"><span>${r.daily[0].day}</span><span>${r.daily[r.daily.length - 1].day}</span></div>` : '<div class="muted">No usage yet.</div>'}
    ${r.byModel.length ? `<div class="section-title">By model</div><table class="data"><thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>
      ${r.byModel.map(m => `<tr><td class="mono" style="font-size:13px">${esc(m.model)}</td><td class="num">${fmt.num(m.requests)}</td><td class="num">${fmt.tok(m.tokens)}</td><td class="num cost">${fmt.costFine(m.cost)}</td></tr>`).join('')}</tbody></table>` : ''}
    <div class="modal-actions"><button class="btn" data-close>Close</button></div>`, { wide: true });
}

function changePassword() {
  openModal(`<h2>Change password</h2><p class="sub">You'll stay signed in here; other devices get signed out.</p>
    <div class="field"><label for="pc">Current password</label><input class="input" type="password" id="pc" autocomplete="current-password" autofocus></div>
    <div class="field"><label for="pn">New password</label><input class="input" type="password" id="pn" autocomplete="new-password"><span class="hint">At least 10 characters.</span></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pSave">Change password</button></div>`, {
    onMount: (el, close) => {
      $('#pSave', el).onclick = async () => {
        try { await api('/api/me/password', { body: { current: $('#pc', el).value, next: $('#pn', el).value } }); close(); toast('Password changed'); }
        catch (e) { toast(e.message, 'error'); }
      };
    },
  });
}

// ---------- artifacts ----------
function buildPreviewDoc(kind, code) {
  if (kind === 'html') return /<html[\s>]/i.test(code) ? code : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${code}</body></html>`;
  if (kind === 'svg') return `<!doctype html><html><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#fff">${code}</body></html>`;
  // React: strip imports/exports, compile with Babel in the sandbox, render the default component.
  let src = code.replace(/^\s*import\s[^;]*?from\s+['"][^'"]+['"];?\s*$/gm, '').replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');
  let name = src.match(/export\s+default\s+function\s+(\w+)/)?.[1];
  src = src.replace(/export\s+default\s+function\s+(\w+)/, 'function $1');
  if (!name) { const m = src.match(/export\s+default\s+(\w+)\s*;?/); if (m) { name = m[1]; src = src.replace(m[0], ''); } }
  src = src.replace(/export\s+(const|function|class)\s/g, '$1 ');
  name = name || src.match(/(?:function|const)\s+([A-Z]\w*)/)?.[1] || 'App';
  const payload = JSON.stringify(src + `\n;ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(${name}));`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7.26.4/babel.min.js"><\/script>
<script src="https://cdn.tailwindcss.com/3.4.17"><\/script></head>
<body><div id="root"></div><pre id="err" style="color:#b00020;white-space:pre-wrap;font:13px monospace;padding:12px"></pre>
<script>
const { useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, createContext, Fragment, useLayoutEffect, useId } = React;
try {
  const out = Babel.transform(${payload}, { presets: [['typescript', { isTSX: true, allExtensions: true }], 'react'] }).code;
  new Function(out)();
} catch (e) { document.getElementById('err').textContent = 'Preview error: ' + e.message + '\\n\\nOnly React and Tailwind are available in previews.'; }
<\/script></body></html>`;
}

function openArtifact(kind, code, title) {
  S.artifact = { kind, code, title: title || (kind === 'react' ? 'React component' : kind === 'svg' ? 'SVG image' : 'HTML page'), view: 'preview' };
  $('#artifactPanel').classList.remove('hidden');
  renderArtifact();
}
function renderArtifact() {
  const a = S.artifact; if (!a) return;
  $('#artName').textContent = a.title;
  $$('.seg button', $('#artifactPanel')).forEach(b => b.classList.toggle('on', b.dataset.view === a.view));
  const body = $('#artBody');
  if (a.view === 'code') {
    const lang = a.kind === 'react' ? 'javascript' : 'xml';
    body.innerHTML = `<pre><code class="hljs">${hljs.highlight(a.code, { language: lang }).value}</code></pre>`;
  } else {
    body.innerHTML = '';
    const f = document.createElement('iframe');
    // No allow-same-origin: preview code can't reach this app or your session.
    f.setAttribute('sandbox', 'allow-scripts allow-modals allow-forms allow-popups');
    f.srcdoc = buildPreviewDoc(a.kind, a.code);
    body.appendChild(f);
  }
}
$$('.seg button', $('#artifactPanel')).forEach(b => b.onclick = () => { S.artifact.view = b.dataset.view; renderArtifact(); });
function closeArtifact() { S.artifact = null; $('#artifactPanel').classList.add('hidden'); $('#artBody').innerHTML = ''; }
$('#artClose').onclick = closeArtifact;
$('#artCopy').onclick = () => navigator.clipboard.writeText(S.artifact.code).then(() => toast('Copied'));
$('#artDownload').onclick = () => {
  const a = S.artifact;
  const ext = a.kind === 'react' ? 'jsx' : a.kind;
  const blob = new Blob([a.code], { type: 'text/plain' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = (a.title || 'artifact').replace(/[^\w.-]+/g, '-').toLowerCase() + '.' + ext;
  link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
