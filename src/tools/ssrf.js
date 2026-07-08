'use strict';
// SSRF guard: validate a user/LLM-supplied URL before fetching it, and pin the
// connection to the resolved public IP so DNS-rebinding can't swap it after the
// check. Blocks private ranges, loopback, link-local and cloud metadata.
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');

function ipIsPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;           // link-local + AWS/GCP metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return false;
  }
  const low = ip.toLowerCase();
  return low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd')
    || low.startsWith('fe80') || low.startsWith('::ffff:127.') || low.startsWith('::ffff:10.')
    || low.startsWith('::ffff:169.254');
}

/**
 * Validate a URL and resolve it to a safe public IP.
 * @returns {Promise<{url: URL, ip: string, family: number}>}
 * @throws if the scheme is not http(s) or the target resolves to a private IP.
 */
async function assertSafeUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`blocked scheme: ${url.protocol}`);
  }
  const host = url.hostname;
  // A literal IP in the URL is checked directly.
  if (net.isIP(host)) {
    if (ipIsPrivate(host)) throw new Error('blocked: private/internal address');
    return { url, ip: host, family: net.isIPv6(host) ? 6 : 4 };
  }
  const records = await dns.lookup(host, { all: true });
  if (!records.length) throw new Error('DNS resolution failed');
  for (const r of records) {
    if (ipIsPrivate(r.address)) throw new Error('blocked: host resolves to a private address');
  }
  return { url, ip: records[0].address, family: records[0].family };
}

/**
 * SSRF-safe fetch: validates the URL, then pins the socket to the pre-resolved
 * IP (Host header preserved) so a rebinding attack can't redirect to internal
 * space between the DNS check and the connection. Follows up to 3 redirects,
 * re-validating each hop.
 */
async function safeFetch(rawUrl, { timeoutMs = 15000, maxRedirects = 3, headers = {} } = {}) {
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, ip, family } = await assertSafeUrl(current);
    const lib = url.protocol === 'https:' ? https : http;
    const res = await new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method: 'GET',
        family,
        // Pin to the validated IP; keep Host header for virtual hosting + TLS SNI.
        lookup: (_h, _o, cb) => cb(null, ip, family),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; secretary-pro/1.0)', Host: url.host, ...headers },
        timeout: timeoutMs,
        servername: url.hostname,
      }, resolve);
      req.on('timeout', () => req.destroy(new Error('request timeout')));
      req.on('error', reject);
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      current = new URL(res.headers.location, url).href;
      res.resume(); // drain
      continue;
    }
    const chunks = [];
    let size = 0;
    for await (const c of res) {
      size += c.length;
      if (size > 5_000_000) { res.destroy(); break; } // 5MB cap
      chunks.push(c);
    }
    return { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('too many redirects');
}

module.exports = { assertSafeUrl, safeFetch, ipIsPrivate };
