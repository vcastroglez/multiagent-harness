/**
 * queue-guard: the task queue must be updated in the same turn that did work.
 *
 * Rule (task-queue skill, rules 2 and 4): if a turn used tools, `tasks.md`
 * must be written before the agent replies. Prompt rules alone were not enough, so this
 * extension checks it when the turn is about to end.
 *
 * - Guarded sessions: cwd is the workspace root (coordinator) or inside the harness.
 *   Worker sessions in the backend and frontend checkouts are not guarded.
 * - A turn that used a tool and did not write tasks.md gets one reminder, injected through
 *   `agent_before_settle` as a continuation. Once per user turn, so it cannot loop.
 * - Writes are detected from `edit`/`write` calls on tasks.md and from bash commands that
 *   mention tasks.md together with a write operation (approximate; see `WRITE_HINT`).
 *
 * Install: symlink this file into ~/.pi/agent/extensions/ (see README.md beside it).
 * Override the queue location with MAH_TASKS_FILE (used by the test) and the
 * workspace with WORKSPACE_ROOT when the harness is not two levels below it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Resolve the harness from this file (Node resolves symlinks), so the extension works
// wherever the checkout lives.
const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TASKS_DEFAULT = path.join(HARNESS, "tasks.md");
const WRITE_HINT = /(>>?|\bsed\s+-i|\btee\b|\bmv\b|\bcp\b|\bperl\s+-i|\bjq\b|\bpython3?\b)/;

function realOr(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

const TASKS = realOr(process.env.MAH_TASKS_FILE || TASKS_DEFAULT);
const HARNESS_ROOT = path.dirname(TASKS);
const WORKSPACE = realOr(process.env.WORKSPACE_ROOT || path.dirname(path.dirname(HARNESS_ROOT)));

function guarded(cwd: string): boolean {
  const c = realOr(cwd);
  return c === WORKSPACE || c === HARNESS_ROOT || c.startsWith(HARNESS_ROOT + path.sep);
}

function isTasksFile(p: string, cwd: string): boolean {
  return realOr(path.resolve(cwd, p)) === TASKS;
}

function bashWritesTasks(cmd: string): boolean {
  return cmd.includes("tasks.md") && WRITE_HINT.test(cmd);
}

type Turn = { toolUsed: boolean; queueWritten: boolean; reminded: boolean };
const fresh = (): Turn => ({ toolUsed: false, queueWritten: false, reminded: false });

const REMINDER = [
  "queue-guard: this turn used tools but did not update the task queue.",
  `Before you reply, re-read ${TASKS} and fix it in this turn:`,
  "- finished work: [x] with the commit hash or reviewer verdict;",
  "- waiting on the human: move the task to Blocked and state the exact question;",
  "- started or dispatched: In progress with its status;",
  "- nothing in the queue changed: say so in one line, then reply.",
].join("\n");

export default function queueGuard(pi: ExtensionAPI) {
  let turn = fresh();

  pi.on("tool_call", async (event, ctx) => {
    if (!guarded(ctx.cwd)) return;
    const input = (event.input ?? {}) as Record<string, unknown>;
    if (event.toolName === "edit" || event.toolName === "write") {
      const p = String(input.path ?? "");
      if (p && isTasksFile(p, ctx.cwd)) turn.queueWritten = true;
      else turn.toolUsed = true;
      return;
    }
    if (event.toolName === "bash") {
      const cmd = String(input.command ?? "");
      if (bashWritesTasks(cmd)) turn.queueWritten = true;
      else turn.toolUsed = true;
      return;
    }
    turn.toolUsed = true;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!guarded(ctx.cwd) || !turn.toolUsed || turn.queueWritten || turn.reminded) return;
    turn.reminded = true;
    return {
      entries: [...event.entries, {
        type: "custom_message",
        customType: "queue-guard",
        content: REMINDER,
        display: true,
      }],
      continue: true,
    };
  });

  // agent_settled fires only when Pi will not continue on its own: start the next turn clean.
  pi.on("agent_settled", async () => { turn = fresh(); });
  pi.on("session_start", async () => { turn = fresh(); });
}
