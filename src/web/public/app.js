'use strict';
/* Secretary Pro admin panel */

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Top progress bar tracks in-flight API requests.
let inflight = 0, progTimer = null;
function progStart() {
  inflight++;
  const bar = document.getElementById('progress-bar');
  if (!bar) return;
  bar.classList.add('active');
  bar.style.width = '18%';
  clearInterval(progTimer);
  progTimer = setInterval(() => {
    const w = parseFloat(bar.style.width) || 18;
    if (w < 88) bar.style.width = (w + (90 - w) * 0.12) + '%';
  }, 200);
}
function progDone() {
  inflight = Math.max(0, inflight - 1);
  if (inflight > 0) return;
  const bar = document.getElementById('progress-bar');
  if (!bar) return;
  clearInterval(progTimer);
  bar.style.width = '100%';
  setTimeout(() => { bar.classList.remove('active'); bar.style.width = '0'; }, 250);
}

async function api(path, options = {}) {
  progStart();
  try {
    const res = await fetch('/api' + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (res.status === 401 && path !== '/login') {
      showLogin();
      throw new Error('authentication required');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } finally {
    progDone();
  }
}

// ---------- auth ----------
function showLogin() {
  $('#login-overlay').style.display = 'flex';
  $('#login-password').focus();
}
async function doLogin() {
  $('#login-error').textContent = '';
  const body = { username: $('#login-username').value, password: $('#login-password').value, remember: $('#login-remember').checked };
  const totp = $('#login-totp').value.trim();
  if (totp) body.totp = totp;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (res.ok) {
    $('#login-overlay').style.display = 'none';
    $('#login-password').value = ''; $('#login-totp').value = '';
    loadDashboard().catch(() => {});
    loadTopbar().catch(() => {});
  } else {
    if (j.totpRequired) $('#login-totp').style.display = 'block';
    $('#login-error').textContent = j.error || 'Sign-in failed';
  }
}
$('#login-btn').addEventListener('click', doLogin);
$('#login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

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

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('sp_theme', t);
  const ic = document.querySelector('#theme-toggle use');
  if (ic) ic.setAttribute('href', t === 'light' ? '#i-moon' : '#i-globe');
}
applyTheme(localStorage.getItem('sp_theme') || 'dark');
$('#theme-toggle')?.addEventListener('click', () =>
  applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'));

// ---------- command palette ----------
function switchTab(name) {
  const btn = document.querySelector(`[data-tab="${name}"]`);
  if (btn) btn.click();
}
const CMDK_COMMANDS = [
  ...['dashboard', 'chat', 'prompt', 'gateway', 'memory', 'library', 'contacts', 'tools', 'logs', 'assistants', 'system', 'security', 'settings']
    .map(t => ({ group: 'Navigate', label: 'Go to ' + t[0].toUpperCase() + t.slice(1), icon: 'i-grid', run: () => switchTab(t) })),
  { group: 'Actions', label: 'Toggle auto-reply', icon: 'i-power', run: () => $('#qt-bot')?.click() },
  { group: 'Actions', label: 'Toggle away mode', icon: 'i-moon', run: () => $('#qt-away')?.click() },
  { group: 'Actions', label: 'Toggle theme (light/dark)', icon: 'i-globe', run: () => $('#theme-toggle')?.click() },
  { group: 'Actions', label: 'New assistant', icon: 'i-plus', run: () => { switchTab('assistants'); setTimeout(() => $('#asst-add')?.click(), 250); } },
  { group: 'Actions', label: 'New skill', icon: 'i-package', run: () => { switchTab('library'); setTimeout(() => $('#skill-add')?.click(), 250); } },
  { group: 'Actions', label: 'System auto-fix all', icon: 'i-heart-pulse', run: () => { switchTab('system'); setTimeout(() => $('#sys-autofix')?.click(), 250); } },
  { group: 'Actions', label: 'Download backup', icon: 'i-download', run: () => { window.location = '/api/backup'; } },
];
let cmdkFiltered = [], cmdkIdx = 0;
function openCmdk() {
  $('#cmdk').classList.add('open');
  $('#cmdk-input').value = '';
  $('#cmdk-input').focus();
  renderCmdk('');
}
function closeCmdk() { $('#cmdk').classList.remove('open'); }
function renderCmdk(q) {
  const query = q.toLowerCase().trim();
  cmdkFiltered = CMDK_COMMANDS.filter(c => !query || c.label.toLowerCase().includes(query) || c.group.toLowerCase().includes(query));
  cmdkIdx = 0;
  if (!cmdkFiltered.length) { $('#cmdk-list').innerHTML = '<div class="cmdk-empty">No matches</div>'; return; }
  let html = '', lastGroup = '';
  cmdkFiltered.forEach((c, i) => {
    if (c.group !== lastGroup) { html += `<div class="cmdk-group">${esc(c.group)}</div>`; lastGroup = c.group; }
    html += `<div class="cmdk-item ${i === 0 ? 'active' : ''}" data-cmdk="${i}"><svg class="ic"><use href="#${c.icon}"/></svg>${esc(c.label)}</div>`;
  });
  $('#cmdk-list').innerHTML = html;
  $$('[data-cmdk]').forEach(el => el.addEventListener('click', () => runCmdk(Number(el.dataset.cmdk))));
}
function runCmdk(i) { const c = cmdkFiltered[i]; if (c) { closeCmdk(); c.run(); } }
function moveCmdk(delta) {
  const items = $$('.cmdk-item');
  if (!items.length) return;
  items[cmdkIdx]?.classList.remove('active');
  cmdkIdx = (cmdkIdx + delta + items.length) % items.length;
  items[cmdkIdx]?.classList.add('active');
  items[cmdkIdx]?.scrollIntoView({ block: 'nearest' });
}
$('#cmdk-open')?.addEventListener('click', openCmdk);
$('#cmdk-input')?.addEventListener('input', e => renderCmdk(e.target.value));
$('#cmdk')?.addEventListener('click', e => { if (e.target.id === 'cmdk') closeCmdk(); });
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#cmdk').classList.contains('open') ? closeCmdk() : openCmdk(); return; }
  if ($('#cmdk').classList.contains('open')) {
    if (e.key === 'Escape') closeCmdk();
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveCmdk(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveCmdk(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runCmdk(cmdkIdx); }
  } else if (e.key === 'Escape') {
    // Close any open modal.
    $$('.modal-backdrop').forEach(m => { if (m.style.display === 'flex') m.style.display = 'none'; });
  }
});

// ---------- SSE live feed ----------
let feedEnabled = true;
function connectSSE() {
  const es = new EventSource('/api/events');
  const feed = $('#live-feed');
  const push = (cls, text) => {
    if (!feedEnabled) return;
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
  es.addEventListener('error', e => { try { push('err', 'error: ' + JSON.parse(e.data).message); } catch {} });
  es.addEventListener('connection', e => {
    const d = JSON.parse(e.data);
    push('out', `link: business connection ${d.status}`);
  });
  es.addEventListener('contact', e => {
    const d = JSON.parse(e.data);
    push('in', `new contact: ${d.name}`);
    if ($('#tab-contacts').classList.contains('active')) loadContacts().catch(() => {});
  });
}
connectSSE();

// ---------- Topbar quick toggles ----------
async function loadTopbar() {
  const s = await api('/settings');
  $('#qt-bot').checked = s.bot_enabled === 'on';
  $('#qt-away').checked = s.away_mode === 'on';
  $('#qt-typing').checked = s.typing_simulation === 'on';
  $('#topbar-model').textContent = `${s.primary_provider}/${s.primary_model}`;
  feedEnabled = s.stream_feed !== 'off';
}
$$('[data-qt]').forEach(el => el.addEventListener('change', async () => {
  await api('/settings', { method: 'PUT', body: { [el.dataset.qt]: el.checked ? 'on' : 'off' } });
  toast(`${el.dataset.qt.replace(/_/g, ' ')}: ${el.checked ? 'on' : 'off'}`);
}));
loadTopbar().catch(() => {});

// ---------- DASHBOARD ----------
let chartHourly, chartCost, chartVolume;
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
    `<div class="stat"><div class="label">${esc(l)}</div><div class="value" data-countup="${esc(v)}">${esc(v)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`
  ).join('');
  animateCounters();

  // Hourly chart
  const hours = [...Array(24)].map((_, i) => String(i).padStart(2, '0'));
  const counts = hours.map(h => (s.perHour.find(r => r.hour === h) || {}).count || 0);
  const ctx1 = $('#chart-hourly');
  chartHourly?.destroy();
  chartHourly = new Chart(ctx1, {
    type: 'bar',
    data: { labels: hours, datasets: [{ data: counts, backgroundColor: '#7c6cff', borderRadius: 5 }] },
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
        backgroundColor: ['#7c6cff', '#4cc9f0', '#2fd575', '#f5b83d', '#f2555a', '#c96da8', '#8b98ad'],
        borderWidth: 0,
      }],
    },
    options: { plugins: { legend: { position: 'right', labels: { color: '#7d8496', boxWidth: 12 } } } },
  });

  // 14-day volume line chart
  const vol = s.dailyVolume || [];
  const vctx = $('#chart-volume');
  if (vctx) {
    chartVolume?.destroy();
    chartVolume = new Chart(vctx, {
      type: 'line',
      data: {
        labels: vol.map(v => v.day),
        datasets: [
          { label: 'Incoming', data: vol.map(v => v.incoming), borderColor: '#56c9ff', backgroundColor: 'rgba(86,201,255,.12)', fill: true, tension: .35, pointRadius: 2 },
          { label: 'Outgoing', data: vol.map(v => v.outgoing), borderColor: '#37e0a0', backgroundColor: 'rgba(55,224,160,.12)', fill: true, tension: .35, pointRadius: 2 },
        ],
      },
      options: {
        plugins: { legend: { labels: { color: '#7d8496', boxWidth: 12, font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: '#7d8496', font: { size: 10 } }, grid: { color: '#23262f' } },
          y: { ticks: { color: '#7d8496', precision: 0 }, grid: { color: '#23262f' }, beginAtZero: true },
        },
      },
    });
  }

  // Per-provider usage table
  $('#usage-table tbody').innerHTML = s.perProvider.length ? s.perProvider.map(p => `
    <tr>
      <td>${esc(p.provider)}</td>
      <td>${(p.tokens_today || 0).toLocaleString()}</td>
      <td>$${(p.cost_today || 0).toFixed(4)}</td>
      <td>${((p.tokens_in || 0) + (p.tokens_out || 0)).toLocaleString()}</td>
      <td>$${(p.cost || 0).toFixed(4)}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="hint">No usage yet</td></tr>';

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

  const pa = $('#per-assistant tbody');
  if (pa) pa.innerHTML = (s.perAssistant && s.perAssistant.length) ? s.perAssistant.map(a =>
    `<tr><td>${esc(a.name)}</td><td>${a.count}</td></tr>`).join('')
    : '<tr><td colspan="2" class="hint">No messages today</td></tr>';
}
// Animate numeric stat values counting up (respects reduced-motion).
function animateCounters() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  $$('[data-countup]').forEach(el => {
    const raw = el.dataset.countup;
    const m = /^([$]?)([\d,]+(?:\.\d+)?)(.*)$/.exec(raw);
    if (!m) return;
    const prefix = m[1], suffix = m[3];
    const target = parseFloat(m[2].replace(/,/g, ''));
    if (!isFinite(target) || target === 0) return;
    const decimals = (m[2].split('.')[1] || '').length;
    const start = performance.now(), dur = 650;
    const step = now => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = target * eased;
      el.textContent = prefix + (decimals ? val.toFixed(decimals) : Math.round(val).toLocaleString()) + suffix;
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = raw;
    };
    requestAnimationFrame(step);
  });
}
function chartOpts() {
  return {
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#7d8496', font: { size: 10 } }, grid: { color: '#23262f' } },
      y: { ticks: { color: '#7d8496', precision: 0 }, grid: { color: '#23262f' }, beginAtZero: true },
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
  loadCharacters().catch(() => {});
  loadSnippets().catch(() => {});
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
        <button class="btn btn-sm btn-danger" data-delver="${v.id}"><svg class="ic ic-sm"><use href="#i-x"/></svg></button>
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
// Prompt snippets
async function loadSnippets() {
  const rows = await api('/snippets');
  const wrap = $('#snippets-list');
  if (!wrap) return;
  wrap.innerHTML = rows.length ? rows.map(s => `
    <span class="snippet-chip">
      <button class="btn btn-sm" data-snip="${s.id}" title="${esc(s.content)}">${esc(s.title)}</button>
      <button class="btn btn-sm btn-danger snippet-del" data-snip-del="${s.id}"><svg class="ic ic-sm"><use href="#i-x"/></svg></button>
    </span>`).join('') : '<span class="hint">No snippets yet.</span>';
  $$('[data-snip]').forEach(b => b.addEventListener('click', () => {
    const s = rows.find(x => x.id == b.dataset.snip);
    const ta = $('#prompt-editor');
    const pos = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, pos) + s.content + ta.value.slice(pos);
    ta.focus();
    toast('Snippet inserted');
  }));
  $$('[data-snip-del]').forEach(b => b.addEventListener('click', async () => {
    await api('/snippets/' + b.dataset.snipDel, { method: 'DELETE' }); loadSnippets();
  }));
}
$('#snippet-add')?.addEventListener('click', async () => {
  const content = $('#snippet-content').value.trim();
  if (!content) return toast('Snippet text required', false);
  await api('/snippets', { method: 'POST', body: { title: $('#snippet-title').value || 'Snippet', content } });
  $('#snippet-title').value = ''; $('#snippet-content').value = '';
  toast('Snippet saved'); loadSnippets();
});
$('#diff-close')?.addEventListener('click', () => $('#diff-card').style.display = 'none');
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
    $('#pending-bubble').outerHTML = `<div class="bubble bot">Error: ${esc(err.message)}</div>`;
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
    : 'No configured providers — add an API key in Settings or .env';

  $('#provider-grid').innerHTML = gwData.providers.map(p => {
    const h = p.health;
    const badge = !p.configured ? '<span class="badge badge-gray">no key</span>'
      : !h ? '<span class="badge badge-blue">ready</span>'
      : `<span class="badge badge-${h.status === 'healthy' ? 'green' : h.status === 'down' ? 'red' : 'yellow'}">${esc(h.status)}</span>`;
    return `<div class="provider-card">
      <h4>${esc(p.label)} ${badge} ${p.free ? '<span class="badge badge-green">free tier</span>' : ''}</h4>
      <div class="models">${p.models.map(esc).join('<br>')}</div>
      ${h ? `<div class="hint">latency ${h.latency_ms}ms · errors ${(h.error_rate * 100).toFixed(0)}%</div>` : ''}
      <button class="btn btn-sm" data-test-provider="${p.id}" ${!p.configured ? 'disabled' : ''}><svg class="ic ic-sm"><use href="#i-zap"/></svg> Test</button>
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
      ? `<span style="color:var(--green)">OK — "${esc(r.reply)}" in ${r.latencyMs}ms</span>`
      : `<span style="color:var(--red)">Failed: ${esc(r.error)}</span>`;
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
        <button class="btn btn-sm btn-danger" data-fb-del="${i}"><svg class="ic ic-sm"><use href="#i-x"/></svg></button>
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
      <td><button class="btn btn-sm btn-danger" data-del-fact="${f.id}"><svg class="ic ic-sm"><use href="#i-trash"/></svg></button></td>
    </tr>`).join('') : '<tr><td colspan="4" class="hint">No facts yet — add things the bot should know.</td></tr>';
  $$('[data-del-fact]').forEach(b => b.addEventListener('click', async () => {
    await api('/facts/' + b.dataset.delFact, { method: 'DELETE' }); loadMemory();
  }));

  $('#memories-table tbody').innerHTML = mems.length ? mems.map(m => `
    <tr>
      <td>${m.chat_id || 'global'}</td><td>${esc(m.content)}</td>
      <td><span class="badge badge-${m.priority === 'critical' ? 'red' : m.priority === 'important' ? 'yellow' : 'gray'}">${esc(m.priority)}</span></td>
      <td>${fmtTime(m.created_at)}</td>
      <td><button class="btn btn-sm btn-danger" data-del-mem="${m.id}"><svg class="ic ic-sm"><use href="#i-trash"/></svg></button></td>
    </tr>`).join('') : '<tr><td colspan="5" class="hint">No memories yet — extracted automatically from conversations.</td></tr>';
  $$('[data-del-mem]').forEach(b => b.addEventListener('click', async () => {
    await api('/memories/' + b.dataset.delMem, { method: 'DELETE' }); loadMemory();
  }));

  loadNotes().catch(() => {});
}

async function loadNotes() {
  const notes = await api('/notes');
  $('#notes-list').innerHTML = notes.length ? notes.map(n => `
    <div class="note-card ${n.pinned ? 'pinned' : ''}">
      <div class="note-head">
        <b>${esc(n.title || 'Untitled')}</b>
        <div class="note-actions">
          <button class="chat-act" data-note-pin="${n.id}" title="${n.pinned ? 'Unpin' : 'Pin'}"><svg class="ic ic-sm ${n.pinned ? 'ic-gold' : ''}"><use href="#i-star"/></svg></button>
          <button class="chat-act" data-note-edit="${n.id}" title="Edit"><svg class="ic ic-sm"><use href="#i-edit"/></svg></button>
          <button class="chat-act" data-note-del="${n.id}" title="Delete"><svg class="ic ic-sm"><use href="#i-trash"/></svg></button>
        </div>
      </div>
      <div class="note-body">${esc(n.body || '')}</div>
    </div>`).join('') : '<p class="hint">No notes yet.</p>';
  $$('[data-note-pin]').forEach(b => b.addEventListener('click', async () => {
    const n = notes.find(x => x.id == b.dataset.notePin);
    await api('/notes', { method: 'POST', body: { id: n.id, title: n.title, body: n.body, pinned: n.pinned ? 0 : 1 } });
    loadNotes();
  }));
  $$('[data-note-del]').forEach(b => b.addEventListener('click', async () => {
    await api('/notes/' + b.dataset.noteDel, { method: 'DELETE' }); loadNotes();
  }));
  $$('[data-note-edit]').forEach(b => b.addEventListener('click', () => editNote(notes.find(x => x.id == b.dataset.noteEdit))));
}
function editNote(n) {
  const title = prompt('Title:', n?.title || '');
  if (title === null) return;
  const body = prompt('Note:', n?.body || '');
  if (body === null) return;
  api('/notes', { method: 'POST', body: { id: n?.id, title, body, pinned: n?.pinned || 0 } })
    .then(() => { toast('Note saved'); loadNotes(); }).catch(e => toast(e.message, false));
}
$('#note-add')?.addEventListener('click', () => editNote(null));
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
let contactAssistant = 0;
async function refreshContactAssistants() {
  try {
    const rows = await api('/assistants');
    const sel = $('#contact-assistant');
    const cur = sel.value;
    sel.innerHTML = '<option value="0">Primary</option>' + rows.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
    sel.value = cur || '0';
  } catch { /* assistants optional */ }
}
let contactTagFilter = '';
async function loadContacts() {
  await refreshContactAssistants();
  contactAssistant = Number($('#contact-assistant').value) || 0;
  const q = $('#contact-search').value;
  const params = new URLSearchParams({ assistant_id: contactAssistant });
  if (q) params.set('q', q);
  if (contactTagFilter) params.set('tag', contactTagFilter);
  const [rows, tags] = await Promise.all([
    api('/contacts?' + params),
    api('/contacts/tags?assistant_id=' + contactAssistant).catch(() => []),
  ]);

  // Tag filter chips
  $('#tag-filters').innerHTML = tags.length
    ? `<button class="btn btn-sm ${contactTagFilter ? '' : 'btn-primary'}" data-tagf="">All</button>` +
      tags.map(t => `<button class="btn btn-sm ${contactTagFilter === t.tag ? 'btn-primary' : ''}" data-tagf="${esc(t.tag)}">${esc(t.tag)} (${t.count})</button>`).join('')
    : '';
  $$('[data-tagf]').forEach(b => b.addEventListener('click', () => { contactTagFilter = b.dataset.tagf; loadContacts(); }));

  $('#contacts-table tbody').innerHTML = rows.length ? rows.map(c => `
    <tr data-edit="${c.chat_id}" style="cursor:pointer">
      <td>${esc(c.name || '—')} ${c.priority ? '<svg class="ic ic-sm ic-gold"><use href="#i-star"/></svg>' : ''}
        ${c.mood && MOOD_META[c.mood] ? `<span class="badge" style="background:${MOOD_META[c.mood].color}22;color:${MOOD_META[c.mood].color};border:1px solid ${MOOD_META[c.mood].color}55" title="Usually reaches out ${esc(MOOD_META[c.mood].label.toLowerCase())}">${esc(MOOD_META[c.mood].label)}</span>` : ''}
        ${(c.tags || '').split(',').map(t => t.trim()).filter(Boolean).map(t => `<span class="badge badge-blue">${esc(t)}</span>`).join(' ')}</td>
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
  $('#c-tags').value = c?.tags || '';
  $('#c-custom_prompt').value = c?.custom_prompt || '';
  $('#c-transcript').value = '';
  $('#c-learned').textContent = c?.learned_tone || '';
  $('#c-history-view').style.display = 'none';
  $('#contact-delete').style.display = c ? '' : 'none';
  $('#contact-modal').style.display = 'flex';
  loadContactStats(c);
  $('#c-dates-wrap').style.display = c ? '' : 'none';
  if (c) loadContactDates().catch(() => {});
}

async function loadContactDates() {
  const rows = await api(`/contacts/${editingChatId}/dates?assistant_id=${contactAssistant}`);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  $('#c-dates-list').innerHTML = rows.length ? rows.map(d => `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
      <span class="badge badge-blue">${MONTHS[d.month - 1]} ${d.day}${d.year ? ', ' + d.year : ''}</span>
      <span style="flex:1">${esc(d.label)}</span>
      <button class="btn btn-sm btn-danger" data-cd-del="${d.id}"><svg class="ic ic-sm"><use href="#i-trash"/></svg></button>
    </div>`).join('') : '<p class="hint">No dates saved.</p>';
  $$('[data-cd-del]').forEach(b => b.addEventListener('click', async () => {
    await api('/dates/' + b.dataset.cdDel, { method: 'DELETE' });
    loadContactDates();
  }));
}
$('#cd-add').addEventListener('click', async () => {
  if (!editingChatId) return;
  try {
    await api(`/contacts/${editingChatId}/dates?assistant_id=${contactAssistant}`, {
      method: 'POST',
      body: { label: $('#cd-label').value, month: $('#cd-month').value, day: $('#cd-day').value, year: $('#cd-year').value || null },
    });
    $('#cd-label').value = ''; $('#cd-month').value = ''; $('#cd-day').value = ''; $('#cd-year').value = '';
    toast('Date saved'); loadContactDates();
  } catch (e) { toast(e.message, false); }
});

async function loadContactStats(c) {
  const box = $('#c-stats');
  if (!c) { box.style.display = 'none'; box.innerHTML = ''; return; }
  try {
    const s = await api(`/contacts/${c.chat_id}/stats?assistant_id=${contactAssistant || 0}`);
    if (!s.total) { box.style.display = 'none'; return; }
    const ago = t => t ? fmtTime(t) : '—';
    const mins = s.avgResponseMs ? (s.avgResponseMs / 1000).toFixed(1) + 's' : '—';
    const rel = s.relationship || { score: 0, level: 'none' };
    const tiles = [
      ['Messages', s.total, `${s.incoming} in · ${s.outgoing} out`],
      ['Response rate', s.responseRate + '%', `avg ${mins}`],
      ['Cadence', s.msgsPerDay + '/day', `${s.activeDays} day span`],
      ['Relationship', rel.score + ' · ' + rel.level, `last seen ${ago(s.lastSeen)}`],
    ];
    box.innerHTML = tiles.map(([l, v, sub]) =>
      `<div class="stat"><div class="label">${esc(l)}</div><div class="value">${esc(String(v))}</div><div class="sub">${esc(sub)}</div></div>`).join('');
    if (s.topics && s.topics.length) {
      box.innerHTML += `<div style="grid-column:1/-1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px">
        <span class="hint">Topics:</span>${s.topics.map(t => `<span class="badge badge-blue" title="mentioned ${t.count}×">${esc(t.word)}</span>`).join(' ')}</div>`;
    }
    box.style.display = '';
  } catch { box.style.display = 'none'; }
}
$('#contact-add').addEventListener('click', () => openContact(null));
$('#contact-modal-close').addEventListener('click', () => $('#contact-modal').style.display = 'none');
$('#contact-modal').addEventListener('click', e => { if (e.target === $('#contact-modal')) $('#contact-modal').style.display = 'none'; });

$('#contact-save').addEventListener('click', async () => {
  const body = {
    chat_id: Number($('#c-chat_id').value), assistant_id: contactAssistant,
    name: $('#c-name').value, username: $('#c-username').value.replace(/^@/, ''),
    relationship: $('#c-relationship').value, tone: $('#c-tone').value, gender: $('#c-gender').value,
    auto_reply: Number($('#c-auto_reply').value), priority: Number($('#c-priority').value),
    delay_multiplier: Number($('#c-delay_multiplier').value) || 1,
    voice_replies: Number($('#c-voice_replies').value),
    max_length: $('#c-max_length').value ? Number($('#c-max_length').value) : null,
    rules: parseLines($('#c-rules').value), blocked_topics: parseLines($('#c-blocked_topics').value),
    notes: $('#c-notes').value, custom_prompt: $('#c-custom_prompt').value || null,
    tags: $('#c-tags').value.split(',').map(s => s.trim()).filter(Boolean).join(', '),
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
  await api(`/contacts/${editingChatId}?assistant_id=${contactAssistant}`, { method: 'DELETE' });
  toast('Contact deleted');
  $('#contact-modal').style.display = 'none';
  loadContacts();
});
$('#contact-assistant').addEventListener('change', loadContacts);
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
  const rows = await api(`/contacts/${editingChatId}/history?assistant_id=${contactAssistant}`);
  const view = $('#c-history-view');
  view.style.display = 'block';
  view.innerHTML = rows.length ? rows.map(m =>
    `<div class="bubble ${m.role === 'assistant' ? 'me' : 'bot'}">${esc(m.content)}</div>`).join('')
    : '<p class="hint">No conversation history.</p>';
  view.scrollTop = view.scrollHeight;
});
$('#contact-timeline').addEventListener('click', async () => {
  if (!editingChatId) return;
  const rows = await api(`/contacts/${editingChatId}/timeline?assistant_id=${contactAssistant}`);
  const view = $('#c-history-view');
  view.style.display = 'block';
  view.innerHTML = rows.length ? rows.map(d => `
    <div style="display:flex;gap:12px;align-items:flex-start;padding:8px 4px;border-bottom:1px solid rgba(127,127,127,.15)">
      <div style="min-width:86px;font-weight:600">${esc(d.day)}</div>
      <div style="flex:1">
        <div><span class="badge badge-blue">${d.incoming} in</span> <span class="badge badge-green">${d.outgoing} out</span></div>
        ${d.snippet ? `<div class="hint" style="margin-top:4px">"${esc(d.snippet)}${d.snippet.length >= 90 ? '…' : ''}"</div>` : ''}
      </div>
    </div>`).join('')
    : '<p class="hint">No activity in the last 30 days.</p>';
  view.scrollTop = 0;
});
$('#contact-dupes').addEventListener('click', async () => {
  const box = $('#dupes-result');
  box.style.display = '';
  box.innerHTML = '<p class="hint">Scanning…</p>';
  const pairs = await api(`/contacts/duplicates?assistant_id=${contactAssistant || 0}`).catch(() => []);
  const who = c => `<b>${esc(c.name || '—')}</b>${c.username ? ' @' + esc(c.username) : ''} <span class="hint">#${c.chat_id}</span>`;
  box.innerHTML = pairs.length ? `
    <div class="card" style="padding:12px 16px">
      <div class="row-between"><h3 style="margin:0">Possible duplicates (${pairs.length})</h3>
        <button class="btn btn-sm" id="dupes-close"><svg class="ic ic-sm"><use href="#i-x"/></svg></button></div>
      ${pairs.map(p => `<div style="padding:6px 0;border-bottom:1px solid rgba(127,127,127,.15)">
        ${who(p.a)} &nbsp;↔&nbsp; ${who(p.b)} <span class="badge badge-yellow">${esc(p.reason)}</span>
      </div>`).join('')}
      <p class="hint" style="margin-top:8px">Review each pair — keep the richer profile and delete the other from its editor.</p>
    </div>`
    : '<div class="card" style="padding:12px 16px"><span class="badge badge-green">No duplicates found</span></div>';
  $('#dupes-close')?.addEventListener('click', () => { box.style.display = 'none'; });
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
      out.textContent = r.ok ? r.output : 'Failed: ' + r.error;
    }
  }));

  $('#sched-table tbody').innerHTML = sched.length ? sched.map(s => `
    <tr>
      <td>${s.chat_id}</td><td>${esc(s.content)}</td><td>${esc(s.send_at)}</td>
      <td>${s.recurrence && s.recurrence !== 'none' ? `<span class="badge badge-blue">${esc(s.recurrence)}</span>` : '—'}</td>
      <td><span class="badge badge-${s.status === 'sent' ? 'green' : s.status === 'failed' ? 'red' : 'blue'}">${esc(s.status)}</span></td>
      <td>${s.status === 'pending' ? `<button class="btn btn-sm btn-danger" data-del-sched="${s.id}"><svg class="ic ic-sm"><use href="#i-x"/></svg></button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="hint">No scheduled messages.</td></tr>';
  $$('[data-del-sched]').forEach(b => b.addEventListener('click', async () => {
    await api('/scheduled/' + b.dataset.delSched, { method: 'DELETE' }); loadTools();
  }));

  // Automation fields
  for (const el of $$('#tab-tools [data-setting]')) el.value = settings[el.dataset.setting] ?? '';

  // Auto-responder rules
  const ars = await api('/autoresponders');
  $('#ar-table tbody').innerHTML = ars.length ? ars.map(a => `
    <tr>
      <td><b>${esc(a.trigger)}</b></td>
      <td><span class="badge badge-gray">${esc(a.match_type)}</span></td>
      <td>${esc(a.reply)}</td>
      <td>${a.uses}</td>
      <td><label class="switch"><input type="checkbox" data-ar-toggle="${a.id}" ${a.enabled ? 'checked' : ''}><span class="slider"></span></label></td>
      <td><button class="btn btn-sm btn-danger" data-ar-del="${a.id}"><svg class="ic ic-sm"><use href="#i-trash"/></svg></button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="hint">No auto-responder rules.</td></tr>';
  $$('[data-ar-toggle]').forEach(el => el.addEventListener('change', async () => {
    await api(`/autoresponders/${el.dataset.arToggle}/toggle`, { method: 'PUT', body: { enabled: el.checked ? 1 : 0 } });
  }));
  $$('[data-ar-del]').forEach(el => el.addEventListener('click', async () => {
    await api('/autoresponders/' + el.dataset.arDel, { method: 'DELETE' }); loadTools();
  }));
}
$('#ar-add')?.addEventListener('click', async () => {
  try {
    await api('/autoresponders', { method: 'POST', body: { trigger: $('#ar-trigger').value, match_type: $('#ar-match').value, reply: $('#ar-reply').value } });
    $('#ar-trigger').value = ''; $('#ar-reply').value = '';
    toast('Rule added'); loadTools();
  } catch (e) { toast(e.message, false); }
});
$('#bc-send')?.addEventListener('click', async () => {
  const msg = $('#bc-message').value.trim();
  if (!msg) return toast('Message required', false);
  if (!confirm('Send this broadcast to matching contacts?')) return;
  try {
    const r = await api('/broadcast', { method: 'POST', body: { message: msg, filter: $('#bc-filter').value, tag: $('#bc-tag').value.trim() || undefined } });
    toast(`Broadcast: ${r.sent} sent, ${r.failed} failed (${r.eligible} eligible)`);
    $('#bc-message').value = '';
  } catch (e) { toast(e.message, false); }
});
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
    await api('/scheduled', { method: 'POST', body: { chat_id: Number($('#sched-chat').value), content: $('#sched-content').value, send_at: $('#sched-at').value, recurrence: $('#sched-recur').value } });
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

// ---------- LIBRARY ----------
const srcBadge = s => `<span class="badge badge-${{ manual: 'blue', catalog: 'green', github: 'yellow', 'self-learned': 'red' }[s] || 'gray'}">${esc(s)}</span>`;

async function loadLibrary() {
  const [skillRows, catalog, servers] = await Promise.all([
    api('/skills'), api('/skills/catalog'), api('/mcp'),
  ]);

  $('#skills-list').innerHTML = skillRows.length ? skillRows.map(s => {
    let trig = []; try { trig = JSON.parse(s.triggers || '[]'); } catch {}
    return `<div class="tool-item">
      <div class="info">
        <div class="name">${esc(s.name)} ${srcBadge(s.source)} ${s.uses ? `<span class="hint">used ${s.uses}×</span>` : ''}</div>
        <div class="desc">${esc(s.description || '')}</div>
        <div class="hint">${trig.length ? 'Triggers: ' + trig.map(esc).join(', ') : 'Always active'}</div>
        <details><summary>instructions</summary><div class="tool-output" style="display:block">${esc(s.content)}</div></details>
      </div>
      <label class="switch"><input type="checkbox" data-skill-toggle="${s.id}" ${s.enabled ? 'checked' : ''}><span class="slider"></span></label>
      <button class="btn btn-sm" data-skill-edit="${s.id}">Edit</button>
      <button class="btn btn-sm btn-danger" data-skill-del="${s.id}"><svg class="ic ic-sm"><use href="#i-trash"/></svg></button>
    </div>`;
  }).join('') : '<p class="hint">No skills yet — install from the catalog below, search GitHub, or let the bot learn its own.</p>';

  $$('[data-skill-toggle]').forEach(el => el.addEventListener('change', async () => {
    await api(`/skills/${el.dataset.skillToggle}/toggle`, { method: 'PUT', body: { enabled: el.checked ? 1 : 0 } });
    toast(el.checked ? 'Skill enabled' : 'Skill disabled');
  }));
  $$('[data-skill-del]').forEach(el => el.addEventListener('click', async () => {
    await api('/skills/' + el.dataset.skillDel, { method: 'DELETE' }); loadLibrary();
  }));
  $$('[data-skill-edit]').forEach(el => el.addEventListener('click', () => {
    openSkill(skillRows.find(s => s.id == el.dataset.skillEdit));
  }));

  $('#catalog-grid').innerHTML = catalog.map(c => `
    <div class="provider-card">
      <h4>${esc(c.name)} ${c.installed ? '<span class="badge badge-green">installed</span>' : ''}</h4>
      <div class="desc hint">${esc(c.description)}</div>
      <div class="hint" style="margin:6px 0">${c.triggers.length ? c.triggers.map(esc).join(' · ') : 'always active'}</div>
      <button class="btn btn-sm ${c.installed ? '' : 'btn-primary'}" data-cat-install="${esc(c.name)}">${c.installed ? 'Reinstall' : 'Install'}</button>
    </div>`).join('');
  $$('[data-cat-install]').forEach(el => el.addEventListener('click', async () => {
    await api('/skills/catalog/install', { method: 'POST', body: { name: el.dataset.catInstall } });
    toast(`Installed: ${el.dataset.catInstall}`); loadLibrary();
  }));

  $('#mcp-list').innerHTML = servers.length ? servers.map(s => `
    <div class="tool-item">
      <div class="info">
        <div class="name">${esc(s.name)}
          <span class="badge badge-${s.status === 'connected' ? 'green' : s.status === 'error' ? 'red' : 'gray'}">${esc(s.status)}</span>
          <span class="hint">${s.tools.length} tools</span>
        </div>
        <div class="desc">${esc(s.url)}</div>
        ${s.last_error ? `<div class="hint" style="color:var(--red)">${esc(s.last_error)}</div>` : ''}
        ${s.tools.length ? `<details><summary>tools</summary><div class="tool-output" style="display:block">${s.tools.map(t => `• ${esc(t.name)} — ${esc(t.description)}`).join('<br>')}</div></details>` : ''}
      </div>
      <label class="switch"><input type="checkbox" data-mcp-toggle="${s.id}" ${s.enabled ? 'checked' : ''}><span class="slider"></span></label>
      <button class="btn btn-sm" data-mcp-connect="${s.id}"><svg class="ic ic-sm"><use href="#i-plug"/></svg> Connect</button>
      <button class="btn btn-sm btn-danger" data-mcp-del="${s.id}"><svg class="ic ic-sm"><use href="#i-trash"/></svg></button>
    </div>`).join('') : '<p class="hint">No MCP servers connected.</p>';

  $$('[data-mcp-toggle]').forEach(el => el.addEventListener('change', async () => {
    await api(`/mcp/${el.dataset.mcpToggle}/toggle`, { method: 'PUT', body: { enabled: el.checked ? 1 : 0 } });
  }));
  $$('[data-mcp-connect]').forEach(el => el.addEventListener('click', async () => {
    el.textContent = '…';
    const r = await api(`/mcp/${el.dataset.mcpConnect}/connect`, { method: 'POST' });
    toast(r.ok ? `Connected — ${r.tools} tools discovered` : r.error, r.ok);
    loadLibrary();
  }));
  $$('[data-mcp-del]').forEach(el => el.addEventListener('click', async () => {
    await api('/mcp/' + el.dataset.mcpDel, { method: 'DELETE' }); loadLibrary();
  }));
}

let editingSkillId = null;
function openSkill(s) {
  editingSkillId = s?.id || null;
  $('#skill-modal-title').textContent = s ? 'Edit skill' : 'New skill';
  $('#sk-name').value = s?.name || '';
  $('#sk-description').value = s?.description || '';
  let trig = []; try { trig = JSON.parse(s?.triggers || '[]'); } catch {}
  $('#sk-triggers').value = trig.join(', ');
  $('#sk-content').value = s?.content || '';
  $('#skill-modal').style.display = 'flex';
}
$('#skill-add').addEventListener('click', () => openSkill(null));
$('#skill-modal-close').addEventListener('click', () => $('#skill-modal').style.display = 'none');
$('#skill-save').addEventListener('click', async () => {
  try {
    await api('/skills', {
      method: 'POST',
      body: { name: $('#sk-name').value, description: $('#sk-description').value, triggers: $('#sk-triggers').value, content: $('#sk-content').value },
    });
    toast('Skill saved');
    $('#skill-modal').style.display = 'none';
    loadLibrary();
  } catch (err) { toast(err.message, false); }
});
$('#skill-learn').addEventListener('click', async () => {
  toast('Analyzing your conversations…');
  try {
    const r = await api('/skills/learn', { method: 'POST' });
    toast(r.created.length ? `Proposed: ${r.created.join(', ')} (disabled — review below)` : 'Nothing new worth learning yet');
    loadLibrary();
  } catch (err) { toast(err.message, false); }
});
$('#gh-search').addEventListener('click', async () => {
  const q = $('#gh-query').value.trim();
  if (!q) return;
  $('#gh-results').innerHTML = '<p class="hint">Searching GitHub…</p>';
  try {
    const rows = await api('/library/github?q=' + encodeURIComponent(q));
    $('#gh-results').innerHTML = rows.length ? rows.map(r => `
      <div class="tool-item">
        <div class="info">
          <div class="name"><svg class="ic ic-sm"><use href="#i-star"/></svg> ${r.stars.toLocaleString()} — ${esc(r.full_name)}</div>
          <div class="desc">${esc(r.description)}</div>
          <a class="hint" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>
        </div>
        <button class="btn btn-sm btn-primary" data-gh-install="${esc(r.full_name)}">Install as skill</button>
      </div>`).join('') : '<p class="hint">No results.</p>';
    $$('[data-gh-install]').forEach(el => el.addEventListener('click', async () => {
      el.textContent = 'Installing…'; el.disabled = true;
      try {
        const r = await api('/library/github/install', { method: 'POST', body: { repo: el.dataset.ghInstall } });
        toast(`Installed skill: ${r.name}`);
        loadLibrary();
      } catch (err) { toast(err.message, false); el.textContent = 'Install as skill'; el.disabled = false; }
    }));
  } catch (err) { $('#gh-results').innerHTML = `<p class="hint" style="color:var(--red)">${esc(err.message)}</p>`; }
});
$('#gh-query').addEventListener('keydown', e => { if (e.key === 'Enter') $('#gh-search').click(); });
$('#mcp-add').addEventListener('click', async () => {
  try {
    await api('/mcp', { method: 'POST', body: { name: $('#mcp-name').value.trim(), url: $('#mcp-url').value.trim(), headers: $('#mcp-headers').value.trim() || '{}' } });
    const servers = await api('/mcp');
    const created = servers[servers.length - 1];
    const r = await api(`/mcp/${created.id}/connect`, { method: 'POST' });
    toast(r.ok ? `Connected — ${r.tools} tools discovered` : `Added, but connect failed: ${r.error}`, r.ok);
    $('#mcp-name').value = ''; $('#mcp-url').value = ''; $('#mcp-headers').value = '';
    loadLibrary();
  } catch (err) { toast(err.message, false); }
});

// ---------- Resolver ----------
$('#resolve-btn').addEventListener('click', async () => {
  const out = $('#resolve-result');
  out.textContent = 'Resolving…';
  try {
    const r = await api('/resolve?username=' + encodeURIComponent($('#resolve-input').value));
    out.innerHTML = `<b>${esc(r.name || '')}</b> → chat_id <code>${r.id}</code> (${esc(r.source)})`;
  } catch (err) { out.textContent = 'Not found: ' + err.message; }
});
$('#resolve-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#resolve-btn').click(); });

// ---------- CHAT PLAYGROUND ----------
const CHAT_KEY = 'sp_chat_history';
let chatHistory = [];
try { chatHistory = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]'); } catch {}
let chatProviders = null;
let chatBusy = false;

// Minimal markdown renderer: code blocks, inline code, bold, italic, links, lists.
function renderMarkdown(text) {
  let out = esc(text);
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) =>
    `<pre class="md-code"><button class="md-copy" data-copy="${esc(encodeURIComponent(code))}" title="Copy"><svg class="ic ic-sm"><use href="#i-copy"/></svg></button><code>${code}</code></pre>`);
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|\s)\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/(^|\n)[-•] (.+)/g, '$1<span class="md-li">• $2</span>');
  out = out.replace(/\n/g, '<br>');
  return out;
}

function saveChat() { localStorage.setItem(CHAT_KEY, JSON.stringify(chatHistory.slice(-60))); }

function renderChatThread() {
  const thread = $('#chat-thread');
  if (!chatHistory.length) {
    thread.innerHTML = `<div class="chat-empty"><svg class="ic ic-xl"><use href="#i-chat"/></svg>
      <p>Talk to your secretary. Test the persona, tools and models — nothing is sent to Telegram.</p></div>`;
    return;
  }
  thread.innerHTML = chatHistory.map((m, i) => `
    <div class="chat-msg ${m.role}">
      <div class="chat-avatar">${m.role === 'user'
        ? '<svg class="ic"><use href="#i-users"/></svg>'
        : '<svg class="ic"><use href="#i-bot"/></svg>'}</div>
      <div class="chat-body">
        <div class="chat-content">${renderMarkdown(m.content)}</div>
        ${m.meta ? `<div class="chat-meta">${esc(m.meta)}</div>` : ''}
        <div class="chat-actions">
          <button class="chat-act" data-chat-copy="${i}" title="Copy"><svg class="ic ic-sm"><use href="#i-copy"/></svg></button>
          ${m.role === 'assistant' && i === chatHistory.length - 1
            ? `<button class="chat-act" data-chat-regen title="Regenerate"><svg class="ic ic-sm"><use href="#i-rotate"/></svg></button>` : ''}
        </div>
      </div>
    </div>`).join('');
  thread.scrollTop = thread.scrollHeight;

  $$('[data-chat-copy]').forEach(b => b.addEventListener('click', () => {
    navigator.clipboard.writeText(chatHistory[b.dataset.chatCopy].content);
    toast('Copied');
  }));
  $$('[data-copy]').forEach(b => b.addEventListener('click', () => {
    navigator.clipboard.writeText(decodeURIComponent(b.dataset.copy));
    toast('Code copied');
  }));
  const regen = $('[data-chat-regen]');
  if (regen) regen.addEventListener('click', () => {
    chatHistory.pop();
    saveChat();
    sendChatRequest();
  });
}

async function loadChat() {
  if (!chatProviders) {
    const gw = await api('/providers');
    chatProviders = gw.providers;
    $('#chat-provider').innerHTML = '<option value="">Auto (fallback chain)</option>' +
      chatProviders.filter(p => p.configured).map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
    fillChatModels();
  }
  renderChatThread();
}
function fillChatModels() {
  const p = chatProviders.find(x => x.id === $('#chat-provider').value);
  $('#chat-model').innerHTML = p ? p.models.map(m => `<option>${esc(m)}</option>`).join('') : '<option value="">auto</option>';
}
async function runBehaviorInspector() {
  const message = $('#bhv-input').value.trim();
  if (!message) return;
  const box = $('#bhv-result');
  box.textContent = 'Inspecting…';
  try {
    const b = await api('/behavior/preview', { method: 'POST', body: { message } });
    const chips = (b.active || []).map(a => `<span class="badge badge-blue">${esc(a)}</span>`).join(' ') || '<span class="hint">no human-layer signals enabled</span>';
    box.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">${chips}</div>
      <div><b>Mood:</b> <span class="badge badge-${b.mood === 'neutral' ? 'gray' : 'green'}">${esc(b.mood)}</span>${b.moodHint ? ` — ${esc(b.moodHint)}` : ''}</div>
      <div style="margin-top:4px"><b>Intent:</b> <span class="badge badge-blue">${esc(b.intent || 'unknown')}</span>
        ${b.expectsAnswer ? `<span class="badge badge-yellow" style="margin-left:8px" title="This message expects a reply">needs answer${b.questionCount > 1 ? ` ×${b.questionCount}` : ''}</span>` : ''}
        <b style="margin-left:10px">Urgency:</b> <span class="badge badge-${b.urgencyLevel === 'high' ? 'red' : b.urgencyLevel === 'medium' ? 'yellow' : 'gray'}">${esc(b.urgencyLevel || 'low')} · ${b.urgency ?? 0}</span></div>
      <div style="margin-top:4px"><b>Language:</b> <span class="badge badge-blue">${esc(b.language || 'Unknown')}</span>${b.languageCode && b.languageCode !== 'und' ? ` <span class="hint">${esc(b.languageCode)}</span>` : ''}</div>
      <div style="margin-top:4px"><b>Local time:</b> <span class="badge badge-gray">${esc(b.period)}</span> <span class="hint">(${esc(b.timezone)})</span>${b.periodHint ? ` — ${esc(b.periodHint)}` : ''}</div>
      ${(b.suggestions && b.suggestions.length) ? `<div style="margin-top:8px"><b>Quick replies:</b><div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">${b.suggestions.map(s => `<button class="btn btn-sm" data-qr="${esc(s)}" style="text-align:left;justify-content:flex-start">${esc(s)}</button>`).join('')}</div></div>` : ''}`;
    $$('[data-qr]').forEach(btn => btn.addEventListener('click', () => {
      const inp = $('#chat-input'); if (inp) { inp.value = btn.dataset.qr; inp.focus(); }
      toast('Copied to composer');
    }));
  } catch (e) { box.textContent = e.message; }
}
async function runBehaviorDryRun() {
  const message = $('#bhv-input').value.trim();
  if (!message) return;
  const box = $('#bhv-result'); const pre = $('#bhv-prompt');
  box.textContent = 'Assembling…'; pre.style.display = 'none';
  try {
    const d = await api('/behavior/dryrun', { method: 'POST', body: { message } });
    const chips = [
      d.wouldReply ? '<span class="badge badge-green">would reply</span>' : '<span class="badge badge-gray">no LLM reply</span>',
      d.autoresponder ? '<span class="badge badge-blue">auto-responder match</span>' : '',
      d.skillActive ? '<span class="badge badge-blue">skill active</span>' : '',
      d.policyBlock ? `<span class="badge badge-red">blocked: ${esc(d.policyBlock)}</span>` : '',
    ].filter(Boolean).join(' ');
    box.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">${chips}</div>`
      + (d.autoresponder ? `<div><b>Canned reply:</b> ${esc(d.autoresponder)}</div>` : '')
      + `<div class="hint">Assembled system prompt (${d.chars} chars):</div>`;
    pre.textContent = d.systemPrompt; pre.style.display = 'block';
  } catch (e) { box.textContent = e.message; }
}
$('#bhv-run').addEventListener('click', runBehaviorInspector);
$('#bhv-dryrun').addEventListener('click', runBehaviorDryRun);
$('#bhv-input').addEventListener('keydown', e => { if (e.key === 'Enter') runBehaviorInspector(); });

$('#chat-provider').addEventListener('change', fillChatModels);
$('#chat-temp').addEventListener('input', () => $('#chat-temp-out').textContent = $('#chat-temp').value);
$('#chat-system-mode').addEventListener('change', () => {
  $('#chat-system-text').style.display = $('#chat-system-mode').value === 'custom' ? 'block' : 'none';
});
$('#chat-export').addEventListener('click', () => {
  if (!chatHistory.length) return toast('Nothing to export', false);
  const text = chatHistory.map(m => `## ${m.role === 'user' ? 'You' : 'Assistant'}\n${m.content}`).join('\n\n');
  const blob = new Blob([text], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'playground-chat.md';
  a.click();
  URL.revokeObjectURL(a.href);
});

async function sendChatRequest() {
  if (chatBusy) return;
  chatBusy = true;
  const thread = $('#chat-thread');
  thread.insertAdjacentHTML('beforeend', `
    <div class="chat-msg assistant" id="chat-pending">
      <div class="chat-avatar"><svg class="ic"><use href="#i-bot"/></svg></div>
      <div class="chat-body"><div class="chat-content"><span class="typing-dots"><i></i><i></i><i></i></span></div></div>
    </div>`);
  thread.scrollTop = thread.scrollHeight;
  try {
    const r = await api('/chat/playground', {
      method: 'POST',
      body: {
        messages: chatHistory.map(m => ({ role: m.role, content: m.content })),
        provider: $('#chat-provider').value || undefined,
        model: $('#chat-provider').value ? $('#chat-model').value : undefined,
        temperature: Number($('#chat-temp').value),
        max_tokens: Number($('#chat-maxtok').value) || 1024,
        use_persona: $('#chat-system-mode').value === 'persona',
        system: $('#chat-system-mode').value === 'custom' ? $('#chat-system-text').value : undefined,
      },
    });
    chatHistory.push({
      role: 'assistant', content: r.reply,
      meta: `${r.provider}/${r.model} · ${r.latencyMs}ms · ${(r.tokensIn || 0) + (r.tokensOut || 0)} tok · $${(r.cost || 0).toFixed(6)}`,
    });
  } catch (err) {
    chatHistory.push({ role: 'assistant', content: `Something went wrong: ${err.message}`, meta: 'error' });
  }
  chatBusy = false;
  saveChat();
  renderChatThread();
}

function sendChatMessage() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || chatBusy) return;
  input.value = '';
  input.style.height = 'auto';
  chatHistory.push({ role: 'user', content: text });
  saveChat();
  renderChatThread();
  sendChatRequest();
}
$('#chat-send').addEventListener('click', sendChatMessage);
$('#chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
});
$('#chat-input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 160) + 'px';
});
$('#chat-clear').addEventListener('click', () => {
  chatHistory = [];
  saveChat();
  renderChatThread();
});

// ---------- CHARACTERS (in prompt tab) ----------
async function loadCharacters() {
  const chars = await api('/characters');
  const grid = $('#characters-grid');
  if (!grid) return;
  grid.innerHTML = chars.map(c => `
    <div class="char-card ${c.active ? 'active' : ''}">
      <div class="char-head"><svg class="ic"><use href="#i-masks"/></svg><b>${esc(c.name)}</b>${c.active ? '<span class="badge badge-green">active</span>' : ''}</div>
      <div class="hint">${esc(c.tagline)}</div>
      <button class="btn btn-sm ${c.active ? '' : 'btn-primary'}" data-char="${esc(c.id)}">${c.active ? 'Re-apply' : 'Apply'}</button>
    </div>`).join('');
  $$('[data-char]').forEach(b => b.addEventListener('click', async () => {
    const r = await api('/characters/apply', { method: 'POST', body: { id: b.dataset.char } });
    $('#prompt-editor').value = r.prompt;
    toast(`Applied character: ${r.character}`);
    loadCharacters();
  }));
}

// ---------- ASSISTANTS ----------
async function loadAssistants() {
  const rows = await api('/assistants');
  const grid = $('#assistants-list');
  grid.innerHTML = rows.length ? rows.map(a => `
    <div class="char-card">
      <div class="char-head"><svg class="ic"><use href="#i-bot"/></svg><b>${esc(a.name)}</b>
        <span class="badge badge-${a.status === 'running' ? 'green' : a.status === 'error' ? 'red' : 'gray'}">${esc(a.status)}</span>
      </div>
      <div class="hint">${a.username ? '@' + esc(a.username) + ' · ' : ''}owner ${a.owner_user_id || '—'}</div>
      ${a.last_error ? `<div class="hint" style="color:var(--red)">${esc(a.last_error)}</div>` : ''}
      <div class="btn-row">
        ${a.running
          ? `<button class="btn btn-sm" data-asst-stop="${a.id}"><svg class="ic ic-sm"><use href="#i-power"/></svg> Stop</button>`
          : `<button class="btn btn-sm btn-primary" data-asst-start="${a.id}"><svg class="ic ic-sm"><use href="#i-play"/></svg> Start</button>`}
        <button class="btn btn-sm" data-asst-edit="${a.id}"><svg class="ic ic-sm"><use href="#i-edit"/></svg> Edit</button>
        <button class="btn btn-sm btn-danger" data-asst-del="${a.id}"><svg class="ic ic-sm"><use href="#i-trash"/></svg></button>
      </div>
    </div>`).join('')
    : '<p class="hint">No additional assistants. The primary bot runs from your .env token. Add one to run a second bot with its own brain.</p>';
  window._assistants = rows;
  $$('[data-asst-edit]').forEach(b => b.addEventListener('click', () => openAssistant(rows.find(a => a.id == b.dataset.asstEdit))));
  $$('[data-asst-start]').forEach(b => b.addEventListener('click', async () => {
    const r = await api(`/assistants/${b.dataset.asstStart}/start`, { method: 'POST' });
    toast(r.ok ? 'Assistant started' : r.error, r.ok); loadAssistants();
  }));
  $$('[data-asst-stop]').forEach(b => b.addEventListener('click', async () => {
    await api(`/assistants/${b.dataset.asstStop}/stop`, { method: 'POST' }); toast('Stopped'); loadAssistants();
  }));
  $$('[data-asst-del]').forEach(b => b.addEventListener('click', async () => {
    const purge = confirm('Also delete this assistant\'s brain (conversations & memory)? OK = purge, Cancel = keep data.');
    await api(`/assistants/${b.dataset.asstDel}${purge ? '?purge=1' : ''}`, { method: 'DELETE' });
    toast('Assistant deleted'); loadAssistants();
  }));
}
const ASST_OVERRIDES = ['temperature', 'reply_style', 'emoji_usage', 'language', 'max_response_length', 'persona_name'];
let editingAssistantId = null;
function openAssistant(a) {
  editingAssistantId = a?.id || null;
  $('#asst-modal-title').textContent = a ? `Edit: ${a.name}` : 'New assistant';
  $('#asst-name').value = a?.name || '';
  $('#asst-token').value = '';
  $('#asst-token').placeholder = a?.has_token ? '•••••• (leave blank to keep)' : '123456:ABC…';
  $('#asst-owner').value = a?.owner_user_id || '';
  $('#asst-prompt').value = a?.system_prompt || '';
  for (const k of ASST_OVERRIDES) $('#asst-' + k).value = a?.settings?.[k] ?? '';
  $('#asst-modal').style.display = 'flex';
}
$('#asst-add').addEventListener('click', () => openAssistant(null));
$('#asst-modal-close').addEventListener('click', () => $('#asst-modal').style.display = 'none');
$('#asst-save').addEventListener('click', async () => {
  const settings = {};
  for (const k of ASST_OVERRIDES) { const v = $('#asst-' + k).value.trim(); if (v) settings[k] = v; }
  const body = {
    name: $('#asst-name').value,
    owner_user_id: $('#asst-owner').value || null,
    system_prompt: $('#asst-prompt').value || null,
    settings_json: JSON.stringify(settings),
  };
  const token = $('#asst-token').value.trim();
  if (token) body.bot_token = token;
  try {
    if (editingAssistantId) await api('/assistants/' + editingAssistantId, { method: 'PUT', body });
    else await api('/assistants', { method: 'POST', body });
    toast('Assistant saved');
    $('#asst-modal').style.display = 'none';
    loadAssistants();
  } catch (e) { toast(e.message, false); }
});

// ---------- MODEL BROWSER ----------
let browseModels = [];
let browseAll = false;
async function openModelBrowser(all) {
  browseAll = all;
  const provider = $('#primary-provider').value;
  $('#models-title').textContent = all ? 'All configured providers' : `${provider} models`;
  $('#models-search').value = '';
  $('#models-list').innerHTML = '<div class="hint"><span class="spinner"></span> Loading live catalog…</div>';
  $('#models-modal').style.display = 'flex';
  try {
    browseModels = await api(all ? '/models' : '/models/' + provider);
    renderModels('');
  } catch (e) { $('#models-list').innerHTML = `<p class="hint" style="color:var(--red)">${esc(e.message)}</p>`; }
}
function renderModels(filter) {
  const rows = browseModels.filter(m => !filter || m.id.toLowerCase().includes(filter.toLowerCase()) || (m.provider || '').includes(filter.toLowerCase()));
  $('#models-list').innerHTML = rows.length ? rows.slice(0, 400).map(m => `
    <div class="model-row">
      <div class="model-info">
        <div class="model-id">${m.provider ? `<span class="badge badge-gray">${esc(m.provider)}</span> ` : ''}${esc(m.id)} ${m.free ? '<span class="badge badge-green">free</span>' : ''} ${m.vision ? '<span class="badge badge-blue">vision</span>' : ''}</div>
        ${m.context ? `<div class="hint">${(m.context/1000).toFixed(0)}K ctx${m.promptCost ? ` · $${m.promptCost.toFixed(2)}/$${(m.completionCost||0).toFixed(2)} per 1M` : ''}</div>` : ''}
      </div>
      <button class="btn btn-sm btn-primary" data-pick-model="${esc(m.id)}" data-pick-provider="${esc(m.provider || '')}">Use</button>
    </div>`).join('') : '<p class="hint">No models match.</p>';
  $$('[data-pick-model]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.pickModel;
    const prov = b.dataset.pickProvider;
    if (prov) { // all-providers mode: also switch the primary provider
      const psel = $('#primary-provider');
      if ([...psel.options].some(o => o.value === prov)) { psel.value = prov; fillModels($('#primary-provider'), $('#primary-model')); }
    }
    const sel = $('#primary-model');
    if (![...sel.options].some(o => o.value === id)) sel.add(new Option(id, id));
    sel.value = id;
    $('#models-modal').style.display = 'none';
    toast(`Selected ${prov ? prov + '/' : ''}${id} — click Save routing to apply`);
  }));
}
$('#browse-models').addEventListener('click', () => openModelBrowser(false));
$('#browse-all-models').addEventListener('click', () => openModelBrowser(true));
$('#models-close').addEventListener('click', () => $('#models-modal').style.display = 'none');
$('#models-search').addEventListener('input', () => renderModels($('#models-search').value));

// ---------- SYSTEM MONITORING ----------
let sysTimer;
function meterBar(label, pct, danger) {
  const color = pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--yellow)' : 'var(--green)';
  return `<div class="meter">
    <div class="meter-top"><span>${esc(label)}</span><span>${pct}%</span></div>
    <div class="meter-track"><div class="meter-fill" style="width:${Math.min(100, pct)}%;background:${color}"></div></div>
  </div>`;
}
const MOOD_META = {
  upset:    { label: 'Upset',    color: '#ef4444' },
  sad:      { label: 'Sad',      color: '#3b82f6' },
  anxious:  { label: 'Anxious',  color: '#f59e0b' },
  grateful: { label: 'Grateful', color: '#14b8a6' },
  confused: { label: 'Confused', color: '#a855f7' },
  excited:  { label: 'Excited',  color: '#22c55e' },
  neutral:  { label: 'Neutral',  color: '#8b95a5' },
};
async function loadMoodMix() {
  const d = await api('/analytics/mood');
  $('#mood-expressiveness').textContent = d.total
    ? `${d.expressiveness}% expressive · ${d.total} messages` : 'no messages yet';
  if (!d.total) { $('#mood-bars').innerHTML = '<p class="hint">No incoming messages to analyze yet.</p>'; return; }
  $('#mood-bars').innerHTML = Object.entries(MOOD_META).map(([k, meta]) => {
    const n = d.counts[k] || 0;
    const pct = Math.round((n / d.total) * 100);
    return `<div style="display:flex;align-items:center;gap:10px;margin:6px 0">
      <span style="width:70px;font-size:.85em;color:var(--text-dim)">${meta.label}</span>
      <div style="flex:1;height:10px;border-radius:6px;background:rgba(127,127,127,.15);overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${meta.color};border-radius:6px;transition:width .4s"></div>
      </div>
      <span style="width:64px;text-align:right;font-size:.82em;color:var(--text-dim)">${n} · ${pct}%</span>
    </div>`;
  }).join('');
}

const INTENT_META = {
  question:  { label: 'Questions',  color: '#3b82f6' },
  request:   { label: 'Requests',   color: '#8b5cf6' },
  complaint: { label: 'Complaints', color: '#ef4444' },
  feedback:  { label: 'Feedback',   color: '#22c55e' },
  greeting:  { label: 'Greetings',  color: '#14b8a6' },
  smalltalk: { label: 'Small talk', color: '#f59e0b' },
  statement: { label: 'Statements', color: '#8b95a5' },
};
async function loadIntentMix() {
  const d = await api('/analytics/intents');
  $('#intent-total').textContent = d.total ? `${d.total} messages` : 'no messages yet';
  if (!d.total) { $('#intent-bars').innerHTML = '<p class="hint">No incoming messages to analyze yet.</p>'; return; }
  $('#intent-bars').innerHTML = Object.entries(INTENT_META).map(([k, meta]) => {
    const n = d.counts[k] || 0;
    const pct = Math.round((n / d.total) * 100);
    return `<div style="display:flex;align-items:center;gap:10px;margin:6px 0">
      <span style="width:80px;font-size:.85em;color:var(--text-dim)">${meta.label}</span>
      <div style="flex:1;height:10px;border-radius:6px;background:rgba(127,127,127,.15);overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${meta.color};border-radius:6px;transition:width .4s"></div>
      </div>
      <span style="width:64px;text-align:right;font-size:.82em;color:var(--text-dim)">${n} · ${pct}%</span>
    </div>`;
  }).join('');
}

async function loadHeatmap() {
  const { grid, max } = await api('/analytics/heatmap');
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  $('#heatmap-note').textContent = max ? `peak ${max}/hr` : 'no activity yet';
  if (!max) { $('#heatmap-grid').innerHTML = '<p class="hint">No messages in the last 30 days.</p>'; return; }
  const cell = (n) => {
    const a = n ? 0.15 + 0.85 * (n / max) : 0;
    return `<td title="${n} messages" style="width:22px;height:18px;border-radius:4px;background:${n ? `rgba(124,108,255,${a.toFixed(2)})` : 'rgba(127,127,127,.08)'}"></td>`;
  };
  $('#heatmap-grid').innerHTML = `<table style="border-spacing:3px;border-collapse:separate">
    <tr><td></td>${Array.from({ length: 24 }, (_, h) => `<td class="hint" style="font-size:.7em;text-align:center">${h % 3 === 0 ? h : ''}</td>`).join('')}</tr>
    ${grid.map((row, d) => `<tr><td class="hint" style="font-size:.75em;padding-right:6px">${DAYS[d]}</td>${row.map(cell).join('')}</tr>`).join('')}
  </table>`;
}

async function loadResponseTimes() {
  const d = await api('/analytics/response-times');
  const fmt = ms => ms >= 60000 ? (ms / 60000).toFixed(1) + 'm' : (ms / 1000).toFixed(1) + 's';
  $('#rt-percentiles').textContent = d.total
    ? `p50 ${fmt(d.p50)} · p90 ${fmt(d.p90)} · p99 ${fmt(d.p99)}` : 'no replies yet';
  if (!d.total) { $('#rt-bars').innerHTML = '<p class="hint">No outgoing replies in the last 30 days.</p>'; return; }
  const max = Math.max(...d.histogram.map(b => b.count), 1);
  $('#rt-bars').innerHTML = d.histogram.map(b => {
    const pct = Math.round((b.count / d.total) * 100);
    return `<div style="display:flex;align-items:center;gap:10px;margin:6px 0">
      <span style="width:60px;font-size:.85em;color:var(--text-dim)">${b.label}</span>
      <div style="flex:1;height:10px;border-radius:6px;background:rgba(127,127,127,.15);overflow:hidden">
        <div style="width:${Math.round((b.count / max) * 100)}%;height:100%;background:#7c6cff;border-radius:6px;transition:width .4s"></div>
      </div>
      <span style="width:64px;text-align:right;font-size:.82em;color:var(--text-dim)">${b.count} · ${pct}%</span>
    </div>`;
  }).join('');
}

async function loadLanguageMix() {
  const d = await api('/analytics/languages');
  const known = d.languages.reduce((a, l) => a + l.count, 0);
  $('#lang-note').textContent = known ? `${d.languages.length} language${d.languages.length === 1 ? '' : 's'}` : '';
  $('#lang-chips').innerHTML = d.languages.length
    ? d.languages.map(l => `<span class="badge badge-blue" title="${l.count} messages">${esc(l.name)} · ${Math.round((l.count / known) * 100)}%</span>`).join('')
    : '<span class="hint">No language signal yet.</span>';
}

async function loadSystem() {
  const { metrics: m, diagnostics: diag } = await api('/system');
  const fmtUp = s => s > 86400 ? `${Math.floor(s/86400)}d ${Math.floor(s%86400/3600)}h` : s > 3600 ? `${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m` : `${Math.floor(s/60)}m`;
  const okCount = diag.filter(d => d.status === 'ok').length;
  const tiles = [
    ['Status', 'Online', 'all systems'],
    ['Health', `${okCount}/${diag.length}`, 'checks passing'],
    ['Process uptime', fmtUp(m.uptimeSec), `pid ${m.pid}`],
    ['CPU load', m.cpu.loadPct + '%', `${m.cpu.cores} cores`],
    ['Memory', m.memory.systemUsedPct + '%', `${m.memory.rssMB}MB rss`],
    ['Database', m.dbSizeMB + 'MB', m.disk ? `${m.disk.freeGB}GB disk free` : ''],
  ];
  $('#sys-stat-grid').innerHTML = tiles.map(([l, v, sub]) =>
    `<div class="stat"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`).join('');

  $('#sys-meters').innerHTML =
    meterBar('CPU', m.cpu.loadPct) +
    meterBar('System memory', m.memory.systemUsedPct) +
    (m.disk ? meterBar('Disk', m.disk.usedPct) : '');

  $('#sys-diagnostics').innerHTML = diag.map(d => `
    <div class="diag-row">
      <span class="diag-dot ${d.status}"></span>
      <div class="diag-body"><b>${esc(d.name)}</b><div class="hint">${esc(d.detail)}</div></div>
      ${d.fix ? `<button class="btn btn-sm" data-fix="${esc(d.fix)}">Fix</button>` : ''}
    </div>`).join('');
  $$('[data-fix]').forEach(b => b.addEventListener('click', async () => {
    const r = await api('/system/autofix', { method: 'POST', body: { action: b.dataset.fix } });
    toast(r.message);
    loadSystem();
  }));

  $('#sys-env').innerHTML = [
    ['Node', m.node], ['Platform', m.platform], ['Arch', m.arch], ['Hostname', m.hostname],
    ['CPU', m.cpu.model], ['Host uptime', fmtUp(m.hostUptimeSec)], ['Total memory', m.memory.systemTotalGB + 'GB'],
  ].map(([k, v]) => `<div class="kv"><span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(v)}</span></div>`).join('');

  loadMoodMix().catch(() => {});
  loadIntentMix().catch(() => {});
  loadHeatmap().catch(() => {});
  loadResponseTimes().catch(() => {});
  loadLanguageMix().catch(() => {});

  clearTimeout(sysTimer);
  sysTimer = setTimeout(() => { if ($('#tab-system').classList.contains('active')) loadSystem().catch(() => {}); }, 4000);
}
$('#sys-autofix').addEventListener('click', async () => {
  const r = await api('/system/autofix', { method: 'POST', body: { action: 'fix_all' } });
  toast(r.message);
  loadSystem();
});
$('#sys-restart').addEventListener('click', async () => {
  if (!confirm('Restart the bot process? It will reconnect in a few seconds if a process manager is running.')) return;
  try { const r = await api('/system/restart', { method: 'POST' }); toast(r.message); } catch (e) { toast(e.message, false); }
});

// ---------- SECURITY ----------
async function load2fa() {
  const st = $('#twofa-status');
  if (!st) return;
  try {
    const s = await api('/2fa/status');
    const on = s.enabled;
    st.className = 'badge badge-' + (on ? 'green' : 'gray');
    st.textContent = s.available ? (on ? 'enabled' : 'disabled') : 'auth off';
    $('#twofa-enable-btn').style.display = on || !s.available ? 'none' : '';
    $('#twofa-disable-btn').style.display = on ? '' : 'none';
    if (!on) $('#twofa-setup').innerHTML = '';
  } catch { /* ignore */ }
}
$('#twofa-enable-btn')?.addEventListener('click', async () => {
  try {
    const r = await api('/2fa/setup', { method: 'POST' });
    const qr = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(r.otpauth)}`;
    $('#twofa-setup').innerHTML = `
      <div class="input-row" style="align-items:flex-start">
        <img src="${esc(qr)}" alt="QR" style="border-radius:8px;background:#fff;padding:6px">
        <div>
          <p class="hint">Scan with your authenticator app, or enter this secret manually:</p>
          <code>${esc(r.secret)}</code>
          <div class="input-row" style="margin-top:10px">
            <input id="twofa-code" placeholder="6-digit code" inputmode="numeric" style="max-width:140px">
            <button class="btn btn-primary" id="twofa-confirm">Confirm &amp; enable</button>
          </div>
        </div>
      </div>`;
    $('#twofa-confirm').addEventListener('click', async () => {
      try {
        await api('/2fa/enable', { method: 'POST', body: { totp: $('#twofa-code').value } });
        toast('2FA enabled — you\'ll need your code at next login');
        load2fa();
      } catch (e) { toast(e.message, false); }
    });
  } catch (e) { toast(e.message, false); }
});
$('#twofa-disable-btn')?.addEventListener('click', async () => {
  const password = prompt('Enter your password to disable 2FA:');
  if (password === null) return;
  try { await api('/2fa/disable', { method: 'POST', body: { password } }); toast('2FA disabled'); load2fa(); }
  catch (e) { toast(e.message, false); }
});

async function loadMySessions() {
  const rows = await api('/sessions').catch(() => []);
  const geo = s => `${s.flag ? s.flag + ' ' : ''}${esc(s.ip || '—')}${s.country ? ` <span class="hint">${esc(s.country)}</span>` : ''}`;
  const status = s => s.current ? '<span class="badge badge-blue">this device</span>'
    : s.active ? '<span class="badge badge-green">active</span>'
    : '<span class="badge badge-gray">revoked</span>';
  $('#mysessions-table tbody').innerHTML = rows.length ? rows.map(s => `
    <tr>
      <td><b>${esc(s.label || 'Unknown')}</b>${s.remember ? ' <span class="badge badge-gray">remembered</span>' : ''}</td>
      <td>${geo(s)}</td>
      <td>${fmtTime(s.created_at)}</td>
      <td>${fmtTime(s.last_seen)}</td>
      <td>${status(s)}</td>
      <td>${s.current || !s.active ? '' : `<button class="btn btn-sm btn-danger" data-revoke="${esc(s.id)}">Revoke</button>`}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="hint">No sessions</td></tr>';
  $$('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
    try { await api('/sessions/' + encodeURIComponent(b.dataset.revoke), { method: 'DELETE' }); toast('Session revoked'); loadMySessions(); }
    catch (e) { toast(e.message, false); }
  }));
}

async function loadSecurity() {
  load2fa().catch(() => {});
  loadMySessions().catch(() => {});
  const [users, sessions, attempts, bans, audit] = await Promise.all([
    api('/users').catch(() => []), api('/security/sessions'), api('/security/attempts'),
    api('/security/bans'), api('/security/audit'),
  ]);

  $('#users-table tbody').innerHTML = users.length ? users.map(u => `
    <tr>
      <td><b>${esc(u.username)}</b></td>
      <td><span class="badge badge-${u.role === 'owner' ? 'blue' : u.role === 'viewer' ? 'gray' : 'green'}">${esc(u.role)}</span></td>
      <td><span class="badge badge-${u.enabled ? 'green' : 'red'}">${u.enabled ? 'active' : 'disabled'}</span></td>
      <td>${u.last_login ? fmtTime(u.last_login) : '—'}</td>
      <td>${esc(u.last_ip || '—')}</td>
      <td class="btn-row" style="margin:0">
        <button class="btn btn-sm" data-user-edit="${u.id}">Edit</button>
        <button class="btn btn-sm btn-danger" data-user-del="${u.id}"><svg class="ic ic-sm"><use href="#i-trash"/></svg></button>
      </td>
    </tr>`).join('') : '<tr><td colspan="6" class="hint">No accounts (auth disabled — set one to lock the panel).</td></tr>';
  $$('[data-user-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this account?')) return;
    try { await api('/users/' + b.dataset.userDel, { method: 'DELETE' }); toast('User deleted'); loadSecurity(); }
    catch (e) { toast(e.message, false); }
  }));
  $$('[data-user-edit]').forEach(b => b.addEventListener('click', () => openUser(users.find(u => u.id == b.dataset.userEdit))));

  const geo = s => `${s.flag ? s.flag + ' ' : ''}${esc(s.ip)}${s.country ? ` <span class="hint">${esc(s.country)}</span>` : ''}`;
  $('#sessions-table tbody').innerHTML = sessions.length ? sessions.map(s => `
    <tr><td>${esc(s.username)} ${s.current ? '<span class="badge badge-blue">you</span>' : ''}</td><td>${geo(s)}</td><td>${fmtTime(s.last_seen)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="hint">No active sessions</td></tr>';

  $('#attempts-table tbody').innerHTML = attempts.length ? attempts.map(a => `
    <tr>
      <td>${fmtTime(a.created_at)}</td><td>${esc(a.username)}</td><td>${geo(a)}</td>
      <td><span class="badge badge-${a.success ? 'green' : 'red'}">${a.success ? 'success' : 'failed'}</span></td>
      <td>${a.success ? '' : `<button class="btn btn-sm btn-danger" data-quickban="${esc(a.ip)}">Ban IP</button>`}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="hint">No login attempts</td></tr>';
  $$('[data-quickban]').forEach(b => b.addEventListener('click', async () => {
    await api('/security/bans', { method: 'POST', body: { ip: b.dataset.quickban, reason: 'failed logins' } });
    toast('IP banned'); loadSecurity();
  }));

  $('#bans-table tbody').innerHTML = bans.length ? bans.map(b => `
    <tr><td>${b.flag ? b.flag + ' ' : ''}${esc(b.ip)}${b.country ? ` <span class="hint">${esc(b.country)}</span>` : ''}</td><td>${esc(b.reason || '')}</td><td>${fmtTime(b.created_at)}</td>
    <td><button class="btn btn-sm" data-unban="${esc(b.ip)}">Unban</button></td></tr>`).join('')
    : '<tr><td colspan="4" class="hint">No banned IPs</td></tr>';
  $$('[data-unban]').forEach(b => b.addEventListener('click', async () => {
    await api('/security/bans/' + encodeURIComponent(b.dataset.unban), { method: 'DELETE' }); toast('Unbanned'); loadSecurity();
  }));

  $('#audit-table tbody').innerHTML = audit.length ? audit.map(a => `
    <tr><td>${fmtTime(a.created_at)}</td><td>${esc(a.username || '—')}</td><td><span class="badge badge-blue">${esc(a.action)}</span></td><td>${esc(a.detail || '')}</td><td>${esc(a.ip || '')}</td></tr>`).join('')
    : '<tr><td colspan="5" class="hint">No audit entries</td></tr>';
}
$('#ban-add').addEventListener('click', async () => {
  if (!$('#ban-ip').value.trim()) return;
  await api('/security/bans', { method: 'POST', body: { ip: $('#ban-ip').value.trim(), reason: $('#ban-reason').value } });
  $('#ban-ip').value = ''; $('#ban-reason').value = '';
  toast('IP banned'); loadSecurity();
});
$('#revoke-others').addEventListener('click', async () => {
  if (!confirm('Sign out all other devices? They will need to log in again.')) return;
  try { const r = await api('/sessions/revoke-others', { method: 'POST' }); toast(`Signed out ${r.revoked} other session(s)`); loadMySessions(); }
  catch (e) { toast(e.message, false); }
});
$('#user-add').addEventListener('click', () => openUser(null));
function openUser(u) {
  const editing = Boolean(u);
  const username = editing ? u.username : prompt('New username:');
  if (username === null) return;
  const password = prompt(editing ? `New password for ${username} (blank = keep):` : 'Password (min 8 chars):');
  if (password === null) return;
  const role = prompt('Role: owner / admin / viewer', editing ? u.role : 'admin');
  if (role === null) return;
  (async () => {
    try {
      if (editing) await api('/users/' + u.id, { method: 'PUT', body: { password: password || undefined, role } });
      else await api('/users', { method: 'POST', body: { username, password, role } });
      toast('Account saved'); loadSecurity();
    } catch (e) { toast(e.message, false); }
  })();
}

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
      || '<tr><td colspan="4" class="hint">No errors</td></tr>';
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
        ${k.source === 'panel' ? `<button class="btn btn-sm btn-danger" data-del-key="${esc(k.name)}"><svg class="ic ic-sm"><use href="#i-x"/></svg></button>` : ''}
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
  chat: loadChat,
  prompt: loadPrompt,
  gateway: loadGateway,
  memory: loadMemory,
  contacts: loadContacts,
  tools: loadTools,
  library: loadLibrary,
  logs: loadLogs,
  assistants: loadAssistants,
  system: loadSystem,
  security: loadSecurity,
  settings: loadSettings,
};
loadDashboard().catch(err => toast(err.message, false));
