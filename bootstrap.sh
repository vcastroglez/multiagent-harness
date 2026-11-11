#!/usr/bin/env bash
# bootstrap.sh - bring up the multi-agent environment (herdr + pi + dashboard).
# Idempotent: safe to run repeatedly; never kills existing agents.
#
# usage: ./bootstrap.sh [--start-agents] [--with-web] [--port N] [--host HOST]
#   WORKSPACE_ROOT  workspace containing the backend/ and frontend/ checkouts
#                   (default: two levels above this script)
#   BACKEND_DIR     backend checkout (default: $WORKSPACE_ROOT/backend)
#   FRONTEND_DIR    frontend checkout (default: $WORKSPACE_ROOT/frontend)
#   --start-agents  start pi in the coordinator and the two repo panes
#   --with-web      start the dashboard if it is not already listening
#   --port N        dashboard port (default 7788)
#   --host HOST     dashboard bind address (default 127.0.0.1; 0.0.0.0 exposes it)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${WORKSPACE_ROOT:-$(cd "$HERE/../.." && pwd)}"
API="${BACKEND_DIR:-$BASE/backend}"
CLIENT="${FRONTEND_DIR:-$BASE/frontend}"
COORD_PROMPT="$HERE/coordinator.md"
REVIEW_PROMPT="$HERE/reviewer.md"
PORT="${DASHBOARD_PORT:-7788}"
HOST="${DASHBOARD_HOST:-127.0.0.1}"
START_AGENTS=0
WITH_WEB=0

while [ $# -gt 0 ]; do
  case "$1" in
    --start-agents) START_AGENTS=1;;
    --with-web) WITH_WEB=1;;
    --port) PORT="${2:?--port needs a value}"; shift;;
    --host) HOST="${2:?--host needs a value}"; shift;;
    *) echo "unknown option: $1" >&2; exit 64;;
  esac
  shift
done

log() { printf '[bootstrap] %s\n' "$*"; }

# ---------- herdr server ----------
if herdr status 2>/dev/null | grep -A1 '^server:' | grep -q 'status: running'; then
  log "herdr server already running"
else
  # under systemd, mah-herdr.service owns the server: never spawn a second one
  if [ "${MAH_REQUIRE_SERVER:-0}" = "1" ]; then
    echo "herdr server not running and MAH_REQUIRE_SERVER=1 (start mah-herdr.service)" >&2
    exit 1
  fi
  log "starting headless herdr server"
  ( cd "$BASE" && setsid nohup herdr server >"$HERE/herdr-server.log" 2>&1 </dev/null & )
  for _ in $(seq 1 30); do
    if herdr status 2>/dev/null | grep -A1 '^server:' | grep -q 'status: running'; then break; fi
    sleep 0.5
  done
  herdr status 2>/dev/null | grep -A1 '^server:' | grep -q 'status: running' \
    || { echo "herdr server failed to start; see $HERE/herdr-server.log" >&2; exit 1; }
fi

WS_ID="$(herdr workspace list 2>/dev/null | jq -r '.result.workspaces[0].workspace_id // empty')"
if [ -z "$WS_ID" ]; then
  log "creating workspace"
  WS_ID="$(herdr workspace create --cwd "$BASE" --label multiagent --focus 2>/dev/null | jq -r '.result.workspace.workspace_id // .result.workspace_id')"
fi
[ -n "$WS_ID" ] || { echo "could not determine herdr workspace" >&2; exit 1; }
log "workspace: $WS_ID"

# ---------- role panes ----------
# Tab labels are the primary anchor because two roles can share a cwd (the
# reviewer audits the backender's repository). cwd is the first-run fallback.
pane_for_label() {
  local role="$1" tab_id
  tab_id="$(herdr tab list 2>/dev/null | jq -r --arg l "$role" '
    [.result.tabs[] | select((.label // "") | ascii_downcase == ($l | ascii_downcase))][0].tab_id // empty')"
  [ -n "$tab_id" ] || return 1
  herdr pane list 2>/dev/null | jq -r --arg t "$tab_id" '
    .result.panes[] | select(.tab_id == $t) | .pane_id' | head -1
}

pane_label() {
  local pane="$1" tab_id
  tab_id="$(herdr pane get "$pane" 2>/dev/null | jq -r '.result.pane.tab_id // empty')"
  [ -n "$tab_id" ] || return 1
  herdr tab list 2>/dev/null | jq -r --arg t "$tab_id" '
    [.result.tabs[] | select(.tab_id == $t)][0].label // empty'
}

ensure_pane() {
  local role="$1" dir="$2" pane candidate label tab_id current_label
  pane="$(pane_for_label "$role" || true)"
  if [ -z "$pane" ]; then
    while IFS= read -r candidate; do
      [ -n "$candidate" ] || continue
      label="$(pane_label "$candidate" || true)"
      case "$label" in
        coordinator|backender|frontender|reviewer)
          [ "$label" = "$role" ] || continue
          ;;
      esac
      pane="$candidate"
      break
    done < <(herdr pane list 2>/dev/null | jq -r --arg d "$dir" '
      [.result.panes[] | select(.cwd == $d)]
      | sort_by(if .agent then 0 else 1 end)
      | .[].pane_id')
  fi
  if [ -z "$pane" ]; then
    log "creating $role pane at $dir" >&2
    pane="$(herdr tab create --workspace "$WS_ID" --cwd "$dir" --label "$role" --no-focus 2>/dev/null \
      | jq -r '.result.root_pane.pane_id')"
  fi
  [ -n "$pane" ] || { echo "could not create $role pane" >&2; exit 1; }

  # Keep the tab label equal to the role so a later run never mistakes the
  # reviewer pane for the backender pane (both live in the backend checkout).
  tab_id="$(herdr pane get "$pane" 2>/dev/null | jq -r '.result.pane.tab_id // empty')"
  if [ -n "$tab_id" ]; then
    current_label="$(herdr tab list 2>/dev/null | jq -r --arg t "$tab_id" \
      '[.result.tabs[] | select(.tab_id == $t)][0].label // empty')"
    if [ "$current_label" != "$role" ]; then
      herdr tab rename "$tab_id" "$role" >/dev/null 2>&1 || true
    fi
  fi
  printf '%s' "$pane"
}

COORD_PANE="$(ensure_pane coordinator "$BASE")"
BE_PANE="$(ensure_pane backender "$API")"
REVIEW_PANE="$(ensure_pane reviewer "$API")"
FE_PANE="$(ensure_pane frontender "$CLIENT")"
log "panes: coordinator=$COORD_PANE backender=$BE_PANE reviewer=$REVIEW_PANE frontender=$FE_PANE"

# ---------- optional agent start ----------
start_agent() {
  local role="$1" pane="$2" agent extra=()
  agent="$(herdr pane get "$pane" 2>/dev/null | jq -r '.result.pane.agent // empty')"
  if [ -n "$agent" ]; then log "$role: already running $agent"; return 0; fi
  if [ "$START_AGENTS" != "1" ]; then log "$role: shell pane (use --start-agents to launch pi)"; return 0; fi
  # The coordinator gets coordination-only rules; it must not edit either repo.
  # The reviewer gets read-only/audit rules for the backender's repository.
  if [ "$role" = coordinator ] && [ -f "$COORD_PROMPT" ]; then
    extra=(-- --append-system-prompt "$COORD_PROMPT")
  elif [ "$role" = reviewer ] && [ -f "$REVIEW_PROMPT" ]; then
    extra=(-- --append-system-prompt "$REVIEW_PROMPT")
  fi
  log "$role: starting pi in $pane"
  herdr agent start "$role" --kind pi --pane "$pane" --timeout 60000 "${extra[@]}" >/dev/null
  log "$role: pi ready"
}
# Coordinator: coordination only (dispatch + task queue). The workers remain
# the only agents allowed to edit the backend and frontend checkouts.
start_agent coordinator "$COORD_PANE"
start_agent backender "$BE_PANE"
start_agent reviewer "$REVIEW_PANE"
start_agent frontender "$FE_PANE"

# ---------- live call-signs + memory.json ----------
PANE_JSON="$(herdr pane list)"
NAMES_JSON="$(PANE_JSON="$PANE_JSON" python3 - <<'PY' 2>/dev/null || echo '{}'
import json, os, sys
scripts = os.path.expanduser("~/.local/share/herdr-agent-messenger/plugin/scripts")
sys.path.insert(0, scripts)
try:
    import msg_names
    panes = json.loads(os.environ["PANE_JSON"])["result"]["panes"]
    print(json.dumps(msg_names.ensure_names(panes)))
except Exception:
    print("{}")
PY
)"

MEMORY="$HERE/memory.json" PANE_JSON="$PANE_JSON" NAMES_JSON="$NAMES_JSON" \
COORD="$COORD_PANE" BE="$BE_PANE" REVIEW="$REVIEW_PANE" FE="$FE_PANE" API="$API" CLIENT="$CLIENT" BASE="$BASE" \
python3 - <<'PY'
import json, os, datetime, subprocess

path = os.environ["MEMORY"]
try:
    doc = json.load(open(path))
except Exception:
    doc = {
        "agents": {},
        "branches": {},
        "current_task": None,
        "constraints": [
            "Agents work only inside the backend and frontend checkouts",
            "The reviewer is read-only: it never edits or commits",
        ],
    }

def branch(d):
    try:
        return subprocess.check_output(["git", "-C", d, "rev-parse", "--abbrev-ref", "HEAD"],
                                       text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return "?"

branches = doc.setdefault("branches", {})
branches["be"] = branch(os.environ["API"])
branches["fe"] = branch(os.environ["CLIENT"])

panes = {p["pane_id"]: p for p in json.loads(os.environ["PANE_JSON"])["result"]["panes"]}
names = json.loads(os.environ.get("NAMES_JSON") or "{}")
role_map = {
    "coordinator": (os.environ["COORD"], os.environ["BASE"]),
    "backender": (os.environ["BE"], os.environ["API"]),
    "reviewer": (os.environ["REVIEW"], os.environ["API"]),
    "frontender": (os.environ["FE"], os.environ["CLIENT"]),
}
agents = doc.setdefault("agents", {})
for role, (pane, cwd) in role_map.items():
    entry = agents.setdefault(role, {})
    entry["pane"] = pane
    entry["cwd"] = cwd
    p = panes.get(pane, {})
    entry["call_sign"] = names.get(pane) or "-"
    entry["agent"] = p.get("agent") or "shell"
    entry["status"] = p.get("agent_status") if p.get("agent") else "shell"

doc["last_updated"] = datetime.datetime.now().isoformat(timespec="seconds")
doc["layout"] = {"workspace": next(iter(panes.values()), {}).get("workspace_id", "w1"),
                 "mode": "herdr panes + messenger",
                 "prepare": "bootstrap.sh"}
json.dump(doc, open(path, "w"), indent=2)
print(json.dumps({r: {"pane": v["pane"], "call_sign": v["call_sign"], "agent": v.get("agent")}
                  for r, v in agents.items()}, indent=2))
PY

# seed the queue on first run (tasks.md itself is git-ignored)
if [ ! -f "$HERE/tasks.md" ]; then
  if [ -f "$HERE/tasks_template.md" ]; then
    cp "$HERE/tasks_template.md" "$HERE/tasks.md"
  else
    printf '# Task queue\n\nNo tasks queued.\n' >"$HERE/tasks.md"
  fi
fi

# ---------- optional dashboard ----------
if [ "$WITH_WEB" = "1" ]; then
  WEB_UNIT="${DASHBOARD_UNIT:-mah-dashboard.service}"
  # the shipped unit pins PORT=7788 / HOST=127.0.0.1; only reuse it for defaults
  USE_UNIT=0
  if [ "$PORT" = "7788" ] && [ "$HOST" = "127.0.0.1" ] \
     && systemctl --user cat "$WEB_UNIT" >/dev/null 2>&1; then
    USE_UNIT=1
  fi

  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
    log "dashboard already listening on :$PORT"
  else
    if [ "$USE_UNIT" = "1" ]; then
      log "starting $WEB_UNIT (systemd --user)"
      systemctl --user start "$WEB_UNIT" 2>/dev/null || true
    else
      log "starting dashboard on :$PORT"
      # setsid + closed stdin: the dashboard must outlive this script and its caller
      ( cd "$HERE/web" && PORT="$PORT" HOST="$HOST" setsid nohup node server.js >>"$HERE/web/dashboard.log" 2>&1 </dev/null & )
    fi
    for _ in $(seq 1 20); do
      if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/health"; then break; fi
      sleep 0.25
    done
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
      log "dashboard: http://$HOST:$PORT/ (sign in with a Linux account)"
      if [ "$USE_UNIT" = "1" ]; then
        log "managed by systemd: systemctl --user status $WEB_UNIT"
      fi
    elif [ "$USE_UNIT" = "1" ]; then
      log "dashboard failed to start; see journalctl --user -u $WEB_UNIT"
    else
      log "dashboard failed to start; see $HERE/web/dashboard.log"
    fi
  fi
fi

log "done. next: $HERE/preflight.sh"
