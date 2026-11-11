#!/usr/bin/env bash
# dispatch.sh - send a task to a role without hard-coding pane ids.
#
# usage: ./dispatch.sh <coordinator|backender|frontender|w1:pN> <message> [--wait]
# Inside a herdr pane it uses the Messenger (msg, agent-msg envelope).
# Outside herdr it falls back to `herdr agent prompt`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${WORKSPACE_ROOT:-$(cd "$HERE/../.." && pwd)}"
API="${BACKEND_DIR:-$BASE/backend}"
CLIENT="${FRONTEND_DIR:-$BASE/frontend}"
TARGET="${1:-}"
shift || true
WAIT=0
MSG_PARTS=()
for arg in "$@"; do
  case "$arg" in
    --wait) WAIT=1;;
    *) MSG_PARTS+=("$arg");;
  esac
done
MESSAGE="${MSG_PARTS[*]:-}"
[ -n "$TARGET" ] && [ -n "$MESSAGE" ] || { echo "usage: dispatch.sh <role|pane> <message> [--wait]" >&2; exit 64; }

# role -> stable cwd anchor. The reviewer shares the backend checkout with the
# backender, so tab labels are resolved first and cwd is only the fallback.
ROLE=""
case "$TARGET" in
  coordinator|coord|lead) ROLE="coordinator"; DIR="$BASE";;
  backender|be|api) ROLE="backender"; DIR="$API";;
  frontender|fe|client) ROLE="frontender"; DIR="$CLIENT";;
  reviewer|rev|auditor|audit) ROLE="reviewer"; DIR="$API";;
  *) DIR="";;
esac

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

if [[ "$TARGET" =~ ^w[0-9]+:p[0-9A-Za-z]+$ ]]; then
  PANE="$TARGET"
elif [ -n "$ROLE" ]; then
  PANE="$(pane_for_label "$ROLE" || true)"
  if [ -z "$PANE" ] && [ "$ROLE" != "reviewer" ]; then
    while IFS= read -r candidate; do
      [ -n "$candidate" ] || continue
      label="$(pane_label "$candidate" || true)"
      case "$label" in
        coordinator|backender|frontender|reviewer)
          [ "$label" = "$ROLE" ] || continue
          ;;
      esac
      PANE="$candidate"
      break
    done < <(herdr pane list 2>/dev/null | jq -r --arg d "$DIR" '
      [.result.panes[] | select(.cwd == $d)]
      | sort_by(if .agent then 0 else 1 end)
      | .[].pane_id')
  fi
else
  echo "unknown target '$TARGET' (use coordinator|backender|reviewer|frontender|<pane>)" >&2; exit 64
fi
[ -n "$PANE" ] || { echo "no pane for '$TARGET' (run bootstrap.sh)" >&2; exit 1; }

if ! herdr pane get "$PANE" 2>/dev/null | jq -e '.result.pane.agent' >/dev/null; then
  echo "pane $PANE has no agent; run $HERE/bootstrap.sh --start-agents" >&2; exit 1
fi

if [ "${HERDR_ENV:-}" = "1" ] && command -v msg >/dev/null 2>&1; then
  msg "$PANE" "$MESSAGE"
else
  if [ "$WAIT" = "1" ]; then
    herdr agent prompt "$PANE" "$MESSAGE" --wait --timeout 300000
  else
    herdr agent prompt "$PANE" "$MESSAGE"
  fi
fi
