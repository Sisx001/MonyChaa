'use strict';
// Express server: admin panel static files, REST API, SSE stream, health check.
const path = require('path');
const express = require('express');
const logger = require('../logger');
const { env } = require('../config');
const routes = require('./routes');
const events = require('./events');
const auth = require('./auth');

function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20mb' }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
  });

  app.use(auth.middleware);
  app.post('/api/login', auth.loginHandler);
  app.post('/api/logout', auth.logoutHandler);
  app.get('/api/auth-status', auth.statusHandler);
  if (auth.enabled()) logger.info('Panel authentication enabled (ADMIN_PASSWORD set)');

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
