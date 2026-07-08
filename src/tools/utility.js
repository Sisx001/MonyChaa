'use strict';
// A large batch of extra tools. Pure-computation tools need no network and are
// always enabled; a few use free keyless public APIs. Each export is a tool
// definition merged into the main registry.
const crypto = require('crypto');

async function getJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Safe arithmetic evaluator — digits, operators, parens, decimals only.
function safeCalc(expr) {
  const cleaned = String(expr).replace(/\s+/g, '');
  if (!/^[-+*/%().0-9eE]+$/.test(cleaned)) throw new Error('only numbers and + - * / % ( ) are allowed');
  if (cleaned.length > 200) throw new Error('expression too long');
  // eslint-disable-next-line no-new-func
  const val = Function(`"use strict";return (${cleaned})`)();
  if (typeof val !== 'number' || !isFinite(val)) throw new Error('invalid expression');
  return val;
}

const UNITS = {
  length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.34, yd: 0.9144, ft: 0.3048, in: 0.0254 },
  weight: { g: 1, kg: 1000, mg: 0.001, lb: 453.592, oz: 28.3495, t: 1e6 },
  data: { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 },
};

const TOOLS = {
  calculator: {
    description: 'Evaluate a math expression (+ - * / % and parentheses)',
    args: '{ "expression": "2*(3+4)/5" }',
    enabled: () => true,
    run: ({ expression }) => `${expression} = ${safeCalc(expression)}`,
  },
  unit_convert: {
    description: 'Convert between units of length, weight or data size',
    args: '{ "value": 10, "from": "km", "to": "mi" }',
    enabled: () => true,
    run: ({ value, from, to }) => {
      const f = String(from).toLowerCase(), t = String(to).toLowerCase();
      for (const [cat, map] of Object.entries(UNITS)) {
        if (map[f] !== undefined && map[t] !== undefined) {
          const out = (Number(value) * map[f]) / map[t];
          return `${value} ${from} = ${+out.toFixed(6)} ${to} (${cat})`;
        }
      }
      throw new Error(`can't convert ${from} → ${to}`);
    },
  },
  temperature_convert: {
    description: 'Convert temperature between C, F and K',
    args: '{ "value": 100, "from": "C", "to": "F" }',
    enabled: () => true,
    run: ({ value, from, to }) => {
      const v = Number(value); const f = String(from).toUpperCase(); const t = String(to).toUpperCase();
      const toC = f === 'C' ? v : f === 'F' ? (v - 32) * 5 / 9 : v - 273.15;
      const out = t === 'C' ? toC : t === 'F' ? toC * 9 / 5 + 32 : toC + 273.15;
      return `${value}°${f} = ${+out.toFixed(2)}°${t}`;
    },
  },
  password_generator: {
    description: 'Generate a strong random password',
    args: '{ "length": 20, "symbols": true }',
    enabled: () => true,
    run: ({ length, symbols }) => {
      const n = Math.min(Math.max(Number(length) || 16, 6), 128);
      const set = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789' + (symbols === false ? '' : '!@#$%^&*-_=+?');
      let out = '';
      const bytes = crypto.randomBytes(n);
      for (let i = 0; i < n; i++) out += set[bytes[i] % set.length];
      return out;
    },
  },
  uuid: {
    description: 'Generate a random UUID v4',
    args: '{}',
    enabled: () => true,
    run: () => crypto.randomUUID(),
  },
  hash: {
    description: 'Hash text with md5, sha1 or sha256',
    args: '{ "text": "hello", "algo": "sha256" }',
    enabled: () => true,
    run: ({ text, algo }) => {
      const a = ['md5', 'sha1', 'sha256', 'sha512'].includes(algo) ? algo : 'sha256';
      return `${a}: ${crypto.createHash(a).update(String(text)).digest('hex')}`;
    },
  },
  base64: {
    description: 'Base64 encode or decode text',
    args: '{ "text": "hello", "mode": "encode" }',
    enabled: () => true,
    run: ({ text, mode }) => mode === 'decode'
      ? Buffer.from(String(text), 'base64').toString('utf8')
      : Buffer.from(String(text), 'utf8').toString('base64'),
  },
  dice: {
    description: 'Roll dice, e.g. 2d6',
    args: '{ "notation": "2d6" }',
    enabled: () => true,
    run: ({ notation }) => {
      const m = /^(\d*)d(\d+)$/i.exec(String(notation || '1d6').trim());
      if (!m) throw new Error('use NdM notation, e.g. 2d6');
      const count = Math.min(Number(m[1] || 1), 100); const sides = Math.min(Number(m[2]), 1000);
      const rolls = Array.from({ length: count }, () => 1 + crypto.randomInt(sides));
      return `${notation}: [${rolls.join(', ')}] = ${rolls.reduce((a, b) => a + b, 0)}`;
    },
  },
  random_number: {
    description: 'Random integer in a range',
    args: '{ "min": 1, "max": 100 }',
    enabled: () => true,
    run: ({ min, max }) => {
      const lo = Math.ceil(Number(min) || 0); const hi = Math.floor(Number(max) || 100);
      return String(lo + crypto.randomInt(Math.max(1, hi - lo + 1)));
    },
  },
  coin_flip: {
    description: 'Flip a coin',
    args: '{}',
    enabled: () => true,
    run: () => (crypto.randomInt(2) ? 'Heads' : 'Tails'),
  },
  word_count: {
    description: 'Count words, characters and lines in text',
    args: '{ "text": "..." }',
    enabled: () => true,
    run: ({ text }) => {
      const s = String(text || '');
      const words = s.trim() ? s.trim().split(/\s+/).length : 0;
      return `${words} words, ${s.length} characters, ${s.split('\n').length} lines`;
    },
  },
  text_transform: {
    description: 'Transform text case: upper, lower, title, reverse',
    args: '{ "text": "...", "mode": "upper" }',
    enabled: () => true,
    run: ({ text, mode }) => {
      const s = String(text || '');
      switch (mode) {
        case 'lower': return s.toLowerCase();
        case 'title': return s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
        case 'reverse': return [...s].reverse().join('');
        default: return s.toUpperCase();
      }
    },
  },

  // ---- keyless network tools ----
  wikipedia: {
    description: 'Look up a topic summary on Wikipedia',
    args: '{ "topic": "quantum computing" }',
    enabled: () => true,
    run: async ({ topic }) => {
      const j = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`);
      return j.extract || 'No summary found.';
    },
  },
  dictionary: {
    description: 'Get the definition of a word',
    args: '{ "word": "serendipity" }',
    enabled: () => true,
    run: async ({ word }) => {
      const j = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      const meanings = j[0]?.meanings || [];
      return meanings.slice(0, 3).map(m => `(${m.partOfSpeech}) ${m.definitions[0]?.definition}`).join('\n') || 'No definition found.';
    },
  },
  ip_lookup: {
    description: 'Geolocate an IP address',
    args: '{ "ip": "8.8.8.8" }',
    enabled: () => true,
    run: async ({ ip }) => {
      const j = await getJson(`http://ip-api.com/json/${encodeURIComponent(ip || '')}?fields=status,country,regionName,city,isp,query`);
      if (j.status !== 'success') return 'Lookup failed.';
      return `${j.query}: ${j.city}, ${j.regionName}, ${j.country} — ${j.isp}`;
    },
  },
  number_fact: {
    description: 'Get an interesting fact about a number',
    args: '{ "number": 42 }',
    enabled: () => true,
    run: async ({ number }) => {
      const res = await fetch(`http://numbersapi.com/${encodeURIComponent(number ?? 'random')}`, { signal: AbortSignal.timeout(10000) });
      return (await res.text()) || 'No fact found.';
    },
  },
  advice: {
    description: 'Get a random piece of advice',
    args: '{}',
    enabled: () => true,
    run: async () => {
      const j = await getJson('https://api.adviceslip.com/advice');
      return j.slip?.advice || 'No advice right now.';
    },
  },
  joke: {
    description: 'Tell a random joke',
    args: '{}',
    enabled: () => true,
    run: async () => {
      const j = await getJson('https://official-joke-api.appspot.com/random_joke');
      return `${j.setup}\n${j.punchline}`;
    },
  },
  holidays: {
    description: 'Public holidays for a country this year',
    args: '{ "country": "US" }',
    enabled: () => true,
    run: async ({ country }) => {
      const year = new Date().getFullYear();
      const j = await getJson(`https://date.nager.at/api/v3/PublicHolidays/${year}/${encodeURIComponent(country || 'US')}`);
      return (j || []).slice(0, 12).map(h => `${h.date}: ${h.localName}`).join('\n') || 'No holidays found.';
    },
  },
};

module.exports = TOOLS;
