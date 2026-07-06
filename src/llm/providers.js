'use strict';
// Provider registry. Every provider speaks either the OpenAI-compatible chat API
// or (for Gemini/Anthropic/Cohere) its native API, normalized by gateway.js.
const { env } = require('../config');

// Cost per 1M tokens [input, output] in USD (0 = free tier / local).
const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyEnv: 'GEMINI_API_KEY',
    free: true,
    vision: true,
    models: {
      'gemini-2.5-flash': { cost: [0, 0], vision: true },
      'gemini-2.5-pro': { cost: [0, 0], vision: true },
      'gemini-2.0-flash': { cost: [0, 0], vision: true },
    },
  },
  groq: {
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    free: true,
    models: {
      'llama-3.3-70b-versatile': { cost: [0.59, 0.79] },
      'llama-3.1-8b-instant': { cost: [0.05, 0.08] },
      'mixtral-8x7b-32768': { cost: [0.24, 0.24] },
    },
  },
  mistral: {
    label: 'Mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    free: true,
    models: {
      'mistral-large-latest': { cost: [2, 6] },
      'mistral-small-latest': { cost: [0.1, 0.3] },
      'open-mistral-nemo': { cost: [0.15, 0.15] },
    },
  },
  cohere: {
    label: 'Cohere',
    kind: 'cohere',
    baseUrl: 'https://api.cohere.com/v2',
    keyEnv: 'COHERE_API_KEY',
    free: true,
    models: {
      'command-r-plus': { cost: [2.5, 10] },
      'command-r': { cost: [0.15, 0.6] },
    },
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    free: true,
    models: {
      'meta-llama/llama-3.3-70b-instruct:free': { cost: [0, 0] },
      'google/gemini-2.0-flash-exp:free': { cost: [0, 0], vision: true },
      'deepseek/deepseek-chat-v3-0324:free': { cost: [0, 0] },
      'anthropic/claude-sonnet-4': { cost: [3, 15], vision: true },
      'openai/gpt-4o': { cost: [2.5, 10], vision: true },
    },
  },
  ollama: {
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: (env.OLLAMA_URL || 'http://localhost:11434') + '/v1',
    keyEnv: null,
    urlEnv: 'OLLAMA_URL',
    free: true,
    models: { 'llama3.2': { cost: [0, 0] }, 'qwen2.5': { cost: [0, 0] } },
  },
  lmstudio: {
    label: 'LM Studio (local)',
    kind: 'openai',
    baseUrl: (env.LMSTUDIO_URL || 'http://localhost:1234') + '/v1',
    keyEnv: null,
    urlEnv: 'LMSTUDIO_URL',
    free: true,
    models: { 'local-model': { cost: [0, 0] } },
  },
  deepseek: {
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
    free: true,
    models: {
      'deepseek-chat': { cost: [0.27, 1.1] },
      'deepseek-reasoner': { cost: [0.55, 2.19] },
    },
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    models: {
      'gpt-4o': { cost: [2.5, 10], vision: true },
      'gpt-4o-mini': { cost: [0.15, 0.6], vision: true },
      'gpt-4-turbo': { cost: [10, 30], vision: true },
      'o3-mini': { cost: [1.1, 4.4] },
      'o1': { cost: [15, 60] },
    },
  },
  anthropic: {
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyEnv: 'ANTHROPIC_API_KEY',
    models: {
      'claude-sonnet-4-20250514': { cost: [3, 15], vision: true },
      'claude-opus-4-20250514': { cost: [15, 75], vision: true },
      'claude-3-5-haiku-20241022': { cost: [0.8, 4], vision: true },
    },
  },
  together: {
    label: 'Together AI',
    kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    keyEnv: 'TOGETHER_API_KEY',
    models: {
      'meta-llama/Llama-3.3-70B-Instruct-Turbo': { cost: [0.88, 0.88] },
      'Qwen/Qwen2.5-72B-Instruct-Turbo': { cost: [1.2, 1.2] },
    },
  },
  perplexity: {
    label: 'Perplexity',
    kind: 'openai',
    baseUrl: 'https://api.perplexity.ai',
    keyEnv: 'PERPLEXITY_API_KEY',
    models: {
      'sonar': { cost: [1, 1] },
      'sonar-pro': { cost: [3, 15] },
    },
  },
  xai: {
    label: 'xAI Grok',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    keyEnv: 'XAI_API_KEY',
    models: {
      'grok-3': { cost: [3, 15] },
      'grok-3-mini': { cost: [0.3, 0.5] },
    },
  },
};

function apiKey(providerId) {
  const p = PROVIDERS[providerId];
  if (!p || !p.keyEnv) return '';
  return env[p.keyEnv] || '';
}

function isConfigured(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return false;
  if (p.keyEnv) return Boolean(env[p.keyEnv]);
  if (p.urlEnv) return Boolean(env[p.urlEnv]); // local providers need explicit URL
  return false;
}

function modelCost(providerId, model) {
  const p = PROVIDERS[providerId];
  const m = p && p.models[model];
  return m ? m.cost : [0, 0];
}

function isVisionModel(providerId, model) {
  const p = PROVIDERS[providerId];
  if (!p) return false;
  const m = p.models[model];
  return Boolean((m && m.vision) || p.vision);
}

module.exports = { PROVIDERS, apiKey, isConfigured, modelCost, isVisionModel };
