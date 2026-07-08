'use strict';
// RFC 6238 TOTP (time-based one-time passwords) for optional 2FA, implemented
// with Node crypto — no external dependency. Compatible with Google
// Authenticator, Authy, 1Password, etc.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** Generate a new random base32 secret (default 20 bytes / 160 bits). */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** Compute the TOTP code for a given secret at a given time (ms). */
function code(secret, timeMs = Date.now(), step = 30, digits = 6) {
  const counter = Math.floor(timeMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Verify a user-entered code, allowing ±1 time step for clock skew. */
function verify(secret, token, timeMs = Date.now()) {
  if (!secret || !token) return false;
  const t = String(token).replace(/\s/g, '');
  for (const drift of [-1, 0, 1]) {
    const expected = code(secret, timeMs + drift * 30_000);
    if (expected.length === t.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(t))) return true;
  }
  return false;
}

/** otpauth:// URI for QR provisioning in authenticator apps. */
function otpauthUrl(secret, label, issuer = 'Secretary Pro') {
  const l = encodeURIComponent(`${issuer}:${label}`);
  return `otpauth://totp/${l}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, code, verify, otpauthUrl, base32Decode, base32Encode };
