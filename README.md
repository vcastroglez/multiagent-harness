# multiagent-harness

A small, opinionated multi-agent workspace built on **herdr** (terminal workspace
and pane API), **pi** (per-repo coding agent), the **herdr-agent-messenger**
(`msg`), and a zero-dependency web dashboard.

Four roles run in herdr panes: a **coordinator** that plans and dispatches, a
**backender** and a **frontender** that implement in their own checkouts, and a
read-only **reviewer** that audits every backend task before it is closed. The
human talks to the coordinator from the dashboard; shared state is just the
checkouts plus one `tasks.md` queue.

Full runbook: [`SETUP.md`](SETUP.md).

## Layout

```
<workspace>/
  backend/                  # optional: backend checkout (backender + reviewer)
  frontend/                 # optional: frontend checkout (frontender)
  ai-utils/multiagent/      # this harness (default location)
```

The scripts resolve the workspace root as two levels above the harness. If your
layout differs, export it:

```bash
export WORKSPACE_ROOT="$HOME/work"       # contains backend/ and frontend/
export BACKEND_DIR="$HOME/work/api"      # optional override
export FRONTEND_DIR="$HOME/work/client"  # optional override
export MAH_STATE_DIR="$PWD"              # queue/memory live here (default: harness root)
```

The backend/frontend repositories are optional: with no checkout the panes are
still created and the dashboard shows the last known state.

## Quick start

```bash
git clone git@github.com:vcastroglez/multiagent-harness.git
cd multiagent-harness

./preflight.sh                          # read-only prerequisite check
./bootstrap.sh --start-agents --with-web
```

Open `http://127.0.0.1:7788/` and sign in with a local Linux account (PAM) plus
the enrolled TOTP code. Enrol the second factor once:

```bash
node web/totp-setup.js
```

`bootstrap.sh` is idempotent: it starts herdr if needed, creates one pane per
role (by tab label, falling back to cwd), starts `pi` in missing panes, refreshes
`memory.json`, seeds `tasks.md`, and optionally starts the dashboard.

## Roles

| Role | Cwd | Job |
|---|---|---|
| coordinator | workspace root | dispatch + task queue; never edits the repos |
| backender | backend checkout | implements backend tasks |
| reviewer | backend checkout | read-only audit of every completed backend task; never edits or commits |
| frontender | frontend checkout | implements frontend tasks |

After the backender reports a task, the coordinator sends the task and commit to
the reviewer. Only `APPROVED` closes the task; `CHANGES REQUESTED` goes back to
the backender and then back to the reviewer.

```bash
./dispatch.sh coordinator "Status?" --wait
./dispatch.sh backender  "Add the endpoint; report commit and tests."
./dispatch.sh reviewer   "Review commit <sha>; run the tests." --wait
./dispatch.sh frontender "Wire the new endpoint; verify on web."
```

## Dashboard

`web/server.js` is a single Node process with no npm dependencies. It provides:

- live, full-output **Tail** per agent (SSE over the pi session JSONL)
- **Prompt** dispatch with optional “wait for idle”
- per-agent **Reset** (`/new`) and **Stop** (interrupts the running turn)
- **Reset all agents**
- task queue rendered from `tasks.md` (created from `tasks.example.md` on first
  bootstrap and git-ignored); click a task to read its full text (including
  wrapped continuation lines) in a pop-up; **Clear** archives the queue first
- searchable **model picker**
- screenshot paste (validated, stored under `uploads/`, pruned)
- per-card **× delete** (disabled when it is the last agent)
- read-only file explorer over the workspace

Security: PAM login, server-side sessions in an `HttpOnly; SameSite=Strict`
cookie, CSRF header, rate limiting, body limits, and a TOTP second factor. It
binds `127.0.0.1` and speaks plain HTTP; do not expose it directly. Use an SSH
tunnel or a TLS-terminating proxy, and set `DASHBOARD_SECURE=1` behind TLS.

## Persistent stack (systemd --user)

```bash
./systemd/install.sh
```

This renders the unit templates in `systemd/` with this checkout's paths and
installs them under `~/.config/systemd/user/`:

| Unit | Type | What it does |
|---|---|---|
| `mah-herdr.service` | simple | `herdr server`: owns the panes, restores them, restarts on crash |
| `mah-agents.service` | oneshot | `bootstrap.sh --start-agents`: pane reuse, relaunch missing agents, refresh state |
| `mah-dashboard.service` | simple | dashboard on `127.0.0.1:7788` |

The installer enables linger (one-time, polkit-guarded) and restarts the units.
Bring-up order is `herdr → agents → dashboard`; agents live in the herdr
server's cgroup, so restarting the dashboard never touches them.

```bash
systemctl --user status mah-herdr mah-agents mah-dashboard
systemctl --user restart mah-herdr.service        # server + panes + agents
systemctl --user restart mah-agents.service       # re-init panes/agents only
systemctl --user restart mah-dashboard.service    # after editing server.js
journalctl --user -u mah-herdr -u mah-agents -u mah-dashboard -f
```

## Layout of this repository

```
bootstrap.sh          idempotent server/pane/agent bring-up
preflight.sh          read-only prerequisite/state checker
dispatch.sh           role -> pane resolver; prompt via msg or herdr
coordinator.md        coordination-only system prompt
reviewer.md           read-only audit prompt
tasks.example.md      queue template (copied to git-ignored tasks.md on first run)
THIRD_PARTY_NOTICES.md  third-party licenses and attributions
web/                  zero-dependency dashboard (Node + static pages)
systemd/              user unit templates + installer
pi-extensions/        optional queue-guard pi extension and its test
```

Runtime files (`memory.json`, `sessions.json`, `auth-state.json`,
`herdr-server.log`, `web/dashboard.log`, `uploads/`, `tasks-archive/`, build
caches) are git-ignored.

## Secrets

Tracked files must never contain credentials. The repository deliberately
excludes `.env` files, API keys, tokens, TOTP secrets, `auth-state.json`,
`sessions.json`, `memory.json`, database dumps, SSH keys and VPN profiles; see
`.gitignore`. The dashboard writes runtime state to `MAH_STATE_DIR` (default:
the harness root) and those files are ignored.

`tasks.md` is **not tracked**; it is created from `tasks.example.md` on first
bootstrap and ignored by Git. Keep deployment details and credentials out of it
anyway, because it may be shared or archived. If a secret is ever committed,
rotate it first, then rewrite history — deleting it in a later commit does not
remove it from Git.

## Licenses and third-party notices

This repository does not vendor or bundle herdr, pi, or their code. It invokes
them as separate programs, so their licenses govern your use of those tools:

- **herdr** — Apache License 2.0. Copyright the herdr contributors.
  <https://github.com/herdrdev/herdr> · [LICENSE](https://github.com/herdrdev/herdr/blob/master/LICENSE)
- **pi** — MIT License. Copyright (c) 2025 Mario Zechner.
  <https://github.com/earendil-works/pi> · [LICENSE](https://github.com/earendil-works/pi/blob/main/LICENSE)
- **Node.js** — its own license; see <https://github.com/nodejs/node/blob/main/LICENSE>.

If you redistribute herdr or pi, include their license and notice files and
mark modified files. Apache-2.0 does not grant trademark rights in the Herdr
name or logo. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the
notices and the full MIT text.

The harness code in this repository is private and **no license is granted for
it at this time**. Add a `LICENSE` file before distributing the harness itself.
