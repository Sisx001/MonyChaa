'use strict';
// Hardened panel auth: multi-user accounts, scrypt password hashing, DB-backed
// sessions, brute-force lockout, IP banning, roles, and an audit trail.
const crypto = require('crypto');
const db = require('../db/schema');
const logger = require('../logger');

const COOKIE = 'sp_sess';
const SESSION_TTL_SEC = 7 * 24 * 3600;
const MAX_FAILS = 6;              // per IP within the window
const LOCKOUT_WINDOW_SEC = 900;  // 15 minutes
const BOOTSTRAP_ENV = process.env.ADMIN_PASSWORD || '';
const BOOTSTRAP_USER = process.env.ADMIN_USER || 'admin';

// ---- password hashing (scrypt) ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(test, 'hex'); const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Seed the first account from env on first boot so the panel is never open.
function ensureBootstrap() {
  const count = db.prepare('SELECT COUNT(*) c FROM admin_users').get().c;
  if (count > 0) return;
  if (BOOTSTRAP_ENV) {
    db.prepare('INSERT INTO admin_users (username, pass_hash, role) VALUES (?, ?, ?)')
      .run(BOOTSTRAP_USER, hashPassword(BOOTSTRAP_ENV), 'owner');
    logger.info(`Seeded owner account "${BOOTSTRAP_USER}" from ADMIN_PASSWORD`);
  }
}
ensureBootstrap();

/** Auth is enforced only when at least one account exists. */
function enabled() {
  return db.prepare('SELECT COUNT(*) c FROM admin_users').get().c > 0;
}

// ---- request helpers ----
// X-Forwarded-For is only trusted when TRUST_PROXY=1 (i.e. you actually run
// behind a reverse proxy). Otherwise it's attacker-spoofable and would let
// someone evade IP bans and rate limits, so we use the socket address.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return (req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}
function parseCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

function audit(req, action, detail, user) {
  db.prepare('INSERT INTO audit_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)')
    .run(user?.id || null, user?.username || null, action, detail || null, clientIp(req));
}

function isBanned(ip) {
  return Boolean(db.prepare('SELECT 1 FROM banned_ips WHERE ip = ?').get(ip));
}

function recentFails(ip) {
  return db.prepare(
    "SELECT COUNT(*) c FROM login_attempts WHERE ip = ? AND success = 0 AND created_at > datetime('now', ?)"
  ).get(ip, `-${LOCKOUT_WINDOW_SEC} seconds`).c;
}

// ---- sessions ----
function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, user_id, ip, user_agent, expires_at)
    VALUES (?, ?, ?, ?, datetime('now', ?))`)
    .run(token, userId, clientIp(req), (req.headers['user-agent'] || '').slice(0, 200), `+${SESSION_TTL_SEC} seconds`);
  return token;
}
function sessionUser(req) {
  const token = parseCookie(req, COOKIE);
  if (!token) return null;
  const row = db.prepare(`SELECT s.token, s.user_id, u.username, u.role, u.enabled
    FROM sessions s JOIN admin_users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now')`).get(token);
  if (!row || !row.enabled) return null;
  db.prepare("UPDATE sessions SET last_seen = datetime('now') WHERE token = ?").run(token);
  return { id: row.user_id, username: row.username, role: row.role, token };
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function cookieHeader(token, maxAge) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${COOKIE}=${token ? encodeURIComponent(token) : ''}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

// ---- middleware ----
function middleware(req, res, next) {
  const ip = clientIp(req);
  if (isBanned(ip)) return res.status(403).json({ error: 'Your IP is banned.' });
  req.clientIp = ip;
  if (!enabled()) return next();
  const open = ['/health', '/api/login', '/api/auth-status'];
  if (open.includes(req.path)) return next();
  if (!req.path.startsWith('/api/')) return next(); // static assets are public shells
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'authentication required' });
  req.user = user;
  // Viewers get read-only access: block mutating methods.
  if (user.role === 'viewer' && !['GET', 'HEAD'].includes(req.method)) {
    return res.status(403).json({ error: 'read-only account' });
  }
  next();
}

// ---- handlers ----
function loginHandler(req, res) {
  const ip = clientIp(req);
  const username = String(req.body?.username || BOOTSTRAP_USER).slice(0, 64);
  const password = req.body?.password || '';
  const ua = (req.headers['user-agent'] || '').slice(0, 200);
  const record = (success) => db.prepare(
    'INSERT INTO login_attempts (username, ip, success, user_agent) VALUES (?, ?, ?, ?)'
  ).run(username, ip, success ? 1 : 0, ua);

  if (!enabled()) return res.json({ ok: true, note: 'auth disabled' });
  if (isBanned(ip)) return res.status(403).json({ error: 'IP banned' });

  if (recentFails(ip) >= MAX_FAILS) {
    record(false);
    logger.warn(`Login lockout for ${ip} (too many failures)`);
    return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
  }

  const user = db.prepare('SELECT * FROM admin_users WHERE username = ? AND enabled = 1').get(username);
  if (!user || !verifyPassword(password, user.pass_hash)) {
    record(false);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  // Second factor, when the account has 2FA enabled.
  if (user.totp_secret) {
    const totp = require('./totp');
    if (!req.body?.totp) {
      record(false);
      return res.status(401).json({ error: 'two-factor code required', totpRequired: true });
    }
    if (!totp.verify(user.totp_secret, req.body.totp)) {
      record(false);
      return res.status(401).json({ error: 'invalid two-factor code', totpRequired: true });
    }
  }
  record(true);
  db.prepare("UPDATE admin_users SET last_login = datetime('now'), last_ip = ? WHERE id = ?").run(ip, user.id);
  const token = createSession(user.id, req);
  res.setHeader('Set-Cookie', cookieHeader(token, SESSION_TTL_SEC));
  audit(req, 'login', `role=${user.role}`, user);
  res.json({ ok: true, user: { username: user.username, role: user.role } });
}

function logoutHandler(req, res) {
  const token = parseCookie(req, COOKIE);
  if (req.user) audit(req, 'logout', null, req.user);
  destroySession(token);
  res.setHeader('Set-Cookie', cookieHeader('', 0));
  res.json({ ok: true });
}

function statusHandler(req, res) {
  const user = sessionUser(req);
  res.json({
    authRequired: enabled(),
    authenticated: !enabled() || Boolean(user),
    user: user ? { username: user.username, role: user.role } : null,
  });
}

module.exports = {
  middleware, loginHandler, logoutHandler, statusHandler,
  enabled, hashPassword, verifyPassword, clientIp, audit, sessionUser,
  isBanned, recentFails,
};
