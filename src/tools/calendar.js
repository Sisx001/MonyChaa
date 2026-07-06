'use strict';
// Google Calendar (read) via OAuth refresh token. Optional integration.
const { env } = require('../config');

let cachedToken = null;
let tokenExpiry = 0;

async function accessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`google oauth HTTP ${res.status}`);
  const j = await res.json();
  cachedToken = j.access_token;
  tokenExpiry = Date.now() + (j.expires_in || 3600) * 1000;
  return cachedToken;
}

function available() {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

/** Upcoming events for the next `days` days, formatted for prompt injection. */
async function upcomingEvents(days = 3) {
  const token = await accessToken();
  const now = new Date();
  const max = new Date(now.getTime() + days * 86400000);
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${max.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=15`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`calendar HTTP ${res.status}`);
  const j = await res.json();
  return (j.items || []).map(e => ({
    summary: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
  }));
}

module.exports = { available, upcomingEvents };
