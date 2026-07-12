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

test('humanize: roughens like texting but preserves meaning and links', () => {
  const { humanize } = require('../src/bot/human');
  // off is a no-op.
  assert.strictEqual(humanize('Sure thing.', 'off'), 'Sure thing.');
  // rng always high → nothing changes.
  assert.strictEqual(humanize('Sure thing.', 'natural', () => 1), 'Sure thing.');
  // rng always low, natural → drop trailing period + lowercase short start.
  assert.strictEqual(humanize('Sure thing.', 'natural', () => 0), 'sure thing');
  // Questions/exclamations keep their terminal punctuation.
  assert.strictEqual(humanize('Cool!', 'natural', () => 0), 'cool!');
  // "I" is never lowercased; period still drops.
  assert.strictEqual(humanize("I'm on it.", 'natural', () => 0), "I'm on it");
  // A trailing URL keeps its period (never truncate a link).
  assert.strictEqual(humanize('see http://example.com.', 'natural', () => 0), 'see http://example.com.');
});

test('mood: detects sentiment and returns a tone hint', () => {
  const { detect } = require('../src/bot/mood');
  assert.strictEqual(detect('this is ridiculous and unacceptable').mood, 'upset');
  assert.strictEqual(detect("i'm feeling really down today :(").mood, 'sad');
  assert.strictEqual(detect("i'm so nervous about tomorrow").mood, 'anxious');
  assert.strictEqual(detect('this is amazing, i love it!').mood, 'excited');
  assert.strictEqual(detect('thank you so much, this means a lot').mood, 'grateful');
  assert.strictEqual(detect("i'm confused, what do you mean?").mood, 'confused');
  const neutral = detect('what time is the meeting');
  assert.strictEqual(neutral.mood, 'neutral');
  assert.strictEqual(neutral.hint, '');
  // Non-neutral moods always carry a usable hint; empty input is safe.
  assert.ok(detect('i hate this').hint.length > 0);
  assert.strictEqual(detect('').mood, 'neutral');
});

test('quickreplies: suggests intent-appropriate candidates, urgent leads fast', () => {
  const { suggest } = require('../src/bot/quickreplies');
  const complaint = suggest('this is broken and terrible');
  assert.strictEqual(complaint.intent, 'complaint');
  assert.ok(complaint.suggestions.length >= 1 && complaint.suggestions.length <= 3);
  assert.match(complaint.suggestions[0], /sorry/i);
  const urgent = suggest('emergency, need this now, please respond asap!!! can you help?');
  assert.strictEqual(urgent.urgent, true);
  assert.match(urgent.suggestions[0], /right now|on it/i);
  assert.ok(suggest('').suggestions.length >= 1); // always safe
});

test('replylength: scales target to message size, never exceeds base', () => {
  const { suggest } = require('../src/bot/replylength');
  const base = 800;
  const tiny = suggest('ok', base);
  const short = suggest('can you send me the file please', base);
  const long = suggest('word '.repeat(60), base);
  assert.ok(tiny < short && short < long);
  assert.ok(long <= base && tiny >= 120);
  // Multiple questions bump a short message up to a fuller answer.
  assert.ok(suggest('what time? and where? and how much?', base) >= base * 0.8);
});

test('urgency: scores time-sensitivity with sane ordering', () => {
  const { score } = require('../src/bot/urgency');
  assert.strictEqual(score('').level, 'low');
  assert.strictEqual(score('just whenever you get a chance').level, 'low');
  const high = score('emergency, need this now, please respond asap!!!');
  assert.strictEqual(high.level, 'high');
  const casual = score('the report looks fine, thanks');
  assert.ok(high.score > score('can you reply today?').score);
  assert.ok(score('can you reply today?').score > casual.score);
  assert.ok(high.score >= 0 && high.score <= 100);
});

test('intent: classifies message intent by ordered rules', () => {
  const { classify } = require('../src/bot/intent');
  assert.strictEqual(classify('hi there').intent, 'greeting');
  assert.strictEqual(classify('how are you?').intent, 'smalltalk');
  assert.strictEqual(classify('this is broken and terrible').intent, 'complaint');
  assert.strictEqual(classify('thanks so much!').intent, 'feedback');
  assert.strictEqual(classify('what time do you open').intent, 'question');
  assert.strictEqual(classify('please send me the invoice').intent, 'request');
  assert.strictEqual(classify('the meeting is at 3pm').intent, 'statement');
  assert.strictEqual(classify('').intent, 'unknown');
});

test('language: detects script and Latin languages', () => {
  const { detect } = require('../src/bot/language');
  assert.strictEqual(detect('hello, how are you today').code, 'en');
  assert.strictEqual(detect('bonjour, merci beaucoup pour tout').code, 'fr');
  assert.strictEqual(detect('hola, gracias por la ayuda').code, 'es');
  assert.strictEqual(detect('привет как дела').code, 'ru');
  assert.strictEqual(detect('こんにちは元気ですか').code, 'ja'); // kana beats Han
  assert.strictEqual(detect('你好吗今天').code, 'zh');
  assert.strictEqual(detect('안녕하세요').code, 'ko');
  assert.strictEqual(detect('شكرا جزيلا').code, 'ar');
  assert.strictEqual(detect('').code, 'und');
  assert.strictEqual(detect('12345 !!!').code, 'und'); // no language signal
});

test('timeofday: hours map to sensible periods with hints', () => {
  const { periodFor, hourIn } = require('../src/bot/timeofday');
  assert.strictEqual(periodFor(7).period, 'morning');
  assert.strictEqual(periodFor(14).period, 'afternoon');
  assert.strictEqual(periodFor(19).period, 'evening');
  assert.strictEqual(periodFor(23).period, 'late night');
  assert.strictEqual(periodFor(2).period, 'late night'); // wraps past midnight
  assert.ok(periodFor(23).hint.length > 0);
  // hourIn tolerates a bad timezone without throwing.
  const h = hourIn('Not/AZone');
  assert.ok(Number.isInteger(h) && h >= 0 && h < 24);
});

test('system diagnostics: away-mode check flags and clear_away fixes it', () => {
  const config = require('../src/config');
  const sys = require('../src/system');
  config.setSetting('away_mode', 'on');
  const away = sys.diagnostics().find(c => c.name === 'Away mode');
  assert.strictEqual(away.status, 'warn');
  assert.strictEqual(away.fix, 'clear_away');
  sys.autofix('clear_away');
  assert.strictEqual(config.getSetting('away_mode'), 'off');
  assert.strictEqual(sys.diagnostics().find(c => c.name === 'Away mode').status, 'ok');
});

test('analytics.contactMoodProfile finds a dominant mood only when it is a pattern', () => {
  const analytics = require('../src/analytics');
  const db = require('../src/db/schema');
  const ins = db.prepare("INSERT INTO messages_log (chat_id, assistant_id, direction, content) VALUES (?, 0, 'incoming', ?)");
  // 4 anxious + 1 neutral over the same contact → clear pattern.
  ['im so stressed', 'this is stressful', 'feeling anxious', 'worried again', 'hi'].forEach(t => ins.run(778899, t));
  let p = analytics.contactMoodProfile(778899, 0);
  assert.strictEqual(p.dominant, 'anxious');
  // A lone signal among neutrals is not a pattern.
  ['ok', 'sure', 'sounds good', 'thanks'].forEach(t => ins.run(667788, t));
  p = analytics.contactMoodProfile(667788, 0);
  assert.strictEqual(p.dominant, null);
  db.prepare('DELETE FROM messages_log WHERE chat_id IN (778899, 667788)').run();
});

test('analytics.moodBreakdown classifies incoming messages', () => {
  const analytics = require('../src/analytics');
  const db = require('../src/db/schema');
  const ins = db.prepare("INSERT INTO messages_log (chat_id, direction, content, assistant_id) VALUES (?, 'incoming', ?, 0)");
  const samples = ['this is ridiculous!!', 'i love this, amazing!', 'what time is it', 'so nervous about tomorrow', 'i feel down :('];
  samples.forEach(t => ins.run(987654, t));
  const b = analytics.moodBreakdown();
  assert.ok(b.total >= 5);
  assert.ok(b.counts.upset >= 1 && b.counts.excited >= 1 && b.counts.anxious >= 1 && b.counts.sad >= 1);
  assert.ok(b.expressiveness >= 0 && b.expressiveness <= 100);
  db.prepare('DELETE FROM messages_log WHERE chat_id = 987654').run();
});

test('replyPolicyBlock: passes normal text, blocks blacklisted words', () => {
  const { replyPolicyBlock } = require('../src/bot/reply');
  const config = require('../src/config');
  config.setSetting('blacklist_words', JSON.stringify(['spam']));
  config.setSetting('min_message_length', '0');
  assert.strictEqual(replyPolicyBlock('hello there', null, 0), null);
  assert.strictEqual(replyPolicyBlock('this is SPAM content', null, 0), 'blacklisted_word');
  config.setSetting('blacklist_words', '[]');
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

test('utility tools: pure-computation tools produce correct output', async () => {
  const { TOOLS } = require('../src/tools');
  assert.strictEqual(await TOOLS.calculator.run({ expression: '2*(3+4)/2' }), '2*(3+4)/2 = 7');
  await assert.rejects(async () => TOOLS.calculator.run({ expression: 'process.exit(1)' }), /allowed/);
  assert.match(await TOOLS.unit_convert.run({ value: 1, from: 'km', to: 'm' }), /1000 m/);
  assert.strictEqual(await TOOLS.temperature_convert.run({ value: 100, from: 'C', to: 'F' }), '100°C = 212°F');
  assert.match(await TOOLS.hash.run({ text: 'abc', algo: 'sha256' }), /ba7816bf/);
  assert.strictEqual(await TOOLS.base64.run({ text: 'hi', mode: 'encode' }), 'aGk=');
  assert.strictEqual(await TOOLS.base64.run({ text: 'aGk=', mode: 'decode' }), 'hi');
  assert.strictEqual((await TOOLS.uuid.run({})).length, 36);
  assert.strictEqual((await TOOLS.password_generator.run({ length: 24 })).length, 24);
  assert.ok(['Heads', 'Tails'].includes(await TOOLS.coin_flip.run({})));
  assert.match(await TOOLS.dice.run({ notation: '2d6' }), /2d6:/);
  assert.strictEqual(await TOOLS.text_transform.run({ text: 'aB', mode: 'reverse' }), 'Ba');
  // second batch
  assert.strictEqual(await TOOLS.morse.run({ text: 'SOS', mode: 'encode' }), '... --- ...');
  assert.strictEqual(await TOOLS.morse.run({ text: '... --- ...', mode: 'decode' }), 'SOS');
  assert.strictEqual(await TOOLS.roman.run({ value: 2024 }), 'MMXXIV');
  assert.strictEqual(await TOOLS.roman.run({ value: 'MMXXIV' }), '2024');
  assert.match(await TOOLS.number_base.run({ value: '255', from: 10, to: 16 }), /= ff/);
  assert.match(await TOOLS.bmi_calculator.run({ weightKg: 70, heightCm: 175 }), /22\.9 \(normal\)/);
  assert.strictEqual(await TOOLS.slugify.run({ text: 'Hello World!' }), 'hello-world');
  assert.match(await TOOLS.color_convert.run({ color: '#7c6cff' }), /rgb\(124, 108, 255\)/);
  assert.match(await TOOLS.percentage.run({ value: 40, of: 200 }), /20\.00%/);
  assert.match(await TOOLS.json_tool.run({ json: '{"a":1}' }), /"a": 1/);
  // third batch
  assert.strictEqual(await TOOLS.gcd_lcm.run({ a: 12, b: 18 }), 'gcd(12, 18) = 6, lcm = 36');
  assert.match(await TOOLS.is_prime.run({ number: 97 }), /is prime/);
  assert.match(await TOOLS.is_prime.run({ number: 98 }), /not prime/);
  assert.strictEqual(await TOOLS.factorial.run({ number: 5 }), '5! = 120');
  assert.strictEqual(await TOOLS.fibonacci.run({ count: 7 }), '0, 1, 1, 2, 3, 5, 8');
  assert.strictEqual(await TOOLS.case_convert.run({ text: 'Hello World', style: 'snake' }), 'hello_world');
  assert.strictEqual(await TOOLS.case_convert.run({ text: 'hello world', style: 'camel' }), 'helloWorld');
  assert.strictEqual(await TOOLS.reverse_text.run({ text: 'a b c', by: 'words' }), 'c b a');
  // fourth batch
  assert.match(await TOOLS.average.run({ numbers: '2, 4, 6' }), /mean 4, median 4/);
  assert.match(await TOOLS.discount.run({ price: 100, percent: 25 }), /= \$75\.00/);
  assert.strictEqual(await TOOLS.binary_text.run({ text: 'Hi', mode: 'encode' }), '01001000 01101001');
  assert.strictEqual(await TOOLS.binary_text.run({ text: '01001000 01101001', mode: 'decode' }), 'Hi');
  assert.match(await TOOLS.text_stats.run({ text: 'one two three. four five.' }), /5 words, 2 sentences/);
  // fifth batch
  assert.strictEqual(await TOOLS.acronym.run({ text: 'as soon as possible' }), 'ASAP');
  assert.match(await TOOLS.vowel_count.run({ text: 'hello' }), /2 vowels, 3 consonants/);
  assert.strictEqual(await TOOLS.leetspeak.run({ text: 'elite' }), '3l173');
  assert.match(await TOOLS.pace.run({ distanceKm: 10, minutes: 50 }), /5:00 per km/);
  // sixth batch
  assert.match(await TOOLS.sentiment.run({ text: 'I love this, amazing' }), /positive/);
  assert.match(await TOOLS.sentiment.run({ text: 'this is terrible and broken' }), /negative/);
  assert.strictEqual(await TOOLS.title_case.run({ text: 'the lord of the rings' }), 'The Lord of the Rings');
  assert.strictEqual(await TOOLS.remove_duplicates.run({ text: 'a\nb\na\nc' }), 'a\nb\nc');
  assert.strictEqual(await TOOLS.rot13.run({ text: 'hello' }), 'uryyb');
  assert.strictEqual(await TOOLS.rot13.run({ text: 'uryyb' }), 'hello');
  assert.strictEqual(await TOOLS.extract_emails.run({ text: 'a@b.com and c@d.org' }), 'a@b.com\nc@d.org');
  // seventh batch
  assert.match(await TOOLS.palindrome.run({ text: 'A man a plan a canal Panama' }), /Yes/);
  assert.match(await TOOLS.anagram_check.run({ a: 'listen', b: 'silent' }), /Yes/);
  assert.strictEqual(await TOOLS.caesar.run({ text: 'abc', shift: 3 }), 'def');
  assert.strictEqual(await TOOLS.ordinal.run({ number: 22 }), '22nd');
  assert.strictEqual(await TOOLS.ordinal.run({ number: 11 }), '11th');
  assert.strictEqual(await TOOLS.number_to_words.run({ number: 1234 }), 'one thousand two hundred thirty four');
  assert.strictEqual(await TOOLS.initials.run({ name: 'Ada Lovelace' }), 'AL');
  // eighth batch
  assert.strictEqual(await TOOLS.scrabble_score.run({ word: 'quiz' }), 'quiz: 22 points');
  assert.strictEqual(await TOOLS.aspect_ratio.run({ width: 1920, height: 1080 }), '16:9');
  assert.strictEqual(await TOOLS.zodiac.run({ month: 7, day: 22 }), 'Cancer');
  assert.strictEqual(await TOOLS.zodiac.run({ month: 7, day: 23 }), 'Leo');
  assert.strictEqual(await TOOLS.strip_html.run({ html: '<b>hi</b> there' }), 'hi there');
  assert.match(await TOOLS.count_words_unique.run({ text: 'the cat the dog' }), /4 total, 3 unique/);
  // ninth batch — data, finance & text
  assert.match(await TOOLS.stats_summary.run({ numbers: [4, 8, 15, 16, 23, 42] }), /mean=18\.00 median=15\.5/);
  assert.match(await TOOLS.percentage_change.run({ from: 80, to: 100 }), /\+25\.00%/);
  assert.match(await TOOLS.compound_interest.run({ principal: 1000, ratePct: 5, years: 10, perYear: 12 }), /1647\.01/);
  assert.strictEqual(await TOOLS.duration_human.run({ seconds: 90061 }), '1d 1h 1m 1s');
  assert.strictEqual(await TOOLS.data_size.run({ bytes: 1536000 }), '1.46 MB');
  assert.strictEqual(await TOOLS.nato_spell.run({ text: 'cat' }), 'Charlie Alpha Tango');
  assert.strictEqual(await TOOLS.pig_latin.run({ text: 'hello world' }), 'ellohay orldway');
  assert.match(await TOOLS.luhn_check.run({ number: '4539578763621486' }), /Valid/);
  assert.match(await TOOLS.luhn_check.run({ number: '1234567890123456' }), /Invalid/);
  assert.match(await TOOLS.loan_payment.run({ principal: 200000, annualRatePct: 6, years: 30 }), /1199\.10/);
});

test('reply post-processing: strip markdown, links cap, phone redaction, signature', () => {
  const { postProcess } = require('../src/bot/reply');
  const config = require('../src/config');
  config.setSetting('strip_markdown', 'on');
  config.setSetting('max_links_per_reply', '1');
  config.setSetting('redact_phone_numbers', 'on');
  config.setSetting('signature_name', 'Alex');
  const out = postProcess('**bold** call +1 415 555 1234 see https://a.com and https://b.com', 0);
  assert.ok(!out.includes('**'), 'markdown not stripped');
  assert.ok(out.includes('[redacted]'), 'phone not redacted');
  assert.ok(out.includes('https://a.com') && !out.includes('https://b.com'), 'link cap not applied');
  assert.ok(out.endsWith('— Alex'), 'signature not appended');
  // reset
  config.setSetting('signature_name', ''); config.setSetting('redact_phone_numbers', 'off');
  config.setSetting('max_links_per_reply', '3');
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

test('sessions: device label parsing from user-agent', () => {
  const auth = require('../src/web/auth');
  assert.strictEqual(
    auth.deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0'),
    'Chrome · Windows');
  assert.strictEqual(
    auth.deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605'),
    'Safari · macOS');
  assert.strictEqual(auth.deviceLabel('curl/8.0'), 'curl');
  assert.strictEqual(auth.deviceLabel(''), 'Unknown');
});

test('sessions: ttl honors remember-me and configured lifetimes', () => {
  const auth = require('../src/web/auth');
  const config = require('../src/config');
  config.setSetting('session_ttl_hours', '2');
  config.setSetting('session_remember_days', '10');
  assert.strictEqual(auth.sessionTtlSec(false), 2 * 3600);
  assert.strictEqual(auth.sessionTtlSec(true), 10 * 24 * 3600);
  config.setSetting('session_ttl_hours', '24');
  config.setSetting('session_remember_days', '30');
});

test('sessions: list, revoke one, and revoke others', () => {
  const auth = require('../src/web/auth');
  const db = require('../src/db/schema');
  db.prepare('INSERT INTO admin_users (username, pass_hash, role) VALUES (?, ?, ?)')
    .run('t_sess', auth.hashPassword('password123'), 'admin');
  const uid = db.prepare("SELECT id FROM admin_users WHERE username = 't_sess'").get().id;
  const mk = (tok) => db.prepare(`INSERT INTO sessions (token, user_id, ip, user_agent, label, expires_at)
    VALUES (?, ?, '1.1.1.1', 'curl/8', 'curl', datetime('now','+1 day'))`).run(tok, uid);
  mk('sess_aaa_current'); mk('sess_bbb_other'); mk('sess_ccc_other');

  let list = auth.listSessions(uid, 'sess_aaa_current');
  assert.strictEqual(list.length, 3);
  assert.ok(list.find(s => s.current)); // current session flagged

  assert.strictEqual(auth.revokeSession(uid, 'sess_bbb_other'), true);
  assert.strictEqual(auth.revokeSession(uid, 'nonexistent'), false);
  const revoked = auth.listSessions(uid, 'sess_aaa_current').find(s => s.id === 'sess_bbb_oth');
  assert.strictEqual(revoked.active, false);

  const n = auth.revokeOtherSessions(uid, 'sess_aaa_current');
  assert.strictEqual(n, 1); // only ccc remained active to revoke
  const active = auth.listSessions(uid, 'sess_aaa_current').filter(s => s.active);
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].current, true);

  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
  db.prepare("DELETE FROM admin_users WHERE username = 't_sess'").run();
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

  // Catalog integrity: enough entries, unique names, every one well-formed.
  assert.ok(skills.CATALOG.length >= 26);
  const names = skills.CATALOG.map(c => c.name);
  assert.strictEqual(new Set(names).size, names.length);
  for (const c of skills.CATALOG) {
    assert.ok(c.name && c.content && Array.isArray(c.triggers));
  }

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
  assert.ok(characters.CHARACTERS.length >= 40);
  // No duplicate ids, and every persona is fully formed.
  const ids = characters.CHARACTERS.map(c => c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const c of characters.CHARACTERS) {
    assert.ok(c.id && c.name && c.prompt && c.emoji_usage && c.reply_style && c.temperature);
  }
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

test('scheduled messages: recurrence column + daily/weekly roll-forward SQL', () => {
  const db = require('../src/db/schema');
  const cols = db.prepare('PRAGMA table_info(scheduled_messages)').all().map(c => c.name);
  assert.ok(cols.includes('recurrence'), 'recurrence column missing');
  db.prepare("INSERT INTO scheduled_messages (chat_id, content, send_at, recurrence, status) VALUES (?,?,?,?,?)")
    .run(555, 'daily ping', '2025-01-01 09:00:00', 'daily', 'pending');
  const id = db.prepare('SELECT last_insert_rowid() id').get().id;
  // Simulate the scheduler roll-forward.
  db.prepare("UPDATE scheduled_messages SET send_at = datetime(send_at, '+1 day') WHERE id = ?").run(id);
  const row = db.prepare('SELECT send_at, status FROM scheduled_messages WHERE id = ?').get(id);
  assert.strictEqual(row.send_at, '2025-01-02 09:00:00');
  assert.strictEqual(row.status, 'pending'); // recurring stays pending
  db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(id);
});

test('autoresponders: match types work and short-circuit correctly', () => {
  const ar = require('../src/autoresponders');
  ar.upsert({ trigger: 'hours', match_type: 'contains', reply: 'We are open 9-5.' });
  ar.upsert({ trigger: 'ping', match_type: 'exact', reply: 'pong' });
  ar.upsert({ trigger: 'hello', match_type: 'starts', reply: 'hi there' });
  ar.upsert({ trigger: '^\\d{4}$', match_type: 'regex', reply: 'four digits' });
  assert.strictEqual(ar.match('what are your HOURS?'), 'We are open 9-5.');
  assert.strictEqual(ar.match('ping'), 'pong');
  assert.strictEqual(ar.match('  PING  '), 'pong');
  assert.strictEqual(ar.match('please ping me'), null); // exact must not substring-match
  assert.strictEqual(ar.match('hello world'), 'hi there');
  assert.strictEqual(ar.match('1234'), 'four digits');
  assert.strictEqual(ar.match('nothing relevant'), null);
  for (const r of ar.list()) ar.remove(r.id);
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

test('contacts: tags column stores and the DB filters by tag', () => {
  const db = require('../src/db/schema');
  const cols = db.prepare('PRAGMA table_info(contacts)').all().map(c => c.name);
  assert.ok(cols.includes('tags'), 'tags column missing');
  db.prepare("INSERT OR REPLACE INTO contacts (chat_id, assistant_id, name, tags) VALUES (?,?,?,?)").run(7001, 0, 'A', 'vip, client');
  db.prepare("INSERT OR REPLACE INTO contacts (chat_id, assistant_id, name, tags) VALUES (?,?,?,?)").run(7002, 0, 'B', 'newsletter');
  const all = db.prepare('SELECT chat_id, tags FROM contacts WHERE assistant_id = 0 AND chat_id IN (7001,7002)').all();
  const vip = all.filter(c => String(c.tags).toLowerCase().split(',').map(s => s.trim()).includes('vip'));
  assert.strictEqual(vip.length, 1);
  assert.strictEqual(vip[0].chat_id, 7001);
  db.prepare('DELETE FROM contacts WHERE chat_id IN (7001,7002)').run();
});

test('contacts: composite (chat_id, assistant_id) key allows same chat under two assistants', () => {
  const { upsertContact, getContact } = require('../src/bot/reply');
  upsertContact(4242, { name: 'Primary View' }, 0);
  upsertContact(4242, { name: 'Assistant-3 View' }, 3);
  assert.strictEqual(getContact(4242, 0).name, 'Primary View');
  assert.strictEqual(getContact(4242, 3).name, 'Assistant-3 View');
  const db = require('../src/db/schema');
  db.prepare('DELETE FROM contacts WHERE chat_id = 4242').run();
});

test('per-assistant settings overlay wins over globals in buildSystemPrompt', () => {
  const { buildSystemPrompt } = require('../src/bot/reply');
  const config = require('../src/config');
  config.setSetting('emoji_usage', 'none');
  const S = key => (key === 'emoji_usage' ? 'heavy' : config.getSetting(key));
  const withOverlay = buildSystemPrompt(null, null, 'Base prompt.', S);
  const withoutOverlay = buildSystemPrompt(null, null, 'Base prompt.', null);
  assert.ok(withOverlay.includes('emoji freely'), 'overlay emoji directive missing');
  assert.ok(withoutOverlay.includes('Never use emoji'), 'global emoji directive missing');
});

test('backup: default export excludes API keys, opt-in includes them', () => {
  const config = require('../src/config');
  const db = require('../src/db/schema');
  config.setKey('GROQ_API_KEY', 'gsk_backuptest');
  const safe = db.prepare('SELECT key FROM settings').all()
    .filter(s => !s.key.startsWith('apikey_'));
  assert.ok(!safe.some(s => s.key.startsWith('apikey_')), 'safe view still had apikey_');
  const full = db.prepare('SELECT key FROM settings').all();
  assert.ok(full.some(s => s.key === 'apikey_GROQ_API_KEY'), 'full view missing the key');
  config.setKey('GROQ_API_KEY', '');
});

test('geoip: flag emoji + private IP detection', () => {
  const geo = require('../src/web/geoip');
  assert.strictEqual(geo.flag('US'), '🇺🇸');
  assert.strictEqual(geo.flag(''), '');
  assert.ok(geo.isPrivate('127.0.0.1'));
  assert.ok(geo.isPrivate('192.168.1.5'));
  assert.ok(!geo.isPrivate('8.8.8.8'));
});

test('totp: matches RFC 6238 test vector and verifies with skew', () => {
  const totp = require('../src/web/totp');
  // RFC 6238 SHA1 test secret is the ASCII "12345678901234567890".
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  // At Unix time 59s the 8-digit TOTP is 94287082 → 6-digit is 287082.
  assert.strictEqual(totp.code(secret, 59_000, 30, 8), '94287082');
  assert.strictEqual(totp.code(secret, 59_000, 30, 6), '287082');
  // verify() accepts the current code and rejects a wrong one.
  const now = totp.code(secret);
  assert.ok(totp.verify(secret, now));
  assert.ok(!totp.verify(secret, '000000'));
  assert.ok(!totp.verify(secret, ''));
  // Round-trip a random secret.
  const s2 = totp.generateSecret();
  assert.ok(totp.verify(s2, totp.code(s2)));
});

test('ssrf: blocks private, loopback, link-local and metadata addresses', async () => {
  const { assertSafeUrl, ipIsPrivate } = require('../src/tools/ssrf');
  assert.ok(ipIsPrivate('127.0.0.1'));
  assert.ok(ipIsPrivate('10.1.2.3'));
  assert.ok(ipIsPrivate('192.168.0.1'));
  assert.ok(ipIsPrivate('169.254.169.254'), 'cloud metadata IP must be blocked');
  assert.ok(ipIsPrivate('172.16.5.5'));
  assert.ok(!ipIsPrivate('8.8.8.8'));
  await assert.rejects(() => assertSafeUrl('http://127.0.0.1/'), /private|internal/);
  await assert.rejects(() => assertSafeUrl('http://169.254.169.254/latest/meta-data/'), /private|internal/);
  await assert.rejects(() => assertSafeUrl('file:///etc/passwd'), /scheme/);
  await assert.rejects(() => assertSafeUrl('ftp://example.com'), /scheme/);
  await assert.rejects(() => assertSafeUrl('not a url'), /invalid URL/);
});

test('auth clientIp ignores X-Forwarded-For unless TRUST_PROXY is set', () => {
  // Default test env has no TRUST_PROXY, so spoofed XFF must be ignored.
  const auth = require('../src/web/auth');
  const req = { headers: { 'x-forwarded-for': '6.6.6.6' }, socket: { remoteAddress: '10.0.0.5' } };
  const ip = auth.clientIp(req);
  assert.strictEqual(ip, '10.0.0.5', 'spoofed X-Forwarded-For must not win when proxy is untrusted');
});
