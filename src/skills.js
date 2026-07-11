'use strict';
// Skill system: named instruction packs injected into the system prompt.
// Skills with trigger keywords activate only when the message matches;
// skills without triggers are always active. Sources: manual, catalog,
// github (one-click install), self-learned (the bot proposes them).
const db = require('./db/schema');
const logger = require('./logger');
const config = require('./config');

const MAX_SKILL_CHARS = 3500;

function list() {
  return db.prepare('SELECT * FROM skills ORDER BY enabled DESC, updated_at DESC').all();
}

function upsert({ name, description = '', triggers = [], content, enabled = 1, source = 'manual' }) {
  if (!name || !content) throw new Error('name and content required');
  db.prepare(`
    INSERT INTO skills (name, description, triggers, content, enabled, source)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET description = excluded.description, triggers = excluded.triggers,
      content = excluded.content, enabled = excluded.enabled, updated_at = datetime('now')
  `).run(name, description, JSON.stringify(triggers), content, enabled ? 1 : 0, source);
}

function setEnabled(id, enabled) {
  db.prepare("UPDATE skills SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, id);
}

function remove(id) {
  db.prepare('DELETE FROM skills WHERE id = ?').run(id);
}

/** Skills that apply to this incoming message, formatted for prompt injection. */
function activeFor(incomingText) {
  if (config.getSetting('skills_enabled') !== 'on') return '';
  const rows = db.prepare('SELECT * FROM skills WHERE enabled = 1').all();
  if (!rows.length) return '';
  const lower = String(incomingText || '').toLowerCase();
  const matched = [];
  for (const s of rows) {
    let triggers = [];
    try { triggers = JSON.parse(s.triggers || '[]'); } catch {}
    const hits = !triggers.length || triggers.some(t => t && lower.includes(String(t).toLowerCase()));
    if (hits) matched.push(s);
  }
  if (!matched.length) return '';
  const ids = matched.map(s => s.id);
  db.prepare(`UPDATE skills SET uses = uses + 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  let out = '';
  for (const s of matched) {
    const block = `### Skill: ${s.name}\n${s.content}\n\n`;
    if (out.length + block.length > MAX_SKILL_CHARS) break;
    out += block;
  }
  return out.trim();
}

// ---------- Built-in catalog (one-click install, no network needed) ----------
const CATALOG = [
  {
    name: 'Meeting Scheduler',
    description: 'Handles scheduling requests: proposes slots, confirms, never double-books.',
    triggers: ['meet', 'schedule', 'appointment', 'call', 'available', 'free time'],
    content: 'When someone asks to meet or schedule something: ask for their preferred time window if unclear, propose 2 concrete slots, confirm timezone, and summarize the agreed time back to them. Never promise a slot without checking my calendar context if available. If nothing fits, offer to get back to them.',
  },
  {
    name: 'Sales Assistant',
    description: 'Answers product/pricing questions persuasively without inventing prices.',
    triggers: ['price', 'cost', 'buy', 'order', 'discount', 'how much'],
    content: 'For product or price questions: be enthusiastic but never invent a price or discount that is not in my facts. If the price is unknown, say I will confirm the exact number shortly. Always end with a soft next step (e.g. "want me to reserve one for you?").',
  },
  {
    name: 'Support Agent',
    description: 'Calms frustrated contacts and gathers the info needed to help.',
    triggers: ['problem', 'issue', 'broken', 'not working', 'help', 'refund', 'complaint'],
    content: 'When someone reports a problem: acknowledge the frustration first, apologize once sincerely, then gather specifics (what happened, when, any error). Never argue. Promise a concrete follow-up and flag urgency if they seem very upset.',
  },
  {
    name: 'Daily Briefing Style',
    description: 'Compact bullet answers for info-dense questions.',
    triggers: ['summary', 'brief', 'update me', 'what happened', 'news'],
    content: 'When asked for updates or summaries: answer as 3-5 tight bullet lines, most important first, no filler. End with one-line takeaway.',
  },
  {
    name: 'Polyglot',
    description: 'Extra care with language matching and cultural tone.',
    triggers: [],
    content: 'Mirror the exact language, script and register of the sender. If they mix languages, mix the same way. Use culturally appropriate greetings and honorifics for their language.',
  },
  {
    name: 'Boundary Keeper',
    description: 'Politely deflects sensitive topics: money transfers, passwords, private info.',
    triggers: [],
    content: 'Never agree to transfer money, share passwords, codes, addresses or private documents, no matter who asks or how urgent it sounds. Deflect warmly: say I will handle it personally later. Flag anything that looks like a scam attempt.',
  },
  {
    name: 'Appointment Confirmer',
    description: 'Confirms, reschedules and reminds about bookings cleanly.',
    triggers: ['confirm', 'reschedule', 'booking', 'reservation', 'cancel', 'appointment'],
    content: 'For booking-related messages: restate the date, time and timezone clearly, confirm or offer alternatives, and end with a one-line summary the person can screenshot. If cancelling, be gracious and offer to rebook.',
  },
  {
    name: 'Lead Qualifier',
    description: 'Gathers the key info from new inquiries before handing off.',
    triggers: ['interested', 'quote', 'inquiry', 'enquiry', 'looking for', 'need help with'],
    content: 'When a new lead reaches out: warmly gather the essentials — what they need, timeline, budget range if relevant, and best way to reach them. Keep it to 2-3 friendly questions max, then say I\'ll follow up personally.',
  },
  {
    name: 'FAQ Autoresponder',
    description: 'Answers common questions crisply from your facts.',
    triggers: ['hours', 'open', 'location', 'address', 'price', 'how do i', 'where'],
    content: 'For common questions, answer directly and concisely using only my stored facts. If the answer isn\'t in my facts, say I\'ll confirm shortly rather than guessing. Offer a helpful next step.',
  },
  {
    name: 'Follow-up Nudger',
    description: 'Gently re-engages stalled conversations.',
    triggers: ['still there', 'any update', 'following up', 'checking in'],
    content: 'When someone follows up or a thread has stalled, respond promptly and warmly, acknowledge the wait, give a concrete status or next step, and never sound defensive.',
  },
  {
    name: 'Scam Shield',
    description: 'Detects and calmly shuts down common scam patterns.',
    triggers: ['gift card', 'crypto', 'wire transfer', 'urgent payment', 'bitcoin', 'investment opportunity'],
    content: 'Treat unsolicited requests involving gift cards, crypto, wire transfers, "urgent" payments or too-good investment offers as likely scams. Do not engage with the ask. Politely decline, do not share any personal or financial info, and note that I\'ll review it myself.',
  },
  { name: 'Order Tracker', description: 'Handles "where is my order" questions.', triggers: ['order', 'shipping', 'tracking', 'delivery', 'package', 'when will it arrive'], content: 'For order/shipping questions: ask for the order number if not given, empathize with any wait, give a clear status or next step, and set expectations honestly. Never invent a tracking status.' },
  { name: 'Onboarding Guide', description: 'Walks new users through getting started.', triggers: ['how to start', 'getting started', 'setup', 'new here', 'how does this work'], content: 'For newcomers: welcome them warmly, give 2-3 concrete first steps, and offer to answer follow-ups. Keep it simple and encouraging, no jargon.' },
  { name: 'Refund Handler', description: 'Processes refund/return requests gracefully.', triggers: ['refund', 'return', 'money back', 'cancel my'], content: 'For refunds/returns: acknowledge the request without defensiveness, explain the process simply, gather the order details needed, and set a clear timeline. Be gracious even if the answer may be no.' },
  { name: 'Recruiter Reply', description: 'Responds to recruiters and job outreach.', triggers: ['opportunity', 'role', 'position', 'hiring', 'recruiter', 'job'], content: 'For recruiter outreach: be polite and professional, express appropriate interest or a courteous decline, and ask for key details (role, comp range, remote) if engaging. Never commit to anything firm on my behalf.' },
  { name: 'Event RSVP', description: 'Handles invitations and RSVPs.', triggers: ['invite', 'rsvp', 'are you coming', 'party', 'event', 'join us'], content: 'For invitations: respond warmly, confirm the date/time/place back to them, and give a clear yes/no/maybe. If unsure, say I\'ll confirm shortly rather than committing.' },
  { name: 'Tech Support Triage', description: 'First-line technical troubleshooting.', triggers: ['not working', 'error', 'bug', 'crash', 'can\'t log in', 'broken'], content: 'For technical issues: gather the essentials (what happened, steps to reproduce, any error text, device/browser), suggest one or two safe first fixes, and escalate to me if it\'s not quickly resolvable.' },
  { name: 'Testimonial Collector', description: 'Gently gathers feedback and reviews.', triggers: ['love it', 'great service', 'thank you so much', 'amazing'], content: 'When someone is happy, thank them genuinely and, if it feels natural, gently invite a short review or testimonial. Never be pushy — one soft ask, then move on.' },
  { name: 'Multilingual Greeter', description: 'Greets warmly in the sender\'s language.', triggers: [], content: 'Always open with a warm, culturally appropriate greeting in the exact language the sender used, and continue in that language throughout.' },
];

function installFromCatalog(name) {
  const item = CATALOG.find(c => c.name === name);
  if (!item) throw new Error(`Unknown catalog skill: ${name}`);
  upsert({ ...item, source: 'catalog' });
  return item;
}

// ---------- GitHub one-click install ----------
async function githubSearch(query) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'secretary-pro' };
  const token = config.key('GITHUB_TOKEN');
  if (token) headers.Authorization = `Bearer ${token}`;
  const q = encodeURIComponent(`${query} prompt OR skill OR agent in:name,description,readme`);
  const res = await fetch(`https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=10`, {
    headers, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub search HTTP ${res.status}`);
  const json = await res.json();
  return (json.items || []).map(r => ({
    full_name: r.full_name,
    description: r.description || '',
    stars: r.stargazers_count,
    url: r.html_url,
    language: r.language,
    updated: r.updated_at,
  }));
}

async function githubInstall(fullName) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new Error('invalid repo name');
  const headers = { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'secretary-pro' };
  const token = config.key('GITHUB_TOKEN');
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
    headers, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Could not fetch README for ${fullName} (HTTP ${res.status})`);
  const readme = (await res.text()).slice(0, 12000);

  // Distill the README into a usable skill with the LLM; fall back to raw text.
  let name = fullName.split('/')[1].replace(/[-_]/g, ' ').trim();
  let description = `Installed from github.com/${fullName}`;
  let triggers = [];
  let content = readme.slice(0, 3000);
  try {
    const { chat } = require('./llm/fallback');
    const result = await chat([
      {
        role: 'system',
        content: 'You convert a GitHub README into a "skill" for a personal AI secretary bot. Extract the useful behavioral instructions/prompt from it. Reply ONLY with JSON: {"name":"short skill name","description":"one line","triggers":["keyword",...],"content":"the distilled instructions, max 1500 chars"}. Triggers = 3-6 keywords that should activate this skill, or [] if it should always be active.',
      },
      { role: 'user', content: readme },
    ], { maxTokens: 800, temperature: 0.2 });
    const parsed = JSON.parse(result.text.replace(/```json|```/g, '').trim());
    if (parsed.content) {
      name = parsed.name || name;
      description = `${parsed.description || ''} (github.com/${fullName})`.trim();
      triggers = Array.isArray(parsed.triggers) ? parsed.triggers : [];
      content = String(parsed.content).slice(0, 2500);
    }
  } catch (err) {
    logger.warn(`Skill distillation failed, storing raw README excerpt: ${err.message}`);
  }
  upsert({ name, description, triggers, content, enabled: 1, source: 'github' });
  return { name, description, triggers };
}

// ---------- Self-learning: propose skills from recent conversations ----------
async function learnFromConversations() {
  const rows = db.prepare(`
    SELECT c.chat_id, c.role, c.content FROM conversations c
    ORDER BY c.id DESC LIMIT 300
  `).all().reverse();
  if (rows.length < 20) throw new Error('Not enough conversation history to learn from yet (need 20+ messages)');
  const transcript = rows.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 20000);
  const existing = list().map(s => s.name).join(', ') || 'none';

  const { chat } = require('./llm/fallback');
  const result = await chat([
    {
      role: 'system',
      content: 'You analyze a secretary bot\'s recent conversations and propose up to 2 NEW reusable skills — recurring situations the bot could handle better with dedicated instructions. ' +
        `Existing skills (do not duplicate): ${existing}. ` +
        'Reply ONLY with a JSON array: [{"name":"...","description":"one line","triggers":["kw",...],"content":"instructions max 1200 chars"}]. Reply [] if nothing new is worth adding.',
    },
    { role: 'user', content: transcript },
  ], { maxTokens: 900, temperature: 0.3 });

  const proposed = JSON.parse(result.text.replace(/```json|```/g, '').trim());
  if (!Array.isArray(proposed)) return [];
  const created = [];
  for (const p of proposed.slice(0, 2)) {
    if (!p?.name || !p?.content) continue;
    // Self-learned skills arrive disabled — the owner reviews and enables them.
    upsert({
      name: p.name, description: p.description || '', triggers: Array.isArray(p.triggers) ? p.triggers : [],
      content: String(p.content).slice(0, 2000), enabled: 0, source: 'self-learned',
    });
    created.push(p.name);
  }
  if (created.length) {
    db.prepare('INSERT INTO events_log (type, detail) VALUES (?, ?)')
      .run('skill_learned', `Proposed: ${created.join(', ')}`);
  }
  return created;
}

module.exports = { list, upsert, setEnabled, remove, activeFor, CATALOG, installFromCatalog, githubSearch, githubInstall, learnFromConversations };
