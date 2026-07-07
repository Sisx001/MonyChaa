'use strict';
// Unit tests for core logic that runs without network or a bot token.
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'secretary-test-' + process.pid);

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../src/db/schema');
const config = require('../src/config');

test('schema creates all tables', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['settings', 'contacts', 'facts', 'conversations', 'messages_log',
    'token_usage', 'provider_health', 'prompt_versions', 'memories', 'scheduled_messages',
    'error_log', 'events_log']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('contacts has voice_replies migration column', () => {
  const cols = db.prepare('PRAGMA table_info(contacts)').all().map(c => c.name);
  assert.ok(cols.includes('voice_replies'));
});

test('settings roundtrip and defaults', () => {
  assert.strictEqual(config.getSetting('typing_speed'), 'medium');
  config.setSetting('typing_speed', 'fast');
  assert.strictEqual(config.getSetting('typing_speed'), 'fast');
  config.setSetting('typing_speed', 'medium');
});

test('api keys: db overrides env, never leaks via allSettings', () => {
  config.setKey('GROQ_API_KEY', 'gsk_test123456789');
  assert.strictEqual(config.key('GROQ_API_KEY'), 'gsk_test123456789');
  const all = config.allSettings();
  assert.ok(!Object.keys(all).some(k => k.startsWith('apikey_')), 'apikey_ leaked in settings');
  config.setKey('GROQ_API_KEY', '');
  assert.strictEqual(config.key('GROQ_API_KEY'), config.env.GROQ_API_KEY || '');
});

test('delayPlan stays within sane bounds', () => {
  const { delayPlan } = require('../src/bot/human');
  for (const momentum of [0, 0.5, 1]) {
    const plan = delayPlan('hello there friend', 'a'.repeat(500), { delayMultiplier: 1, momentum, priority: 0 });
    assert.ok(plan.thinkMs >= 0 && plan.thinkMs <= 20000, `thinkMs out of range: ${plan.thinkMs}`);
    assert.ok(plan.typeMs >= 0 && plan.typeMs <= 25000, `typeMs out of range: ${plan.typeMs}`);
  }
  config.setSetting('typing_simulation', 'off');
  assert.deepStrictEqual(delayPlan('a', 'b'), { thinkMs: 0, typeMs: 0, totalMs: 0 });
  config.setSetting('typing_simulation', 'on');
});

test('splitBursts keeps short messages whole, splits long ones', () => {
  const { splitBursts } = require('../src/bot/human');
  assert.deepStrictEqual(splitBursts('short message'), ['short message']);
  const long = 'A'.repeat(150) + '\n\n' + 'B'.repeat(150) + '\n\n' + 'C'.repeat(150);
  const bursts = splitBursts(long);
  assert.ok(bursts.length > 1 && bursts.length <= 3, `unexpected burst count ${bursts.length}`);
  assert.strictEqual(bursts.join('\n\n').replace(/\n\n/g, ''), 'A'.repeat(150) + 'B'.repeat(150) + 'C'.repeat(150));
});

test('provider registry integrity', () => {
  const { PROVIDERS, modelCost, isConfigured } = require('../src/llm/providers');
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.label && p.kind && p.baseUrl, `provider ${id} incomplete`);
    assert.ok(Object.keys(p.models).length > 0, `provider ${id} has no models`);
    for (const m of Object.keys(p.models)) {
      const cost = modelCost(id, m);
      assert.ok(Array.isArray(cost) && cost.length === 2, `bad cost for ${id}/${m}`);
    }
    assert.doesNotThrow(() => isConfigured(id));
  }
});

test('tool registry: enabled() never throws, llm-gated tools excluded from auto use', () => {
  const { TOOLS, enabledTools } = require('../src/tools');
  for (const [name, t] of Object.entries(TOOLS)) {
    assert.ok(t.description && t.args, `tool ${name} incomplete`);
    assert.doesNotThrow(() => t.enabled(), `tool ${name}.enabled() threw`);
  }
  const names = enabledTools().map(t => t.name);
  assert.ok(!names.includes('gmail_send'), 'gmail_send must never be LLM-invocable');
});

test('facts store roundtrip and prompt formatting', () => {
  const facts = require('../src/memory/facts');
  facts.upsert('test_fact', 'the answer is 42', 'critical');
  const rows = facts.list('test_fact');
  assert.strictEqual(rows[0].value, 'the answer is 42');
  assert.ok(facts.forPrompt().includes('test_fact'));
  facts.remove(rows[0].id);
  assert.strictEqual(facts.list('test_fact').length, 0);
});

test('buildSystemPrompt resolves contact profile and template vars', () => {
  const { buildSystemPrompt } = require('../src/bot/reply');
  db.prepare(`INSERT OR REPLACE INTO contacts (chat_id, name, tone, rules, blocked_topics)
    VALUES (999, 'Unit Test', 'formal', '["always rhyme"]', '["politics"]')`).run();
  const contact = db.prepare('SELECT * FROM contacts WHERE chat_id = 999').get();
  const p = buildSystemPrompt(contact, 'ctx-block');
  assert.ok(p.includes('Unit Test'));
  assert.ok(p.includes('always rhyme'));
  assert.ok(p.includes('politics'));
  assert.ok(p.includes('ctx-block'));
  assert.ok(!p.includes('{name}'), 'unresolved template variable');
  db.prepare('DELETE FROM contacts WHERE chat_id = 999').run();
});

test('auth: enabled() reflects presence of admin accounts', () => {
  const auth = require('../src/web/auth');
  const db = require('../src/db/schema');
  const before = db.prepare('SELECT COUNT(*) c FROM admin_users').get().c;
  if (before === 0) assert.strictEqual(auth.enabled(), false);
  // Create an account → auth becomes enforced; then clean up.
  db.prepare('INSERT INTO admin_users (username, pass_hash, role) VALUES (?, ?, ?)')
    .run('t_authcheck', auth.hashPassword('password123'), 'admin');
  assert.strictEqual(auth.enabled(), true);
  db.prepare("DELETE FROM admin_users WHERE username = 't_authcheck'").run();
});

test('maybeSummarize never runs with a negative excess (SQLite LIMIT trap)', async () => {
  const conv = require('../src/memory/conversations');
  config.setSetting('auto_summarize_threshold', '5');
  config.setSetting('history_limit', '100'); // keep > count → excess negative
  for (let i = 0; i < 8; i++) conv.addMessage(777, 'user', 'msg ' + i);
  await conv.maybeSummarize(777); // would previously delete everything via LIMIT -92
  assert.strictEqual(conv.countMessages(777), 8, 'messages were wrongly summarized/deleted');
  conv.clearHistory(777);
  config.setSetting('auto_summarize_threshold', '120');
  config.setSetting('history_limit', '30');
});

test('skills: trigger matching, always-on, toggle, catalog install', () => {
  const skills = require('../src/skills');
  skills.upsert({ name: 'T-Test Skill', description: 'x', triggers: ['pineapple'], content: 'Do pineapple things.' });
  skills.upsert({ name: 'T-Always Skill', description: 'x', triggers: [], content: 'Always be kind.' });

  const matched = skills.activeFor('I love PINEAPPLE pizza');
  assert.ok(matched.includes('T-Test Skill'), 'trigger skill not matched');
  assert.ok(matched.includes('T-Always Skill'), 'always-on skill missing');

  const unmatched = skills.activeFor('nothing relevant here');
  assert.ok(!unmatched.includes('T-Test Skill'), 'trigger skill matched wrongly');
  assert.ok(unmatched.includes('T-Always Skill'), 'always-on skill missing on unrelated msg');

  const row = skills.list().find(s => s.name === 'T-Test Skill');
  skills.setEnabled(row.id, 0);
  assert.ok(!skills.activeFor('pineapple').includes('T-Test Skill'), 'disabled skill still active');

  skills.installFromCatalog('Boundary Keeper');
  assert.ok(skills.list().some(s => s.name === 'Boundary Keeper' && s.source === 'catalog'));

  for (const s of skills.list().filter(s => s.name.startsWith('T-') || s.name === 'Boundary Keeper')) skills.remove(s.id);
});

test('skills respect the global skills_enabled switch', () => {
  const skills = require('../src/skills');
  skills.upsert({ name: 'T-Switch', triggers: [], content: 'x' });
  config.setSetting('skills_enabled', 'off');
  assert.strictEqual(skills.activeFor('anything'), '');
  config.setSetting('skills_enabled', 'on');
  assert.ok(skills.activeFor('anything').includes('T-Switch'));
  skills.remove(skills.list().find(s => s.name === 'T-Switch').id);
});

test('mcp: tool registry empty by default, qualified name validation', async () => {
  const mcp = require('../src/mcp');
  assert.deepStrictEqual(mcp.allTools(), []);
  await assert.rejects(() => mcp.callQualified('not-mcp-format', {}), /bad MCP tool name/);
  await assert.rejects(() => mcp.callQualified('mcp:ghost:tool', {}), /not found or disabled/);
});

test('auth: scrypt hashing verifies correctly and rejects wrong passwords', () => {
  const auth = require('../src/web/auth');
  const hash = auth.hashPassword('correct horse battery staple');
  assert.ok(hash.includes(':'));
  assert.ok(auth.verifyPassword('correct horse battery staple', hash));
  assert.ok(!auth.verifyPassword('wrong password', hash));
  assert.ok(!auth.verifyPassword('correct horse battery staple', 'malformed'));
});

test('system: metrics and diagnostics are well-formed', () => {
  const sys = require('../src/system');
  const m = sys.metrics();
  assert.strictEqual(m.status, 'online');
  assert.ok(m.cpu.cores > 0);
  assert.ok(m.memory.systemUsedPct >= 0 && m.memory.systemUsedPct <= 100);
  const diag = sys.diagnostics();
  assert.ok(Array.isArray(diag) && diag.length > 0);
  for (const d of diag) assert.ok(['ok', 'warn'].includes(d.status));
});

test('system: autofix actions run and reject unknown ones', () => {
  const sys = require('../src/system');
  assert.match(sys.autofix('clear_sessions'), /session/i);
  assert.match(sys.autofix('reset_health'), /health/i);
  assert.throws(() => sys.autofix('nonexistent'), /Unknown fix/);
});

test('characters: apply sets prompt and generation defaults', () => {
  const characters = require('../src/characters');
  assert.ok(characters.CHARACTERS.length >= 10);
  characters.apply('minimal');
  assert.strictEqual(config.getSetting('active_character'), 'minimal');
  assert.strictEqual(config.getSetting('emoji_usage'), 'none');
  assert.ok(config.getSetting('system_prompt').length > 20);
  assert.throws(() => characters.apply('ghost'), /Unknown character/);
});

test('conversation history add/get/clear', () => {
  const conv = require('../src/memory/conversations');
  conv.addMessage(888, 'user', 'hi');
  conv.addMessage(888, 'assistant', 'hello!');
  const h = conv.getHistory(888);
  assert.strictEqual(h.length, 2);
  assert.strictEqual(h[0].role, 'user');
  conv.clearHistory(888);
  assert.strictEqual(conv.getHistory(888).length, 0);
});

test('multi-tenancy: conversations are isolated by assistant_id', () => {
  const conv = require('../src/memory/conversations');
  conv.addMessage(500, 'user', 'primary brain', 0, 0);
  conv.addMessage(500, 'user', 'assistant-7 brain', 0, 7);
  const primary = conv.getHistory(500, 50, 0);
  const seven = conv.getHistory(500, 50, 7);
  assert.strictEqual(primary.length, 1);
  assert.strictEqual(seven.length, 1);
  assert.strictEqual(primary[0].content, 'primary brain');
  assert.strictEqual(seven[0].content, 'assistant-7 brain');
  conv.clearHistory(500, 0); conv.clearHistory(500, 7);
  assert.strictEqual(conv.getHistory(500, 50, 7).length, 0);
});

test('assistants: create/list/update/remove lifecycle', async () => {
  const assistants = require('../src/assistants');
  const id = assistants.create({ name: 'Test Asst', system_prompt: 'You are test.' });
  assert.ok(id > 0);
  assert.ok(assistants.list().some(a => a.id === id && a.name === 'Test Asst'));
  assistants.update(id, { name: 'Renamed' });
  assert.ok(assistants.list().some(a => a.id === id && a.name === 'Renamed'));
  await assistants.remove(id);
  assert.ok(!assistants.list().some(a => a.id === id));
});

test('telegram settings: SETTABLE validators accept/reject correctly', () => {
  const { SETTABLE } = require('../src/bot/telegramSettings');
  assert.strictEqual(SETTABLE.temperature('1.5'), '1.5');
  assert.strictEqual(SETTABLE.temperature('9'), null);
  assert.strictEqual(SETTABLE.emoji_usage('heavy'), 'heavy');
  assert.strictEqual(SETTABLE.emoji_usage('bogus'), null);
  assert.strictEqual(SETTABLE.bot_enabled('ON'), 'on');
  assert.strictEqual(SETTABLE.reply_probability('50'), '50');
  assert.strictEqual(SETTABLE.reply_probability('200'), null);
});

test('model catalog: static fallback returns known models', async () => {
  const { listModels } = require('../src/llm/models');
  const models = await listModels('cohere'); // no key → static list
  assert.ok(Array.isArray(models) && models.length > 0);
  assert.ok(models.every(m => m.id));
});
