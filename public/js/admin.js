// Admin panel: overview, staff, API keys, models, reports, chat review, shared templates, settings.
const NAV = {
  overview: ['chart', 'Overview'], staff: ['users', 'Staff'], keys: ['key', 'API keys'], models: ['cpu', 'Models'],
  reports: ['chart', 'Usage reports'], chats: ['chat', 'Chat review'], templates: ['template', 'Shared templates'], settings: ['gear', 'Settings'],
};
$$('#nav [data-page]').forEach(b => { const [ic, label] = NAV[b.dataset.page]; b.innerHTML = `${icon(ic)}${label}`; b.onclick = () => go(b.dataset.page); });
$('#nav [data-page="overview"]').innerHTML = `${icon('eye')}Overview`;
$('#toChat').innerHTML = `${icon('chat')}Open chat`; $('#toChat').onclick = () => location.href = '/chat';
$('#logout').innerHTML = `${icon('logout')}Sign out`; $('#logout').onclick = async () => { await api('/api/logout', { body: {} }); location.href = '/login'; };

const A = { models: [] };
const page = $('#page');
const head = (title, sub, actions = '') => `<div class="page-head"><button class="icon-btn menu-toggle" onclick="document.getElementById('nav').classList.toggle('open')" aria-label="Menu">${icon('menu')}</button>
  <div style="flex:1;min-width:220px"><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${actions}</div>`;

function go(p) {
  if (!NAV[p]) p = 'overview';
  location.hash = p;
  $$('#nav [data-page]').forEach(b => b.classList.toggle('on', b.dataset.page === p));
  $('#nav').classList.remove('open');
  ({ overview, staff, keys, models, reports, chats, templates, settings })[p]().catch(e => toast(e.message, 'error'));
}
(async () => { A.models = (await api('/api/admin/models')).models; go(location.hash.slice(1)); })();

// ---------- overview ----------
async function overview() {
  const [o, u, k] = await Promise.all([api('/api/admin/overview'), api('/api/admin/usage'), api('/api/admin/keys')]);
  const maxDay = Math.max(0.0001, ...u.daily.map(d => d.cost));
  page.innerHTML = head('Overview', 'Spending, activity and key health at a glance.') + `
  <div class="stats">
    <div class="stat"><div class="v amber">${fmt.costFine(o.today.cost)}</div><div class="l">Spent today · ${fmt.num(o.today.requests)} requests</div></div>
    <div class="stat"><div class="v amber">${fmt.costFine(o.month.cost)}</div><div class="l">Spent this month</div></div>
    <div class="stat"><div class="v">${o.activeToday} / ${o.staff}</div><div class="l">Staff active today</div></div>
    <div class="stat"><div class="v">${o.keys.ready || 0} / ${o.keys.total || 0}</div><div class="l">API keys ready</div></div>
  </div>
  ${!o.keys.total ? `<div class="panel"><div class="panel-body row"><div style="flex:1"><b style="font-weight:500">Add your first API key</b><div class="muted" style="font-size:14px">Nobody can chat until there's at least one key.</div></div><button class="btn primary" onclick="go('keys')">Add API key</button></div></div>` : ''}
  <div class="panel"><div class="panel-head"><h2>Daily spend, last 30 days</h2></div><div class="panel-body">
    ${u.daily.length ? `<div class="bar-chart">${u.daily.map(d => `<div class="b" style="height:${Math.max(2, d.cost / maxDay * 100)}%" data-tip="${d.day}: ${fmt.costFine(d.cost)} · ${d.requests} req"></div>`).join('')}</div>
    <div class="bar-axis"><span>${u.daily[0].day}</span><span>${u.daily[u.daily.length - 1].day}</span></div>` : '<div class="muted">No usage yet.</div>'}
  </div></div>
  <div class="grid-2">
    <div class="panel"><div class="panel-head"><h2>Top staff, 30 days</h2></div><div class="table-wrap"><table class="data"><tbody>
      ${u.byUser.slice(0, 6).map(r => `<tr><td>${esc(r.display_name || r.username)}</td><td class="num">${fmt.num(r.requests)} req</td><td class="num cost">${fmt.costFine(r.cost)}</td></tr>`).join('') || '<tr><td class="empty-row">No usage yet.</td></tr>'}
    </tbody></table></div></div>
    <div class="panel"><div class="panel-head"><h2>Key status</h2></div><div class="table-wrap"><table class="data"><tbody>
      ${k.keys.map(x => `<tr><td>${esc(x.label)}</td><td>${keyState(x)}</td><td class="num muted">${fmt.when(x.last_used_at)}</td></tr>`).join('') || '<tr><td class="empty-row">No keys yet.</td></tr>'}
    </tbody></table></div></div>
  </div>`;
}
function keyState(k) {
  if (!k.enabled) return '<span class="tag">disabled</span>';
  if (k.cooldown_until > Date.now()) return `<span class="tag warn" title="${esc(k.last_error || '')}">cooling down · ${Math.ceil((k.cooldown_until - Date.now()) / 60000)} min</span>`;
  if (k.last_error) return `<span class="tag bad" title="${esc(k.last_error)}">last request failed</span>`;
  return '<span class="tag ok">ready</span>';
}

// ---------- staff ----------
async function staff() {
  const { users } = await api('/api/admin/users');
  const limitText = (u) => {
    if (u.role === 'admin') return '<span class="muted">unlimited</span>';
    if (u.limit_mode === 'none') return '<span class="muted">no limit</span>';
    const p = [];
    if (u.limit_mode !== 'tokens') { if (u.daily_cost_limit != null) p.push(`${fmt.cost(u.daily_cost_limit)}/day`); if (u.monthly_cost_limit != null) p.push(`${fmt.cost(u.monthly_cost_limit)}/mo`); }
    if (u.limit_mode !== 'cost') { if (u.daily_token_limit != null) p.push(`${fmt.tok(u.daily_token_limit)} tok/day`); if (u.monthly_token_limit != null) p.push(`${fmt.tok(u.monthly_token_limit)} tok/mo`); }
    return p.join(', ') || '<span class="muted">none set</span>';
  };
  page.innerHTML = head('Staff', 'Create accounts, set limits, and choose which models each person can use.', `<button class="btn primary" id="addUser">${icon('plus')} Add staff member</button>`) + `
  <div class="panel"><div class="table-wrap"><table class="data">
    <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Limits</th><th class="num">Today</th><th class="num">This month</th><th>Last sign-in</th><th></th></tr></thead>
    <tbody>${users.map(u => `<tr class="click" data-id="${u.id}">
      <td><b style="font-weight:500">${esc(u.display_name || u.username)}</b><div class="muted mono" style="font-size:12px">${esc(u.username)}</div></td>
      <td>${u.role === 'admin' ? '<span class="tag accent">admin</span>' : '<span class="tag">staff</span>'}</td>
      <td>${u.active ? '<span class="tag ok">active</span>' : '<span class="tag bad">disabled</span>'}</td>
      <td style="font-size:13px">${limitText(u)}</td>
      <td class="num cost">${fmt.costFine(u.usage.today.cost)}</td><td class="num cost">${fmt.costFine(u.usage.month.cost)}</td>
      <td class="muted" style="font-size:13px">${fmt.when(u.last_login_at)}</td>
      <td class="actions"><button class="btn sm" data-edit="${u.id}">Edit</button></td></tr>`).join('')}</tbody>
  </table></div></div>`;
  $('#addUser').onclick = () => userForm(null);
  $$('tr.click').forEach(tr => tr.onclick = () => userForm(users.find(u => u.id === Number(tr.dataset.id))));
}

function userForm(u) {
  const isNew = !u;
  u = u || { role: 'staff', active: true, limit_mode: 'cost', allowed_models: [], allow_web_search: true, allow_thinking: true };
  const v = (x) => x == null ? '' : x;
  openModal(`<h2>${isNew ? 'Add staff member' : `Edit ${esc(u.display_name || u.username)}`}</h2>
    <p class="sub">${isNew ? 'Share the username and password with them. They can change the password after signing in.' : 'Changes apply to their next message.'}</p>
    <div class="grid-2">
      <div class="field"><label for="fu">Username</label><input class="input" id="fu" value="${esc(v(u.username))}" ${isNew ? 'autofocus' : 'disabled'}></div>
      <div class="field"><label for="fn">Display name</label><input class="input" id="fn" value="${esc(v(u.display_name))}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label for="fp">${isNew ? 'Password' : 'New password'}</label><input class="input" id="fp" type="text" autocomplete="off" placeholder="${isNew ? 'At least 10 characters' : 'Leave blank to keep current'}"></div>
      <div class="field"><label for="fr">Role</label><select class="select" id="fr"><option value="staff">Staff</option><option value="admin">Admin</option></select></div>
    </div>
    ${!isNew ? `<label class="check" style="margin-bottom:6px"><input type="checkbox" id="fa" ${u.active ? 'checked' : ''}> Account active (unchecked signs them out and blocks sign-in)</label>` : ''}
    <div class="section-title">Usage limits</div>
    <div class="field"><label for="fm">Count limits in</label><select class="select" id="fm">
      <option value="none">No limit</option><option value="cost">Cost (USD)</option><option value="tokens">Tokens</option><option value="both">Both cost and tokens</option></select></div>
    <div class="grid-2" id="costLim">
      <div class="field"><label for="fdc">Daily cost limit ($)</label><input class="input" id="fdc" type="number" min="0" step="0.01" value="${v(u.daily_cost_limit)}" placeholder="No daily cap"></div>
      <div class="field"><label for="fmc">Monthly cost limit ($)</label><input class="input" id="fmc" type="number" min="0" step="0.01" value="${v(u.monthly_cost_limit)}" placeholder="No monthly cap"></div>
    </div>
    <div class="grid-2" id="tokLim">
      <div class="field"><label for="fdt">Daily token limit</label><input class="input" id="fdt" type="number" min="0" step="1000" value="${v(u.daily_token_limit)}" placeholder="No daily cap"></div>
      <div class="field"><label for="fmt">Monthly token limit</label><input class="input" id="fmt" type="number" min="0" step="1000" value="${v(u.monthly_token_limit)}" placeholder="No monthly cap"></div>
    </div>
    <div class="section-title">Access</div>
    <div class="field"><label>Models they can use <span class="hint">(none ticked = all enabled models)</span></label>
      <div class="model-checks">${A.models.map(m => `<label class="check"><input type="checkbox" class="fmod" value="${esc(m.id)}" ${u.allowed_models.includes(m.id) ? 'checked' : ''}> ${esc(m.label)}${m.enabled ? '' : ' <span class="tag">off</span>'}</label>`).join('')}</div></div>
    <div class="row" style="gap:20px">
      <label class="check"><input type="checkbox" id="fws" ${u.allow_web_search ? 'checked' : ''}> Web search</label>
      <label class="check"><input type="checkbox" id="fth" ${u.allow_thinking ? 'checked' : ''}> Extended thinking</label>
    </div>
    <div class="modal-actions">${!isNew ? '<button class="btn danger" id="fDel" style="margin-right:auto">Delete account</button>' : ''}
      <button class="btn" data-close>Cancel</button><button class="btn primary" id="fSave">${isNew ? 'Create account' : 'Save changes'}</button></div>`, {
    wide: true,
    onMount: (el, close) => {
      $('#fr', el).value = u.role; $('#fm', el).value = u.limit_mode;
      const sync = () => { const m = $('#fm', el).value; $('#costLim', el).classList.toggle('hidden', !(m === 'cost' || m === 'both')); $('#tokLim', el).classList.toggle('hidden', !(m === 'tokens' || m === 'both')); };
      $('#fm', el).onchange = sync; sync();
      $('#fSave', el).onclick = async () => {
        const body = {
          username: $('#fu', el).value.trim(), display_name: $('#fn', el).value.trim(), role: $('#fr', el).value,
          limit_mode: $('#fm', el).value,
          daily_cost_limit: $('#fdc', el).value, monthly_cost_limit: $('#fmc', el).value,
          daily_token_limit: $('#fdt', el).value, monthly_token_limit: $('#fmt', el).value,
          allowed_models: $$('.fmod', el).filter(c => c.checked).map(c => c.value),
          allow_web_search: $('#fws', el).checked, allow_thinking: $('#fth', el).checked,
        };
        const pw = $('#fp', el).value; if (pw) body.password = pw;
        if (!isNew) body.active = $('#fa', el).checked;
        try {
          if (isNew) await api('/api/admin/users', { body }); else await api(`/api/admin/users/${u.id}`, { method: 'PUT', body });
          close(); toast(isNew ? 'Account created' : 'Changes saved'); staff();
        } catch (e) { toast(e.message, 'error'); }
      };
      $('#fDel', el) && ($('#fDel', el).onclick = async () => {
        if (!await confirmBox(`Delete ${u.username}?`, 'Their chats are deleted. Their usage stays in reports. To keep chats, disable the account instead.')) return;
        try { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); close(); toast('Account deleted'); staff(); } catch (e) { toast(e.message, 'error'); }
      });
    },
  });
}

// ---------- API keys ----------
async function keys() {
  const r = await api('/api/admin/keys');
  const spend = Object.fromEntries(r.spend.map(s => [s.key_id, s]));
  page.innerHTML = head('API keys', `Requests use the top ready key. If it hits a rate limit, runs out of credit, or fails, the next key takes over automatically. Default endpoint: <span class="mono">${esc(r.default_endpoint)}</span>`,
    `<button class="btn primary" id="addKey">${icon('plus')} Add API key</button>`) + `
  <div class="panel"><div class="table-wrap"><table class="data">
    <thead><tr><th></th><th>Label</th><th>Key</th><th>Status</th><th class="num">Requests</th><th class="num">Failures</th><th class="num">Spend this month</th><th>Last used</th><th></th></tr></thead>
    <tbody id="keyRows">${r.keys.map((k, i) => `<tr draggable="true" data-id="${k.id}">
      <td class="key-row-drag" title="Drag to reorder">${icon('grip')}</td>
      <td><b style="font-weight:500">${esc(k.label)}</b>${i === 0 ? ' <span class="tag accent">first</span>' : ''}${k.endpoint ? `<div class="muted mono" style="font-size:11px">${esc(k.endpoint)}</div>` : ''}</td>
      <td class="mono muted" style="font-size:13px">${esc(k.key_hint)}</td>
      <td>${keyState(k)}${k.last_error ? `<div class="muted" style="font-size:12px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(k.last_error)}">${esc(k.last_error)}</div>` : ''}</td>
      <td class="num">${fmt.num(k.request_count)}</td><td class="num">${fmt.num(k.fail_count)}</td>
      <td class="num cost">${fmt.costFine(spend[k.id]?.cost || 0)}</td>
      <td class="muted" style="font-size:13px">${fmt.when(k.last_used_at)}</td>
      <td class="actions"><button class="btn sm" data-test="${k.id}">Test</button> ${k.cooldown_until > Date.now() || k.last_error ? `<button class="btn sm" data-reset="${k.id}">Clear error</button> ` : ''}<button class="btn sm" data-edit="${k.id}">Edit</button></td></tr>`).join('')
      || '<tr><td colspan="9" class="empty-row">No keys yet. Add one to start chatting.</td></tr>'}</tbody>
  </table></div></div>
  <p class="muted" style="font-size:13px">Keys are encrypted on the server and never sent to browsers. How keys are sent (x-api-key, Bearer, or both) is set in Settings. Drag rows to change which key is tried first.</p>`;
  $('#addKey').onclick = () => keyForm(null);
  $$('[data-edit]').forEach(b => b.onclick = () => keyForm(r.keys.find(k => k.id === Number(b.dataset.edit))));
  $$('[data-reset]').forEach(b => b.onclick = async () => { await api(`/api/admin/keys/${b.dataset.reset}/reset`, { body: {} }); keys(); });
  $$('[data-test]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Testing…';
    const t = await api(`/api/admin/keys/${b.dataset.test}/test`, { body: {} }).catch(e => ({ ok: false, message: e.message }));
    toast(t.message, t.ok ? '' : 'error'); keys();
  });
  // drag to reorder
  let dragId = null;
  $$('#keyRows tr[draggable]').forEach(tr => {
    tr.ondragstart = () => { dragId = tr.dataset.id; tr.style.opacity = .4; };
    tr.ondragend = () => { tr.style.opacity = 1; };
    tr.ondragover = (e) => { e.preventDefault(); };
    tr.ondrop = async (e) => {
      e.preventDefault();
      const rows = $$('#keyRows tr[draggable]'); const from = rows.find(x => x.dataset.id === dragId);
      if (!from || from === tr) return;
      tr.parentNode.insertBefore(from, rows.indexOf(from) < rows.indexOf(tr) ? tr.nextSibling : tr);
      await api('/api/admin/keys/order', { body: { ids: $$('#keyRows tr[draggable]').map(x => Number(x.dataset.id)) } });
      keys();
    };
  });
}

function keyForm(k) {
  const isNew = !k;
  openModal(`<h2>${isNew ? 'Add API key' : 'Edit API key'}</h2><p class="sub">${isNew ? 'Paste a Tokenhot (or Anthropic) key. It is encrypted before saving.' : 'Leave the key blank to keep the current one.'}</p>
    <div class="field"><label for="kl">Label</label><input class="input" id="kl" value="${esc(k?.label || '')}" placeholder="e.g. Main account" ${isNew ? 'autofocus' : ''}></div>
    <div class="field"><label for="kk">${isNew ? 'API key' : 'Replace key'}</label><input class="input mono" id="kk" type="password" autocomplete="off" placeholder="${isNew ? 'sk-…' : `Current: ${esc(k.key_hint)}`}"></div>
    <div class="field"><label for="ke">Endpoint for this key <span class="hint">(optional)</span></label><input class="input mono" id="ke" value="${esc(k?.endpoint || '')}" placeholder="Uses the default endpoint from Settings">
      <span class="hint">Set this to mix providers, e.g. https://api.anthropic.com/v1/messages for an Anthropic key.</span></div>
    ${!isNew ? `<label class="check"><input type="checkbox" id="ken" ${k.enabled ? 'checked' : ''}> Enabled</label>` : ''}
    <div class="modal-actions">${!isNew ? '<button class="btn danger" id="kDel" style="margin-right:auto">Delete key</button>' : ''}
      <button class="btn" data-close>Cancel</button><button class="btn primary" id="kSave">${isNew ? 'Add key' : 'Save changes'}</button></div>`, {
    onMount: (el, close) => {
      $('#kSave', el).onclick = async () => {
        const body = { label: $('#kl', el).value, key: $('#kk', el).value, endpoint: $('#ke', el).value };
        if (!isNew) body.enabled = $('#ken', el).checked;
        try {
          if (isNew) await api('/api/admin/keys', { body }); else await api(`/api/admin/keys/${k.id}`, { method: 'PUT', body });
          close(); toast(isNew ? 'Key added' : 'Key saved'); keys();
        } catch (e) { toast(e.message, 'error'); }
      };
      $('#kDel', el) && ($('#kDel', el).onclick = async () => {
        if (!await confirmBox(`Delete "${k.label}"?`, 'The key is removed from this server. Past usage stays in reports.')) return;
        await api(`/api/admin/keys/${k.id}`, { method: 'DELETE' }); close(); toast('Key deleted'); keys();
      });
    },
  });
}

// ---------- models ----------
async function models() {
  A.models = (await api('/api/admin/models')).models;
  page.innerHTML = head('Models', 'Model IDs must match what your endpoint accepts. Check Tokenhot\'s model list and set prices to their rates so cost tracking is accurate.',
    `<button class="btn primary" id="addModel">${icon('plus')} Add model</button>`) + `
  <div class="panel"><div class="table-wrap"><table class="data">
    <thead><tr><th>Display name</th><th>Model ID</th><th class="num">Input $/M</th><th class="num">Output $/M</th><th class="num">Max tokens</th><th>Status</th><th></th></tr></thead>
    <tbody>${A.models.map(m => `<tr class="click" data-id="${esc(m.id)}"><td>${esc(m.label)}</td><td class="mono" style="font-size:13px">${esc(m.id)}</td>
      <td class="num">$${m.input_price}</td><td class="num">$${m.output_price}</td><td class="num">${fmt.num(m.max_tokens)}</td>
      <td>${m.enabled ? '<span class="tag ok">enabled</span>' : '<span class="tag">disabled</span>'}</td><td class="actions"><button class="btn sm">Edit</button></td></tr>`).join('')
      || '<tr><td colspan="7" class="empty-row">No models. Add one so staff can chat.</td></tr>'}</tbody>
  </table></div></div>
  <p class="muted" style="font-size:13px">The starting prices are placeholders. Edit each model to match what you actually pay.</p>`;
  $('#addModel').onclick = () => modelForm(null);
  $$('tr.click').forEach(tr => tr.onclick = () => modelForm(A.models.find(m => m.id === tr.dataset.id)));
}

function modelForm(m) {
  const isNew = !m;
  m = m || { enabled: 1, max_tokens: 16000, input_price: 0, output_price: 0 };
  openModal(`<h2>${isNew ? 'Add model' : 'Edit model'}</h2><p class="sub">Prices are USD per million tokens.</p>
    <div class="grid-2">
      <div class="field"><label for="mi">Model ID</label><input class="input mono" id="mi" value="${esc(m.id || '')}" ${isNew ? 'autofocus' : 'disabled'} placeholder="claude-sonnet-4.6"></div>
      <div class="field"><label for="ml">Display name</label><input class="input" id="ml" value="${esc(m.label || '')}"></div>
      <div class="field"><label for="mip">Input price ($/M)</label><input class="input" id="mip" type="number" step="0.01" min="0" value="${m.input_price}"></div>
      <div class="field"><label for="mop">Output price ($/M)</label><input class="input" id="mop" type="number" step="0.01" min="0" value="${m.output_price}"></div>
      <div class="field"><label for="mmt">Max output tokens</label><input class="input" id="mmt" type="number" step="1000" min="256" value="${m.max_tokens}"></div>
      <div class="field"><label for="ms">Sort order</label><input class="input" id="ms" type="number" value="${m.sort ?? ''}"></div>
    </div>
    <label class="check"><input type="checkbox" id="men" ${m.enabled ? 'checked' : ''}> Enabled for chat</label>
    <div class="modal-actions">${!isNew ? '<button class="btn danger" id="mDel" style="margin-right:auto">Delete model</button>' : ''}
      <button class="btn" data-close>Cancel</button><button class="btn primary" id="mSave">${isNew ? 'Add model' : 'Save changes'}</button></div>`, {
    onMount: (el, close) => {
      $('#mSave', el).onclick = async () => {
        const body = { id: $('#mi', el).value, label: $('#ml', el).value, input_price: Number($('#mip', el).value), output_price: Number($('#mop', el).value),
          max_tokens: Number($('#mmt', el).value), enabled: $('#men', el).checked };
        if ($('#ms', el).value !== '') body.sort = Number($('#ms', el).value);
        try {
          if (isNew) await api('/api/admin/models', { body }); else await api(`/api/admin/models/${encodeURIComponent(m.id)}`, { method: 'PUT', body });
          close(); toast('Model saved'); models();
        } catch (e) { toast(e.message, 'error'); }
      };
      $('#mDel', el) && ($('#mDel', el).onclick = async () => {
        if (!await confirmBox(`Delete ${m.id}?`, 'Staff will no longer see it. Past usage stays in reports.')) return;
        await api(`/api/admin/models/${encodeURIComponent(m.id)}`, { method: 'DELETE' }); close(); models();
      });
    },
  });
}

// ---------- reports ----------
async function reports() {
  const today = new Date(); const iso = (d) => d.toISOString().slice(0, 10);
  const from = A.rFrom || iso(new Date(today - 29 * 864e5)), to = A.rTo || iso(today);
  const u = await api(`/api/admin/usage?from=${from}&to=${to}`);
  const total = u.byUser.reduce((a, r) => ({ cost: a.cost + r.cost, req: a.req + r.requests, tok: a.tok + r.input_tokens + r.output_tokens }), { cost: 0, req: 0, tok: 0 });
  const maxDay = Math.max(0.0001, ...u.daily.map(d => d.cost));
  page.innerHTML = head('Usage reports', 'Costs are estimates from the model prices you set.', `<div class="filters">
      <input type="date" class="input" id="rFrom" value="${from}" aria-label="From"><input type="date" class="input" id="rTo" value="${to}" aria-label="To">
      <button class="btn" id="rApply">Apply</button><a class="btn" id="rCsv" href="/api/admin/usage.csv?from=${from}&to=${to}">${icon('download')} Export CSV</a></div>`) + `
  <div class="stats">
    <div class="stat"><div class="v amber">${fmt.costFine(total.cost)}</div><div class="l">Total cost</div></div>
    <div class="stat"><div class="v">${fmt.num(total.req)}</div><div class="l">Requests</div></div>
    <div class="stat"><div class="v">${fmt.tok(total.tok)}</div><div class="l">Tokens</div></div>
  </div>
  <div class="panel"><div class="panel-head"><h2>Daily cost</h2></div><div class="panel-body">
    ${u.daily.length ? `<div class="bar-chart">${u.daily.map(d => `<div class="b" style="height:${Math.max(2, d.cost / maxDay * 100)}%" data-tip="${d.day}: ${fmt.costFine(d.cost)} · ${fmt.tok(d.tokens)} tok"></div>`).join('')}</div>
    <div class="bar-axis"><span>${u.daily[0].day}</span><span>${u.daily[u.daily.length - 1].day}</span></div>` : '<div class="muted">No usage in this range.</div>'}</div></div>
  <div class="panel"><div class="panel-head"><h2>By staff member</h2></div><div class="table-wrap"><table class="data">
    <thead><tr><th>Name</th><th class="num">Requests</th><th class="num">Input tokens</th><th class="num">Output tokens</th><th class="num">Searches</th><th class="num">Cost</th></tr></thead>
    <tbody>${u.byUser.map(r => `<tr><td>${esc(r.display_name || r.username)}</td><td class="num">${fmt.num(r.requests)}</td><td class="num">${fmt.num(r.input_tokens)}</td><td class="num">${fmt.num(r.output_tokens)}</td><td class="num">${fmt.num(r.web_searches)}</td><td class="num cost">${fmt.costFine(r.cost)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-row">No usage in this range.</td></tr>'}</tbody></table></div></div>
  <div class="grid-2">
    <div class="panel"><div class="panel-head"><h2>By model</h2></div><div class="table-wrap"><table class="data"><tbody>
      ${u.byModel.map(r => `<tr><td class="mono" style="font-size:13px">${esc(r.model)}</td><td class="num">${fmt.num(r.requests)} req</td><td class="num cost">${fmt.costFine(r.cost)}</td></tr>`).join('') || '<tr><td class="empty-row">—</td></tr>'}</tbody></table></div></div>
    <div class="panel"><div class="panel-head"><h2>By API key</h2></div><div class="table-wrap"><table class="data"><tbody>
      ${u.byKey.map(r => `<tr><td>${esc(r.label)}</td><td class="num">${fmt.num(r.requests)} req</td><td class="num cost">${fmt.costFine(r.cost)}</td></tr>`).join('') || '<tr><td class="empty-row">—</td></tr>'}</tbody></table></div></div>
  </div>`;
  $('#rApply').onclick = () => { A.rFrom = $('#rFrom').value; A.rTo = $('#rTo').value; reports(); };
}

// ---------- chat review ----------
async function chats() {
  const { users } = await api('/api/admin/users');
  const q = A.cq || '', uid = A.cu || '';
  const r = await api(`/api/admin/chats?${new URLSearchParams({ q, ...(uid ? { user: uid } : {}) })}`);
  page.innerHTML = head('Chat review', 'Read any staff conversation. Staff see a notice that admins can view chats.', `<div class="filters">
    <select class="select" id="cu" aria-label="Staff member"><option value="">Everyone</option>${users.map(u => `<option value="${u.id}">${esc(u.display_name || u.username)}</option>`).join('')}</select>
    <input class="input" id="cq" placeholder="Search titles and messages" value="${esc(q)}"><button class="btn" id="cGo">Search</button></div>`) + `
  <div class="panel"><div class="table-wrap"><table class="data">
    <thead><tr><th>Chat</th><th>Staff member</th><th class="num">Messages</th><th class="num">Cost</th><th>Updated</th></tr></thead>
    <tbody>${r.chats.map(c => `<tr class="click" data-id="${c.id}"><td>${esc(c.title)}</td><td>${esc(c.display_name || c.username)}</td><td class="num">${c.message_count}</td><td class="num cost">${fmt.costFine(c.cost)}</td><td class="muted" style="font-size:13px">${fmt.when(c.updated_at)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty-row">No chats found.</td></tr>'}</tbody></table></div></div>`;
  $('#cu').value = uid;
  const apply = () => { A.cq = $('#cq').value.trim(); A.cu = $('#cu').value; chats(); };
  $('#cGo').onclick = apply; $('#cu').onchange = apply; $('#cq').onkeydown = (e) => { if (e.key === 'Enter') apply(); };
  $$('tr.click').forEach(tr => tr.onclick = () => reviewChat(Number(tr.dataset.id)));
}

async function reviewChat(id) {
  const r = await api(`/api/admin/chats/${id}`);
  const total = r.messages.reduce((a, m) => a + (m.cost || 0), 0);
  openModal(`<div class="row"><div style="flex:1"><h2>${esc(r.chat.title)}</h2><p class="sub" style="margin:0">${esc(r.chat.display_name || r.chat.username)} · ${r.messages.length} messages · <span style="color:var(--amber)">${fmt.costFine(total)}</span></p></div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    ${r.chat.system_prompt ? `<details class="thinking" style="margin-top:14px"><summary>System prompt</summary><div class="body">${esc(r.chat.system_prompt)}</div></details>` : ''}
    <div class="review" style="margin-top:16px">${r.messages.map(m => `<div class="msg ${m.role}">${renderMessageHTML(m)}
      ${m.role === 'assistant' ? `<div class="msg-meta" style="margin:6px 0 0">${esc(m.model || '')} · ${fmt.tok(m.input_tokens)} in · ${fmt.tok(m.output_tokens)} out · <span class="c">${fmt.costFine(m.cost)}</span></div>` : ''}</div>`).join('') || '<div class="muted">This chat is empty.</div>'}</div>`, { wide: true });
}

// ---------- shared templates ----------
async function templates() {
  const all = (await api('/api/templates')).templates.filter(t => t.shared);
  page.innerHTML = head('Shared templates', 'These appear for every staff member under the ⚡ button. Use {{name}} for blanks they fill in.', `<button class="btn primary" id="addTpl">${icon('plus')} New shared template</button>`) + `
  <div class="panel"><div class="table-wrap"><table class="data"><tbody>
    ${all.map(t => `<tr><td><b style="font-weight:500">${esc(t.name)}</b><div class="muted" style="font-size:13px;white-space:pre-wrap;max-height:60px;overflow:hidden">${esc(t.body)}</div></td>
      <td class="actions"><button class="btn sm" data-e="${t.id}">Edit</button> <button class="btn sm danger" data-d="${t.id}">Delete</button></td></tr>`).join('')
      || '<tr><td class="empty-row">No shared templates yet.</td></tr>'}</tbody></table></div></div>`;
  const form = (t) => openModal(`<h2>${t ? 'Edit shared template' : 'New shared template'}</h2><p class="sub">Example: Summarize this for {{audience}} in {{length}}.</p>
    <div class="field"><label for="tn">Name</label><input class="input" id="tn" value="${esc(t?.name || '')}" autofocus></div>
    <div class="field"><label for="tb">Prompt</label><textarea class="textarea" id="tb" style="min-height:180px">${esc(t?.body || '')}</textarea></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="tS">Save template</button></div>`, {
    onMount: (el, close) => { $('#tS', el).onclick = async () => {
      const body = { name: $('#tn', el).value, body: $('#tb', el).value, shared: true };
      try { if (t) await api(`/api/templates/${t.id}`, { method: 'PUT', body }); else await api('/api/templates', { body }); close(); toast('Template saved'); templates(); }
      catch (e) { toast(e.message, 'error'); } }; },
  });
  $('#addTpl').onclick = () => form(null);
  $$('[data-e]').forEach(b => b.onclick = () => form(all.find(t => t.id === Number(b.dataset.e))));
  $$('[data-d]').forEach(b => b.onclick = async () => { if (!await confirmBox('Delete shared template?', 'It disappears for all staff.')) return; await api(`/api/templates/${b.dataset.d}`, { method: 'DELETE' }); templates(); });
}

// ---------- settings ----------
async function settings() {
  const s = await api('/api/admin/settings');
  page.innerHTML = head('Settings', 'Workspace-wide options.') + `
  <div class="panel"><div class="panel-head"><h2>API connection</h2></div><div class="panel-body">
    <div class="field"><label for="se">Default endpoint</label><input class="input mono" id="se" value="${esc(s.default_endpoint)}">
      <span class="hint">Keys without their own endpoint use this. Official Anthropic: https://api.anthropic.com/v1/messages</span></div>
    <div class="grid-2">
      <div class="field"><label for="sa">How keys are sent</label><select class="select" id="sa">
        <option value="both">Both headers (works with most gateways)</option>
        <option value="x-api-key">x-api-key only (Tokenhot docs style)</option>
        <option value="bearer">Authorization: Bearer only</option></select></div>
      <div class="field"><label for="sv">anthropic-version header</label><input class="input mono" id="sv" value="${esc(s.anthropic_version)}"></div>
    </div>
    <div class="field"><label for="sc">Key cooldown after an error (seconds)</label><input class="input" id="sc" type="number" min="15" value="${esc(s.key_cooldown_seconds)}" style="max-width:200px"></div>
    <div class="field"><label for="sw">Web search price per 1,000 searches ($)</label><input class="input" id="sw" type="number" step="0.5" min="0" value="${esc(s.web_search_price_per_1000)}" style="max-width:200px"></div>
  </div></div>
  <div class="panel"><div class="panel-head"><h2>Staff experience</h2></div><div class="panel-body">
    <div class="field"><label for="sn">Notice on the sign-in page</label><input class="input" id="sn" value="${esc(s.staff_notice)}"><span class="hint">Leave blank to hide it.</span></div>
    <div class="field"><label for="ss">Default system prompt for new chats</label><textarea class="textarea" id="ss" placeholder="Optional. Staff can change it per chat.">${esc(s.default_system_prompt)}</textarea></div>
  </div></div>
  <button class="btn primary" id="sSave">Save settings</button>`;
  $('#sa').value = s.auth_header || 'both';
  $('#sSave').onclick = async () => {
    try {
      await api('/api/admin/settings', { method: 'PUT', body: {
        default_endpoint: $('#se').value.trim(), anthropic_version: $('#sv').value.trim(), auth_header: $('#sa').value, key_cooldown_seconds: $('#sc').value,
        web_search_price_per_1000: $('#sw').value, staff_notice: $('#sn').value, default_system_prompt: $('#ss').value } });
      toast('Settings saved');
    } catch (e) { toast(e.message, 'error'); }
  };
}
