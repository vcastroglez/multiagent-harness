// Run: node pi-extensions/queue-guard.test.mjs
// Drives the extension with a fake pi API over a temporary workspace layout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-guard-'));
const projects = path.join(root, 'projects');
const harness = path.join(projects, 'multiagent');
const backend = path.join(projects, 'backend');
fs.mkdirSync(harness, { recursive: true });
fs.mkdirSync(backend, { recursive: true });
fs.writeFileSync(path.join(harness, 'tasks.md'), '# Task queue\n');
process.env.MAH_TASKS_FILE = path.join(harness, 'tasks.md');
process.env.WORKSPACE_ROOT = projects;

const { default: queueGuard } = await import('./queue-guard.ts');

const handlers = {};
queueGuard({ on: (name, fn) => { (handlers[name] ??= []).push(fn); } });
const emit = async (name, event, ctx) => {
  let out;
  for (const fn of handlers[name] ?? []) out = (await fn(event, ctx)) ?? out;
  return out;
};

const coord = { cwd: projects };
const bash = (command) => ({ toolName: 'bash', input: { command } });
const edit = (p) => ({ toolName: 'edit', input: { path: p } });
const settle = (ctx = coord) => emit('agent_before_settle', { entries: [] }, ctx);
const done = () => emit('agent_settled', {}, coord);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('tool use without a queue write -> one continuation with the reminder', async () => {
  await emit('tool_call', bash('git -C x commit -m y'), coord);
  const r = await settle();
  assert.equal(r.continue, true);
  const last = r.entries.at(-1);
  assert.equal(last.type, 'custom_message');
  assert.equal(last.customType, 'queue-guard');
  assert.match(last.content, /did not update the task queue/);
  await done();
});

test('reminder is not repeated within the same turn', async () => {
  await emit('tool_call', bash('ls'), coord);
  assert.ok(await settle());
  assert.equal(await settle(), undefined);
  await done();
});

test('edit of tasks.md (absolute path) satisfies the guard', async () => {
  await emit('tool_call', bash('ls'), coord);
  await emit('tool_call', edit(path.join(harness, 'tasks.md')), coord);
  assert.equal(await settle(), undefined);
  await done();
});

test('edit of tasks.md (relative to cwd) satisfies the guard', async () => {
  await emit('tool_call', bash('ls'), coord);
  await emit('tool_call', edit('multiagent/tasks.md'), coord);
  assert.equal(await settle(), undefined);
  await done();
});

test('bash write to tasks.md (sed -i) satisfies the guard', async () => {
  await emit('tool_call', bash('git commit -m z && sed -i s/a/b/ multiagent/tasks.md'), coord);
  assert.equal(await settle(), undefined);
  await done();
});

test('read-only bash mention of tasks.md does not satisfy the guard', async () => {
  await emit('tool_call', bash('cat multiagent/tasks.md'), coord);
  assert.ok(await settle());
  await done();
});

test('a turn with no tool use is not guarded', async () => {
  assert.equal(await settle(), undefined);
  await done();
});

test('worker sessions in the backend repo are not guarded', async () => {
  const worker = { cwd: backend };
  await emit('tool_call', edit('app/Http/x.php'), worker);
  assert.equal(await settle(worker), undefined);
  await done();
});

test('settled resets state: next turn is guarded again', async () => {
  await emit('tool_call', bash('ls'), coord);
  assert.ok(await settle());
  await done();
  await emit('tool_call', bash('ls'), coord);
  assert.ok(await settle());
  await done();
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
