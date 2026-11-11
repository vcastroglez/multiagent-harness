#!/usr/bin/env bash
# create-agent.sh - start one more pi agent whose name says what it is for.
#
# usage: ./create-agent.sh <name> --cwd <dir> --purpose "<one line>" [--prompt <file>] [--model <provider/model>] [--dry-run]
#   <name>     purpose-based name, e.g. api-migrations or client-e2e-tests. It becomes the
#              tab label and the agent name, which is what the dashboard card shows.
#   --cwd      existing directory the agent works in
#   --purpose  one line saying what the agent is for (stored in memory.json)
#   --prompt   optional system prompt file, passed as --append-system-prompt
#   --model    predefined model for this agent; stored in role-models.json so it
#              survives /new. Defaults to the config's `default`.
#   --dry-run  run every check and print the plan, without creating anything
# Built-in roles (coordinator, backender, reviewer, frontender) are managed by bootstrap.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEMORY="$HERE/memory.json"
ROLE_MODELS="$HERE/role-models.json"
RESERVED='^(coordinator|backender|reviewer|frontender)$'
# Names that say nothing about the work. Trailing digits/-/_ are ignored before matching.
GENERIC='^(other|others|agent|agents|new|new-agent|tmp|temp|test|misc|misc-agent|worker|helper|tab|shell|pi|default|untitled|unnamed|extra|foo|bar)$'

fail() { echo "create-agent: $1" >&2; exit "${2:-1}"; }

NAME="${1:-}"
[ -n "$NAME" ] && [ "${NAME:0:1}" != "-" ] || fail "usage: create-agent.sh <name> --cwd <dir> --purpose \"<one line>\" [--prompt <file>] [--model <provider/model>] [--dry-run]" 64
shift
DIR=""; PURPOSE=""; PROMPT=""; MODEL=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cwd) DIR="${2:?--cwd needs a value}"; shift;;
    --purpose) PURPOSE="${2:?--purpose needs a value}"; shift;;
    --prompt) PROMPT="${2:?--prompt needs a value}"; shift;;
    --model) MODEL="${2:?--model needs a value}"; shift;;
    --dry-run) DRY=1;;
    *) fail "unknown option: $1" 64;;
  esac
  shift
done

# ---------- validate the request (no herdr changes yet) ----------
[[ "$NAME" =~ ^[a-z][a-z0-9_-]{1,31}$ ]] \
  || fail "name '$NAME' is invalid: 2-32 chars, lowercase letters/digits/-/_, starting with a letter" 64
core="$(sed -E 's/[-_0-9]+$//' <<<"$NAME")"
[[ ! "$NAME" =~ $RESERVED ]] || fail "'$NAME' is a built-in role; bootstrap.sh manages it" 64
[[ ! "$core" =~ $GENERIC ]] || fail "'$NAME' says nothing about the work; name the agent after its purpose (e.g. api-migrations)" 64
[ -n "${PURPOSE//[[:space:]]/}" ] || fail "--purpose is required: one line on what this agent is for" 64
[ -n "$DIR" ] && [ -d "$DIR" ] || fail "--cwd must be an existing directory (got '$DIR')" 64
DIR="$(cd "$DIR" && pwd)"
[ -z "$PROMPT" ] || [ -f "$PROMPT" ] || fail "--prompt file not found: $PROMPT" 64
[ -z "$MODEL" ] || [[ "$MODEL" =~ ^[A-Za-z0-9~][A-Za-z0-9._:/@~-]{0,119}$ ]] \
  || fail "--model '$MODEL' is not a valid model id" 64
# No explicit model: use the agent's own entry or the shared default. The entry
# is written to role-models.json below, so role-model.ts re-applies it on /new.
if [ -z "$MODEL" ] && [ -f "$ROLE_MODELS" ]; then
  MODEL="$(jq -r --arg n "$NAME" '.models[$n] // .default // empty' "$ROLE_MODELS" 2>/dev/null || true)"
fi

# ---------- check the live state (read-only) ----------
TABS_JSON="$(herdr tab list 2>/dev/null)" || fail "herdr is not reachable (is the server running?)"
AGENTS_JSON="$(herdr agent list 2>/dev/null)" || fail "herdr agent list failed"
LIVE="$({ jq -r '.result.tabs[].label // empty' <<<"$TABS_JSON"; jq -r '.result.agents[].name // empty' <<<"$AGENTS_JSON"; } | tr 'A-Z' 'a-z')"
grep -qxF "$NAME" <<<"$LIVE" && fail "'$NAME' is already used by a live tab or agent; pick a name for its purpose" 1

WS="$(jq -r '[.result.tabs[] | select(.label == "coordinator")][0].workspace_id // empty' <<<"$TABS_JSON")"
[ -n "$WS" ] || WS="$(herdr workspace list | jq -r '.result.workspaces[0].workspace_id')"

if [ "$DRY" = 1 ]; then
  echo "dry run: all checks passed"
  echo "  name=$NAME cwd=$DIR workspace=$WS"
  echo "  purpose: $PURPOSE"
  echo "  model: ${MODEL:-pi default}"
  echo "  would run: herdr tab create --workspace $WS --cwd $DIR --label $NAME --no-focus"
  echo "  would run: herdr agent start $NAME --kind pi --pane <new pane> --timeout 60000 -- ${MODEL:+--model $MODEL }${PROMPT:+--append-system-prompt $PROMPT}"
  exit 0
fi

# ---------- create the tab (label == name == purpose-based name) and start pi ----------
OUT="$(herdr tab create --workspace "$WS" --cwd "$DIR" --label "$NAME" --no-focus)" || fail "tab create failed"
TAB="$(jq -r '.result.tab.tab_id' <<<"$OUT")"
PANE="$(jq -r '.result.root_pane.pane_id' <<<"$OUT")"
agent_args=()
[ -z "$MODEL" ] || agent_args+=(--model "$MODEL")
[ -z "$PROMPT" ] || agent_args+=(--append-system-prompt "$PROMPT")
if [ ${#agent_args[@]} -gt 0 ]; then
  started=0
  herdr agent start "$NAME" --kind pi --pane "$PANE" --timeout 60000 -- "${agent_args[@]}" >/dev/null && started=1
else
  started=0
  herdr agent start "$NAME" --kind pi --pane "$PANE" --timeout 60000 >/dev/null && started=1
fi
if [ "$started" != 1 ]; then
  fail "tab $TAB (pane $PANE) exists but pi did not start; inspect with: herdr agent read $NAME --source visible --lines 40" 1
fi
herdr agent get "$NAME" | jq -r '.result.agent | "started: name=\(.name) pane=\(.pane_id) cwd=\(.cwd) status=\(.agent_status) ready=\(.interactive_ready)"'

# ---------- record it in memory.json (call-sign from the messenger name store, if present) ----------
PANE_JSON="$(herdr pane list 2>/dev/null || echo '{}')" \
NAME="$NAME" PANE="$PANE" DIR="$DIR" PURPOSE="$PURPOSE" MODEL="$MODEL" \
MEMORY="$MEMORY" ROLE_MODELS="$ROLE_MODELS" python3 - <<'PY'
import datetime, json, os, sys
call_sign = ""
try:
    sys.path.insert(0, os.path.expanduser("~/.local/share/herdr-agent-messenger/plugin/scripts"))
    import msg_names
    panes = json.loads(os.environ["PANE_JSON"])["result"]["panes"]
    call_sign = msg_names.ensure_names(panes).get(os.environ["PANE"], "")
except Exception as e:  # messenger missing: still register the agent
    print(f"create-agent: no call-sign ({e})", file=sys.stderr)
path = os.environ["MEMORY"]
with open(path) as f:
    mem = json.load(f)
entry = {
    "pane": os.environ["PANE"],
    "cwd": os.environ["DIR"],
    "call_sign": call_sign,
    "agent": "pi",
    "status": "idle",
    "purpose": os.environ["PURPOSE"],
}
model = os.environ.get("MODEL", "").strip()
if model:
    entry["model"] = model
mem.setdefault("agents", {})[os.environ["NAME"]] = entry
mem["last_updated"] = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
with open(path + ".tmp", "w") as f:
    json.dump(mem, f, indent=2)
    f.write("\n")
os.replace(path + ".tmp", path)

if model:
    cfg_path = os.environ["ROLE_MODELS"]
    try:
        try:
            with open(cfg_path) as f:
                cfg = json.load(f)
            if not isinstance(cfg, dict):
                cfg = {}
        except FileNotFoundError:
            cfg = {"version": 1, "models": {}}
        cfg.setdefault("version", 1)
        models = cfg.setdefault("models", {})
        if not isinstance(models, dict):
            models = cfg["models"] = {}
        models[os.environ["NAME"]] = model
        with open(cfg_path + ".tmp", "w") as f:
            json.dump(cfg, f, indent=2)
            f.write("\n")
        os.replace(cfg_path + ".tmp", cfg_path)
    except Exception as e:
        print(f"create-agent: could not record model in {cfg_path}: {e}", file=sys.stderr)
PY

echo "created '$NAME' (tab $TAB, pane $PANE, cwd $DIR${MODEL:+, model $MODEL})"
echo "task it with: herdr agent prompt $NAME \"<task>\"   (dispatch.sh only knows the four built-in roles)"
