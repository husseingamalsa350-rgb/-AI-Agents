#!/usr/bin/env node
// AgentTeam — a small local "team of AI agents" chat app.
// Zero dependencies: run with `node server.js`.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.AGENT_TEAM_DATA || path.join(__dirname, 'data'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_STEPS = 12; // agent replies allowed per user message (stops runaway loops)
const HISTORY_LIMIT = 40; // messages of thread memory sent to the model
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 60 * 1000;
const MAX_OUTPUT = 20000;

// ---------------------------------------------------------------- providers
// Each provider is a locally installed CLI that uses the user's own login.
// `{prompt}` in args is replaced by the prompt; with `stdin: true` the prompt
// is written to stdin instead. `modelArgs` is added only when a model is set.
// Override or add providers in data/providers.json.
const PROVIDERS = {
  claude: { label: 'Claude Code CLI', cmd: 'claude', args: ['-p'], modelArgs: ['--model', '{model}'], stdin: true },
  codex: {
    label: 'Codex CLI',
    cmd: 'codex',
    args: ['exec', '--skip-git-repo-check', '-'],
    modelArgs: ['-m', '{model}'],
    stdin: true,
  },
  grok: { label: 'Grok CLI', cmd: 'grok', args: ['-p', '{prompt}'], modelArgs: ['-m', '{model}'], stdin: false },
  demo: { label: 'Demo (no model)', builtin: true },
};

function loadProviderOverrides() {
  try {
    const extra = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'providers.json'), 'utf8'));
    for (const [id, def] of Object.entries(extra)) PROVIDERS[id] = { ...PROVIDERS[id], ...def };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Ignoring data/providers.json: ${err.message}`);
  }
}

function isOnPath(cmd) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return probe.status === 0;
}

function providerList() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label || id,
    available: p.builtin ? true : isOnPath(p.cmd),
  }));
}

// -------------------------------------------------------------------- state
let state = { agents: [], conversations: [] };
const busy = new Map(); // conversationId -> agentId currently thinking

const newId = () => crypto.randomUUID().slice(0, 8);

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return;
  }
  const available = providerList().filter((p) => p.available && p.id !== 'demo');
  const provider = available.length ? available[0].id : 'demo';
  const seed = [
    { name: 'Coder', emoji: '👨‍💻', persona: 'A pragmatic senior software engineer. Writes small, correct code and explains trade-offs briefly.' },
    { name: 'Researcher', emoji: '🔎', persona: 'A careful researcher. Separates facts from guesses and says what would need checking.' },
    { name: 'Analyst', emoji: '📊', persona: 'A data analyst. Thinks in tables and numbers, and states assumptions up front.' },
  ];
  for (const a of seed) createAgent({ ...a, provider, model: '' });
  createChannel({ name: 'team', agentIds: state.agents.map((a) => a.id) });
  saveNow();
}

let saveTimer = null;
function saveNow() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

const getAgent = (id) => state.agents.find((a) => a.id === id);
const getConv = (id) => state.conversations.find((c) => c.id === id);

function cleanAgentInput(input, base = {}) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
  const out = { ...base };
  const name = str(input.name, 40);
  if (name !== undefined) out.name = name.replace(/@/g, '');
  if (str(input.emoji, 8) !== undefined) out.emoji = str(input.emoji, 8) || '🤖';
  if (str(input.persona, 4000) !== undefined) out.persona = str(input.persona, 4000);
  if (str(input.model, 80) !== undefined) out.model = str(input.model, 80);
  if (input.provider !== undefined) {
    if (!Object.hasOwn(PROVIDERS, input.provider)) throw httpError(400, 'Unknown provider');
    out.provider = input.provider;
  }
  if (!out.name) throw httpError(400, 'Agent name is required');
  return out;
}

function createAgent(input) {
  const agent = cleanAgentInput(input, { id: newId(), emoji: '🤖', persona: '', provider: 'demo', model: '' });
  state.agents.push(agent);
  state.conversations.push({ id: 'dm-' + agent.id, type: 'dm', agentIds: [agent.id], messages: [], steps: 0 });
  return agent;
}

function createChannel(input) {
  const name = String(input.name || '').trim().replace(/^#/, '').slice(0, 40);
  const agentIds = (Array.isArray(input.agentIds) ? input.agentIds : []).filter((id) => getAgent(id));
  if (!name) throw httpError(400, 'Channel name is required');
  if (!agentIds.length) throw httpError(400, 'Pick at least one agent');
  const conv = { id: 'ch-' + newId(), type: 'channel', name, agentIds, messages: [], steps: 0 };
  state.conversations.push(conv);
  return conv;
}

function addMessage(conv, msg) {
  const full = { id: newId(), ts: Date.now(), ...msg };
  conv.messages.push(full);
  save();
  broadcast();
  return full;
}

// ------------------------------------------------------------ agent runtime
function workspaceFor(agent) {
  const dir = path.join(DATA_DIR, 'workspaces', agent.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function buildPrompt(agent, conv) {
  const lines = [];
  lines.push(`You are ${agent.name}, an AI agent in a team chat app. Stay in character.`);
  if (agent.persona) lines.push(`Your persona: ${agent.persona}`);
  if (conv.type === 'channel') {
    const others = conv.agentIds.map(getAgent).filter((a) => a && a.id !== agent.id).map((a) => a.name);
    lines.push(
      `You are in the channel #${conv.name}` +
        (others.length ? ` with these other agents: ${others.join(', ')}.` : '.') +
        ' Reply only as yourself. To hand something to another agent, mention them as @Name.'
    );
  }
  lines.push(
    '',
    'You have a workspace computer. To run a shell command there, include exactly one fenced block like this in your reply:',
    '```run',
    '<one shell command>',
    '```',
    'The user must approve every command before it runs, and you will then be shown its output.',
    'Request at most one command per reply, and only when it is really needed. Otherwise just answer.',
    '',
    'Conversation so far:'
  );
  for (const m of conv.messages.slice(-HISTORY_LIMIT)) {
    const who = m.agentId ? (getAgent(m.agentId) || { name: 'Former agent' }).name : 'User';
    if (m.role === 'user') lines.push(`User: ${m.text}`);
    else if (m.role === 'agent') lines.push(`${who}: ${m.text}`);
    else if (m.role === 'approval') {
      let line = `[${who} requested the command: ${m.command}] -> `;
      if (m.status === 'approved') line += `approved, exit code ${m.exitCode}, output:\n${(m.output || '(no output)').slice(0, 6000)}`;
      else if (m.status === 'denied') line += 'the user DENIED it; do not retry it.';
      else line += 'still waiting for approval.';
      lines.push(line);
    }
  }
  lines.push('', `Write ${agent.name}'s next reply now. Output only the reply text.`);
  return lines.join('\n');
}

function demoReply(agent, conv) {
  const last = conv.messages[conv.messages.length - 1] || {};
  if (last.role === 'approval') {
    if (last.status === 'denied') return 'Understood — I will not run that command.';
    return `Done. The command exited with code ${last.exitCode}.` + (last.output ? `\n\`\`\`\n${last.output.slice(0, 1500)}\n\`\`\`` : '');
  }
  const text = last.text || '';
  const run = text.match(/(?:^|\s)run:\s*(.+)$/im);
  if (run) return `I'd like to run this on my workspace computer:\n\`\`\`run\n${run[1].trim()}\n\`\`\``;
  return (
    `(demo mode) ${agent.name} here. I received: "${text.slice(0, 200)}".\n` +
    'No model is connected to me yet — edit me and choose the claude, codex or grok provider to get real answers. ' +
    'Try "run: ls -la" to see the approval flow.'
  );
}

function runProvider(agent, conv) {
  const provider = PROVIDERS[agent.provider];
  if (!provider) return Promise.reject(new Error(`unknown provider "${agent.provider}"`));
  if (provider.builtin) return new Promise((resolve) => setTimeout(() => resolve(demoReply(agent, conv)), 400));

  const prompt = buildPrompt(agent, conv);
  const fill = (arg) => arg.replace('{prompt}', prompt).replace('{model}', agent.model || '');
  const args = [...(provider.args || []), ...(agent.model ? provider.modelArgs || [] : [])].map(fill);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(provider.cmd, args, { cwd: workspaceFor(agent), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(err);
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), AGENT_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? `the "${provider.cmd}" CLI is not installed or not on PATH` : e.message));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error(`timed out or was killed (${signal})`));
      if (code !== 0) return reject(new Error(`${provider.cmd} exited with code ${code}: ${err.trim() || out.trim().slice(-500)}`));
      resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(provider.stdin ? prompt : '');
  });
}

function runCommand(agent, command) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd: workspaceFor(agent), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (d) => {
      if (output.length < MAX_OUTPUT) output += d;
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS);
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, output: `Failed to start: ${e.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (output.length >= MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + '\n… (output truncated)';
      resolve({ exitCode: signal ? -1 : code, output: signal ? output + `\n(killed: ${signal})` : output });
    });
  });
}

// One agent turn. Returns { text } on a normal reply, { paused: true } when the
// agent asked for a command and is waiting on approval, or null on failure.
async function agentTurn(conv, agent) {
  if (conv.steps >= MAX_STEPS) {
    addMessage(conv, { role: 'system', text: `Step limit reached (${MAX_STEPS} agent replies). Send a new message to continue.` });
    return { stop: true };
  }
  conv.steps++;
  busy.set(conv.id, agent.id);
  broadcast();
  let reply;
  try {
    reply = await runProvider(agent, conv);
  } catch (err) {
    addMessage(conv, { role: 'system', text: `${agent.name} could not reply: ${err.message}` });
    return null;
  } finally {
    busy.delete(conv.id);
    broadcast();
  }
  if (!getConv(conv.id)) return { stop: true }; // deleted while the agent was thinking

  const block = reply.match(/```run[ \t]*\r?\n([\s\S]*?)```/);
  const text = (block ? reply.replace(block[0], '') : reply).trim();
  if (text) addMessage(conv, { role: 'agent', agentId: agent.id, text });
  const command = block && block[1].trim();
  if (command) {
    addMessage(conv, { role: 'approval', agentId: agent.id, command, status: 'pending' });
    return { paused: true };
  }
  if (!text) addMessage(conv, { role: 'system', text: `${agent.name} returned an empty reply.` });
  return { text };
}

function mentionedAgents(conv, text) {
  const lower = text.toLowerCase();
  return conv.agentIds.filter((id) => {
    const a = getAgent(id);
    return a && lower.includes('@' + a.name.toLowerCase());
  });
}

async function dispatch(conv, queue) {
  while (queue.length) {
    const agent = getAgent(queue.shift());
    if (!agent || !conv.agentIds.includes(agent.id)) continue;
    const result = await agentTurn(conv, agent);
    if (!result) continue;
    if (result.stop) return;
    if (result.paused) {
      conv.waiting = queue;
      save();
      return;
    }
    if (conv.type === 'channel') {
      for (const id of mentionedAgents(conv, result.text)) {
        if (id !== agent.id && !queue.includes(id)) queue.push(id);
      }
    }
  }
}

// Serialise work per conversation so replies never interleave.
const chains = new Map();
function enqueue(convId, job) {
  const next = (chains.get(convId) || Promise.resolve()).then(job).catch((err) => console.error(err));
  chains.set(convId, next);
  return next;
}

function handleUserMessage(conv, text) {
  addMessage(conv, { role: 'user', text });
  enqueue(conv.id, () => {
    conv.steps = 0;
    conv.waiting = [];
    let queue = conv.agentIds.slice();
    if (conv.type === 'channel') {
      const mentioned = mentionedAgents(conv, text);
      if (mentioned.length) queue = mentioned;
    }
    return dispatch(conv, queue);
  });
}

function handleDecision(conv, msg, approve) {
  if (msg.status !== 'pending') throw httpError(409, 'Already decided');
  msg.status = approve ? 'running' : 'denied';
  save();
  broadcast();
  enqueue(conv.id, async () => {
    const agent = getAgent(msg.agentId);
    if (approve) {
      const result = agent ? await runCommand(agent, msg.command) : { exitCode: -1, output: 'Agent no longer exists.' };
      Object.assign(msg, result, { status: 'approved' });
      save();
      broadcast();
    }
    const stillLast = conv.messages[conv.messages.length - 1] === msg;
    if (!agent || !stillLast) return; // the conversation moved on; don't resume the old turn
    const rest = conv.waiting || [];
    conv.waiting = [];
    return dispatch(conv, [agent.id, ...rest]);
  });
}

// --------------------------------------------------------------------- http
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const sseClients = new Set();
function broadcast() {
  for (const res of sseClients) res.write('data: update\n\n');
}

function publicState() {
  return {
    agents: state.agents,
    conversations: state.conversations.map((c) => ({ ...c, busy: busy.get(c.id) || null })),
    providers: providerList(),
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 1e6) reject(httpError(413, 'Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

// This server can run shell commands, so refuse requests a random web page
// could forge: DNS-rebinding (unexpected Host) and cross-site POSTs.
function checkRequest(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (LOOPBACK && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) throw httpError(403, 'Bad Host header');
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host.toLowerCase() !== host) throw httpError(403, 'Cross-origin request blocked');
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw httpError(415, 'JSON required');
  }
}

async function api(req, res, parts) {
  const method = req.method;
  const [resource, id, sub, subId] = parts;
  const body = method === 'GET' ? {} : await readJson(req);

  if (resource === 'state' && method === 'GET') return publicState();

  if (resource === 'agents') {
    if (method === 'POST' && !id) {
      const agent = createAgent(body);
      return agent;
    }
    const agent = getAgent(id);
    if (!agent) throw httpError(404, 'Agent not found');
    if (method === 'PUT') return Object.assign(agent, cleanAgentInput(body, agent));
    if (method === 'DELETE') {
      state.agents = state.agents.filter((a) => a !== agent);
      state.conversations = state.conversations.filter((c) => c.id !== 'dm-' + agent.id);
      for (const c of state.conversations) c.agentIds = c.agentIds.filter((x) => x !== agent.id);
      return { ok: true };
    }
  }

  if (resource === 'channels' && method === 'POST') return createChannel(body);

  if (resource === 'conversations') {
    const conv = getConv(id);
    if (!conv) throw httpError(404, 'Conversation not found');
    if (method === 'DELETE' && !sub) {
      if (conv.type !== 'channel') throw httpError(400, 'Only channels can be deleted');
      state.conversations = state.conversations.filter((c) => c !== conv);
      return { ok: true };
    }
    if (method === 'POST' && sub === 'clear') {
      conv.messages = [];
      conv.steps = 0;
      conv.waiting = [];
      return { ok: true };
    }
    if (method === 'POST' && sub === 'messages') {
      const text = String(body.text || '').trim().slice(0, 20000);
      if (!text) throw httpError(400, 'Empty message');
      handleUserMessage(conv, text);
      return { ok: true };
    }
    if (method === 'POST' && sub === 'approvals') {
      const msg = conv.messages.find((m) => m.id === subId && m.role === 'approval');
      if (!msg) throw httpError(404, 'Approval not found');
      if (body.decision !== 'approve' && body.decision !== 'deny') throw httpError(400, 'decision must be approve or deny');
      handleDecision(conv, msg, body.decision === 'approve');
      return { ok: true };
    }
  }
  throw httpError(404, 'Not found');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(pathname, res) {
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw httpError(403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    checkRequest(req);
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('data: update\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (pathname.startsWith('/api/')) {
      const result = await api(req, res, pathname.slice(5).split('/'));
      if (req.method !== 'GET') {
        save();
        broadcast();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    if (req.method !== 'GET') throw httpError(405, 'Method not allowed');
    serveStatic(pathname, res);
  } catch (err) {
    if (!err.status) console.error(err);
    res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.status ? err.message : 'Internal error' }));
  }
});

loadProviderOverrides();
loadState();
server.listen(PORT, HOST, () => {
  console.log(`AgentTeam running at http://${LOOPBACK ? 'localhost' : HOST}:${PORT}`);
  if (!LOOPBACK) {
    console.warn('WARNING: listening on a non-loopback address with NO authentication.');
    console.warn('Anyone who can reach this port can approve shell commands. Prefer an SSH tunnel or a VPN.');
  }
});
