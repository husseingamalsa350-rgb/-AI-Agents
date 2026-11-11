'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

let state = { agents: [], conversations: [], providers: [] };
let currentId = localStorage.getItem('conversation') || null;
let editingAgentId = null;

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const act = (promise) => promise.catch((err) => alert(err.message));

const agentById = (id) => state.agents.find((a) => a.id === id);
const currentConv = () => state.conversations.find((c) => c.id === currentId);

async function refresh() {
  state = await request('GET', '/api/state');
  if (!currentConv()) currentId = state.conversations[0] ? state.conversations[0].id : null;
  render();
}

function select(id) {
  currentId = id;
  localStorage.setItem('conversation', id);
  document.body.classList.remove('nav-open');
  render();
  $('#input').focus();
}

// ------------------------------------------------------------------ render
function render() {
  renderSidebar();
  renderChat();
}

function pendingCount(conv) {
  return conv.messages.filter((m) => m.role === 'approval' && m.status === 'pending').length;
}

function navItem(conv, icon, title, subtitle) {
  const pending = pendingCount(conv);
  const item = el(
    'li',
    { className: conv.id === currentId ? 'active' : '', onclick: () => select(conv.id) },
    el('span', { className: 'avatar', textContent: icon }),
    el('span', { className: 'who' }, el('strong', { textContent: title }), el('small', { textContent: subtitle }))
  );
  if (pending) item.append(el('span', { className: 'badge', textContent: String(pending), title: 'Waiting for approval' }));
  else if (conv.busy) item.append(el('span', { className: 'dot', title: 'Working…' }));
  return item;
}

function renderSidebar() {
  const agents = state.agents.map((a) => {
    const conv = state.conversations.find((c) => c.id === 'dm-' + a.id);
    return navItem(conv, a.emoji, a.name, a.provider + (a.model ? ' · ' + a.model : ''));
  });
  $('#agent-list').replaceChildren(...agents);

  const channels = state.conversations
    .filter((c) => c.type === 'channel')
    .map((c) => navItem(c, '#', c.name, c.agentIds.map((id) => (agentById(id) || {}).name).filter(Boolean).join(', ')));
  $('#channel-list').replaceChildren(...channels);
}

// Plain text with ``` fences rendered as <pre>. Never uses innerHTML.
function richText(text) {
  const frag = document.createDocumentFragment();
  text.split(/```[^\n]*\n?/).forEach((part, i) => {
    if (!part.trim()) return;
    frag.append(i % 2 ? el('pre', { textContent: part.replace(/\n$/, '') }) : el('p', { textContent: part.trim(), dir: 'auto' }));
  });
  return frag;
}

function approvalCard(conv, m, agent) {
  const labels = { pending: 'Needs your approval', running: 'Running…', approved: 'Approved', denied: 'Denied' };
  const card = el(
    'div',
    { className: 'approval ' + m.status },
    el('div', { className: 'approval-head', textContent: `${labels[m.status]} — ${agent.name} wants to run a command` }),
    el('pre', { textContent: m.command })
  );
  if (m.status === 'pending') {
    const decide = (decision) => act(request('POST', `/api/conversations/${conv.id}/approvals/${m.id}`, { decision }));
    card.append(
      el(
        'div',
        { className: 'approval-actions' },
        el('button', { className: 'primary', textContent: 'Approve & run', onclick: () => decide('approve') }),
        el('button', { textContent: 'Deny', onclick: () => decide('deny') })
      )
    );
  }
  if (m.status === 'approved') {
    card.append(
      el('div', { className: 'exit', textContent: `exit code ${m.exitCode}` }),
      el('pre', { className: 'output', textContent: m.output || '(no output)' })
    );
  }
  return card;
}

function renderChat() {
  const conv = currentConv();
  const box = $('#messages');
  $('#composer').hidden = !conv;
  if (!conv) {
    $('#chat-title').textContent = '';
    $('#chat-actions').replaceChildren();
    box.replaceChildren(el('p', { className: 'empty', textContent: 'Create an agent to get started.' }));
    return;
  }

  const dmAgent = conv.type === 'dm' ? agentById(conv.agentIds[0]) : null;
  $('#chat-title').textContent = dmAgent ? `${dmAgent.emoji} ${dmAgent.name}` : `# ${conv.name}`;
  $('#input').placeholder = dmAgent ? `Message ${dmAgent.name}…` : `Message #${conv.name} — use @Name to address one agent`;

  const actions = [
    el('button', {
      textContent: 'Clear',
      title: 'Forget this thread',
      onclick: () => confirm('Clear this conversation and its memory?') && act(request('POST', `/api/conversations/${conv.id}/clear`, {})),
    }),
  ];
  if (dmAgent) actions.unshift(el('button', { textContent: 'Edit', onclick: () => openAgentDialog(dmAgent) }));
  else
    actions.push(
      el('button', {
        textContent: 'Delete',
        className: 'danger',
        onclick: () => confirm(`Delete #${conv.name}?`) && act(request('DELETE', `/api/conversations/${conv.id}`, {})),
      })
    );
  $('#chat-actions').replaceChildren(...actions);

  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const nodes = conv.messages.map((m) => {
    if (m.role === 'system') return el('div', { className: 'msg system', textContent: m.text });
    if (m.role === 'user') return el('div', { className: 'msg user' }, el('div', { className: 'bubble' }, richText(m.text)));
    const agent = agentById(m.agentId) || { name: 'Former agent', emoji: '👻' };
    const body = m.role === 'approval' ? approvalCard(conv, m, agent) : el('div', { className: 'bubble' }, richText(m.text));
    return el(
      'div',
      { className: 'msg agent' },
      el('span', { className: 'avatar', textContent: agent.emoji }),
      el('div', { className: 'body' }, el('div', { className: 'name', textContent: agent.name }), body)
    );
  });
  if (!nodes.length) nodes.push(el('p', { className: 'empty', textContent: 'No messages yet. Say hello.' }));
  if (conv.busy) {
    const agent = agentById(conv.busy) || { name: 'Agent' };
    nodes.push(el('div', { className: 'msg system typing', textContent: `${agent.name} is working…` }));
  }
  box.replaceChildren(...nodes);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ----------------------------------------------------------------- dialogs
function openAgentDialog(agent) {
  editingAgentId = agent ? agent.id : null;
  const form = $('#agent-form');
  $('#agent-dialog-title').textContent = agent ? `Edit ${agent.name}` : 'New agent';
  $('#agent-delete').hidden = !agent;
  form.provider.replaceChildren(
    ...state.providers.map((p) => el('option', { value: p.id, textContent: p.label + (p.available ? '' : ' (not installed)') }))
  );
  const firstAvailable = (state.providers.find((p) => p.available) || { id: 'demo' }).id;
  const values = agent || { emoji: '🤖', name: '', persona: '', provider: firstAvailable, model: '' };
  for (const key of ['emoji', 'name', 'persona', 'provider', 'model']) form[key].value = values[key];
  $('#agent-dialog').showModal();
}

$('#agent-form').addEventListener('submit', (event) => {
  const data = Object.fromEntries(new FormData(event.target));
  act(
    (editingAgentId ? request('PUT', `/api/agents/${editingAgentId}`, data) : request('POST', '/api/agents', data)).then((agent) => {
      if (!editingAgentId) select('dm-' + agent.id);
    })
  );
});

$('#agent-delete').addEventListener('click', () => {
  const agent = agentById(editingAgentId);
  if (!agent || !confirm(`Delete ${agent.name} and its conversation?`)) return;
  $('#agent-dialog').close();
  act(request('DELETE', `/api/agents/${agent.id}`, {}));
});

$('#new-agent').addEventListener('click', () => openAgentDialog(null));

$('#new-channel').addEventListener('click', () => {
  $('#channel-form').reset();
  $('#channel-members').replaceChildren(
    ...state.agents.map((a) =>
      el('label', { className: 'check' }, el('input', { type: 'checkbox', name: 'agentIds', value: a.id, checked: true }), ` ${a.emoji} ${a.name}`)
    )
  );
  $('#channel-dialog').showModal();
});

$('#channel-form').addEventListener('submit', (event) => {
  const data = new FormData(event.target);
  act(request('POST', '/api/channels', { name: data.get('name'), agentIds: data.getAll('agentIds') }).then((conv) => select(conv.id)));
});

document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));
$('#menu').addEventListener('click', () => document.body.classList.toggle('nav-open'));

// ---------------------------------------------------------------- composer
const input = $('#input');
function send() {
  const text = input.value.trim();
  const conv = currentConv();
  if (!text || !conv) return;
  input.value = '';
  input.style.height = '';
  act(request('POST', `/api/conversations/${conv.id}/messages`, { text }));
  $('#messages').scrollTop = $('#messages').scrollHeight;
}
$('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  send();
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
});
input.addEventListener('input', () => {
  input.style.height = '';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
});

// Live updates: the server pings on every change and we refetch.
let refreshTimer = null;
new EventSource('/api/events').onmessage = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(console.error), 30);
};
