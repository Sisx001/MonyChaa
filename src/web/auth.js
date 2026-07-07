'use strict';
// Optional panel authentication. Set ADMIN_PASSWORD in .env to require login.
// Sessions are HMAC-signed cookies with a per-boot secret (restart = re-login).
const crypto = require('crypto');

const PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = crypto.randomBytes(32);
const COOKIE = 'sp_auth';
const MAX_AGE_SEC = 7 * 24 * 3600;

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

function makeToken() {
  const payload = `admin.${Date.now() + MAX_AGE_SEC * 1000}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token) return false;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return false;
  const payload = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = sign(payload);
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  const expiry = Number(payload.split('.')[1]);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

function parseCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return '';
}

function enabled() { return Boolean(PASSWORD); }

function checkPassword(candidate) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Express middleware: gate the API when a password is configured. */
function middleware(req, res, next) {
  if (!enabled()) return next();
  if (req.path === '/health' || req.path === '/api/login' || req.path === '/api/auth-status') return next();
  // Static assets stay public (they contain no data); every /api route is gated.
  if (!req.path.startsWith('/api/')) return next();
  if (verifyToken(parseCookie(req))) return next();
  res.status(401).json({ error: 'authentication required' });
}

function loginHandler(req, res) {
  if (!enabled()) return res.json({ ok: true, note: 'auth disabled' });
  if (!checkPassword(req.body?.password)) {
    return res.status(401).json({ error: 'wrong password' });
  }
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SEC}`);
  res.json({ ok: true });
}

function logoutHandler(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}

function statusHandler(req, res) {
  res.json({ authRequired: enabled(), authenticated: !enabled() || verifyToken(parseCookie(req)) });
}

module.exports = { middleware, loginHandler, logoutHandler, statusHandler, enabled, verifyToken, makeToken, checkPassword };
