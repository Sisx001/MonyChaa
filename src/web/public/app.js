'use strict';
/* Secretary Pro admin panel */

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

let toastTimer;
function toast(msg, ok = true) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${ok ? 'ok' : 'err'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso.includes('T') ? iso : iso + 'Z').toLocaleString();
}

// ---------- tabs ----------
$$('.nav-btn').forEach(btn => btn.addEventListener('click', () => {
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  $$('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  $('#tab-' + btn.dataset.tab).classList.add('active');
  loaders[btn.dataset.tab]?.();
}));

// ---------- SSE live feed ----------
function connectSSE() {
  const es = new EventSource('/api/events');
  const feed = $('#live-feed');
  const push = (cls, text) => {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = text;
    feed.prepend(div);
    while (feed.children.length > 12) feed.lastChild.remove();
  };
  es.onopen = () => { $('#conn-status').innerHTML = '<span class="dot dot-green"></span> online'; };
  es.onerror = () => { $('#conn-status').innerHTML = '<span class="dot dot-red"></span> reconnecting…'; };
  es.addEventListener('message', e => {
    const d = JSON.parse(e.data);
    push(d.direction === 'incoming' ? 'in' : 'out', `${d.direction === 'incoming' ? '←' : '→'} ${d.chatId}: ${d.content}`);
    if ($('#tab-dashboard').classList.contains('active')) loadDashboard();
  });
  es.addEventListener('error', e => { try { push('err', '⚠ ' + JSON.parse(e.data).message); } catch {} });
  es.addEventListener('connection', e => {
    const d = JSON.parse(e.data);
    push('out', `🔗 business connection ${d.status}`);
  });
}
connectSSE();

// ---------- DASHBOARD ----------
let chartHourly, chartCost;
async function loadDashboard() {
  const s = await api('/stats');
  const up = s.uptimeSec;
  const uptime = up > 86400 ? `${Math.floor(up / 86400)}d ${Math.floor(up % 86400 / 3600)}h`
    : up > 3600 ? `${Math.floor(up / 3600)}h ${Math.floor(up % 3600 / 60)}m` : `${Math.floor(up / 60)}m`;

  const tiles = [
    ['Messages today', s.msgsToday, `${s.msgsWeek} this week · ${s.msgsMonth} this month`],
    ['Active chats (24h)', s.activeChats, ''],
    ['Avg response', s.avgResponseMs ? (s.avgResponseMs / 1000).toFixed(1) + 's' : '—', 'last 7 days'],
    ['Response rate', s.responseRate + '%', 'auto-replied (7d)'],
    ['Tokens today', s.tokensToday.toLocaleString(), ''],
    ['Cost today', '$' + s.costToday.toFixed(4), `$${s.costTotal.toFixed(2)} total`],
    ['Queue depth', s.queueDepth, 'messages processing'],
    ['Errors today', s.errorsToday, ''],
    ['Uptime', uptime, ''],
    ['Current model', '', s.currentModel],
  ];
  $('#stat-grid').innerHTML = tiles.map(([l, v, sub]) =>
    `<div class="stat"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`
  ).join('');

  // Hourly chart
  const hours = [...Array(24)].map((_, i) => String(i).padStart(2, '0'));
  const counts = hours.map(h => (s.perHour.find(r => r.hour === h) || {}).count || 0);
  const ctx1 = $('#chart-hourly');
  chartHourly?.destroy();
  chartHourly = new Chart(ctx1, {
    type: 'bar',
    data: { labels: hours, datasets: [{ data: counts, backgroundColor: '#5288c1', borderRadius: 4 }] },
    options: chartOpts(),
  });

  // Cost per provider
  const ctx2 = $('#chart-cost');
  chartCost?.destroy();
  chartCost = new Chart(ctx2, {
    type: 'doughnut',
    data: {
      labels: s.perProvider.map(p => p.provider),
      datasets: [{
        data: s.perProvider.map(p => Number(p.cost?.toFixed(6)) || 0.000001),
        backgroundColor: ['#5288c1', '#4fae4e', '#e0a934', '#e05348', '#9b6dd6', '#4ec3c9', '#c96da8'],
        borderWidth: 0,
      }],
    },
    options: { plugins: { legend: { position: 'right', labels: { color: '#8a9aa9', boxWidth: 12 } } } },
  });

  // Health table
  $('#health-table tbody').innerHTML = s.health.length ? s.health.map(h => `
    <tr>
      <td>${esc(h.provider)}</td>
      <td><span class="badge badge-${h.status === 'healthy' ? 'green' : h.status === 'degraded' ? 'yellow' : h.status === 'down' ? 'red' : 'gray'}">${esc(h.status)}</span></td>
      <td>${h.latency_ms}ms</td>
      <td>${(h.error_rate * 100).toFixed(0)}%</td>
      <td>${fmtTime(h.last_check)}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="hint">No provider calls yet</td></tr>';

  $('#top-contacts tbody').innerHTML = s.topContacts.length ? s.topContacts.map(c =>
    `<tr><td>${esc(c.name)}</td><td>${c.count}</td></tr>`).join('')
    : '<tr><td colspan="2" class="hint">No messages yet</td></tr>';
}
function chartOpts() {
  return {
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#8a9aa9', font: { size: 10 } }, grid: { color: '#1e2c3a' } },
      y: { ticks: { color: '#8a9aa9', precision: 0 }, grid: { color: '#1e2c3a' }, beginAtZero: true },
    },
  };
}
setInterval(() => { if ($('#tab-dashboard').classList.contains('active')) loadDashboard().catch(() => {}); }, 15000);

// ---------- SYSTEM PROMPT ----------
let currentSettings = {};
async function loadPrompt() {
  currentSettings = await api('/settings');
  $('#prompt-editor').value = currentSettings.system_prompt || '';
  for (const el of $$('[data-ctx-setting]')) el.value = currentSettings[el.dataset.ctxSetting] ?? '';
  const presets = await api('/prompts/presets');
  $('#preset-row').innerHTML = Object.keys(presets).map(name =>
    `<button class="btn btn-sm ${currentSettings.active_preset === name ? 'btn-primary' : ''}" data-preset="${esc(name)}">${esc(name)}</button>`
  ).join('') + `<button class="btn btn-sm ${currentSettings.active_preset === 'Custom' ? 'btn-primary' : ''}" data-preset="Custom">Custom</button>`;
  $$('#preset-row [data-preset]').forEach(b => b.addEventListener('click', () => {
    const name = b.dataset.preset;
    if (presets[name]) $('#prompt-editor').value = presets[name];
    api('/settings', { method: 'PUT', body: { active_preset: name } }).catch(() => {});
    $$('#preset-row .btn').forEach(x => x.classList.remove('btn-primary'));
    b.classList.add('btn-primary');
  }));
  loadVersions();
}

async function loadVersions() {
  const versions = await api('/prompts/versions');
  $('#version-list').innerHTML = versions.length ? versions.map(v => `
    <div class="version-item">
      <div>
        <div>${esc(v.name)}</div>
        <div class="meta">#${v.id} · ${fmtTime(v.created_at)} · ${v.content.length} chars</div>
      </div>
      <div class="btn-row" style="margin:0">
        <button class="btn btn-sm" data-diff="${v.id}">Diff</button>
        <button class="btn btn-sm" data-rollback="${v.id}">Rollback</button>
        <button class="btn btn-sm btn-danger" data-delver="${v.id}">✕</button>
      </div>
    </div>`).join('') : '<p class="hint">No saved versions yet.</p>';

  $$('[data-rollback]').forEach(b => b.addEventListener('click', async () => {
    const r = await api(`/prompts/versions/${b.dataset.rollback}/rollback`, { method: 'POST' });
    $('#prompt-editor').value = r.content;
    toast('Rolled back — a backup of the previous prompt was saved');
    loadVersions();
  }));
  $$('[data-delver]').forEach(b => b.addEventListener('click', async () => {
    await api(`/prompts/versions/${b.dataset.delver}`, { method: 'DELETE' });
    loadVersions();
  }));
  $$('[data-diff]').forEach(b => b.addEventListener('click', () => {
    const v = versions.find(x => x.id == b.dataset.diff);
    showDiff(v.content, $('#prompt-editor').value);
  }));
}

// Simple LCS-free line diff: marks removed/added/unchanged lines.
function showDiff(oldText, newText) {
  const a = oldText.split('\n'), b = newText.split('\n');
  const bSet = new Set(b), aSet = new Set(a);
  let html = '';
  for (const line of a) if (!bSet.has(line)) html += `<span class="diff-del">− ${esc(line)}</span>`;
  for (const line of b) {
    html += aSet.has(line)
      ? `<span class="diff-same">  ${esc(line)}</span>`
      : `<span class="diff-add">＋ ${esc(line)}</span>`;
  }
  $('#diff-view').innerHTML = html;
  $('#diff-card').style.display = 'block';
  $('#diff-card').scrollIntoView({ behavior: 'smooth' });
}

$('#save-prompt').addEventListener('click', async () => {
  await api('/settings', { method: 'PUT', body: { system_prompt: $('#prompt-editor').value } });
  toast('Prompt saved');
});
$('#save-version').addEventListener('click', async () => {
  const name = prompt('Version name:', 'v' + new Date().toISOString().slice(0, 16).replace('T', ' '));
  if (name === null) return;
  await api('/prompts/versions', { method: 'POST', body: { name, content: $('#prompt-editor').value } });
  toast('Version saved');
  loadVersions();
});
$('#save-context').addEventListener('click', async () => {
  const body = {};
  for (const el of $$('[data-ctx-setting]')) body[el.dataset.ctxSetting] = el.value;
  await api('/settings', { method: 'PUT', body });
  toast('Context blocks saved');
});
$('#preview-prompt').addEventListener('click', async () => {
  const r = await api('/prompts/preview');
  showDiff($('#prompt-editor').value, r.prompt);
  toast('Showing resolved prompt as diff vs editor');
});

async function sendTestChat() {
  const input = $('#test-chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  const log = $('#test-chat-log');
  log.insertAdjacentHTML('beforeend', `<div class="bubble me">${esc(msg)}</div>`);
  log.insertAdjacentHTML('beforeend', `<div class="bubble bot" id="pending-bubble">…</div>`);
  log.scrollTop = log.scrollHeight;
  try {
    const r = await api('/chat/test', { method: 'POST', body: { message: msg } });
    $('#pending-bubble').outerHTML = `<div class="bubble bot">${esc(r.reply)}<span class="meta">${esc(r.provider)}/${esc(r.model)} · ${r.latencyMs}ms · $${(r.cost || 0).toFixed(6)}</span></div>`;
  } catch (err) {
    $('#pending-bubble').outerHTML = `<div class="bubble bot">⚠ ${esc(err.message)}</div>`;
  }
  log.scrollTop = log.scrollHeight;
}
$('#test-chat-send').addEventListener('click', sendTestChat);
$('#test-chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendTestChat(); });

// ---------- MODEL GATEWAY ----------
let gwData = null;
let fallbackChain = [];
async function loadGateway() {
  gwData = await api('/providers');
  fallbackChain = gwData.fallback_chain || [];

  const provOptions = gwData.providers.map(p =>
    `<option value="${p.id}" ${!p.configured ? 'data-un="1"' : ''}>${esc(p.label)}${p.configured ? '' : ' (no key)'}</option>`).join('');
  $('#primary-provider').innerHTML = provOptions;
  $('#fb-provider').innerHTML = provOptions;
  $('#primary-provider').value = gwData.primary.provider;
  fillModels($('#primary-provider'), $('#primary-model'), gwData.primary.model);
  fillModels($('#fb-provider'), $('#fb-model'));
  $('#load-balancing').value = gwData.load_balancing;
  renderFallbacks();

  $('#active-chain').textContent = gwData.active_chain.length
    ? 'Active chain: ' + gwData.active_chain.map(c => `${c.provider}/${c.model}`).join(' → ')
    : '⚠ No configured providers — add an API key to .env';

  $('#provider-grid').innerHTML = gwData.providers.map(p => {
    const h = p.health;
    const badge = !p.configured ? '<span class="badge badge-gray">no key</span>'
      : !h ? '<span class="badge badge-blue">ready</span>'
      : `<span class="badge badge-${h.status === 'healthy' ? 'green' : h.status === 'down' ? 'red' : 'yellow'}">${esc(h.status)}</span>`;
    return `<div class="provider-card">
      <h4>${esc(p.label)} ${badge} ${p.free ? '<span class="badge badge-green">free tier</span>' : ''}</h4>
      <div class="models">${p.models.map(esc).join('<br>')}</div>
      ${h ? `<div class="hint">latency ${h.latency_ms}ms · errors ${(h.error_rate * 100).toFixed(0)}%</div>` : ''}
      <button class="btn btn-sm" data-test-provider="${p.id}" ${!p.configured ? 'disabled' : ''}>⚡ Test</button>
      <div class="test-result" id="test-${p.id}"></div>
    </div>`;
  }).join('');

  $$('[data-test-provider]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.testProvider;
    const model = gwData.providers.find(p => p.id === id).models[0];
    const out = $('#test-' + id);
    out.textContent = 'Testing…';
    const r = await api('/providers/test', { method: 'POST', body: { provider: id, model } });
    out.innerHTML = r.ok
      ? `<span style="color:var(--green)">✓ "${esc(r.reply)}" in ${r.latencyMs}ms</span>`
      : `<span style="color:var(--red)">✗ ${esc(r.error)}</span>`;
  }));
}

function fillModels(provSel, modelSel, selected) {
  const p = gwData.providers.find(x => x.id === provSel.value);
  modelSel.innerHTML = (p?.models || []).map(m => `<option>${esc(m)}</option>`).join('');
  if (selected) modelSel.value = selected;
}
$('#primary-provider').addEventListener('change', () => fillModels($('#primary-provider'), $('#primary-model')));
$('#fb-provider').addEventListener('change', () => fillModels($('#fb-provider'), $('#fb-model')));

function renderFallbacks() {
  $('#fallback-list').innerHTML = fallbackChain.length ? fallbackChain.map((f, i) => `
    <div class="version-item">
      <div>${i + 1}. <b>${esc(f.provider)}</b> / ${esc(f.model)}</div>
      <div class="btn-row" style="margin:0">
        ${i > 0 ? `<button class="btn btn-sm" data-fb-up="${i}">↑</button>` : ''}
        <button class="btn btn-sm btn-danger" data-fb-del="${i}">✕</button>
      </div>
    </div>`).join('') : '<p class="hint">No fallbacks configured.</p>';
  $$('[data-fb-del]').forEach(b => b.addEventListener('click', () => { fallbackChain.splice(b.dataset.fbDel, 1); renderFallbacks(); }));
  $$('[data-fb-up]').forEach(b => b.addEventListener('click', () => {
    const i = Number(b.dataset.fbUp);
    [fallbackChain[i - 1], fallbackChain[i]] = [fallbackChain[i], fallbackChain[i - 1]];
    renderFallbacks();
  }));
}
$('#fb-add').addEventListener('click', () => {
  fallbackChain.push({ provider: $('#fb-provider').value, model: $('#fb-model').value });
  renderFallbacks();
});
$('#save-gateway').addEventListener('click', async () => {
  await api('/settings', {
    method: 'PUT',
    body: {
      primary_provider: $('#primary-provider').value,
      primary_model: $('#primary-model').value,
      load_balancing: $('#load-balancing').value,
      fallback_chain: JSON.stringify(fallbackChain),
    },
  });
  toast('Routing saved');
  loadGateway();
});

// ---------- MEMORY ----------
async function loadMemory() {
  const [factsRows, mems] = await Promise.all([
    api('/facts' + ($('#fact-search').value ? '?q=' + encodeURIComponent($('#fact-search').value) : '')),
    api('/memories' + ($('#mem-search').value ? '?q=' + encodeURIComponent($('#mem-search').value) : '')),
  ]);
  $('#facts-table tbody').innerHTML = factsRows.length ? factsRows.map(f => `
    <tr>
      <td><b>${esc(f.key)}</b></td><td>${esc(f.value)}</td>
      <td><span class="badge badge-${f.priority === 'critical' ? 'red' : f.priority === 'important' ? 'yellow' : 'gray'}">${esc(f.priority)}</span></td>
      <td><button class="btn btn-sm btn-danger" data-del-fact="${f.id}">✕</button></td>
    </tr>`).join('') : '<tr><td colspan="4" class="hint">No facts yet — add things the bot should know.</td></tr>';
  $$('[data-del-fact]').forEach(b => b.addEventListener('click', async () => {
    await api('/facts/' + b.dataset.delFact, { method: 'DELETE' }); loadMemory();
  }));

  $('#memories-table tbody').innerHTML = mems.length ? mems.map(m => `
    <tr>
      <td>${m.chat_id || 'global'}</td><td>${esc(m.content)}</td>
      <td><span class="badge badge-${m.priority === 'critical' ? 'red' : m.priority === 'important' ? 'yellow' : 'gray'}">${esc(m.priority)}</span></td>
      <td>${fmtTime(m.created_at)}</td>
      <td><button class="btn btn-sm btn-danger" data-del-mem="${m.id}">✕</button></td>
    </tr>`).join('') : '<tr><td colspan="5" class="hint">No memories yet — extracted automatically from conversations.</td></tr>';
  $$('[data-del-mem]').forEach(b => b.addEventListener('click', async () => {
    await api('/memories/' + b.dataset.delMem, { method: 'DELETE' }); loadMemory();
  }));
}
$('#fact-add').addEventListener('click', async () => {
  try {
    await api('/facts', { method: 'POST', body: { key: $('#fact-key').value, value: $('#fact-value').value, priority: $('#fact-priority').value } });
    $('#fact-key').value = ''; $('#fact-value').value = '';
    toast('Fact saved'); loadMemory();
  } catch (err) { toast(err.message, false); }
});
$('#mem-add').addEventListener('click', async () => {
  try {
    await api('/memories', { method: 'POST', body: { chat_id: $('#mem-chat').value || 0, content: $('#mem-content').value, priority: $('#mem-priority').value } });
    $('#mem-content').value = '';
    toast('Memory saved'); loadMemory();
  } catch (err) { toast(err.message, false); }
});
$('#fact-search').addEventListener('input', debounce(loadMemory, 350));
$('#mem-search').addEventListener('input', debounce(loadMemory, 350));
$('#memory-import-btn').addEventListener('click', () => $('#memory-import-file').click());
$('#memory-import-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  const payload = JSON.parse(await file.text());
  const r = await api('/memory/import', { method: 'POST', body: payload });
  toast(`Imported ${r.imported} items`); loadMemory();
});

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------- CONTACTS ----------
async function loadContacts() {
  const q = $('#contact-search').value;
  const rows = await api('/contacts' + (q ? '?q=' + encodeURIComponent(q) : ''));
  $('#contacts-table tbody').innerHTML = rows.length ? rows.map(c => `
    <tr data-edit="${c.chat_id}" style="cursor:pointer">
      <td>${esc(c.name || '—')} ${c.priority ? '⭐' : ''}</td>
      <td>${c.username ? '@' + esc(c.username) : '—'}</td>
      <td>${c.chat_id}</td>
      <td>${esc(c.relationship || '—')}</td>
      <td>${esc(c.tone || 'casual')}</td>
      <td><span class="badge badge-${c.auto_reply ? 'green' : 'gray'}">${c.auto_reply ? 'on' : 'off'}</span></td>
      <td>${c.priority ? 'VIP' : ''}</td>
      <td><button class="btn btn-sm">Edit</button></td>
    </tr>`).join('') : '<tr><td colspan="8" class="hint">No contacts yet — they appear automatically when people message you.</td></tr>';
  $$('[data-edit]').forEach(tr => tr.addEventListener('click', () => openContact(rows.find(c => c.chat_id == tr.dataset.edit))));
}
$('#contact-search').addEventListener('input', debounce(loadContacts, 350));

const parseLines = v => JSON.stringify(v.split('\n').map(s => s.trim()).filter(Boolean));
const joinLines = j => { try { return JSON.parse(j || '[]').join('\n'); } catch { return ''; } };

let editingChatId = null;
function openContact(c) {
  editingChatId = c ? c.chat_id : null;
  $('#contact-modal-title').textContent = c ? `Edit: ${c.name || c.chat_id}` : 'Add contact';
  $('#c-chat_id').value = c?.chat_id ?? '';
  $('#c-chat_id').disabled = Boolean(c);
  $('#c-name').value = c?.name || '';
  $('#c-username').value = c?.username || '';
  $('#c-relationship').value = c?.relationship || '';
  $('#c-tone').value = c?.tone || 'casual';
  $('#c-gender').value = c?.gender || '';
  $('#c-auto_reply').value = String(c?.auto_reply ?? 1);
  $('#c-priority').value = String(c?.priority ?? 0);
  $('#c-delay_multiplier').value = c?.delay_multiplier ?? 1;
  $('#c-max_length').value = c?.max_length || '';
  $('#c-voice_replies').value = String(c?.voice_replies ?? 0);
  $('#c-rules').value = joinLines(c?.rules);
  $('#c-blocked_topics').value = joinLines(c?.blocked_topics);
  $('#c-notes').value = c?.notes || '';
  $('#c-custom_prompt').value = c?.custom_prompt || '';
  $('#c-transcript').value = '';
  $('#c-learned').textContent = c?.learned_tone || '';
  $('#c-history-view').style.display = 'none';
  $('#contact-delete').style.display = c ? '' : 'none';
  $('#contact-modal').style.display = 'flex';
}
$('#contact-add').addEventListener('click', () => openContact(null));
$('#contact-modal-close').addEventListener('click', () => $('#contact-modal').style.display = 'none');
$('#contact-modal').addEventListener('click', e => { if (e.target === $('#contact-modal')) $('#contact-modal').style.display = 'none'; });

$('#contact-save').addEventListener('click', async () => {
  const body = {
    chat_id: Number($('#c-chat_id').value),
    name: $('#c-name').value, username: $('#c-username').value.replace(/^@/, ''),
    relationship: $('#c-relationship').value, tone: $('#c-tone').value, gender: $('#c-gender').value,
    auto_reply: Number($('#c-auto_reply').value), priority: Number($('#c-priority').value),
    delay_multiplier: Number($('#c-delay_multiplier').value) || 1,
    voice_replies: Number($('#c-voice_replies').value),
    max_length: $('#c-max_length').value ? Number($('#c-max_length').value) : null,
    rules: parseLines($('#c-rules').value), blocked_topics: parseLines($('#c-blocked_topics').value),
    notes: $('#c-notes').value, custom_prompt: $('#c-custom_prompt').value || null,
  };
  if (!body.chat_id) return toast('chat_id is required', false);
  try {
    if (editingChatId) await api('/contacts/' + editingChatId, { method: 'PUT', body });
    else await api('/contacts', { method: 'POST', body });
    toast('Contact saved');
    $('#contact-modal').style.display = 'none';
    loadContacts();
  } catch (err) { toast(err.message, false); }
});
$('#contact-delete').addEventListener('click', async () => {
  if (!editingChatId || !confirm('Delete this contact?')) return;
  await api('/contacts/' + editingChatId, { method: 'DELETE' });
  toast('Contact deleted');
  $('#contact-modal').style.display = 'none';
  loadContacts();
});
$('#c-learn').addEventListener('click', async () => {
  if (!editingChatId) return toast('Save the contact first', false);
  const transcript = $('#c-transcript').value.trim();
  if (!transcript) return toast('Paste a chat transcript first', false);
  $('#c-learned').textContent = 'Learning…';
  try {
    const r = await api(`/contacts/${editingChatId}/learn`, { method: 'POST', body: { transcript } });
    $('#c-learned').textContent = r.learned_tone;
    toast('Style learned');
  } catch (err) { $('#c-learned').textContent = ''; toast(err.message, false); }
});
$('#contact-history').addEventListener('click', async () => {
  if (!editingChatId) return;
  const rows = await api(`/contacts/${editingChatId}/history`);
  const view = $('#c-history-view');
  view.style.display = 'block';
  view.innerHTML = rows.length ? rows.map(m =>
    `<div class="bubble ${m.role === 'assistant' ? 'me' : 'bot'}">${esc(m.content)}</div>`).join('')
    : '<p class="hint">No conversation history.</p>';
  view.scrollTop = view.scrollHeight;
});
$('#contact-import-btn').addEventListener('click', () => $('#contact-import-file').click());
$('#contact-import-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const r = await api('/contacts/import', { method: 'POST', body: payload });
    toast(`Imported ${r.imported} contacts`); loadContacts();
  } catch (err) { toast('Import failed: ' + err.message, false); }
});

// ---------- TOOLS ----------
async function loadTools() {
  const [tools, sched, settings] = await Promise.all([api('/tools'), api('/scheduled'), api('/settings')]);
  $('#tools-list').innerHTML = tools.map(t => `
    <div class="tool-item">
      <div class="info">
        <div class="name">${esc(t.name)} <span class="badge badge-${t.enabled ? 'green' : 'gray'}">${t.enabled ? 'enabled' : 'needs config'}</span></div>
        <div class="desc">${esc(t.description)}</div>
        <div class="tool-output" id="tool-out-${esc(t.name)}" style="display:none"></div>
      </div>
      <input class="args-input" id="tool-args-${esc(t.name)}" placeholder='${esc(t.args)}'>
      <button class="btn btn-sm" data-run-tool="${esc(t.name)}" ${t.enabled ? '' : 'disabled'}>▶ Test</button>
    </div>`).join('');
  $$('[data-run-tool]').forEach(b => b.addEventListener('click', async () => {
    const name = b.dataset.runTool;
    const out = $('#tool-out-' + name);
    out.style.display = 'block';
    out.textContent = 'Running…';
    let args = {};
    try { args = JSON.parse($('#tool-args-' + name).value || '{}'); } catch { return out.textContent = 'Invalid JSON args'; }
    const r = await api(`/tools/${name}/test`, { method: 'POST', body: args });
    if (r.ok && r.photoUrl) {
      out.innerHTML = `${esc(r.output)}<br><img src="${esc(r.photoUrl)}" style="max-width:220px;border-radius:8px;margin-top:6px">`;
    } else {
      out.textContent = r.ok ? r.output : '✗ ' + r.error;
    }
  }));

  $('#sched-table tbody').innerHTML = sched.length ? sched.map(s => `
    <tr>
      <td>${s.chat_id}</td><td>${esc(s.content)}</td><td>${esc(s.send_at)}</td>
      <td><span class="badge badge-${s.status === 'sent' ? 'green' : s.status === 'failed' ? 'red' : 'blue'}">${esc(s.status)}</span></td>
      <td>${s.status === 'pending' ? `<button class="btn btn-sm btn-danger" data-del-sched="${s.id}">✕</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="hint">No scheduled messages.</td></tr>';
  $$('[data-del-sched]').forEach(b => b.addEventListener('click', async () => {
    await api('/scheduled/' + b.dataset.delSched, { method: 'DELETE' }); loadTools();
  }));

  // Automation fields
  for (const el of $$('#tab-tools [data-setting]')) el.value = settings[el.dataset.setting] ?? '';
}
$('#send-now').addEventListener('click', async () => {
  try {
    await api('/send', {
      method: 'POST',
      body: { chat_id: Number($('#send-chat').value), type: $('#send-type').value, content: $('#send-content').value },
    });
    toast('Sent');
    $('#send-content').value = '';
  } catch (err) { toast(err.message, false); }
});
$('#sched-add').addEventListener('click', async () => {
  try {
    await api('/scheduled', { method: 'POST', body: { chat_id: Number($('#sched-chat').value), content: $('#sched-content').value, send_at: $('#sched-at').value } });
    toast('Message scheduled'); $('#sched-content').value = ''; loadTools();
  } catch (err) { toast(err.message, false); }
});
$('#save-automation').addEventListener('click', async () => {
  const body = {};
  for (const el of $$('#tab-tools [data-setting]')) body[el.dataset.setting] = el.value;
  try { JSON.parse(body.keyword_triggers); } catch { return toast('Keyword triggers must be a JSON array', false); }
  await api('/settings', { method: 'PUT', body });
  toast('Automation saved');
});

// ---------- LOGS ----------
let currentLog = 'messages';
$$('.subtab').forEach(b => b.addEventListener('click', () => {
  $$('.subtab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  currentLog = b.dataset.log;
  $('#log-filters').style.display = currentLog === 'messages' ? 'flex' : 'none';
  loadLogs();
}));

async function loadLogs() {
  const table = $('#logs-table');
  if (currentLog === 'messages') {
    const params = new URLSearchParams();
    if ($('#log-search').value) params.set('q', $('#log-search').value);
    if ($('#log-chat').value) params.set('chat_id', $('#log-chat').value);
    if ($('#log-status').value) params.set('status', $('#log-status').value);
    const rows = await api('/logs/messages?' + params);
    table.querySelector('thead').innerHTML = '<tr><th>Time</th><th>Contact</th><th>Dir</th><th>Content</th><th>Model</th><th>Tokens</th><th>ms</th><th>Status</th></tr>';
    table.querySelector('tbody').innerHTML = rows.map(r => `
      <tr>
        <td>${fmtTime(r.created_at)}</td>
        <td>${esc(r.contact_name || r.chat_id)}</td>
        <td>${r.direction === 'incoming' ? '←' : '→'}</td>
        <td style="max-width:340px">${esc(r.content)}</td>
        <td>${esc(r.model || '')}</td>
        <td>${r.tokens_used || ''}</td>
        <td>${r.response_time_ms || ''}</td>
        <td><span class="badge badge-${r.status === 'ok' ? 'green' : 'red'}">${esc(r.status)}</span>${r.error ? `<div class="hint">${esc(r.error)}</div>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="hint">No entries</td></tr>';
  } else if (currentLog === 'errors') {
    const rows = await api('/logs/errors');
    table.querySelector('thead').innerHTML = '<tr><th>Time</th><th>Source</th><th>Message</th><th>Stack</th></tr>';
    table.querySelector('tbody').innerHTML = rows.map(r => `
      <tr><td>${fmtTime(r.created_at)}</td><td>${esc(r.source)}</td><td>${esc(r.message)}</td>
      <td><details><summary>stack</summary><pre style="font-size:11px;white-space:pre-wrap">${esc(r.stack || '')}</pre></details></td></tr>`).join('')
      || '<tr><td colspan="4" class="hint">No errors 🎉</td></tr>';
  } else if (currentLog === 'events') {
    const rows = await api('/logs/events');
    table.querySelector('thead').innerHTML = '<tr><th>Time</th><th>Type</th><th>Detail</th></tr>';
    table.querySelector('tbody').innerHTML = rows.map(r => `
      <tr><td>${fmtTime(r.created_at)}</td><td><span class="badge badge-blue">${esc(r.type)}</span></td><td>${esc(r.detail)}</td></tr>`).join('')
      || '<tr><td colspan="3" class="hint">No events</td></tr>';
  } else {
    const rows = await api('/logs/tokens');
    table.querySelector('thead').innerHTML = '<tr><th>Time</th><th>Provider</th><th>Model</th><th>In</th><th>Out</th><th>Cost</th></tr>';
    table.querySelector('tbody').innerHTML = rows.map(r => `
      <tr><td>${fmtTime(r.created_at)}</td><td>${esc(r.provider)}</td><td>${esc(r.model)}</td>
      <td>${r.tokens_in}</td><td>${r.tokens_out}</td><td>$${(r.cost_estimate || 0).toFixed(6)}</td></tr>`).join('')
      || '<tr><td colspan="6" class="hint">No usage yet</td></tr>';
  }
}
$('#log-refresh').addEventListener('click', loadLogs);
$('#log-search').addEventListener('input', debounce(loadLogs, 400));

// ---------- SETTINGS ----------
async function loadSettings() {
  const [settings, keys] = await Promise.all([api('/settings'), api('/keys')]);
  for (const el of $$('#tab-settings [data-setting]')) el.value = settings[el.dataset.setting] ?? '';

  $('#keys-table tbody').innerHTML = keys.map(k => `
    <tr>
      <td><code>${esc(k.name)}</code></td>
      <td><span class="badge badge-${k.source === 'panel' ? 'blue' : k.source === 'env' ? 'green' : 'gray'}">${esc(k.source)}</span></td>
      <td>${esc(k.masked || '—')}</td>
      <td class="btn-row" style="margin:0">
        <button class="btn btn-sm" data-set-key="${esc(k.name)}">Set</button>
        ${k.source === 'panel' ? `<button class="btn btn-sm btn-danger" data-del-key="${esc(k.name)}">✕</button>` : ''}
      </td>
    </tr>`).join('');
  $$('[data-set-key]').forEach(b => b.addEventListener('click', async () => {
    const value = prompt(`Enter value for ${b.dataset.setKey}:`);
    if (value === null) return;
    await api('/keys/' + b.dataset.setKey, { method: 'PUT', body: { value } });
    toast(value ? 'Key saved — active immediately' : 'Key cleared');
    loadSettings();
  }));
  $$('[data-del-key]').forEach(b => b.addEventListener('click', async () => {
    await api('/keys/' + b.dataset.delKey, { method: 'DELETE' });
    toast('Key removed (env value applies if set)');
    loadSettings();
  }));
}
$('#save-settings').addEventListener('click', async () => {
  const body = {};
  for (const el of $$('#tab-settings [data-setting]')) body[el.dataset.setting] = el.value;
  await api('/settings', { method: 'PUT', body });
  toast('Settings saved');
});
$('#restore-btn').addEventListener('click', () => $('#restore-file').click());
$('#restore-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  if (!confirm('Restore from backup? Existing contacts/facts with matching keys will be overwritten.')) return;
  try {
    const payload = JSON.parse(await file.text());
    const r = await api('/restore', { method: 'POST', body: payload });
    toast('Restored: ' + JSON.stringify(r.restored));
    loadSettings();
  } catch (err) { toast('Restore failed: ' + err.message, false); }
});

// ---------- boot ----------
const loaders = {
  dashboard: loadDashboard,
  prompt: loadPrompt,
  gateway: loadGateway,
  memory: loadMemory,
  contacts: loadContacts,
  tools: loadTools,
  logs: loadLogs,
  settings: loadSettings,
};
loadDashboard().catch(err => toast(err.message, false));
