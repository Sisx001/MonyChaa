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

  // ---- second utility batch ----
  morse: {
    description: 'Encode or decode Morse code',
    args: '{ "text": "SOS", "mode": "encode" }',
    enabled: () => true,
    run: ({ text, mode }) => {
      const M = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.', ' ': '/' };
      if (mode === 'decode') {
        const R = Object.fromEntries(Object.entries(M).map(([k, v]) => [v, k]));
        return String(text).trim().split(/\s+/).map(c => R[c] || '').join('');
      }
      return [...String(text).toUpperCase()].map(c => M[c] || '').join(' ').trim();
    },
  },
  number_base: {
    description: 'Convert a number between binary, octal, decimal and hex',
    args: '{ "value": "255", "from": 10, "to": 16 }',
    enabled: () => true,
    run: ({ value, from, to }) => {
      const n = parseInt(String(value), Number(from) || 10);
      if (isNaN(n)) throw new Error('invalid number for that base');
      return `${value} (base ${from || 10}) = ${n.toString(Number(to) || 16)} (base ${to || 16})`;
    },
  },
  roman: {
    description: 'Convert to/from Roman numerals',
    args: '{ "value": 2024 }  or  { "value": "MMXXIV" }',
    enabled: () => true,
    run: ({ value }) => {
      const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
      if (/^\d+$/.test(String(value))) {
        let n = Number(value); if (n < 1 || n > 3999) throw new Error('1–3999 only'); let out = '';
        for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
        return out;
      }
      const r = String(value).toUpperCase(); let i = 0, total = 0;
      for (const [v, s] of map) while (r.startsWith(s, i)) { total += v; i += s.length; }
      return String(total);
    },
  },
  age_calculator: {
    description: 'Calculate age from a birthdate (YYYY-MM-DD)',
    args: '{ "birthdate": "1990-05-15" }',
    enabled: () => true,
    run: ({ birthdate }) => {
      const b = new Date(birthdate); if (isNaN(b)) throw new Error('use YYYY-MM-DD');
      const days = Math.floor((Date.now() - b.getTime()) / 86400000);
      const years = Math.floor(days / 365.25);
      return `${years} years old (~${days.toLocaleString()} days)`;
    },
  },
  bmi_calculator: {
    description: 'Calculate BMI from weight (kg) and height (cm)',
    args: '{ "weightKg": 70, "heightCm": 175 }',
    enabled: () => true,
    run: ({ weightKg, heightCm }) => {
      const h = Number(heightCm) / 100; const bmi = Number(weightKg) / (h * h);
      const cat = bmi < 18.5 ? 'underweight' : bmi < 25 ? 'normal' : bmi < 30 ? 'overweight' : 'obese';
      return `BMI ${bmi.toFixed(1)} (${cat})`;
    },
  },
  tip_calculator: {
    description: 'Split a bill with tip',
    args: '{ "bill": 84.50, "tipPct": 18, "people": 4 }',
    enabled: () => true,
    run: ({ bill, tipPct, people }) => {
      const b = Number(bill); const tip = b * (Number(tipPct) || 0) / 100; const total = b + tip;
      const per = total / (Number(people) || 1);
      return `Tip $${tip.toFixed(2)}, total $${total.toFixed(2)}${people > 1 ? `, $${per.toFixed(2)} each (${people})` : ''}`;
    },
  },
  percentage: {
    description: 'Percentage calculations',
    args: '{ "value": 40, "of": 200 }',
    enabled: () => true,
    run: ({ value, of }) => `${value} is ${((Number(value) / Number(of)) * 100).toFixed(2)}% of ${of}`,
  },
  days_until: {
    description: 'Days until (or since) a date',
    args: '{ "date": "2025-12-25" }',
    enabled: () => true,
    run: ({ date }) => {
      const d = new Date(date); if (isNaN(d)) throw new Error('use YYYY-MM-DD');
      const days = Math.round((d.getTime() - Date.now()) / 86400000);
      return days === 0 ? 'That is today.' : days > 0 ? `${days} days until ${date}` : `${-days} days since ${date}`;
    },
  },
  day_of_week: {
    description: 'What day of the week a date falls on',
    args: '{ "date": "2025-07-04" }',
    enabled: () => true,
    run: ({ date }) => {
      const d = new Date(date); if (isNaN(d)) throw new Error('use YYYY-MM-DD');
      return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    },
  },
  world_time: {
    description: 'Current time in a timezone (IANA name)',
    args: '{ "timezone": "Asia/Tokyo" }',
    enabled: () => true,
    run: ({ timezone }) => {
      try { return new Date().toLocaleString('en-US', { timeZone: timezone || 'UTC', dateStyle: 'full', timeStyle: 'long' }); }
      catch { throw new Error('unknown timezone — use IANA names like Asia/Tokyo'); }
    },
  },
  json_tool: {
    description: 'Validate and pretty-print JSON',
    args: '{ "json": "{\\"a\\":1}" }',
    enabled: () => true,
    run: ({ json }) => {
      try { return JSON.stringify(JSON.parse(json), null, 2); }
      catch (e) { return `Invalid JSON: ${e.message}`; }
    },
  },
  slugify: {
    description: 'Turn text into a URL slug',
    args: '{ "text": "Hello World!" }',
    enabled: () => true,
    run: ({ text }) => String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
  },
  color_convert: {
    description: 'Convert a hex color to RGB (and back)',
    args: '{ "color": "#7c6cff" }',
    enabled: () => true,
    run: ({ color }) => {
      const c = String(color).trim();
      const hex = /^#?([0-9a-f]{6})$/i.exec(c);
      if (hex) {
        const n = parseInt(hex[1], 16);
        return `#${hex[1]} = rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      }
      const rgb = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c);
      if (rgb) return `rgb(${rgb[1]}, ${rgb[2]}, ${rgb[3]}) = #${[rgb[1], rgb[2], rgb[3]].map(x => Number(x).toString(16).padStart(2, '0')).join('')}`;
      throw new Error('give a hex like #7c6cff or rgb like 124,108,255');
    },
  },

  // ---- third utility batch ----
  reverse_text: {
    description: 'Reverse words or characters in text',
    args: '{ "text": "hello world", "by": "words" }',
    enabled: () => true,
    run: ({ text, by }) => by === 'words' ? String(text).split(/\s+/).reverse().join(' ') : [...String(text)].reverse().join(''),
  },
  count_occurrences: {
    description: 'Count how many times a substring appears in text',
    args: '{ "text": "...", "needle": "a" }',
    enabled: () => true,
    run: ({ text, needle }) => {
      if (!needle) return '0';
      return String((String(text).match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length);
    },
  },
  gcd_lcm: {
    description: 'Greatest common divisor and least common multiple of two integers',
    args: '{ "a": 12, "b": 18 }',
    enabled: () => true,
    run: ({ a, b }) => {
      let x = Math.abs(Number(a)), y = Math.abs(Number(b));
      const g = (m, n) => (n ? g(n, m % n) : m);
      const gcd = g(x, y);
      return `gcd(${a}, ${b}) = ${gcd}, lcm = ${(x * y) / gcd}`;
    },
  },
  is_prime: {
    description: 'Check whether a number is prime',
    args: '{ "number": 97 }',
    enabled: () => true,
    run: ({ number }) => {
      const n = Number(number);
      if (!Number.isInteger(n) || n < 2) return `${number} is not prime`;
      for (let i = 2; i <= Math.sqrt(n); i++) if (n % i === 0) return `${number} is not prime (divisible by ${i})`;
      return `${number} is prime`;
    },
  },
  factorial: {
    description: 'Compute the factorial of a number (0–170)',
    args: '{ "number": 10 }',
    enabled: () => true,
    run: ({ number }) => {
      const n = Number(number);
      if (!Number.isInteger(n) || n < 0 || n > 170) throw new Error('0–170 only');
      let f = 1; for (let i = 2; i <= n; i++) f *= i;
      return `${n}! = ${f}`;
    },
  },
  fibonacci: {
    description: 'First N Fibonacci numbers',
    args: '{ "count": 10 }',
    enabled: () => true,
    run: ({ count }) => {
      const n = Math.min(Math.max(Number(count) || 10, 1), 50);
      const out = [0, 1];
      while (out.length < n) out.push(out[out.length - 1] + out[out.length - 2]);
      return out.slice(0, n).join(', ');
    },
  },
  char_count_map: {
    description: 'Frequency of each character in text',
    args: '{ "text": "hello" }',
    enabled: () => true,
    run: ({ text }) => {
      const map = {};
      for (const ch of String(text).replace(/\s/g, '')) map[ch] = (map[ch] || 0) + 1;
      return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}: ${n}`).join(', ') || '(empty)';
    },
  },
  timestamp: {
    description: 'Convert between Unix timestamp and human date',
    args: '{ "value": 1700000000 }  or  { "value": "2024-01-01" }',
    enabled: () => true,
    run: ({ value }) => {
      if (/^\d{9,13}$/.test(String(value))) {
        const ms = String(value).length > 10 ? Number(value) : Number(value) * 1000;
        return new Date(ms).toISOString();
      }
      const d = new Date(value);
      if (isNaN(d)) throw new Error('give a unix timestamp or a date');
      return `${Math.floor(d.getTime() / 1000)} (unix seconds)`;
    },
  },
  case_convert: {
    description: 'Convert text to camelCase, snake_case or kebab-case',
    args: '{ "text": "Hello World", "style": "snake" }',
    enabled: () => true,
    run: ({ text, style }) => {
      const words = String(text).trim().split(/[\s_-]+/).filter(Boolean);
      if (style === 'camel') return words.map((w, i) => i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join('');
      if (style === 'kebab') return words.map(w => w.toLowerCase()).join('-');
      return words.map(w => w.toLowerCase()).join('_');
    },
  },
  random_pick: {
    description: 'Pick a random item from a comma-separated list',
    args: '{ "items": "pizza, sushi, tacos" }',
    enabled: () => true,
    run: ({ items }) => {
      const list = String(items).split(',').map(s => s.trim()).filter(Boolean);
      if (!list.length) throw new Error('give a comma-separated list');
      return list[crypto.randomInt(list.length)];
    },
  },
  shuffle: {
    description: 'Shuffle a comma-separated list randomly',
    args: '{ "items": "a, b, c, d" }',
    enabled: () => true,
    run: ({ items }) => {
      const list = String(items).split(',').map(s => s.trim()).filter(Boolean);
      for (let i = list.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [list[i], list[j]] = [list[j], list[i]]; }
      return list.join(', ');
    },
  },
};

module.exports = TOOLS;
