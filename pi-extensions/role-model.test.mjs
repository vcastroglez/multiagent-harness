// Run: node pi-extensions/role-model.test.mjs
// Drives the extension with a fake pi API; no model calls are made.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-model-"));
const multiagent = path.join(root, "multiagent");
fs.mkdirSync(multiagent, { recursive: true });
const configFile = path.join(multiagent, "role-models.json");
fs.writeFileSync(configFile, JSON.stringify({
  version: 1,
  default: "openrouter/deepseek/deepseek-v4.1-flash-1017",
  models: {
    coordinator: "openrouter/anthropic/claude-haiku-5.5",
    backender: "openrouter/deepseek/deepseek-v4.1-flash-1017",
  },
}, null, 2));
fs.writeFileSync(path.join(multiagent, "memory.json"), JSON.stringify({
  agents: { toolsmith: { pane: "w1:p5" } },
}));

process.env.MAH_ROLE_MODELS = configFile;
delete process.env.HERDR_TAB_ID;

const { default: roleModel } = await import("./role-model.ts");

const models = [
  { provider: "openrouter", id: "anthropic/claude-haiku-5.5" },
  { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017" },
  { provider: "openrouter", id: "xiaomi/mimo-v2.6-pro" },
];

function makeHarness(current = models[1], available = models) {
  const handlers = {};
  const notifications = [];
  const setCalls = [];
  const pi = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    setModel: async (model) => {
      setCalls.push(`${model.provider}/${model.id}`);
      return true;
    },
  };
  roleModel(pi);
  const ctx = {
    cwd: root,
    model: current,
    modelRegistry: { getAvailable: () => available },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  };
  const start = async () => {
    for (const fn of handlers.session_start ?? []) await fn({ reason: "new" }, ctx);
  };
  return { start, setCalls, notifications };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("applies the role model on a fresh session", async () => {
  process.env.MAH_ROLE = "backender";
  const h = makeHarness(models[2]);
  await h.start();
  assert.deepEqual(h.setCalls, ["openrouter/deepseek/deepseek-v4.1-flash-1017"]);
});

test("keeps the model when it already matches (full provider/id)", async () => {
  process.env.MAH_ROLE = "backender";
  const h = makeHarness(models[1]);
  await h.start();
  assert.deepEqual(h.setCalls, []);
});

test("keeps the model when it already matches (bare id)", async () => {
  process.env.MAH_ROLE = "coordinator";
  const h = makeHarness({ provider: "openrouter", id: "anthropic/claude-haiku-5.5" });
  await h.start();
  assert.deepEqual(h.setCalls, []);
});

test("default applies to an agent recorded in memory.json", async () => {
  process.env.MAH_ROLE = "toolsmith";
  const h = makeHarness(models[2]);
  await h.start();
  assert.deepEqual(h.setCalls, ["openrouter/deepseek/deepseek-v4.1-flash-1017"]);
});

test("unknown role outside memory.json is untouched", async () => {
  process.env.MAH_ROLE = "some-other-project";
  const h = makeHarness(models[2]);
  await h.start();
  assert.deepEqual(h.setCalls, []);
});

test("no role context means no change", async () => {
  delete process.env.MAH_ROLE;
  const h = makeHarness(models[2]);
  await h.start();
  assert.deepEqual(h.setCalls, []);
});

test("unknown model warns and leaves the session alone", async () => {
  process.env.MAH_ROLE = "backender";
  const h = makeHarness(models[2], [models[2]]);
  await h.start();
  assert.deepEqual(h.setCalls, []);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].message, /not available/);
});

test("setModel refusal warns", async () => {
  process.env.MAH_ROLE = "backender";
  const handlers = {};
  const notifications = [];
  roleModel({
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    setModel: async () => false,
  });
  await handlers.session_start[0]({ reason: "new" }, {
    cwd: root,
    model: models[2],
    modelRegistry: { getAvailable: () => models },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /no credentials/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
delete process.env.MAH_ROLE;
delete process.env.MAH_ROLE_MODELS;
fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
