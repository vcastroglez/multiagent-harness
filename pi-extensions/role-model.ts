/**
 * role-model: a herdr agent keeps its role's predefined model across /new.
 *
 * pi restores a session's recorded model when resuming it, but a fresh session
 * (/new, /fork, /resume of another session) starts from the process defaults.
 * That loses the per-role assignment. This extension re-applies the model from
 * `role-models.json` on every session_start, so the role default survives:
 *
 * - `models[<tab label>]` is the predefined model for that role/agent.
 * - `default` is used only for agents recorded in `memory.json`, so unrelated
 *   herdr tabs (other projects) are never touched.
 * - A missing/unknown model is a warning, not a failure; the session keeps pi's
 *   current model.
 *
 * The role comes from the herdr tab label (the same anchor bootstrap.sh and the
 * dashboard use), or from MAH_ROLE when set (the test uses this).
 *
 * Install: symlink this file into ~/.pi/agent/extensions/ (see README.md).
 * Override the config path with MAH_ROLE_MODELS and the state dir (memory.json)
 * with MAH_STATE_DIR (the test uses both).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function realFile(file: string): string {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

const EXT_DIR = path.dirname(realFile(fileURLToPath(import.meta.url)));
const CONFIG_CANDIDATES = [
  process.env.MAH_ROLE_MODELS,
  path.resolve(EXT_DIR, "..", "role-models.json"),
].filter((p): p is string => !!p);

function configFile(): string | null {
  for (const candidate of CONFIG_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* try next */ }
  }
  return null;
}

function readJson(file: string): Record<string, any> {
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    return doc && typeof doc === "object" ? doc : {};
  } catch {
    return {};
  }
}

function bareModel(spec: string): string {
  return String(spec).replace(/^openrouter\//, "");
}

function sameModel(spec: string, model: any): boolean {
  if (!model || typeof model.id !== "string") return false;
  const s = String(spec);
  const full = `${model.provider}/${model.id}`;
  return s === full || s === model.id || bareModel(s) === model.id;
}

// The tab label is the role name (coordinator, backender, api-migrations, ...).
function herdrRole(): string | null {
  const tabId = process.env.HERDR_TAB_ID;
  if (!tabId) return null;
  const bin = process.env.HERDR_BIN_PATH || "herdr";
  try {
    const raw = execFileSync(bin, ["tab", "list"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const doc = JSON.parse(raw);
    const tab = (doc?.result?.tabs || []).find((t: any) => t?.tab_id === tabId);
    return typeof tab?.label === "string" && tab.label.trim() ? tab.label.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function roleForSession(): string | null {
  const explicit = String(process.env.MAH_ROLE || "").trim().toLowerCase();
  return explicit || herdrRole();
}

function memoryFile(configPath: string): string {
  const stateDir = process.env.MAH_STATE_DIR
    ? path.resolve(process.env.MAH_STATE_DIR)
    : path.dirname(configPath);
  return path.join(stateDir, "memory.json");
}

function knownAgent(role: string, configPath: string): boolean {
  const memory = readJson(memoryFile(configPath));
  return !!(memory.agents && typeof memory.agents === "object" && memory.agents[role]);
}

function modelSpecFor(role: string, configPath: string): string | null {
  const doc = readJson(configPath);
  const models = doc.models && typeof doc.models === "object" ? doc.models : {};
  if (typeof models[role] === "string" && models[role].trim()) return models[role].trim();
  if (typeof doc.default === "string" && doc.default.trim() && knownAgent(role, configPath)) {
    return doc.default.trim();
  }
  return null;
}

function findModel(registry: any, spec: string): any {
  const models = typeof registry?.getAvailable === "function" ? registry.getAvailable() : [];
  const s = String(spec);
  const wanted = bareModel(s);
  return models.find((m: any) => `${m.provider}/${m.id}` === s)
    || models.find((m: any) => m.id === wanted)
    || null;
}

export default function roleModel(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const role = roleForSession();
    if (!role) return;
    const file = configFile();
    if (!file) return;
    const spec = modelSpecFor(role, file);
    if (!spec) return;
    if (sameModel(spec, ctx.model)) return;

    const model = findModel(ctx.modelRegistry, spec);
    if (!model) {
      ctx.ui?.notify?.(`role-model: ${spec} for ${role} is not available`, "warning");
      return;
    }
    const ok = await pi.setModel(model);
    if (!ok) ctx.ui?.notify?.(`role-model: no credentials for ${spec} (${role})`, "warning");
  });
}
