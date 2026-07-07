'use strict';
// Express server: admin panel static files, REST API, SSE stream, health check.
const path = require('path');
const express = require('express');
const logger = require('../logger');
const { env } = require('../config');
const routes = require('./routes');
const events = require('./events');
const auth = require('./auth');

// Simple in-memory sliding-window rate limiter (per IP). Each limiter owns its
// own bucket so different routes don't interfere.
const allBuckets = [];
function rateLimit(max, windowMs) {
  const hits = new Map(); // ip → timestamps[]
  allBuckets.push({ hits, windowMs });
  return (req, res, next) => {
    const ip = req.clientIp || req.ip || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
    arr.push(now);
    hits.set(ip, arr);
    if (arr.length > max) return res.status(429).json({ error: 'rate limit exceeded — slow down' });
    next();
  };
}
// Periodic cleanup so the maps don't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const { hits, windowMs } of allBuckets) {
    for (const [ip, arr] of hits) { const f = arr.filter(t => now - t < windowMs); f.length ? hits.set(ip, f) : hits.delete(ip); }
  }
}, 120000).unref();

function createServer() {
  const app = express();
  app.disable('x-powered-by');
  // Only trust proxy headers when explicitly running behind one.
  app.set('trust proxy', process.env.TRUST_PROXY === '1');

  // Security headers on every response.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    next();
  });

  app.use(express.json({ limit: '20mb' }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
  });

  // Throttle: 300 API requests/min per IP overall, and a tight 10/min on login.
  app.use('/api', rateLimit(300, 60_000));
  app.use('/api/login', rateLimit(10, 60_000));
  app.use(auth.middleware);
  app.post('/api/login', auth.loginHandler);
  app.post('/api/logout', auth.logoutHandler);
  app.get('/api/auth-status', auth.statusHandler);
  if (auth.enabled()) logger.info('Panel authentication enabled');

  app.get('/api/events', events.handler);
  app.use('/api', routes);

  // Vendored Chart.js so the panel works fully offline. chart.js v4's exports
  // map blocks require.resolve on dist files, so point at node_modules directly.
  app.get('/vendor/chart.js', (req, res) => {
    const chartPath = path.join(__dirname, '..', '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
    res.type('application/javascript').sendFile(chartPath);
  });

  app.use(express.static(path.join(__dirname, 'public')));

  // API 404s return JSON; anything else falls back to the SPA.
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Error handler (bad JSON bodies etc.).
  app.use((err, req, res, next) => {
    logger.warn(`HTTP error: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = app.listen(env.PORT, () => {
    logger.info(`Admin panel: http://localhost:${env.PORT}`);
  });
  return server;
}

module.exports = { createServer };
