# Multi-agent harness — setup and runbook

A minimal, local multi-agent workspace:

- **herdr** is the process layer: a headless terminal workspace with a pane/socket API.
- **pi** runs one coding agent per repository, in its own pane.
- **herdr-agent-messenger** (`msg`) carries agent-to-agent envelopes.
- A **zero-dependency web dashboard** gives the human status, prompts, live output,
  a task queue and model controls.

There is no orchestrator framework, message bus, container layer or database. The
repository checkouts and one `tasks.md` file are the shared state.

```
                    ┌──────────────────────────────┐
  browser ────────► │ dashboard  :7788             │  status · prompt · tail
                    │ web/                         │
                    └──────────────┬───────────────┘
                                   │ herdr socket / CLI
                    ┌──────────────▼───────────────┐
                    │ herdr server (headless)      │
                    │  coordinator  pi             │  dispatch.sh / task queue
                    │  backender    pi             │──► backend checkout
                    │  reviewer     pi             │◄── read-only audit of backend
                    │  frontender   pi             │──► frontend checkout
                    └───────────┬──────┬───────────┘
                                └─msg──┘  agent-to-agent envelopes
```

Pane ids are **not** configuration. Scripts resolve a role by its tab label first
(the backender and reviewer share the backend checkout) and fall back to the
working directory, so the setup survives herdr restarts and renumbering. Live
ids and call-signs are written to `memory.json` after each bootstrap.

## Design goals

| Need | Minimal answer | Deliberately not used |
|---|---|---|
| Isolated workers | one OS process per role; one git working tree per repo | containers/VMs per agent |
| Dispatch | herdr agent prompt / dashboard | queue service, agent framework |
| Agent-to-agent talk | Messenger envelope (`msg`) | Redis/NATS/pub-sub |
| Shared state | git + `tasks.md` + `.pi/SESSION.md` | database, vector store |
| Human interface | local web dashboard + herdr TUI | custom SPA, SSH-only |
| Verification | per-repo tests + headless Chromium | full CI pipeline |

Each project keeps its own conventions: `AGENTS.md`, project skills under
`.pi/skills/`, and its own test commands. The harness does not replicate those.

## Layout and configuration

By default the harness sits two levels below the workspace root:

```
<workspace>/
  ai-utils/multiagent/   <- harness checkout
  backend/               <- backender + reviewer
  frontend/              <- frontender
```

If your layout differs, set environment variables (for the dashboard, also export
them in the systemd unit environment):

| Variable | Default | Meaning |
|---|---|---|
| `WORKSPACE_ROOT` | two levels above the harness | workspace whose cwd the coordinator uses |
| `BACKEND_DIR` | `$WORKSPACE_ROOT/backend` | backend checkout |
| `FRONTEND_DIR` | `$WORKSPACE_ROOT/frontend` | frontend checkout |
| `MAH_STATE_DIR` | harness root | where `tasks.md`, `memory.json`, uploads live |
| `MAH_TASKS_FILE` | `$MAH_STATE_DIR/tasks.md` | queue path used by the pi extension |
| `MAH_REQUIRE_SERVER` | `0` | refuse to spawn a second herdr server |
| `MAH_REQUIRE_TOTP` | `1` | fail closed until a TOTP secret is enrolled |
| `MAH_ALLOWED_USERS` | dashboard user | comma-separated PAM accounts allowed to sign in |
| `MAH_TOTP_FILE` | `~/.config/mah/totp.key` | TOTP secret |
| `DASHBOARD_PORT` / `DASHBOARD_HOST` | `7788` / `127.0.0.1` | dashboard bind |
| `DASHBOARD_SESSION_HOURS` | `12` | session lifetime |
| `DASHBOARD_PAM_SERVICE` | `login` | PAM stack used for passwords |
| `DASHBOARD_TRUST_PROXY` | `0` | trust `X-Forwarded-For` |
| `DASHBOARD_SECURE` | `0` | set `Secure` on the session cookie (use behind TLS) |

## Prerequisites

### Required

| # | Prerequisite | Verify |
|---|---|---|
| 1 | `herdr` >= 0.9 on `PATH` | `herdr status` |
| 2 | `msg` (herdr-agent-messenger) on `PATH` | `msg --help` |
| 3 | `pi` with a provider credential | `pi --help`, `OPENROUTER_API_KEY` or `~/.pi/agent/auth.json` |
| 4 | `git`, `curl`, `jq`, `python3`, `node` >= 20.9 | `command -v ...`, `node -v` |
| 5 | Optional: backend/frontend git checkouts | `git -C <repo> status` |
| 6 | Local Linux account + PAM service | `ls /etc/pam.d/login` |
| 7 | `libpam.so.0` (Python ctypes helper) | `ldconfig -p | grep libpam.so.0` |

### Optional, depending on the projects

- PHP >= 8.2 + Composer for a Laravel backend (`vendor/`, `.env`, `APP_KEY`).
- A reachable MariaDB/MySQL for that backend.
- Node + `node_modules/` for a JS frontend; Expo/React Native needs Android SDK,
  JDK 17 and local prebuilds if you build native apps.
- Headless Chromium for UI verification.

Run the checks any time:

```bash
./preflight.sh            # human table, exit 1 on a required failure
./preflight.sh --json     # same data for automation
```

Optional runtime probes: set `API_HEALTH_URL` and/or `FRONTEND_URL` before running
`preflight.sh`.

### Notes

- `HERDR_ENV` / `HERDR_PANE_ID` exist only inside panes. Outside, `msg` cannot run;
  use `herdr agent prompt` (the dashboard and `dispatch.sh` already do).
- `msg` resolves **agent** panes. The coordinator is a normal agent pane, reachable
  with `dispatch.sh coordinator` or the dashboard.
- When an agent needs a human decision it ends its turn with a clear question; the
  human sees it in **Tail** and answers with **Prompt**.

## Bring-up and daily use

```bash
# 1. prerequisites and live state
./preflight.sh

# 2. first run: start herdr, create panes by role/cwd, launch pi in all four,
#    start the dashboard, refresh memory.json
./bootstrap.sh --start-agents --with-web

# 3. later: reuse panes and refresh state
./bootstrap.sh

# 4. once, to survive reboots and crashes
./systemd/install.sh
```

`--start-agents` gives the coordinator its coordination-only prompt
(`coordinator.md`) and the reviewer its read-only audit prompt (`reviewer.md`).
Only the backender and frontender may edit their checkouts.

Open the dashboard and sign in with a local Linux account:

```
http://127.0.0.1:7788/
```

Enrol the TOTP second factor once (the dashboard refuses sign-in until then unless
`MAH_REQUIRE_TOTP=0`):

```bash
node web/totp-setup.js
```

Per agent, the dashboard shows call-sign, pane id, agent/status, repo, branch and
dirty-file count. It also provides:

- **Tail** — a live, full session console (messages, thinking, tool calls, results).
- **Prompt** — dispatch, optionally waiting for idle.
- **Reset** — starts a fresh pi session via `/new`; blocked while the agent works.
- **Stop** — while working, Reset becomes Stop and interrupts the turn with `Esc`.
- **Model picker** — searchable model dropdown; applies `/model <id>`.
- **× delete** — closes that agent's pane/tab; disabled when it is the last agent.
- **Reset all agents** — sequential reset, skipping working agents.
- **Task queue** — `tasks.md`; click a task for its full text; **Clear** archives first.
- **Files** — read-only explorer confined to the workspace.

Command-line equivalents:

```bash
./dispatch.sh backender   "Add GET /api/foo + feature test; report commit."
./dispatch.sh reviewer    "Review the backender task at <commit>; run the tests and report APPROVED or CHANGES REQUESTED." --wait
./dispatch.sh frontender  "Wire the new endpoint; verify on web; report commit."
./dispatch.sh coordinator "Status?" --wait
herdr agent read <pane> --source visible --lines 40
```

## Task queue (`tasks.md`)

- It is a plain markdown file at the harness root. Nothing executes it; it is a
  coordination artifact.
- It is **not tracked**: `bootstrap.sh` creates it from the tracked
  `tasks.example.md` on first run, and `.gitignore` ignores it. Edit the example
  to change the default sections.
- Format: `##` section headings and `- [ ]` / `- [x]` checkbox lines. Indented
  continuation lines are the task's detail and appear in the dashboard pop-up.
- Sections: `## In progress`, `## Blocked — waiting on human decision`, `## Done`,
  `## Backlog`.
- The dashboard parses the last 40 checkboxes, groups them by section, and refreshes
  every 5 seconds.
- Conventions: one task per worker, backend first, then reviewer before the task is
  marked done.
- **Clear** archives the current file to `tasks-archive/<timestamp>.md` (last 20
  kept) and writes the empty template atomically.
- There is no lock: edits are last-write-wins. Clear writes a temp file and renames
  it, so the queue is never half-written.

### Working agreement

1. One task per agent at a time; the queue lives in `tasks.md`.
2. Backend first when the frontend consumes the change; every backend task then
   goes to the reviewer. `APPROVED` closes it, `CHANGES REQUESTED` returns it to the
   backender and then to the reviewer again.
3. Plan before code for anything crossing a module boundary; short status reports
   (outcome, files, verification, blocker) — no file dumps.
4. Each repo's `AGENTS.md` / `.pi/SESSION.md` workflow wins for implementation
   details. Commit when a change is complete; the repo must be clean between tasks.
5. Human approval is required for destructive, privileged or irreversible actions.
6. No cross-repo edits: backender and frontender only write inside their assigned
   checkout; the reviewer never writes or commits.
7. Verification is evidence: test output for logic, an inspected screenshot for UI,
   never “it should work”.
8. Waiting is bounded: a single wait/sleep is capped at **30 seconds**. If a worker
   is still running, report `waiting on <role>` and yield.

## Web interface

- Zero runtime dependencies (`node:http` + `child_process`), static pages, no
  external assets, works offline.
- **Live tail:** one background follower per agent pane, started at dashboard start
  and re-targeted every 2 s (so it follows `/new` and agent restarts). It reads the
  pi session JSONL from the beginning and streams complete lines over SSE.
- **Interrupt:** while an agent is `working`, its card's **Reset** button becomes
  **Stop**. `POST /api/stop` sends `Esc`, polls until the agent leaves `working`,
  and returns the state it landed in. Auth + CSRF required; 409 if the agent is not
  working or ignores the interrupt.
- **Bulk reset:** `POST /api/reset-all` loops every agent pane, runs the same `/new`
  flow, skips working panes, and returns per-role results.
- **Task clear:** `POST /api/tasks/clear` archives and atomically rewrites the queue.
- **Screenshot paste:** `POST /api/prompt` accepts base64 images, validates magic
  bytes/type/size/count, writes random names under `uploads/` (pruned after 7 days),
  and appends the absolute paths to the prompt.
- **Model change:** the dropdown calls `POST /api/model`; the server validates the id
  against the OpenRouter catalog, clears any draft, sends `/model <id>`, and returns
  the detected footer model.
- **Auth:** username + password are verified by `pam_auth.py` through `libpam` using
  the system `login` service; a TOTP code is required. Passwords are never logged or
  placed in argv/env. Accounts can be restricted with `MAH_ALLOWED_USERS`.
- **Session:** 256-bit random id, server-side only, `HttpOnly; SameSite=Strict`
  cookie, 12 h absolute expiry, cleared on logout. Sessions persist in
  `sessions.json` (mode 600, keyed by SHA-256 of the id), so a dashboard restart does
  not log you out.
- **CSRF:** `SameSite=Strict` plus an `x-csrf-token` header for prompts and logout;
  cross-origin POSTs are rejected by `Origin`.
- **Brute force:** account locks escalate after repeated failures; per-IP limits
  return 429 with `Retry-After`. `X-Forwarded-For` is trusted only with
  `DASHBOARD_TRUST_PROXY=1`.
- **Body limit** 8 KB, pane ids validated against a strict pattern, security headers
  (`nosniff`, `DENY`, `no-referrer`).
- **Composer QoL** in `localStorage`, namespaced by Linux username: wait-for-idle,
  selected agent, per-agent draft, thinking toggle, prompt history.

### Exposure

The dashboard binds `127.0.0.1` by default. It uses password + TOTP auth over plain
HTTP; **never expose it directly on a network**. Use an SSH tunnel
(`ssh -L 7788:127.0.0.1:7788`) or a TLS-terminating proxy, and set
`DASHBOARD_SECURE=1` behind TLS so the session cookie gets the `Secure` flag.

## systemd user units

`systemd/install.sh` renders the templates in `systemd/` with this checkout's paths
and installs them under `~/.config/systemd/user/`:

| Unit | Purpose |
|---|---|
| `mah-herdr.service` | `herdr server`; owns the panes and restores them |
| `mah-agents.service` | oneshot `bootstrap.sh --start-agents`; idempotent pane/agent bring-up |
| `mah-dashboard.service` | dashboard on `127.0.0.1:7788` |

Bring-up order: `herdr → agents → dashboard`. `mah-agents` waits for the herdr
socket and is `PartOf=mah-herdr.service`, so restarting herdr re-runs the idempotent
agent bring-up. Agents live in the herdr server's cgroup, so restarting the
dashboard never touches them.

```bash
systemctl --user status mah-herdr mah-agents mah-dashboard
systemctl --user restart mah-herdr.service
systemctl --user restart mah-agents.service
systemctl --user restart mah-dashboard.service
journalctl --user -u mah-herdr -u mah-agents -u mah-dashboard -f
```

`bootstrap.sh --with-web` also works by hand: it starts the dashboard unit when
installed and the defaults are in use (otherwise `setsid nohup node server.js`), and
under `MAH_REQUIRE_SERVER=1` it refuses to spawn a second herdr server.

## Intentionally out of scope

- An orchestrator framework or autonomous task loop (the human/coordinator decides;
  agents execute one task at a time).
- Per-agent containers, VMs or separate users (the checkouts are the boundary).
- A database, queue or bus for coordination.
- CI, release automation, or internet exposure.
- A coordinator that implements code.

## Files

| Path | Purpose |
|---|---|
| `README.md` | overview + quick start |
| `SETUP.md` | this runbook |
| `preflight.sh` | read-only prerequisite/state checker |
| `bootstrap.sh` | idempotent server/pane/agent/memory bring-up |
| `dispatch.sh` | role→pane resolver; prompt via msg or herdr |
| `web/server.js` | zero-dep dashboard API |
| `web/index.html` | login form + console + model picker + paste composer |
| `web/files.html` | read-only workspace explorer |
| `web/auth.js` | allowed users, lockout, TOTP |
| `web/pam_auth.py` | PAM authenticator (JSON in → exit 0/1) |
| `web/totp-setup.js` | one-time TOTP enrolment |
| `systemd/install.sh` | render/enable the user units, enable linger |
| `systemd/mah-*.service` | unit templates (`@HARNESS@`, `@WORKSPACE@`, ...) |
| `coordinator.md` | coordination-only system prompt |
| `reviewer.md` | read-only audit prompt |
| `tasks.example.md` | tracked queue template (copied to git-ignored `tasks.md`) |
| `pi-extensions/` | optional queue-guard extension + test |

Runtime logs: `journalctl --user -u mah-herdr -u mah-agents -u mah-dashboard`, or
`web/dashboard.log` when started outside systemd. herdr also writes its own log under
`~/.config/herdr/`; `herdr-server.log` is used when `bootstrap.sh` starts the server
itself.
