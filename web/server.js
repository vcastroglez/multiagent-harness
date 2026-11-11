#!/usr/bin/env node
// Minimal zero-dependency dashboard for a herdr + pi multi-agent workspace.
// Read + prompt only. Lifecycle changes stay in bootstrap.sh.
//
// Authentication: a login form posts to /api/login; credentials are verified
// against the host's PAM stack (pam_auth.py => libpam), so any local Linux user
// can sign in with their own password. A random server-side session id is kept
// in an HttpOnly, SameSite=Strict cookie; there are no tokens in URLs.
//
// usage: PORT=7788 HOST=127.0.0.1 node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const auth = require('./auth');

const HERE = __dirname;
// Harness root = this checkout. Workspace root and repo locations can be overridden
// when the harness does not sit at <workspace>/ai-utils/multiagent.
const HARNESS = path.resolve(HERE, '..');
const BASE = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : path.resolve(HARNESS, '../..');
const API = process.env.BACKEND_DIR ? path.resolve(process.env.BACKEND_DIR) : path.join(BASE, 'backend');
const CLIENT = process.env.FRONTEND_DIR ? path.resolve(process.env.FRONTEND_DIR) : path.join(BASE, 'frontend');
const STATE = process.env.MAH_STATE_DIR ? path.resolve(process.env.MAH_STATE_DIR) : HARNESS;
const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.HOST || '127.0.0.1';
const HERDR = process.env.HERDR_BIN || 'herdr';
const PI_BIN = process.env.PI_BIN || 'pi';
const PYTHON = process.env.DASHBOARD_PYTHON || 'python3';
const AUTH_HELPER = process.env.DASHBOARD_AUTH_HELPER || path.join(HERE, 'pam_auth.py');
const PAM_SERVICE = process.env.DASHBOARD_PAM_SERVICE || 'login';
const ALLOWED_USERS = auth.allowedUsers();
const TOTP_FILE = auth.totpFile();
const LOCK_FILE = path.join(STATE, 'auth-state.json');
// Fail closed: without an enrolled second factor nobody can sign in (MAH_REQUIRE_TOTP=0 disables).
const REQUIRE_TOTP = process.env.MAH_REQUIRE_TOTP !== '0';
const INVALID_LOGIN = 'Invalid username, password or code.';

const COOKIE = 'mah_session';
const SESSION_HOURS = (() => {
  const n = Number(process.env.DASHBOARD_SESSION_HOURS || 12);
  return Number.isFinite(n) && n > 0 ? n : 12;
})();
const SESSION_TTL_MS = SESSION_HOURS * 60 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 15000;
const MAX_BODY = 8192;
const HOME = os.homedir();
const PI_SETTINGS = path.join(HOME, '.pi/agent/settings.json');
const SESSIONS_ROOT = path.join(HOME, '.pi/agent/sessions');
const STREAM_MAX_EVENTS = 20000;
const STREAM_POLL_MS = 400;
const UPLOADS = path.join(STATE, 'uploads');
const MAX_ATTACHMENTS = 4;
const MAX_ATTACH_BYTES = 6 * 1024 * 1024;
const MAX_ATTACH_TOTAL = 12 * 1024 * 1024;
const MAX_PROMPT_BODY = 24 * 1024 * 1024;
const SESSIONS_FILE = path.join(STATE, 'sessions.json');
const TASKS_FILE = path.join(STATE, 'tasks.md');
const TASKS_ARCHIVE = path.join(STATE, 'tasks-archive');
const EMPTY_TASKS = `# Task queue

One task per agent. Backend first when the frontend depends on it.
Format: \`- [ ] task\` / \`- [x] done\`. Keep it short; details belong in the repo's
\`.pi/SESSION.md\` and in commit messages.

## In progress
_No tasks queued._

## Blocked — waiting on human decision
_None._

## Done
_None._

## Backlog
_No tasks queued._
`;

const sessions = new Map(); // sha256(session id) -> { username, csrf, expires }
const resettingPanes = new Set(); // pane ids with a reset in flight
const stoppingPanes = new Set(); // pane ids with an interrupt in flight
const modelSwitching = new Set(); // pane ids with a model change in flight
const streamers = new Map(); // pane id -> AgentStreamer
const ipFailures = new Map(); // ip -> { count, resetAt }
const userFailures = new Map(); // ip|user -> { count, resetAt }
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_IP_FAILURES = 20;
const MAX_USER_FAILURES = 5;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 15000, maxBuffer: 4 * 1024 * 1024, cwd: opts.cwd || BASE },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err ? (err.code || 1) : 0 }));
  });
}

async function herdrJson(args) {
  const r = await run(HERDR, args);
  if (!r.ok) return { error: r.stderr.trim() || `herdr exited ${r.code}` };
  try { return JSON.parse(r.stdout).result || {}; } catch { return { error: 'invalid herdr JSON' }; }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  }
  return out;
}

function currentSession(req) {
  const id = parseCookies(req)[COOKIE];
  if (!id) return null;
  const key = hashSession(id);
  const s = sessions.get(key);
  if (!s) return null;
  if (s.expires <= Date.now()) { sessions.delete(key); return null; }
  return { id, ...s };
}

function isSecure(req) {
  return process.env.DASHBOARD_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
}

function sessionCookie(req, id, maxAgeSec) {
  const bits = [`${COOKIE}=${id}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSec}`];
  if (isSecure(req)) bits.push('Secure');
  return bits.join('; ');
}

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
}

function json(res, code, body, extraHeaders = {}) {
  securityHeaders(res);
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function text(res, code, body) {
  securityHeaders(res);
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const PANE_RE = /^w\d+:p[0-9A-Za-z]+$/;
const USER_RE = /^[A-Za-z0-9._@-]{1,64}$/;
const ROLES = new Set(['coordinator', 'backender', 'reviewer', 'frontender']);

function parseTasks(md) {
  const out = [];
  let section = '';
  let cur = null;
  // A task is the `- [ ] ...` line plus its wrapped/indented continuation lines. The dashboard
  // shows `text` as the compact label and keeps `detail` for the full-text pop-up.
  const flush = () => { cur = null; };
  for (const line of md.split('\n')) {
    if (/^##\s+/.test(line)) { flush(); section = line.replace(/^##\s+/, '').trim(); continue; }
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (m) {
      flush();
      cur = { section, done: m[1].toLowerCase() === 'x', text: m[2].replace(/\*\*/g, '').trim(), detail: '' };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!line.trim()) { flush(); continue; } // blank line ends the task block
    if (/^\s+\S/.test(line)) { // indented continuation line (details, evidence, refs)
      const extra = line.trim().replace(/\*\*/g, '');
      cur.detail += (cur.detail ? '\n' : '') + extra;
      continue;
    }
    flush(); // unindented prose or a new list is not part of the task
  }
  return out.slice(-40);
}

async function gitInfo(dir) {
  const [branch, status, last] = await Promise.all([
    run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']),
    run('git', ['-C', dir, 'status', '--porcelain']),
    run('git', ['-C', dir, 'log', '-1', '--pretty=%h %s']),
  ]);
  return {
    branch: branch.ok ? branch.stdout.trim() : '?',
    dirty: status.ok ? status.stdout.trim().split('\n').filter(Boolean).length : 0,
    last_commit: last.ok ? last.stdout.trim() : '?',
  };
}

// ---------- session log streaming (full agent output) ----------

function sessionDirFor(cwd) {
  // pi stores sessions in ~/.pi/agent/sessions/--<cwd with / -> ->--
  return path.join(SESSIONS_ROOT, '--' + String(cwd || '').replace(/^\//, '').replace(/\//g, '-') + '--');
}

function newestSessionFile(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    let best = null;
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const m = fs.statSync(full).mtimeMs;
        if (!best || m > best.m) best = { full, m };
      } catch { /* race */ }
    }
    return best ? best.full : null;
  } catch {
    return null;
  }
}

function resolveSessionFile(paneInfo, allowFallback = true) {
  const reported = paneInfo && paneInfo.agent_session && paneInfo.agent_session.value;
  // herdr reports the pane's current session. After /new it can point at a file pi has
  // not written yet (pi writes it on the first message): wait for it, never show the
  // newest older transcript in its place.
  if (reported) return fs.existsSync(reported) ? reported : null;
  if (!allowFallback) return null;
  return newestSessionFile(sessionDirFor(paneInfo && paneInfo.cwd));
}

function parseSessionLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return []; }
  const ts = o.timestamp || new Date().toISOString();
  if (o.type === 'session') return [{ kind: 'session', role: 'system', ts, text: `New session · ${o.cwd || ''}` }];
  if (o.type === 'model_change') return [{ kind: 'model', role: 'system', ts, text: `model → ${o.modelId}` }];
  if (o.type !== 'message' || !o.message) return [];
  const m = o.message;
  const role = m.role || '?';
  if (role === 'system') return [];

  const blocks = (content) => (Array.isArray(content) ? content : [content]);
  const textOf = (content) => blocks(content).map((b) => {
    if (typeof b === 'string') return b;
    if (!b || typeof b !== 'object') return '';
    if (b.type === 'text') return b.text || '';
    if (b.type === 'image') return '[image]';
    return '';
  }).filter(Boolean).join('\n');

  // pi records `!cmd` (user bash) as its own role, not as tool messages: show the command as a
  // tool call and its output as a tool result so the existing feed filters keep working.
  if (role === 'bashExecution') {
    const cmd = String(m.command || '');
    const out = [{ kind: 'tool', role: 'user', ts, text: `→ ! ${cmd}` }];
    const output = String(m.output || '').replace(/\n+$/, '');
    const notes = [];
    if (m.cancelled) notes.push('cancelled');
    if (m.exitCode != null && m.exitCode !== 0) notes.push(`exit ${m.exitCode}`);
    if (m.truncated) notes.push('truncated');
    const tail = notes.length ? ` (${notes.join(', ')})` : '';
    if (output || tail) out.push({ kind: 'result', role: 'tool', ts, text: `← ! ${cmd}${tail}${output ? `\n${output}` : ''}` });
    return out;
  }

  if (role === 'toolResult') {
    const body = textOf(m.content);
    return [{ kind: 'result', role: 'tool', ts, text: `← ${m.toolName || 'tool'}${m.isError ? ' (error)' : ''}\n${body}` }];
  }

  if (typeof m.content === 'string') {
    return m.content.trim() ? [{ kind: 'text', role, ts, text: m.content }] : [];
  }

  const out = [];
  for (const b of blocks(m.content)) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text) out.push({ kind: 'text', role, ts, text: b.text });
    else if (b.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', role, ts, text: b.thinking });
    else if (b.type === 'toolCall') {
      let args = '';
      try { args = JSON.stringify(b.arguments); } catch { args = String(b.arguments || ''); }
      out.push({ kind: 'tool', role, ts, text: `→ ${b.name || 'tool'} ${args}` });
    } else if (b.type === 'image') out.push({ kind: 'image', role, ts, text: '[image]' });
  }
  return out;
}

class AgentStreamer {
  constructor(pane) {
    this.pane = pane;
    this.path = null;
    this.offset = 0;
    this.partial = '';
    this.events = [];
    this.seq = 0;
    this.clients = new Set();
    this.pathTimer = null;
    this.readTimer = null;
    this.busy = false;
    this.resetPending = false;
    this.retired = new Set(); // session files replaced by a reset; never adopted again
  }

  start() {
    this.refreshPath();
    this.readTimer = setInterval(() => this.appendNew(), STREAM_POLL_MS);
    this.pathTimer = setInterval(() => this.refreshPath(), 2000);
    if (this.pathTimer.unref) this.pathTimer.unref();
    if (this.readTimer.unref) this.readTimer.unref();
  }

  stop() {
    clearInterval(this.readTimer);
    clearInterval(this.pathTimer);
    for (const res of this.clients) { try { res.end(); } catch { /* ignore */ } }
    this.clients.clear();
  }

  markReset() {
    // /new switches the session file. Stop reading the old one and clear
    // connected Tail views immediately. The old file is never adopted again.
    if (this.path) this.retired.add(this.path);
    this.resetPending = true;
    this.path = null;
    this.resetBuffer();
    this.broadcast('session', { pane: this.pane, path: null });
  }

  broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) { try { res.write(frame); } catch { /* ignore */ } }
  }

  resetBuffer() {
    this.offset = 0;
    this.partial = '';
    this.events = [];
    this.seq = 0;
  }

  async refreshPath() {
    const info = await herdrJson(['pane', 'get', this.pane]);
    if (info.error || !info.pane || !info.pane.agent) return;
    let next = null;
    if (this.resetPending) {
      // After /new, only a session file other than the pre-reset one counts. Never fall
      // back to the old transcript: pi writes the new file on its first message, so keep
      // waiting (the Tail stays empty) until a new file exists.
      const reported = info.pane.agent_session && info.pane.agent_session.value;
      const fresh = [reported, newestSessionFile(sessionDirFor(info.pane.cwd))]
        .find((p) => p && !this.retired.has(p) && fs.existsSync(p));
      if (!fresh) return;
      next = fresh;
      this.resetPending = false;
    } else {
      next = resolveSessionFile(info.pane, true);
      // herdr may lag behind /new and still report the replaced file: keep the current one
      if (next && this.retired.has(next)) return;
    }
    if (next && next !== this.path) {
      this.path = next;
      this.resetBuffer();
      this.broadcast('session', { pane: this.pane, path: next });
      this.appendNew();
    }
  }

  appendNew() {
    if (!this.path || this.busy) return;
    this.busy = true;
    try {
      let st;
      try { st = fs.statSync(this.path); } catch { this.path = null; return; }
      if (st.size < this.offset) {
        this.resetBuffer();
        this.broadcast('session', { pane: this.pane, path: this.path });
      }
      if (st.size === this.offset) return;
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(this.path, 'r');
      try { fs.readSync(fd, buf, 0, len, this.offset); } finally { fs.closeSync(fd); }
      this.offset = st.size;
      const text = this.partial + buf.toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() || '';
      const fresh = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        for (const ev of parseSessionLine(line)) {
          ev.id = ++this.seq;
          this.events.push(ev);
          fresh.push(ev);
        }
      }
      if (this.events.length > STREAM_MAX_EVENTS) this.events.splice(0, this.events.length - STREAM_MAX_EVENTS);
      if (fresh.length) this.broadcast('append', { pane: this.pane, events: fresh });
    } catch (e) {
      // keep the streamer alive; a transient read error must not kill the dashboard
    } finally {
      this.busy = false;
    }
  }

  attach(res, req) {
    securityHeaders(res);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    res.write(`event: session\ndata: ${JSON.stringify({ pane: this.pane, path: this.path })}\n\n`);
    res.write(`event: snapshot\ndata: ${JSON.stringify({ pane: this.pane, events: this.events })}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
    req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }
}

// Roles can share a cwd (backender and reviewer both audit the api checkout),
// so a known tab label wins and cwd is only the fallback.
function roleForPane(pane, tabs) {
  const label = String((tabs || []).find((t) => t.tab_id === pane.tab_id)?.label || '').toLowerCase();
  if (ROLES.has(label)) return label;
  return pane.cwd === API ? 'backender' : pane.cwd === CLIENT ? 'frontender' : pane.cwd === BASE ? 'coordinator' : 'other';
}

// Session file herdr reports for a pane. pi's herdr extension re-reports it on every
// /new, so a change from `before` proves the fresh session started (the file itself
// is only written on the first message, so it cannot be checked directly).
async function waitForNewSession(pane, before, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const info = await herdrJson(['pane', 'get', pane]);
    const now = info.pane && info.pane.agent_session ? info.pane.agent_session.value : null;
    if (now && now !== before) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function resetAgentPane(pane) {
  if (resettingPanes.has(pane)) return { status: 'skipped', code: 409, reason: 'a reset is already in progress' };
  const info = await herdrJson(['pane', 'get', pane]);
  if (!info.pane) return { status: 'error', code: 404, reason: 'pane not found' };
  if (!info.pane.agent) return { status: 'error', code: 409, reason: 'pane has no agent' };
  if (info.pane.agent_status === 'working') return { status: 'skipped', code: 409, reason: 'agent is working' };
  resettingPanes.add(pane);
  try {
    // Equivalent to typing /new in pi: starts a fresh session, keeps the process.
    // A draft left in pi's prompt would make /new get appended to it (Enter would then
    // submit "draft/new" as a message and no reset happens), so clear the prompt first.
    const before = (info.pane.agent_session && info.pane.agent_session.value) || null;
    const esc = await run(HERDR, ['pane', 'send-keys', pane, 'esc'], { timeout: 4000 });
    if (!esc.ok) return { status: 'error', code: 502, reason: esc.stderr.trim() || 'could not send Esc' };
    await new Promise((r) => setTimeout(r, 200));
    const clear = await run(HERDR, ['pane', 'send-keys', pane, 'ctrl+u'], { timeout: 4000 });
    if (!clear.ok) return { status: 'error', code: 502, reason: clear.stderr.trim() || 'could not clear the prompt' };
    await new Promise((r) => setTimeout(r, 150));
    const typed = await run(HERDR, ['pane', 'send-text', pane, '/new'], { timeout: 4000 });
    if (!typed.ok) return { status: 'error', code: 502, reason: typed.stderr.trim() || 'could not type /new' };
    await new Promise((r) => setTimeout(r, 150));
    const enter = await run(HERDR, ['pane', 'send-keys', pane, 'Enter'], { timeout: 4000 });
    if (!enter.ok) return { status: 'error', code: 502, reason: enter.stderr.trim() || 'could not press Enter' };
    // If the first Enter did not start the session, press it once more. The prompt is
    // empty by now, so a second Enter does nothing if the first one already worked.
    if (!(await waitForNewSession(pane, before, 1500))) {
      const retry = await run(HERDR, ['pane', 'send-keys', pane, 'Enter'], { timeout: 4000 });
      if (!retry.ok) return { status: 'error', code: 502, reason: retry.stderr.trim() || 'could not press Enter' };
      if (!(await waitForNewSession(pane, before, 2500))) {
        return { status: 'error', code: 502, reason: 'could not confirm that /new started a new session' };
      }
    }
    const live = streamers.get(pane);
    if (live) live.markReset();
    setTimeout(() => { const s = streamers.get(pane); if (s) s.refreshPath(); }, 1200);
    return { status: 'reset' };
  } finally {
    resettingPanes.delete(pane);
  }
}

// Poll an agent pane until it leaves `working` (or the deadline passes) and
// report the state it ended up in; used to confirm that an interrupt landed.
async function waitForAgentState(pane, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const info = await herdrJson(['pane', 'get', pane]);
    const state = info.pane ? info.pane.agent_status : null;
    if (state && state !== 'working') return state;
    if (Date.now() >= deadline) return state || 'unknown';
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Interrupt the turn an agent is running. pi aborts generation on Esc; states
// that ask for a confirmation press need a second one, so escalate once and
// then report whether the agent actually stopped.
async function stopAgentPane(pane) {
  if (stoppingPanes.has(pane)) return { status: 'skipped', code: 409, reason: 'a stop is already in progress' };
  const info = await herdrJson(['pane', 'get', pane]);
  if (!info.pane) return { status: 'error', code: 404, reason: 'pane not found' };
  if (!info.pane.agent) return { status: 'error', code: 409, reason: 'pane has no agent' };
  const state = info.pane.agent_status;
  if (state !== 'working') {
    return { status: 'skipped', code: 409, reason: `agent is ${state || 'idle'}, not working` };
  }
  stoppingPanes.add(pane);
  try {
    let current = state;
    for (const wait of [2500, 3000]) {
      const esc = await run(HERDR, ['pane', 'send-keys', pane, 'esc'], { timeout: 4000 });
      if (!esc.ok) return { status: 'error', code: 502, reason: esc.stderr.trim() || 'could not send Esc' };
      current = await waitForAgentState(pane, wait);
      if (current !== 'working') return { status: 'stopped', state: current };
    }
    return { status: 'error', code: 409, reason: 'agent ignored the interrupt and is still working' };
  } finally {
    stoppingPanes.delete(pane);
  }
}

// ---------- agent deletion ----------
// Closing a pane is the only destructive action in the dashboard. The last agent is
// never closed: talking to a live agent is the only way to create new ones, so the
// human would be locked out of the setup entirely.
const deletingPanes = new Set();

// Drop the role from memory.json so a deleted agent stops advertising a stale
// call-sign. bootstrap.sh rewrites this file on its next run anyway.
function forgetMemoryRole(role, pane) {
  const file = path.join(STATE, 'memory.json');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  const entry = doc.agents && doc.agents[role];
  if (!entry || (entry.pane && entry.pane !== pane)) return;
  delete doc.agents[role];
  doc.last_updated = new Date().toISOString().replace(/\.\d+Z$/, '');
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(tmp, file);
  } catch { /* a locked memory.json must not fail the delete */ }
}

async function closeAgentPane(pane) {
  if (deletingPanes.has(pane)) return { status: 'skipped', code: 409, reason: 'a delete is already in progress' };
  const [list, tabList] = await Promise.all([herdrJson(['pane', 'list']), herdrJson(['tab', 'list'])]);
  if (list.error) return { status: 'error', code: 503, reason: list.error };
  const panes = list.panes || [];
  const target = panes.find((p) => p.pane_id === pane);
  if (!target) return { status: 'error', code: 404, reason: 'pane not found' };
  if (!target.agent) return { status: 'error', code: 409, reason: 'pane has no agent' };
  if (panes.filter((p) => p.agent).length <= 1) {
    return {
      status: 'error',
      code: 409,
      reason: 'refusing to delete the last agent: a live agent is the only way to create new ones',
    };
  }
  deletingPanes.add(pane);
  try {
    const tabs = tabList.tabs || [];
    const role = roleForPane(target, tabs);
    // Each role lives in its own tab (bootstrap.sh creates them that way), so close
    // the tab when it only holds this pane and leave no empty tab behind.
    const tab = tabs.find((t) => t.tab_id === target.tab_id);
    const alone = !!target.tab_id && panes.filter((p) => p.tab_id === target.tab_id).length === 1;
    let closed = alone && tab
      ? await run(HERDR, ['tab', 'close', tab.tab_id], { timeout: 10000 })
      : await run(HERDR, ['pane', 'close', pane], { timeout: 10000 });
    if (!closed.ok && alone && tab) closed = await run(HERDR, ['pane', 'close', pane], { timeout: 10000 });
    if (!closed.ok) return { status: 'error', code: 502, reason: closed.stderr.trim() || 'could not close the pane' };
    // Stop following the deleted pane's session log now; reconcileStreams would
    // also notice within 2s, but its events would keep landing until then.
    const live = streamers.get(pane);
    if (live) { live.stop(); streamers.delete(pane); }
    forgetMemoryRole(role, pane);
    return { status: 'closed', role };
  } finally {
    deletingPanes.delete(pane);
  }
}

async function reconcileStreams() {
  const res = await herdrJson(['pane', 'list']);
  if (res.error) return;
  const agents = (res.panes || []).filter((p) => p.agent);
  for (const p of agents) {
    let s = streamers.get(p.pane_id);
    if (!s) {
      s = new AgentStreamer(p.pane_id);
      streamers.set(p.pane_id, s);
      s.start();
    }
  }
  const live = new Set(agents.map((p) => p.pane_id));
  for (const [pane, s] of streamers) {
    if (!live.has(pane)) { s.stop(); streamers.delete(pane); }
  }
}

// ---------- slash commands ----------
// The command list pi shows for an agent's working folder. Extension commands, prompt
// templates and skills come from `pi --mode rpc` (get_commands); built-ins are pi's
// documented set (docs/slash-commands.md). /quit is left out: it would end the agent.
const PI_BUILTIN_COMMANDS = [
  { name: 'settings', description: 'Open settings' },
  { name: 'model', args: '[provider/model]', description: 'Select a model' },
  { name: 'thinking', args: '[level]', description: 'Set the thinking level' },
  { name: 'scoped-models', description: 'Configure the models used by interactive cycling' },
  { name: 'login', args: '[provider]', description: 'Add provider authentication' },
  { name: 'logout', description: 'Remove provider authentication' },
  { name: 'llama', description: 'Manage models on the configured llama.cpp router' },
  { name: 'new', description: 'Start a new session' },
  { name: 'resume', description: 'Resume another session' },
  { name: 'name', args: '[name]', description: 'Set the session display name' },
  { name: 'session', description: 'Show current session information and statistics' },
  { name: 'tree', description: 'Navigate the session tree' },
  { name: 'fork', description: 'Create a new session from an earlier user message' },
  { name: 'clone', description: 'Duplicate the current session at its current position' },
  { name: 'compact', args: '[instructions]', description: 'Compact the current context' },
  { name: 'import', args: '<path>', description: 'Import a JSONL session' },
  { name: 'copy', description: 'Copy the last assistant message' },
  { name: 'export', args: '[path]', description: 'Export the session as HTML or JSONL' },
  { name: 'share', description: 'Upload the session and return a viewer link' },
  { name: 'bug', args: '[description]', description: 'Prepare a private bug report for the Pi developers' },
  { name: 'trust', description: 'Save a project trust decision for future Pi processes' },
  { name: 'mcp', description: 'Manage MCP servers' },
  { name: 'reload', description: 'Reload keybindings, extensions, skills, templates, themes, and context files' },
  { name: 'hotkeys', description: 'Show active keyboard shortcuts' },
  { name: 'changelog', description: 'Show changelog entries' },
].map((c) => ({ ...c, source: 'builtin' }));

const COMMANDS_TTL_MS = 60 * 1000;
const COMMANDS_RPC_TIMEOUT_MS = 20000;
const commandCache = new Map(); // working folder -> { at, commands, error, builtin }
const commandFetches = new Map(); // working folder -> in-flight promise

// Start pi in RPC mode inside `cwd`, ask for its commands, then stop it.
function fetchPiCommands(cwd) {
  return new Promise((resolve) => {
    let child = null;
    let buf = '';
    let timer = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child) child.kill(); } catch { /* already gone */ }
      resolve(result);
    };
    try {
      child = spawn(PI_BIN, ['--mode', 'rpc', '--no-session'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      return resolve({ error: String(e.message || e) });
    }
    timer = setTimeout(() => finish({ error: 'pi did not answer in time' }), COMMANDS_RPC_TIMEOUT_MS);
    child.on('error', (e) => finish({ error: e.message }));
    child.on('exit', () => finish({ error: 'pi exited before answering' }));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'response' && o.id === 'get-commands') {
          if (!o.success) return finish({ error: o.error || 'get_commands failed' });
          const commands = (o.data?.commands || []).map((c) => ({ name: c.name, description: c.description || '', source: c.source }));
          return finish({ commands });
        }
      }
    });
    child.stdin.write('{"id":"get-commands","type":"get_commands"}\n');
  });
}

async function commandsFor(cwd, refresh) {
  const hit = commandCache.get(cwd);
  if (!refresh && hit && Date.now() - hit.at < COMMANDS_TTL_MS) return hit;
  if (commandFetches.has(cwd)) return commandFetches.get(cwd);
  const p = fetchPiCommands(cwd).then((r) => {
    const entry = { at: Date.now(), commands: r.commands || [], error: r.error || null, builtin: PI_BUILTIN_COMMANDS };
    commandCache.set(cwd, entry);
    return entry;
  }).finally(() => commandFetches.delete(cwd));
  commandFetches.set(cwd, p);
  return p;
}

// ---------- model catalog ----------

let modelCache = { at: 0, list: [], source: 'none' };

function enabledModelsFromSettings() {
  try {
    const doc = JSON.parse(fs.readFileSync(PI_SETTINGS, 'utf8'));
    return (doc.enabledModels || []).map((id) => ({ id: String(id).replace(/^openrouter\//, ''), name: String(id) }));
  } catch { return []; }
}

async function fetchModelCatalog() {
  if (Date.now() - modelCache.at < 60 * 60 * 1000 && modelCache.list.length) return modelCache;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = (data.data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      context: m.context_length || null,
      prompt: m.pricing && m.pricing.prompt ? Number(m.pricing.prompt) : null,
      completion: m.pricing && m.pricing.completion ? Number(m.pricing.completion) : null,
    })).sort((a, b) => {
      const aa = a.id.startsWith('~') ? 1 : 0;
      const bb = b.id.startsWith('~') ? 1 : 0;
      return aa - bb || a.id.localeCompare(b.id);
    });
    if (!list.length) throw new Error('empty catalog');
    modelCache = { at: Date.now(), list, source: 'openrouter' };
  } catch (e) {
    const list = enabledModelsFromSettings();
    modelCache = { at: Date.now(), list, source: 'settings', error: e.message };
  }
  return modelCache;
}

function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return '.gif';
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF'
      && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return null;
}

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function decodeImageAttachment(att) {
  if (!att || typeof att !== 'object') throw new Error('invalid attachment');
  if (att.type && !ALLOWED_IMAGE_TYPES.has(String(att.type))) throw new Error('only PNG, JPEG, WebP or GIF images are allowed');
  let data = String(att.data || '');
  const comma = data.indexOf(',');
  if (data.startsWith('data:') && comma >= 0) data = data.slice(comma + 1);
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw new Error('empty image');
  if (buf.length > MAX_ATTACH_BYTES) throw new Error(`image too large (max ${Math.round(MAX_ATTACH_BYTES / 1048576)} MB)`);
  const ext = sniffImage(buf);
  if (!ext) throw new Error('not a PNG, JPEG, WebP or GIF image');
  return { buf, ext };
}

function pruneUploads() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(UPLOADS)) {
      const full = path.join(UPLOADS, f);
      try {
        if (now - fs.statSync(full).mtimeMs > 7 * 864e5) fs.unlinkSync(full);
      } catch { /* race */ }
    }
  } catch { /* no dir yet */ }
}

function saveAttachments(list) {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.length > MAX_ATTACHMENTS) throw new Error(`too many images (max ${MAX_ATTACHMENTS})`);
  let total = 0;
  const decoded = list.map((att) => {
    const d = decodeImageAttachment(att);
    total += d.buf.length;
    return d;
  });
  if (total > MAX_ATTACH_TOTAL) throw new Error(`images too large in total (max ${Math.round(MAX_ATTACH_TOTAL / 1048576)} MB)`);
  fs.mkdirSync(UPLOADS, { recursive: true });
  const saved = [];
  try {
    for (const d of decoded) {
      const name = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${d.ext}`;
      const full = path.join(UPLOADS, name);
      fs.writeFileSync(full, d.buf, { mode: 0o644 });
      saved.push(full);
    }
  } catch (e) {
    for (const p of saved) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
    throw e;
  }
  pruneUploads();
  return saved;
}

function hashSession(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex');
}

function loadSessions() {
  try {
    const doc = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const [key, s] of Object.entries(doc.sessions || {})) {
      if (!s || typeof s.username !== 'string' || typeof s.csrf !== 'string') continue;
      if (!(s.expires > now)) continue;
      sessions.set(key, { username: s.username, csrf: s.csrf, expires: s.expires });
    }
  } catch { /* first run or unreadable file */ }
}

function saveSessions() {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    const tmp = `${SESSIONS_FILE}.tmp`;
    const data = JSON.stringify({ version: 1, sessions: Object.fromEntries(sessions) });
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch {
    console.error('[dashboard] could not persist sessions');
  }
}

function pruneTaskArchives(keep = 20) {
  try {
    const files = fs.readdirSync(TASKS_ARCHIVE)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, m: fs.statSync(path.join(TASKS_ARCHIVE, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const old of files.slice(keep)) {
      try { fs.unlinkSync(path.join(TASKS_ARCHIVE, old.f)); } catch { /* race */ }
    }
  } catch { /* no archive dir */ }
}

function clearTaskQueue() {
  let previous = '';
  try { previous = fs.readFileSync(TASKS_FILE, 'utf8'); } catch { /* first run */ }
  let archived = null;
  if (previous.trim()) {
    fs.mkdirSync(TASKS_ARCHIVE, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    archived = path.join(TASKS_ARCHIVE, `${stamp}.md`);
    fs.writeFileSync(archived, previous, { mode: 0o644 });
    pruneTaskArchives();
  }
  const tmp = `${TASKS_FILE}.tmp`;
  fs.writeFileSync(tmp, EMPTY_TASKS, { mode: 0o644 });
  fs.renameSync(tmp, TASKS_FILE);
  return archived;
}

async function paneModel(pane) {
  const r = await run(HERDR, ['agent', 'read', pane, '--source', 'visible', '--lines', '6'], { timeout: 5000 });
  if (!r.ok) return { model: null, thinking: null };
  const m = r.stdout.match(/([A-Za-z0-9._/-]+)\s+•\s+(off|minimal|low|medium|high|xhigh|max)\b/);
  return m ? { model: m[1], thinking: m[2] } : { model: null, thinking: null };
}

async function state() {
  const [paneRes, wsRes, tabRes, apiGit, feGit] = await Promise.all([
    herdrJson(['pane', 'list']),
    herdrJson(['workspace', 'list']),
    herdrJson(['tab', 'list']),
    gitInfo(API),
    gitInfo(CLIENT),
  ]);
  if (paneRes.error) return { error: paneRes.error, herdr: 'down' };
  const tabs = tabRes.tabs || [];
  const panes = (paneRes.panes || []).map((p) => {
    const role = roleForPane(p, tabs);
    return {
      pane_id: p.pane_id,
      cwd: p.cwd,
      tab_id: p.tab_id || null,
      agent: p.agent || null,
      status: p.agent ? (p.agent_status || 'unknown') : 'shell',
      title: p.terminal_title_stripped || p.terminal_title || '',
      role,
      repo: role === 'backender' || role === 'reviewer'
        ? { name: 'api', ...apiGit }
        : role === 'frontender' ? { name: 'client', ...feGit } : null,
    };
  });
  await Promise.all(panes.filter((p) => p.agent).map(async (p) => {
    const info = await paneModel(p.pane_id);
    p.model = info.model;
    p.thinking = info.thinking;
  }));
  let tasksRaw = '';
  try { tasksRaw = fs.readFileSync(path.join(STATE, 'tasks.md'), 'utf8'); } catch {}
  let memory = {};
  try { memory = JSON.parse(fs.readFileSync(path.join(STATE, 'memory.json'), 'utf8')); } catch {}
  return {
    herdr: 'up',
    workspace: (wsRes.workspaces || [])[0] || null,
    panes,
    repos: { api: apiGit, client: feGit },
    tasks: parseTasks(tasksRaw),
    memory,
    server_time: new Date().toISOString(),
  };
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser or same-origin fetch without Origin
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function clientIp(req) {
  // Only trust X-Forwarded-For when explicitly behind a proxy; otherwise a
  // direct client could spoof it and dodge the per-IP rate limit.
  if (process.env.DASHBOARD_TRUST_PROXY === '1') {
    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

function bucket(map, key, max) {
  const now = Date.now();
  let b = map.get(key);
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + RATE_WINDOW_MS }; map.set(key, b); }
  return { b, exceeded: b.count >= max, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
}

function pamAuthenticate(username, password) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(PYTHON, [AUTH_HELPER], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        DASHBOARD_PAM_SERVICE: PAM_SERVICE,
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve('timeout');
    }, LOGIN_TIMEOUT_MS);
    child.on('error', () => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve('backend');
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve(code === 0 ? 'ok' : code === 1 ? 'reject' : 'backend');
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ username, password }));
  });
}

// ---- File explorer: read-only, confined to the workspace (BASE) ----
const FILES_PAGE = path.join(HERE, 'files.html');
const FILE_READ_MAX = 512 * 1024;
const FILE_LIST_MAX = 2000;

// Resolve symlinks first, then require the real path to stay inside the workspace root.
function workspacePath(raw) {
  const p = String(raw || '');
  if (!path.isAbsolute(p) || p.includes('\0')) return null;
  try {
    const root = fs.realpathSync(BASE);
    const real = fs.realpathSync(p);
    return real === root || real.startsWith(root + path.sep) ? real : null;
  } catch { return null; }
}

function listFolder(dir) {
  const entries = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).slice(0, FILE_LIST_MAX)) {
    let st;
    try { st = fs.statSync(path.join(dir, d.name)); } catch { continue; } // broken link or unreadable
    entries.push({
      name: d.name,
      type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
      size: st.size,
      mtime: st.mtime.toISOString(),
    });
  }
  entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
  return entries;
}

function readTextFile(file) {
  const st = fs.statSync(file);
  const len = Math.min(st.size, FILE_READ_MAX);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
  if (buf.subarray(0, Math.min(len, 8192)).includes(0)) return { binary: true, size: st.size };
  return { size: st.size, truncated: st.size > FILE_READ_MAX, text: buf.toString('utf8') };
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return text(res, 400, 'bad request'); }

  if (url.pathname === '/api/health') return json(res, 200, { ok: true, uptime: process.uptime() });

  // Explorer tab: same session cookie as the console; signed-out visitors go to the login page.
  if (req.method === 'GET' && url.pathname === '/files') {
    if (!currentSession(req)) { res.writeHead(302, { location: '/' }); return res.end(); }
    let html;
    try { html = fs.readFileSync(FILES_PAGE); }
    catch { return text(res, 500, 'file explorer missing'); }
    securityHeaders(res);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }

  if (req.method === 'GET' && url.pathname === '/') {
    let html;
    try { html = fs.readFileSync(path.join(HERE, 'index.html')); }
    catch { return text(res, 500, 'dashboard missing'); }
    securityHeaders(res);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    const s = currentSession(req);
    return json(res, 200, s ? { authenticated: true, username: s.username, csrf: s.csrf } : { authenticated: false });
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'forbidden origin' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); }
    catch { return json(res, 400, { error: 'invalid request' }); }

    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const otp = String(body.otp || '').trim();
    if (!USER_RE.test(username) || username.startsWith('-') || !password || password.length > 1024) {
      return json(res, 400, { error: 'Enter a valid Linux username and password.' });
    }

    // Client IP comes from the proxy's X-Forwarded-For (DASHBOARD_TRUST_PROXY=1); every failure
    // counts against that IP and against the account, whichever IP it came from.
    const ipB = bucket(ipFailures, `ip:${clientIp(req)}`, MAX_IP_FAILURES);
    if (ipB.exceeded) {
      return json(res, 429, { error: `Too many attempts. Try again in ${ipB.retryAfter}s.` }, { 'retry-after': String(ipB.retryAfter) });
    }
    const failLogin = () => {
      ipB.b.count += 1;
      auth.recordFailure(lockDoc, username);
      auth.saveLockState(LOCK_FILE, lockDoc);
      return json(res, 401, { error: INVALID_LOGIN });
    };

    // Only the allowlisted accounts are tried against PAM; anything else gets the same answer.
    if (!ALLOWED_USERS.has(username)) { ipB.b.count += 1; return json(res, 401, { error: INVALID_LOGIN }); }

    const lockDoc = auth.loadLockState(LOCK_FILE);
    const lock = auth.accountLock(lockDoc, username);
    if (lock.locked) {
      return json(res, 429, { error: 'Too many failed attempts for this account. Try again later.' }, { 'retry-after': String(lock.retryAfter) });
    }

    const totpKey = auth.readTotpSecret(TOTP_FILE);
    if (REQUIRE_TOTP && !totpKey) {
      return json(res, 503, { error: 'Sign-in is disabled until a second factor is set up on this host.' });
    }

    const result = await pamAuthenticate(username, password);
    if (result === 'ok') {
      let step = null;
      if (totpKey) {
        const lastStep = (lockDoc.users[username] && lockDoc.users[username].lastStep) ?? -1;
        step = auth.verifyTotp(totpKey, otp, Date.now(), lastStep);
        if (step === null) return failLogin();
      }
      auth.recordSuccess(lockDoc, username, step);
      auth.saveLockState(LOCK_FILE, lockDoc);
      const id = crypto.randomBytes(32).toString('hex');
      const csrf = crypto.randomBytes(24).toString('hex');
      sessions.set(hashSession(id), { username, csrf, expires: Date.now() + SESSION_TTL_MS });
      saveSessions();
      return json(res, 200, { ok: true, username, csrf },
        { 'set-cookie': sessionCookie(req, id, Math.floor(SESSION_TTL_MS / 1000)) });
    }

    if (result === 'reject') return failLogin();
    console.error('[dashboard] PAM authentication backend failed');
    return json(res, 503, { error: 'Authentication is temporarily unavailable.' });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const s = currentSession(req);
    if (!s) return json(res, 200, { ok: true });
    if (!sameOrigin(req) || req.headers['x-csrf-token'] !== s.csrf) return json(res, 403, { error: 'forbidden' });
    sessions.delete(hashSession(s.id));
    saveSessions();
    return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
  }

  // Everything below requires a valid session.
  const session = currentSession(req);
  if (!session) return json(res, 401, { error: 'authentication required' });

  try {
    if (req.method === 'GET' && url.pathname === '/api/models') {
      const catalog = await fetchModelCatalog();
      return json(res, 200, catalog);
    }

    if (req.method === 'GET' && url.pathname === '/api/commands') {
      const pane = url.searchParams.get('pane') || '';
      if (!PANE_RE.test(pane)) return json(res, 400, { error: 'invalid pane id' });
      const paneInfo = await herdrJson(['pane', 'get', pane]);
      if (!paneInfo.pane) return json(res, 404, { error: 'pane not found' });
      const cwd = paneInfo.pane.cwd;
      if (!cwd || !fs.existsSync(cwd)) return json(res, 409, { error: 'pane has no working folder' });
      const entry = await commandsFor(cwd, url.searchParams.get('refresh') === '1');
      return json(res, 200, { commands: entry.commands, builtin: entry.builtin, error: entry.error, at: entry.at });
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const pane = url.searchParams.get('pane') || '';
      if (!PANE_RE.test(pane)) return json(res, 400, { error: 'invalid pane id' });
      const paneInfo = await herdrJson(['pane', 'get', pane]);
      if (!paneInfo.pane) return json(res, 404, { error: 'pane not found' });
      if (!paneInfo.pane.agent) return json(res, 409, { error: 'pane has no agent' });
      let s = streamers.get(pane);
      if (!s) { s = new AgentStreamer(pane); streamers.set(pane, s); s.start(); }
      return s.attach(res, req);
    }

    if (req.method === 'POST' && url.pathname === '/api/model') {
      if (!sameOrigin(req) || req.headers['x-csrf-token'] !== session.csrf) return json(res, 403, { error: 'forbidden' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const pane = String(body.pane || '');
      // The catalog and /model use ids without the provider prefix; accept both.
      const model = String(body.model || '').trim().replace(/^openrouter\//, '');
      if (!PANE_RE.test(pane)) return json(res, 400, { error: 'invalid pane id' });
      if (!/^[A-Za-z0-9~][A-Za-z0-9._:/@~-]{0,119}$/.test(model)) return json(res, 400, { error: 'invalid model id' });
      if (modelSwitching.has(pane)) return json(res, 409, { error: 'a model change is already in progress' });
      const paneInfo = await herdrJson(['pane', 'get', pane]);
      if (!paneInfo.pane) return json(res, 404, { error: 'pane not found' });
      if (!paneInfo.pane.agent) return json(res, 409, { error: 'pane has no agent' });
      if (paneInfo.pane.agent_status === 'working') {
        return json(res, 409, { error: 'agent is working; wait for it to finish before changing the model' });
      }
      const catalog = await fetchModelCatalog();
      if (catalog.source === 'openrouter' && !catalog.list.some((m) => m.id === model)) {
        return json(res, 400, { error: `unknown model: ${model}` });
      }
      modelSwitching.add(pane);
      try {
        // Clear any draft/autocomplete, then submit. The TUI's model autocomplete
        // can swallow the first Enter, so retry once if the footer did not change.
        await run(HERDR, ['pane', 'send-keys', pane, 'esc'], { timeout: 4000 });
        await new Promise((r) => setTimeout(r, 200));
        // Clear any leftover draft/model-selector filter before typing the command.
        await run(HERDR, ['pane', 'send-keys', pane, 'C-u'], { timeout: 4000 });
        await new Promise((r) => setTimeout(r, 150));
        const typed = await run(HERDR, ['pane', 'send-text', pane, `/model ${model}`], { timeout: 4000 });
        if (!typed.ok) return json(res, 502, { error: typed.stderr.trim() || 'could not type /model' });
        await new Promise((r) => setTimeout(r, 500));
        const enter = await run(HERDR, ['pane', 'send-keys', pane, 'Enter'], { timeout: 4000 });
        if (!enter.ok) return json(res, 502, { error: enter.stderr.trim() || 'could not press Enter' });
        await new Promise((r) => setTimeout(r, 700));
        let detected = await paneModel(pane);
        if (detected.model !== model) {
          await run(HERDR, ['pane', 'send-keys', pane, 'Enter'], { timeout: 4000 });
          await new Promise((r) => setTimeout(r, 700));
          detected = await paneModel(pane);
        }
        return json(res, 200, { ok: true, pane, model: detected.model || model, verified: detected.model === model });
      } finally {
        modelSwitching.delete(pane);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/tasks/clear') {
      if (!sameOrigin(req) || req.headers['x-csrf-token'] !== session.csrf) return json(res, 403, { error: 'forbidden' });
      try {
        const archived = clearTaskQueue();
        return json(res, 200, { ok: true, archived: archived ? path.basename(archived) : null });
      } catch (e) {
        return json(res, 500, { error: e.message || 'could not clear the task queue' });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const s = await state();
      return json(res, s.error ? 503 : 200, s);
    }

    if (req.method === 'GET' && url.pathname === '/api/tail') {
      const pane = url.searchParams.get('pane') || '';
      const lines = Math.min(Math.max(Number(url.searchParams.get('lines') || 40), 1), 200);
      if (!PANE_RE.test(pane)) return json(res, 400, { error: 'invalid pane id' });
      const paneInfo = await herdrJson(['pane', 'get', pane]);
      if (!paneInfo.pane) return json(res, 404, { error: 'pane not found' });
      const args = paneInfo.pane.agent
        ? ['agent', 'read', pane, '--lines', String(lines)]
        : ['pane', 'read', pane, '--lines', String(lines), '--source', 'recent'];
      const r = await run(HERDR, args, { timeout: 8000 });
      if (!r.ok) return json(res, 502, { error: r.stderr.trim() || 'read failed' });
      return json(res, 200, { pane, lines, output: r.stdout });
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') {
      if (!sameOrigin(req) || req.headers['x-csrf-token'] !== session.csrf) return json(res, 403, { error: 'forbidden' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const pane = String(body.pane || '');
      if (!PANE_RE.test(pane)) return json(res, 400, { error: 'invalid pane id' });
      const result = await resetAgentPane(pane);
      if (result.status === 'reset') return json(res, 200, { ok: true, pane });
      return json(res, result.code || 409, { error: result.reason || 'reset failed' });
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      if (!sameOrigin(req) || req.headers['x-csrf-token'] !== session.csrf) return json(res, 403, { error: 'forbidden' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const pane = String(body.pane || '');
      if (!PANE_RE.test(pane)) return json(res, 400, { error: 'invalid pane id' });
      const result = await stopAgentPane(pane);
      if (result.status === 'stopped') return json(res, 200, { ok: true, pane, state: result.state });
      return json(res, result.code || 409, { error: result.reason || 'stop failed' });
    }

    if (req.method === 'POST' && url.pathname === '/api/agent/delete') {
      if (!sameOrigin(req) || req.headers['x-csrf-token'] !== session.csrf) return json(res, 403, { error: 'forbidden' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const pane = String(body.pane || '');
      if (!PANE_RE.test(pane)) return json(res, 400, { error: 'invalid pane id' });
      const result = await closeAgentPane(pane);
      if (result.status === 'closed') return json(res, 200, { ok: true, pane, role: result.role });
      return json(res, result.code || 409, { error: result.reason || 'delete failed' });
    }

    if (req.method === 'POST' && url.pathname === '/api/reset-all') {
      if (!sameOrigin(req) || req.headers['x-csrf-token'] !== session.csrf) return json(res, 403, { error: 'forbidden' });
      const [list, tabs] = await Promise.all([herdrJson(['pane', 'list']), herdrJson(['tab', 'list'])]);
      if (list.error) return json(res, 503, { error: list.error });
      const agents = (list.panes || []).filter((p) => p.agent);
      const results = [];
      for (const p of agents) {
        const result = await resetAgentPane(p.pane_id);
        results.push({
          pane: p.pane_id,
          role: roleForPane(p, tabs.tabs || []),
          status: result.status,
          reason: result.reason || null,
        });
      }
      return json(res, 200, { ok: true, results });
    }

    if (req.method === 'POST' && url.pathname === '/api/prompt') {
      if (!sameOrigin(req) || req.headers['x-csrf-token'] !== session.csrf) return json(res, 403, { error: 'forbidden' });
      const body = JSON.parse((await readBody(req, MAX_PROMPT_BODY)) || '{}');
      const pane = String(body.pane || '');
      const msg = String(body.text || '').trim();
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (!PANE_RE.test(pane)) return json(res, 400, { error: 'invalid pane id' });
      if (!msg && !attachments.length) return json(res, 400, { error: 'empty message' });
      if (msg.length > 4000) return json(res, 400, { error: 'message too long (max 4000)' });
      if (attachments.length > MAX_ATTACHMENTS) return json(res, 400, { error: `too many images (max ${MAX_ATTACHMENTS})` });
      let saved = [];
      try {
        saved = saveAttachments(attachments);
      } catch (e) {
        return json(res, 400, { error: e.message || 'could not save image' });
      }
      const note = saved.length
        ? `${msg ? '\n\n' : ''}Screenshot${saved.length > 1 ? 's' : ''} attached — open with the read tool:\n${saved.map((p) => `- ${p}`).join('\n')}`
        : '';
      const fullMsg = msg + note;
      const paneInfo = await herdrJson(['pane', 'get', pane]);
      if (!paneInfo.pane) {
        for (const p of saved) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
        return json(res, 404, { error: 'pane not found' });
      }
      if (!paneInfo.pane.agent) {
        for (const p of saved) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
        return json(res, 409, { error: 'pane has no agent' });
      }
      const args = ['agent', 'prompt', pane, fullMsg];
      if (body.wait) { args.push('--wait', '--timeout', '180000'); }
      const r = await run(HERDR, args, { timeout: body.wait ? 190000 : 12000 });
      if (!r.ok) {
        for (const p of saved) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
        return json(res, 502, { error: r.stderr.trim() || 'prompt failed', code: r.code });
      }
      return json(res, 200, { ok: true, pane, accepted: true, attachments: saved.length });
    }

    if (req.method === 'GET' && url.pathname === '/api/fs/list') {
      const dir = workspacePath(url.searchParams.get('path') || BASE);
      if (!dir) return json(res, 404, { error: 'not found in the workspace' });
      if (!fs.statSync(dir).isDirectory()) return json(res, 400, { error: 'not a folder' });
      return json(res, 200, { root: fs.realpathSync(BASE), path: dir, entries: listFolder(dir) });
    }

    if (req.method === 'GET' && url.pathname === '/api/fs/read') {
      const file = workspacePath(url.searchParams.get('path') || '');
      if (!file) return json(res, 404, { error: 'not found in the workspace' });
      if (!fs.statSync(file).isFile()) return json(res, 400, { error: 'not a regular file' });
      const r = readTextFile(file);
      if (r.binary) return json(res, 415, { error: 'binary file, not shown as text' });
      return json(res, 200, { path: file, size: r.size, truncated: r.truncated, text: r.text });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
});

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions) if (s.expires <= now) { sessions.delete(id); changed = true; }
  for (const [k, b] of ipFailures) if (b.resetAt <= now) ipFailures.delete(k);
  for (const [k, b] of userFailures) if (b.resetAt <= now) userFailures.delete(k);
  if (changed) saveSessions();
}, 10 * 60 * 1000).unref();

loadSessions();

server.listen(PORT, HOST, () => {
  console.log(`[dashboard] http://${HOST}:${PORT} (Linux/PAM login, service=${PAM_SERVICE})`);
  // Keep one live session-log follower per agent, including after /new and restarts.
  reconcileStreams();
  setInterval(reconcileStreams, 2000).unref();
  pruneUploads();
});
