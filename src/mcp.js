'use strict';
// Minimal MCP (Model Context Protocol) client over streamable HTTP.
// Connect any HTTP MCP server: its tools are discovered via tools/list and
// exposed to the LLM tool pre-pass as `mcp:<server>:<tool>`.
const db = require('./db/schema');
const logger = require('./logger');

const sessions = new Map(); // server id → Mcp-Session-Id
let rpcId = 1;

function parseHeaders(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

async function rpc(server, method, params, { notification = false } = {}) {
  const id = notification ? undefined : rpcId++;
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!notification) body.id = id;

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...parseHeaders(server.headers),
  };
  const session = sessions.get(server.id);
  if (session) headers['Mcp-Session-Id'] = session;

  const res = await fetch(server.url, {
    method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const newSession = res.headers.get('mcp-session-id');
  if (newSession) sessions.set(server.id, newSession);

  if (notification) return null; // fire-and-forget; some servers return 202
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);

  let json = null;
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    // Streamable HTTP: the response arrives as SSE `data:` lines.
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const obj = JSON.parse(line.slice(5).trim());
        if (obj.id === id || obj.result !== undefined || obj.error) json = obj;
      } catch { /* keep scanning */ }
    }
  } else if (text.trim()) {
    json = JSON.parse(text);
  }
  if (!json) throw new Error('MCP: empty response');
  if (json.error) throw new Error(json.error.message || `MCP error ${json.error.code}`);
  return json.result;
}

/** Initialize the session and refresh the server's tool list. */
async function connect(serverId) {
  const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId);
  if (!server) throw new Error('server not found');
  sessions.delete(server.id);
  try {
    await rpc(server, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'secretary-pro', version: '1.0.0' },
    });
    await rpc(server, 'notifications/initialized', undefined, { notification: true }).catch(() => {});
    const result = await rpc(server, 'tools/list', {});
    const tools = (result.tools || []).map(t => ({
      name: t.name,
      description: (t.description || '').slice(0, 300),
      schema: t.inputSchema || {},
    }));
    db.prepare(`UPDATE mcp_servers SET status = 'connected', tools_json = ?, last_error = NULL,
      last_connected = datetime('now') WHERE id = ?`).run(JSON.stringify(tools), server.id);
    logger.info(`MCP ${server.name}: connected, ${tools.length} tools`);
    return tools;
  } catch (err) {
    db.prepare("UPDATE mcp_servers SET status = 'error', last_error = ? WHERE id = ?")
      .run(err.message.slice(0, 300), server.id);
    throw err;
  }
}

/** Call a tool on a connected server. Returns text output. */
async function callTool(serverId, toolName, args) {
  const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId);
  if (!server) throw new Error('server not found');
  if (!sessions.get(server.id)) await connect(server.id);
  const result = await rpc(server, 'tools/call', { name: toolName, arguments: args || {} });
  const content = result?.content || [];
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (result?.isError) throw new Error(text.slice(0, 300) || 'MCP tool error');
  return text || JSON.stringify(result).slice(0, 2000);
}

/** All tools from enabled servers, qualified as mcp:<server>:<tool>. */
function allTools() {
  const out = [];
  for (const server of db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1').all()) {
    let tools = [];
    try { tools = JSON.parse(server.tools_json || '[]'); } catch {}
    for (const t of tools) {
      out.push({
        qualified: `mcp:${server.name}:${t.name}`,
        serverId: server.id,
        tool: t.name,
        description: `[MCP ${server.name}] ${t.description}`,
        args: JSON.stringify(t.schema?.properties ? Object.fromEntries(
          Object.entries(t.schema.properties).slice(0, 6).map(([k, v]) => [k, v.type || 'any'])
        ) : {}),
      });
    }
  }
  return out;
}

/** Call by qualified name mcp:<server>:<tool>. */
async function callQualified(qualified, args) {
  const m = /^mcp:([^:]+):(.+)$/.exec(qualified);
  if (!m) throw new Error(`bad MCP tool name: ${qualified}`);
  const server = db.prepare('SELECT * FROM mcp_servers WHERE name = ? AND enabled = 1').get(m[1]);
  if (!server) throw new Error(`MCP server not found or disabled: ${m[1]}`);
  return callTool(server.id, m[2], args);
}

module.exports = { connect, callTool, allTools, callQualified };
