'use strict';
// Multi-provider LLM gateway: normalizes chat calls across OpenAI-compatible,
// Gemini, Anthropic and Cohere APIs. Tracks usage, cost and health.
const db = require('../db/schema');
const logger = require('../logger');
const { PROVIDERS, apiKey, isConfigured, modelCost, isVisionModel } = require('./providers');

const REQUEST_TIMEOUT_MS = 60_000;

function recordUsage(provider, model, tokensIn, tokensOut) {
  const [inCost, outCost] = modelCost(provider, model);
  const cost = (tokensIn * inCost + tokensOut * outCost) / 1_000_000;
  db.prepare(
    'INSERT INTO token_usage (provider, model, tokens_in, tokens_out, cost_estimate) VALUES (?, ?, ?, ?, ?)'
  ).run(provider, model, tokensIn, tokensOut, cost);
  return cost;
}

function recordHealth(provider, ok, latencyMs, errMsg) {
  const row = db.prepare('SELECT * FROM provider_health WHERE provider = ?').get(provider) || {
    success_count: 0, error_count: 0,
  };
  const success = row.success_count + (ok ? 1 : 0);
  const errors = row.error_count + (ok ? 0 : 1);
  const total = success + errors;
  const errorRate = total ? errors / total : 0;
  const status = ok ? (errorRate > 0.3 ? 'degraded' : 'healthy') : (errorRate > 0.5 ? 'down' : 'degraded');
  db.prepare(`
    INSERT INTO provider_health (provider, status, latency_ms, error_rate, success_count, error_count, last_error, last_check)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(provider) DO UPDATE SET
      status = excluded.status, latency_ms = excluded.latency_ms, error_rate = excluded.error_rate,
      success_count = excluded.success_count, error_count = excluded.error_count,
      last_error = COALESCE(excluded.last_error, provider_health.last_error), last_check = excluded.last_check
  `).run(provider, status, latencyMs, errorRate, success, errors, ok ? null : String(errMsg).slice(0, 500));
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) {
      const msg = (json && (json.error?.message || json.message)) || text.slice(0, 300);
      const err = new Error(`HTTP ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Message normalization ----
// Internal format: [{ role: 'system'|'user'|'assistant', content: string|parts }]
// parts: [{ type:'text', text }, { type:'image', mimeType, dataBase64 }, { type:'audio', mimeType, dataBase64 }]

function partsToText(content) {
  if (typeof content === 'string') return content;
  return content.filter(p => p.type === 'text').map(p => p.text).join('\n');
}

async function callOpenAI(provider, model, messages, opts) {
  const p = PROVIDERS[provider];
  const body = {
    model,
    messages: messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        if (part.type === 'image') return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.dataBase64}` } };
        return { type: 'text', text: '[unsupported attachment]' };
      }),
    })),
    max_tokens: opts.maxTokens || 1024,
    temperature: opts.temperature ?? 0.8,
  };
  const headers = { 'Content-Type': 'application/json' };
  const key = apiKey(provider);
  if (key) headers['Authorization'] = `Bearer ${key}`;
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'http://localhost:3000';
    headers['X-Title'] = 'secretary-pro';
  }
  const json = await fetchJson(`${p.baseUrl}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  return {
    text: json.choices?.[0]?.message?.content || '',
    tokensIn: json.usage?.prompt_tokens || 0,
    tokensOut: json.usage?.completion_tokens || 0,
  };
}

async function callGemini(provider, model, messages, opts) {
  const p = PROVIDERS[provider];
  const key = apiKey(provider);
  const system = messages.filter(m => m.role === 'system').map(m => partsToText(m.content)).join('\n\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content.map(part => {
      if (part.type === 'text') return { text: part.text };
      return { inline_data: { mime_type: part.mimeType, data: part.dataBase64 } };
    }),
  }));
  const body = {
    contents,
    generationConfig: { maxOutputTokens: opts.maxTokens || 1024, temperature: opts.temperature ?? 0.8 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const json = await fetchJson(
    `${p.baseUrl}/models/${model}:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const parts = json.candidates?.[0]?.content?.parts || [];
  return {
    text: parts.map(pt => pt.text || '').join(''),
    tokensIn: json.usageMetadata?.promptTokenCount || 0,
    tokensOut: json.usageMetadata?.candidatesTokenCount || 0,
  };
}

async function callAnthropic(provider, model, messages, opts) {
  const p = PROVIDERS[provider];
  const system = messages.filter(m => m.role === 'system').map(m => partsToText(m.content)).join('\n\n');
  const body = {
    model,
    max_tokens: opts.maxTokens || 1024,
    temperature: opts.temperature ?? 0.8,
    messages: messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        if (part.type === 'image') return { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.dataBase64 } };
        return { type: 'text', text: '[unsupported attachment]' };
      }),
    })),
  };
  if (system) body.system = system;
  const json = await fetchJson(`${p.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey(provider),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  return {
    text: (json.content || []).filter(c => c.type === 'text').map(c => c.text).join(''),
    tokensIn: json.usage?.input_tokens || 0,
    tokensOut: json.usage?.output_tokens || 0,
  };
}

async function callCohere(provider, model, messages, opts) {
  const p = PROVIDERS[provider];
  const json = await fetchJson(`${p.baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey(provider)}` },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens || 1024,
      temperature: opts.temperature ?? 0.8,
      messages: messages.map(m => ({ role: m.role, content: partsToText(m.content) })),
    }),
  });
  return {
    text: (json.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join(''),
    tokensIn: json.usage?.tokens?.input_tokens || 0,
    tokensOut: json.usage?.tokens?.output_tokens || 0,
  };
}

const CALLERS = { openai: callOpenAI, gemini: callGemini, anthropic: callAnthropic, cohere: callCohere };

/**
 * Single provider call with usage + health tracking.
 * @returns {Promise<{text, tokensIn, tokensOut, cost, provider, model, latencyMs}>}
 */
async function chatOnce(provider, model, messages, opts = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider: ${provider}`);
  const caller = CALLERS[p.kind];
  const start = Date.now();
  try {
    const result = await caller(provider, model, messages, opts);
    const latencyMs = Date.now() - start;
    const cost = recordUsage(provider, model, result.tokensIn, result.tokensOut);
    recordHealth(provider, true, latencyMs);
    return { ...result, cost, provider, model, latencyMs };
  } catch (err) {
    recordHealth(provider, false, Date.now() - start, err.message);
    throw err;
  }
}

/** Gemini embeddings for vector memory (free tier). Returns float array or null. */
async function embed(text) {
  if (!isConfigured('gemini')) return null;
  try {
    const json = await fetchJson(
      `${PROVIDERS.gemini.baseUrl}/models/text-embedding-004:embedContent?key=${apiKey('gemini')}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 8000) }] } }),
      }
    );
    return json.embedding?.values || null;
  } catch (err) {
    logger.warn(`embed failed: ${err.message}`);
    return null;
  }
}

/** Transcribe a voice note with Gemini multimodal. */
async function transcribeAudio(dataBase64, mimeType) {
  if (!isConfigured('gemini')) throw new Error('GEMINI_API_KEY required for voice transcription');
  const result = await chatOnce('gemini', 'gemini-2.5-flash', [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Transcribe this voice message verbatim. Output ONLY the transcription text, in the original language.' },
        { type: 'audio', mimeType, dataBase64 },
      ],
    },
  ], { temperature: 0 });
  return result.text.trim();
}

module.exports = { chatOnce, embed, transcribeAudio, isConfigured, isVisionModel, PROVIDERS };
