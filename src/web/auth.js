'use strict';
// Hardened panel auth: multi-user accounts, scrypt password hashing, DB-backed
// sessions, brute-force lockout, IP banning, roles, and an audit trail.
const crypto = require('crypto');
const db = require('../db/schema');
const logger = require('../logger');
const config = require('../config');

const COOKIE = 'sp_sess';
const DEFAULT_TTL_SEC = 24 * 3600;
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
const num = (key, fallback) => {
  const v = parseFloat(config.getSetting(key));
  return Number.isFinite(v) ? v : fallback;
};

/** Turn a raw User-Agent into a short "Browser · OS" device label. */
function deviceLabel(ua = '') {
  const s = String(ua);
  let browser =
    /Edg\//.test(s) ? 'Edge' :
    /OPR\/|Opera/.test(s) ? 'Opera' :
    /Chrome\//.test(s) ? 'Chrome' :
    /Firefox\//.test(s) ? 'Firefox' :
    /Safari\//.test(s) ? 'Safari' :
    /curl\//i.test(s) ? 'curl' :
    /PostmanRuntime/i.test(s) ? 'Postman' : 'Unknown';
  let os =
    /Windows NT 10/.test(s) ? 'Windows' :
    /Windows/.test(s) ? 'Windows' :
    /iPhone|iPad|iOS/.test(s) ? 'iOS' :
    /Android/.test(s) ? 'Android' :
    /Mac OS X|Macintosh/.test(s) ? 'macOS' :
    /Linux/.test(s) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

/** Lifetime (seconds) for a new session, honoring the remember-me flag. */
function sessionTtlSec(remember) {
  if (remember) return Math.max(1, num('session_remember_days', 30)) * 24 * 3600;
  return Math.max(1, num('session_ttl_hours', 24)) * 3600;
}

function createSession(userId, req, remember = false) {
  const token = crypto.randomBytes(32).toString('hex');
  const ip = clientIp(req);
  const ttl = sessionTtlSec(remember);
  db.prepare(`INSERT INTO sessions (token, user_id, ip, user_agent, label, remember, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`)
    .run(token, userId, ip, (req.headers['user-agent'] || '').slice(0, 200),
         deviceLabel(req.headers['user-agent']), remember ? 1 : 0, `+${ttl} seconds`);
  // Single-session mode: kill the user's other live sessions.
  if (config.getSetting('session_single') === 'on') {
    db.prepare(`UPDATE sessions SET revoked = 1, revoked_at = datetime('now')
      WHERE user_id = ? AND token != ? AND revoked = 0`).run(userId, token);
  }
  return token;
}

function sessionUser(req) {
  const token = parseCookie(req, COOKIE);
  if (!token) return null;
  const row = db.prepare(`SELECT s.token, s.user_id, s.ip, s.last_seen, s.revoked, u.username, u.role, u.enabled
    FROM sessions s JOIN admin_users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now')`).get(token);
  if (!row || !row.enabled || row.revoked) return null;
  // Optional idle timeout: expire sessions untouched for too long.
  const idle = num('session_idle_timeout_min', 0);
  if (idle > 0 && row.last_seen) {
    const ageMs = Date.now() - Date.parse(row.last_seen.replace(' ', 'T') + 'Z');
    if (Number.isFinite(ageMs) && ageMs > idle * 60_000) {
      db.prepare("UPDATE sessions SET revoked = 1, revoked_at = datetime('now') WHERE token = ?").run(token);
      return null;
    }
  }
  // Optional IP binding: a stolen cookie is useless from a different address.
  if (config.getSetting('session_bind_ip') === 'on' && row.ip && row.ip !== clientIp(req)) {
    return null;
  }
  db.prepare("UPDATE sessions SET last_seen = datetime('now') WHERE token = ?").run(token);
  return { id: row.user_id, username: row.username, role: row.role, token };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ---- session management (panel-facing) ----
function listSessions(userId, currentToken) {
  const rows = db.prepare(`SELECT token, ip, country, user_agent, label, remember, revoked,
      created_at, last_seen, expires_at
    FROM sessions WHERE user_id = ? ORDER BY last_seen DESC`).all(userId);
  const now = Date.now();
  return rows.map(r => {
    const exp = Date.parse((r.expires_at || '').replace(' ', 'T') + 'Z');
    const expired = Number.isFinite(exp) && exp < now;
    return {
      id: r.token.slice(0, 12),          // short, non-sensitive handle
      ip: r.ip, country: r.country || '',
      label: r.label || deviceLabel(r.user_agent),
      remember: !!r.remember,
      current: r.token === currentToken,
      active: !r.revoked && !expired,
      revoked: !!r.revoked,
      created_at: r.created_at, last_seen: r.last_seen, expires_at: r.expires_at,
    };
  });
}

/** Revoke one session of a user by its short id (first 12 chars of token). */
function revokeSession(userId, shortId) {
  const row = db.prepare('SELECT token FROM sessions WHERE user_id = ? AND token LIKE ?')
    .get(userId, shortId + '%');
  if (!row) return false;
  db.prepare("UPDATE sessions SET revoked = 1, revoked_at = datetime('now') WHERE token = ?").run(row.token);
  return true;
}

/** Revoke every session for a user except (optionally) the one in use. */
function revokeOtherSessions(userId, keepToken) {
  const info = db.prepare(`UPDATE sessions SET revoked = 1, revoked_at = datetime('now')
    WHERE user_id = ? AND revoked = 0 AND token != ?`).run(userId, keepToken || '');
  return info.changes;
}

/** Housekeeping: drop revoked/expired rows older than a day. */
function pruneSessions() {
  return db.prepare(`DELETE FROM sessions
    WHERE (revoked = 1 OR expires_at < datetime('now'))
      AND COALESCE(revoked_at, expires_at) < datetime('now', '-1 day')`).run().changes;
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
  const remember = Boolean(req.body?.remember);
  const token = createSession(user.id, req, remember);
  res.setHeader('Set-Cookie', cookieHeader(token, sessionTtlSec(remember)));
  audit(req, 'login', `role=${user.role}${remember ? ' remember' : ''}`, user);
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
  isBanned, recentFails, deviceLabel, sessionTtlSec,
  listSessions, revokeSession, revokeOtherSessions, pruneSessions,
};
