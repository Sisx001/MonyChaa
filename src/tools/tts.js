'use strict';
// Text-to-speech: ElevenLabs (key) or OpenAI TTS (key). Returns audio Buffer + mime.
const { env } = require('../config');

async function speak(text) {
  if (env.ELEVENLABS_API_KEY) {
    const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM', {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`elevenlabs HTTP ${res.status}`);
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg' };
  }
  if (env.OPENAI_API_KEY) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice: 'alloy', input: text, response_format: 'opus' }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`openai tts HTTP ${res.status}`);
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: 'audio/ogg' };
  }
  throw new Error('No TTS provider configured (ELEVENLABS_API_KEY or OPENAI_API_KEY)');
}

function available() {
  return Boolean(env.ELEVENLABS_API_KEY || env.OPENAI_API_KEY);
}

module.exports = { speak, available };
