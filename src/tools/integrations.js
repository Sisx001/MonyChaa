'use strict';
// Optional service integrations: Gmail, GitHub, Notion, Spotify, YouTube, Twitter/X.
// Each is enabled only when its credentials are configured.
const config = require('../config');

async function getJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------- Gmail (shares the Google OAuth refresh token with Calendar) ----------
async function googleToken() {
  const { available } = require('./calendar');
  if (!available()) throw new Error('Google OAuth not configured');
  // calendar.js caches the access token; reuse its flow via a fresh request here.
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.key('GOOGLE_CLIENT_ID'),
      client_secret: config.key('GOOGLE_CLIENT_SECRET'),
      refresh_token: config.key('GOOGLE_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`google oauth HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function gmailUnread(limit = 5) {
  const token = await googleToken();
  const list = await getJson(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!list.messages?.length) return 'No unread emails.';
  const out = [];
  for (const m of list.messages.slice(0, limit)) {
    const msg = await getJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const h = Object.fromEntries((msg.payload?.headers || []).map(x => [x.name, x.value]));
    out.push(`- From ${h.From || '?'}: ${h.Subject || '(no subject)'} — ${msg.snippet || ''}`);
  }
  return 'Unread emails:\n' + out.join('\n');
}

async function gmailSend(to, subject, body) {
  const token = await googleToken();
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64url');
  await getJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await googleToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  return `Email sent to ${to}`;
}

// ---------- GitHub ----------
async function githubNotifications() {
  const rows = await getJson('https://api.github.com/notifications?per_page=8', {
    headers: {
      Authorization: `Bearer ${config.key('GITHUB_TOKEN')}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'secretary-pro',
    },
  });
  if (!rows.length) return 'No GitHub notifications.';
  return 'GitHub notifications:\n' + rows.map(n =>
    `- [${n.subject?.type}] ${n.repository?.full_name}: ${n.subject?.title} (${n.reason})`).join('\n');
}

// ---------- Notion ----------
async function notionSearch(query) {
  const json = await getJson('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.key('NOTION_TOKEN')}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, page_size: 5 }),
  });
  if (!json.results?.length) return 'Nothing found in Notion.';
  return 'Notion results:\n' + json.results.map(r => {
    const title = r.properties?.title?.title?.[0]?.plain_text
      || r.properties?.Name?.title?.[0]?.plain_text
      || Object.values(r.properties || {}).find(p => p.type === 'title')?.title?.[0]?.plain_text
      || '(untitled)';
    return `- ${title} (${r.object}) ${r.url || ''}`;
  }).join('\n');
}

// ---------- Spotify ----------
async function spotifyToken() {
  const auth = Buffer.from(`${config.key('SPOTIFY_CLIENT_ID')}:${config.key('SPOTIFY_CLIENT_SECRET')}`).toString('base64');
  const json = await getJson('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: config.key('SPOTIFY_REFRESH_TOKEN') }),
  });
  return json.access_token;
}

async function spotifyNowPlaying() {
  const token = await spotifyToken();
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
  });
  if (res.status === 204) return 'Nothing playing on Spotify right now.';
  if (!res.ok) throw new Error(`spotify HTTP ${res.status}`);
  const j = await res.json();
  const item = j.item;
  if (!item) return 'Nothing playing on Spotify right now.';
  return `Now playing: "${item.name}" by ${(item.artists || []).map(a => a.name).join(', ')}${j.is_playing ? '' : ' (paused)'}`;
}

// ---------- YouTube ----------
async function youtubeSearch(query) {
  const json = await getJson(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(query)}&key=${config.key('YOUTUBE_API_KEY')}`
  );
  if (!json.items?.length) return 'No YouTube results.';
  return 'YouTube results:\n' + json.items.map(v =>
    `- ${v.snippet.title} (${v.snippet.channelTitle}) https://youtu.be/${v.id.videoId}`).join('\n');
}

// ---------- Twitter / X ----------
async function twitterSearch(query) {
  const json = await getJson(
    `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=10&tweet.fields=author_id,created_at`,
    { headers: { Authorization: `Bearer ${config.key('TWITTER_BEARER_TOKEN')}` } }
  );
  if (!json.data?.length) return 'No recent tweets found.';
  return 'Recent tweets:\n' + json.data.slice(0, 5).map(t => `- ${t.text.replace(/\n/g, ' ').slice(0, 180)}`).join('\n');
}

module.exports = {
  gmailUnread, gmailSend, githubNotifications, notionSearch,
  spotifyNowPlaying, youtubeSearch, twitterSearch,
};
