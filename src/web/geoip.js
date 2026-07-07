'use strict';
// Best-effort country lookup for an IP, cached. Uses the keyless ip-api.com
// service; private/loopback IPs resolve to "Local". Never throws.
const cache = new Map(); // ip → { country, code, at }
const TTL = 24 * 3600 * 1000;

function isPrivate(ip) {
  return !ip || ip === 'unknown' || ip === '::1' || ip.startsWith('127.')
    || ip.startsWith('10.') || ip.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip.startsWith('::ffff:127.');
}

/** Returns { code, country } — code is a 2-letter ISO for the flag emoji. */
async function lookup(ip) {
  if (isPrivate(ip)) return { code: '', country: 'Local' };
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < TTL) return hit;
  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode`, {
      signal: AbortSignal.timeout(6000),
    });
    const j = await res.json();
    const out = j.status === 'success'
      ? { code: j.countryCode || '', country: j.country || 'Unknown', at: Date.now() }
      : { code: '', country: 'Unknown', at: Date.now() };
    cache.set(ip, out);
    return out;
  } catch {
    return { code: '', country: 'Unknown' };
  }
}

/** ISO country code → flag emoji (e.g. "US" → 🇺🇸). */
function flag(code) {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

module.exports = { lookup, flag, isPrivate };
