'use strict';
// Fallback chain + optional load balancing on top of the gateway.
const db = require('../db/schema');
const logger = require('../logger');
const config = require('../config');
const { chatOnce, isConfigured, isVisionModel } = require('./gateway');

function logEvent(type, detail) {
  db.prepare('INSERT INTO events_log (type, detail) VALUES (?, ?)').run(type, detail);
}

// Rate-limit warning to the owner, throttled to once per provider per 30 min.
const rateLimitNotified = new Map();
function notifyRateLimit(provider, model) {
  if (config.getSetting('rate_limit_alerts') !== 'on') return;
  const last = rateLimitNotified.get(provider) || 0;
  if (Date.now() - last < 30 * 60000) return;
  rateLimitNotified.set(provider, Date.now());
  // Lazy require to avoid a circular import (handlers → reply → fallback).
  const { notifyOwner } = require('../bot/handlers');
  notifyOwner(`⏳ Rate limit hit on ${provider}/${model} — falling back to the next provider.`).catch(() => {});
}

/** Build ordered candidate list: primary first, then the fallback chain. */
function candidates({ needsVision = false } = {}) {
  const chain = [];
  const primary = { provider: config.getSetting('primary_provider'), model: config.getSetting('primary_model') };
  chain.push(primary);
  for (const step of config.getJSON('fallback_chain', [])) {
    if (step && step.provider && step.model) chain.push(step);
  }
  // De-dup, keep only configured providers; when vision is needed prefer vision models.
  const seen = new Set();
  const list = chain.filter(c => {
    const key = `${c.provider}/${c.model}`;
    if (seen.has(key) || !isConfigured(c.provider)) return false;
    seen.add(key);
    return true;
  });
  if (needsVision) {
    const visionFirst = list.filter(c => isVisionModel(c.provider, c.model));
    const rest = list.filter(c => !isVisionModel(c.provider, c.model));
    return [...visionFirst, ...rest];
  }
  if (config.getSetting('load_balancing') === 'on' && list.length > 1) {
    // Round-robin across healthy candidates by rotating the start position.
    const healthy = list.filter(c => {
      const h = db.prepare('SELECT status FROM provider_health WHERE provider = ?').get(c.provider);
      return !h || h.status !== 'down';
    });
    const pool = healthy.length ? healthy : list;
    const offset = Math.floor(Math.random() * pool.length);
    return [...pool.slice(offset), ...pool.slice(0, offset)];
  }
  return list;
}

/**
 * Chat with automatic fallback: tries each candidate until one succeeds.
 * Throws only if every candidate fails.
 */
async function chat(messages, opts = {}) {
  const list = candidates(opts);
  if (!list.length) throw new Error('No LLM provider configured. Set GEMINI_API_KEY (or another provider key) in .env');
  let lastErr;
  for (let i = 0; i < list.length; i++) {
    const { provider, model } = list[i];
    try {
      const result = await chatOnce(provider, model, messages, opts);
      if (i > 0) logEvent('model_switch', `Fell back to ${provider}/${model} (attempt ${i + 1})`);
      return result;
    } catch (err) {
      lastErr = err;
      const kind = err.status === 429 ? 'rate_limit' : 'provider_error';
      logEvent(kind, `${provider}/${model}: ${err.message}`);
      if (kind === 'rate_limit') notifyRateLimit(provider, model);
      logger.warn(`LLM ${provider}/${model} failed (${err.message}), trying next candidate`);
    }
  }
  throw lastErr;
}

module.exports = { chat, candidates };
