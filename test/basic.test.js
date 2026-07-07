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

test('auth: token roundtrip and password check', () => {
  const auth = require('../src/web/auth');
  const token = auth.makeToken();
  assert.ok(auth.verifyToken(token), 'valid token rejected');
  assert.ok(!auth.verifyToken(token.slice(0, -2) + 'ff'), 'tampered token accepted');
  assert.ok(!auth.verifyToken(''), 'empty token accepted');
  assert.ok(!auth.verifyToken('admin.99999999999999.deadbeef'), 'forged token accepted');
  // No ADMIN_PASSWORD in the test env → auth disabled.
  assert.strictEqual(auth.enabled(), false);
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
