'use strict';
// Telegram-side settings: configure the assistant by DMing the bot.
// Owner-only. Mirrors the panel's most-used controls.
const config = require('../config');

// Whitelist of settings safe to change from Telegram, with light validation.
const SETTABLE = {
  temperature: v => (Number(v) >= 0 && Number(v) <= 2 ? String(v) : null),
  reply_style: v => (['concise', 'balanced', 'detailed'].includes(v) ? v : null),
  emoji_usage: v => (['none', 'light', 'natural', 'heavy'].includes(v) ? v : null),
  typing_speed: v => (['slow', 'medium', 'fast'].includes(v) ? v : null),
  typing_simulation: onoff, away_mode: onoff, bot_enabled: onoff,
  auto_read: onoff, reply_in_groups: onoff, group_mention_only: onoff,
  footer_enabled: onoff, skills_enabled: onoff, auto_search: onoff,
  language: v => v,
  agent_name: v => v,
  message_footer: v => v,
  away_message: v => v,
  offline_message: v => v,
  max_response_length: v => (Number(v) > 0 ? String(Math.floor(Number(v))) : null),
  reply_probability: v => (Number(v) >= 0 && Number(v) <= 100 ? String(Math.floor(Number(v))) : null),
};
function onoff(v) { return ['on', 'off'].includes(String(v).toLowerCase()) ? String(v).toLowerCase() : null; }

function register(bot, assistant, isOwner) {
  bot.command('settings', ctx => {
    if (!isOwner(ctx)) return;
    const keys = ['bot_enabled', 'away_mode', 'temperature', 'reply_style', 'emoji_usage', 'typing_speed', 'language', 'agent_name', 'reply_in_groups', 'max_response_length'];
    const lines = keys.map(k => `${k}: ${config.getSetting(k) || '(empty)'}`);
    ctx.reply('Current settings:\n' + lines.join('\n') + '\n\nChange with: /set key value');
  });

  bot.command('get', ctx => {
    if (!isOwner(ctx)) return;
    const key = ctx.match?.trim();
    if (!key) return ctx.reply('Usage: /get <key>');
    ctx.reply(`${key} = ${config.getSetting(key) || '(empty)'}`);
  });

  bot.command('set', ctx => {
    if (!isOwner(ctx)) return;
    const parts = (ctx.match || '').trim().split(/\s+/);
    const key = parts.shift();
    const value = parts.join(' ');
    if (!key) return ctx.reply('Usage: /set <key> <value>\nSettable: ' + Object.keys(SETTABLE).join(', '));
    if (!(key in SETTABLE)) return ctx.reply(`"${key}" can't be set from Telegram. Settable keys:\n${Object.keys(SETTABLE).join(', ')}`);
    const validated = SETTABLE[key](value);
    if (validated === null) return ctx.reply(`Invalid value for ${key}.`);
    config.setSetting(key, validated);
    ctx.reply(`Set ${key} = ${validated}`);
  });

  bot.command('persona', ctx => {
    if (!isOwner(ctx)) return;
    const text = (ctx.match || '').trim();
    if (!text) return ctx.reply('Usage: /persona <system prompt text>\nCurrent:\n' + config.getSetting('system_prompt').slice(0, 500));
    const db = require('../db/schema');
    db.prepare('INSERT INTO prompt_versions (name, content) VALUES (?, ?)').run('backup before /persona', config.getSetting('system_prompt'));
    config.setSetting('system_prompt', text);
    config.setSetting('active_preset', 'Custom');
    ctx.reply('Persona updated (previous saved as a version).');
  });

  bot.command('model', ctx => {
    if (!isOwner(ctx)) return;
    const [provider, ...rest] = (ctx.match || '').trim().split(/\s+/);
    const model = rest.join(' ');
    if (!provider) {
      return ctx.reply(`Current: ${config.getSetting('primary_provider')}/${config.getSetting('primary_model')}\nUsage: /model <provider> <model>`);
    }
    const { PROVIDERS, isConfigured } = require('../llm/providers');
    if (!PROVIDERS[provider]) return ctx.reply(`Unknown provider. Options: ${Object.keys(PROVIDERS).join(', ')}`);
    if (!isConfigured(provider)) return ctx.reply(`${provider} has no API key configured.`);
    config.setSetting('primary_provider', provider);
    if (model) config.setSetting('primary_model', model);
    ctx.reply(`Primary model: ${config.getSetting('primary_provider')}/${config.getSetting('primary_model')}`);
  });

  bot.command('character', ctx => {
    if (!isOwner(ctx)) return;
    const id = (ctx.match || '').trim().toLowerCase();
    const characters = require('../characters');
    if (!id) return ctx.reply('Usage: /character <id>\nAvailable: ' + characters.CHARACTERS.map(c => c.id).join(', '));
    try {
      const c = characters.apply(id);
      ctx.reply(`Applied character: ${c.name}`);
    } catch (err) { ctx.reply(err.message); }
  });

  bot.command('skills', ctx => {
    if (!isOwner(ctx)) return;
    const skills = require('../skills').list();
    if (!skills.length) return ctx.reply('No skills installed.');
    ctx.reply('Skills:\n' + skills.map(s => `${s.enabled ? '[on] ' : '[off]'} ${s.name}`).join('\n'));
  });
}

function helpText(port) {
  return [
    'Commands:',
    '/status — status & stats',
    '/pause — pause/resume auto-replies',
    '/away — toggle away mode',
    '/settings — show current settings',
    '/set key value — change a setting',
    '/get key — read a setting',
    '/persona text — set the system prompt',
    '/model provider model — set the model',
    '/character id — apply a preloaded character',
    '/skills — list skills',
    '/summary — daily summary',
    '/id — show Telegram id',
    `Panel: http://localhost:${port}`,
  ].join('\n');
}

module.exports = { register, helpText, SETTABLE };
