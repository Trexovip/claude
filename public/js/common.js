// Shared helpers for all pages.
window.$ = (sel, root = document) => root.querySelector(sel);
window.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];

window.esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

window.api = async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !url.startsWith('/api/login')) { location.href = '/login'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

window.toast = function toast(msg, kind = '') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`; t.textContent = msg; box.appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 2800);
};

// Modal: pass inner HTML; returns { el, close }. onMount gets the modal element.
window.openModal = function openModal(html, { wide = false, onMount } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(back);
  const el = back.firstElementChild;
  const prevFocus = document.activeElement;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  $$('[data-close]', el).forEach(b => b.addEventListener('click', close));
  onMount?.(el, close);
  setTimeout(() => (el.querySelector('[autofocus]') || el.querySelector('input,textarea,select,button'))?.focus(), 20);
  return { el, close };
};

window.confirmBox = (title, text, okLabel = 'Delete', danger = true) => new Promise(resolve => {
  let done = false;
  const m = openModal(`<h2>${esc(title)}</h2><p class="sub">${esc(text)}</p>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cOk">${esc(okLabel)}</button></div>`,
    { onMount: (el, close) => { $('#cOk', el).onclick = () => { done = true; close(); resolve(true); }; } });
  const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(false); } });
  obs.observe(document.body, { childList: true });
});

window.fmt = {
  cost: (n) => n == null ? '—' : (n < 0.01 && n > 0 ? '$' + n.toFixed(4) : '$' + n.toFixed(2)),
  costFine: (n) => '$' + (n || 0).toFixed(n >= 1 ? 2 : 4),
  num: (n) => (n || 0).toLocaleString(),
  tok: (n) => { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); },
  when: (ms) => {
    if (!ms) return 'never';
    const d = new Date(ms), diff = Date.now() - ms;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' h ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  },
};

// Icons (stroke SVG paths)
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  paperclip: '<path d="m21.4 11.1-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 10a3 3 0 0 0 1.2 2.4A3 3 0 0 0 6 17a3 3 0 0 0 3 3h1V4H9zM15 4a3 3 0 0 1 3 3v.2A3 3 0 0 1 20 10a3 3 0 0 1-1.2 2.4A3 3 0 0 1 18 17a3 3 0 0 1-3 3h-1V4h1z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m14 6 4 4"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  file: '<path d="M14 3H6v18h12V7l-4-4z"/><path d="M14 3v4h4"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  chat: '<path d="M4 5h16v11H9l-5 4V5z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  template: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M9 9v11"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
};
window.icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// ---------- Markdown rendering (shared by chat and admin review) ----------
const PREVIEWABLE = { html: 'html', htm: 'html', svg: 'svg', jsx: 'react', tsx: 'react', react: 'react' };
window.renderMarkdown = function renderMarkdown(text, { artifacts = false, streaming = false } = {}) {
  const renderer = new marked.Renderer();
  let codeIndex = 0;
  renderer.code = function (token) {
    const code = typeof token === 'object' ? token.text : token;
    const lang = (typeof token === 'object' ? token.lang : arguments[1]) || '';
    const l = lang.trim().split(/\s+/)[0].toLowerCase();
    let highlighted;
    try {
      highlighted = l && hljs.getLanguage(l) ? hljs.highlight(code, { language: l }).value : hljs.highlightAuto(code).value;
    } catch { highlighted = esc(code); }
    const idx = codeIndex++;
    const kind = PREVIEWABLE[l] || (l === 'xml' && /^\s*<svg/i.test(code) ? 'svg' : null);
    const encoded = encodeURIComponent(code);
    const block = `<div class="code-block"><div class="code-head"><span class="lang">${esc(l || 'text')}</span>
      ${kind && artifacts && !streaming ? `<button class="btn sm ghost" data-preview="${kind}" data-code="${encoded}">${icon('eye')} Preview</button>` : ''}
      <button class="btn sm ghost" data-copy="${encoded}">${icon('copy')} Copy</button></div>
      <pre><code class="hljs">${highlighted}</code></pre></div>`;
    if (kind && artifacts && !streaming && code.split('\n').length >= 6) {
      const title = guessTitle(code, kind);
      return `<div class="artifact-card" data-preview="${kind}" data-code="${encoded}" data-title="${esc(title)}">
        <div class="ic">${icon('code')}</div><div><b>${esc(title)}</b><small>${kind === 'react' ? 'React component' : kind.toUpperCase()} · ${code.split('\n').length} lines · click to open preview and code</small></div></div>`;
    }
    return block;
  };
  const html = marked.parse(text || '', { renderer, gfm: true, breaks: false });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-preview', 'data-code', 'data-copy', 'data-title', 'data-idx', 'target'] });
};
function guessTitle(code, kind) {
  const t = code.match(/<title>([^<]{1,60})<\/title>/i)?.[1]
    || code.match(/export\s+default\s+function\s+(\w+)/)?.[1]
    || code.match(/function\s+([A-Z]\w+)/)?.[1];
  return t || (kind === 'svg' ? 'SVG image' : kind === 'react' ? 'React component' : 'HTML page');
}

// Copy buttons anywhere
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard.writeText(decodeURIComponent(b.dataset.copy)).then(() => toast('Copied'));
});

// Open links from model output in a new tab.
if (window.DOMPurify) DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});

// Render one stored message's content blocks (used by chat and admin review).
window.renderMessageHTML = function (m, { artifacts = false } = {}) {
  const blocks = m.content || [];
  if (m.role === 'user') {
    const att = blocks.filter(b => b.type !== 'text' || b.filename).map(b => {
      if (b.type === 'image') return `<img src="data:${b.source.media_type};base64,${b.source.data}" alt="${esc(b.filename || 'image')}">`;
      return `<span class="file-chip">${icon('file')}${esc(b.filename || (b.type === 'document' ? 'document.pdf' : 'file'))}</span>`;
    }).join('');
    const text = blocks.filter(b => b.type === 'text' && !b.filename).map(b => b.text).join('\n');
    return `${att ? `<div class="attachments">${att}</div>` : ''}${text ? `<div class="bubble">${esc(text)}</div>` : ''}`;
  }
  let html = '';
  for (const b of blocks) {
    if (b.type === 'thinking') html += `<details class="thinking"><summary>Thought process</summary><div class="body">${esc(b.thinking)}</div></details>`;
    if (b.type === 'searches') html += `<div class="searching">${b.queries.map(q => `<span>Searched: ${esc(q)}</span>`).join('')}</div>`;
    if (b.type === 'text') html += `<div class="md">${renderMarkdown(b.text, { artifacts })}</div>`;
    if (b.type === 'sources') html += `<div class="sources">${b.items.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.url)}">${esc(s.title)}</a>`).join('')}</div>`;
  }
  if (m.stopped) html += `<div class="notice-line">Stopped before finishing.</div>`;
  return html;
};
