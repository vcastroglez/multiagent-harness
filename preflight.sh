#!/usr/bin/env bash
# preflight.sh - verify every prerequisite for the multi-agent setup.
# Read-only: starts nothing, changes nothing.
#
# usage: ./preflight.sh [--json]
# exit:  0 = all required checks pass (warnings allowed)
#        1 = at least one required check failed
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${WORKSPACE_ROOT:-$(cd "$HERE/../.." && pwd)}"
API="${BACKEND_DIR:-$BASE/backend}"
CLIENT="${FRONTEND_DIR:-$BASE/frontend}"
STATE="${MAH_STATE_DIR:-$HERE}"
JSON=0
[ "${1:-}" = "--json" ] && JSON=1

FAILS=0
WARNS=0
declare -a ROWS=()

pass() { ROWS+=("PASS|$1|$2"); }
warn() { WARNS=$((WARNS+1)); ROWS+=("WARN|$1|$2"); }
fail() { FAILS=$((FAILS+1)); ROWS+=("FAIL|$1|$2"); }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------- 1. binaries ----------
for bin in herdr msg pi git curl jq python3 php composer node npm java adb; do
  if have "$bin"; then pass "bin:$bin" "$(command -v "$bin")"; else
    case "$bin" in
      adb|java) warn "bin:$bin" "missing (only needed for native builds)";;
      *) fail "bin:$bin" "missing from PATH";;
    esac
  fi
done

# ---------- 2. versions ----------
php_ver="$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;' 2>/dev/null || echo 0.0)"
if php -r 'exit(version_compare(PHP_VERSION,"8.2.0",">=")?0:1);' 2>/dev/null; then
  pass "php>=8.2" "$php_ver"
else
  fail "php>=8.2" "found $php_ver"
fi

node_ver="$(node -v 2>/dev/null | sed 's/^v//')"
if node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=9)?0:1)' 2>/dev/null; then
  pass "node>=20.9" "$node_ver"
else
  fail "node>=20.9" "found ${node_ver:-none}"
fi

if php -m 2>/dev/null | grep -qx pdo_mysql; then pass "php-ext:pdo_mysql" "loaded"; else fail "php-ext:pdo_mysql" "missing"; fi
for ext in mbstring openssl tokenizer xml ctype json curl fileinfo bcmath; do
  php -m 2>/dev/null | grep -qix "$ext" || warn "php-ext:$ext" "missing (Laravel may complain)"
done

# ---------- 3. herdr server + panes ----------
if herdr status 2>/dev/null | grep -A1 '^server:' | grep -q 'status: running'; then
  pass "herdr:server" "running"
  panes_json="$(herdr pane list 2>/dev/null || echo '{}')"
  if echo "$panes_json" | jq -e '.result.panes|length>0' >/dev/null 2>&1; then
    pass "herdr:panes" "$(echo "$panes_json" | jq '.result.panes|length') pane(s)"
  else
    fail "herdr:panes" "no panes (run bootstrap.sh)"
  fi
  for role in api client; do
    dir=$([ "$role" = api ] && echo "$API" || echo "$CLIENT")
    if echo "$panes_json" | jq -e --arg d "$dir" '.result.panes[]|select(.cwd==$d)' >/dev/null 2>&1; then
      agent="$(echo "$panes_json" | jq -r --arg d "$dir" '.result.panes[]|select(.cwd==$d)|.agent // "shell"' | head -1)"
      status="$(echo "$panes_json" | jq -r --arg d "$dir" '.result.panes[]|select(.cwd==$d)|.agent_status // "unknown"' | head -1)"
      pass "herdr:pane:$role" "$dir (agent=$agent, status=$status)"
    else
      fail "herdr:pane:$role" "no pane with cwd $dir (run bootstrap.sh)"
    fi
  done
  if echo "$panes_json" | jq -e --arg d "$BASE" '.result.panes[]|select(.cwd==$d)' >/dev/null 2>&1; then
    coord_agent="$(echo "$panes_json" | jq -r --arg d "$BASE" '.result.panes[]|select(.cwd==$d)|.agent // empty' | head -1)"
    if [ -n "$coord_agent" ]; then
      pass "herdr:pane:coordinator" "agent=$coord_agent (coordination only)"
    else
      warn "herdr:pane:coordinator" "shell; run bootstrap.sh --start-agents to enable chat"
    fi
  else
    warn "herdr:pane:coordinator" "no coordinator pane at $BASE"
  fi

  tabs_json="$(herdr tab list 2>/dev/null || echo '{}')"
  reviewer_tab="$(echo "$tabs_json" | jq -r '
    [.result.tabs[] | select((.label // "") | ascii_downcase == "reviewer")][0].tab_id // empty')"
  reviewer_pane=""
  if [ -n "$reviewer_tab" ]; then
    reviewer_pane="$(echo "$panes_json" | jq -r --arg t "$reviewer_tab" '.result.panes[]|select(.tab_id==$t)|.pane_id' | head -1)"
  fi
  if [ -n "$reviewer_pane" ]; then
    reviewer_agent="$(echo "$panes_json" | jq -r --arg p "$reviewer_pane" '.result.panes[]|select(.pane_id==$p)|.agent // empty' | head -1)"
    if [ -n "$reviewer_agent" ]; then
      pass "herdr:pane:reviewer" "$reviewer_pane (agent=$reviewer_agent, read-only audit)"
    else
      warn "herdr:pane:reviewer" "shell; run bootstrap.sh --start-agents to enable review"
    fi
  else
    fail "herdr:pane:reviewer" "no reviewer pane (run bootstrap.sh)"
  fi
else
  fail "herdr:server" "not running (run: nohup herdr server &)"
fi

if [ -n "${HERDR_ENV:-}" ]; then
  pass "herdr:env" "HERDR_ENV=$HERDR_ENV"
else
  warn "herdr:env" "not set (normal outside panes; msg needs it inside a pane)"
fi

# ---------- 4. pi provider readiness ----------
if [ -n "${OPENROUTER_API_KEY:-}" ] || [ -s "$HOME/.pi/agent/auth.json" ]; then
  pass "pi:auth" "provider credentials present"
else
  fail "pi:auth" "set OPENROUTER_API_KEY or run pi auth"
fi
if [ -f "$HOME/.pi/agent/extensions/herdr-agent-messenger.ts" ]; then
  pass "pi:extension:messenger" "installed"
else
  warn "pi:extension:messenger" "herdr-agent-messenger pi adapter not linked"
fi

# ---------- 5. project shape ----------
for d in "$API" "$CLIENT"; do
  if [ -d "$d/.git" ]; then pass "git:$(basename "$d")" "$d"; else fail "git:$(basename "$d")" "not a git repo: $d"; fi
done
[ -f "$STATE/tasks.md" ] && pass "queue:tasks.md" "$STATE/tasks.md" || fail "queue:tasks.md" "missing (run bootstrap.sh)"
[ -f "$STATE/memory.json" ] && pass "state:memory.json" "$STATE/memory.json" || fail "state:memory.json" "missing (run bootstrap.sh)"
[ -f "$STATE/web/server.js" ] && pass "web:server" "$STATE/web/server.js" || fail "web:server" "missing"
[ -f "$STATE/web/pam_auth.py" ] && pass "web:pam_auth" "$STATE/web/pam_auth.py" || fail "web:pam_auth" "missing"
[ -f "$STATE/coordinator.md" ] && pass "agent:coordinator_prompt" "$STATE/coordinator.md" || warn "agent:coordinator_prompt" "missing"
[ -f "$STATE/reviewer.md" ] && pass "agent:reviewer_prompt" "$STATE/reviewer.md" || fail "agent:reviewer_prompt" "missing"
pam_service="${DASHBOARD_PAM_SERVICE:-login}"
if [ -f "/etc/pam.d/$pam_service" ]; then pass "pam:service" "/etc/pam.d/$pam_service"; else fail "pam:service" "/etc/pam.d/$pam_service missing"; fi
if python3 -c 'import ctypes; ctypes.CDLL("libpam.so.0")' 2>/dev/null; then pass "pam:libpam" "libpam.so.0"; else fail "pam:libpam" "libpam.so.0 not found"; fi
if printf '{"username":"__no_such_user__","password":"x"}' | python3 "$STATE/web/pam_auth.py" >/dev/null 2>&1; then
  warn "pam:probe" "unexpected success for nonexistent user"
else
  rc=$?
  if [ "$rc" = "1" ]; then pass "pam:probe" "rejects unknown user (rc=1)"; else warn "pam:probe" "helper returned rc=$rc (expected 1)"; fi
fi
for d in "$API" "$CLIENT"; do
  n="$(find "$d/.pi/skills" -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${n:-0}" -gt 0 ]; then pass "skills:$(basename "$d")" "$n project skill(s)"; else warn "skills:$(basename "$d")" "no .pi/skills"; fi
done

# ---------- 6. API prerequisites ----------
if [ -f "$API/vendor/autoload.php" ]; then pass "api:composer" "vendor installed"; else fail "api:composer" "run composer install in $API"; fi
if [ -f "$API/.env" ]; then
  pass "api:env" "$API/.env"
  [ -n "$(grep -E '^APP_KEY=base64:' "$API/.env" 2>/dev/null)" ] && pass "api:app_key" "set" || fail "api:app_key" "run php artisan key:generate"
  db_host="$(grep -E '^DB_HOST=' "$API/.env" | head -1 | cut -d= -f2- | tr -d '"')"
  db_user="$(grep -E '^DB_USERNAME=' "$API/.env" | head -1 | cut -d= -f2- | tr -d '"')"
  db_pass="$(grep -E '^DB_PASSWORD=' "$API/.env" | head -1 | cut -d= -f2- | tr -d '"')"
  if have mysqladmin && mysqladmin -h"${db_host:-127.0.0.1}" -u"${db_user:-root}" -p"$db_pass" ping >/dev/null 2>&1; then
    pass "api:db" "${db_host:-127.0.0.1} reachable as ${db_user:-root}"
  else
    fail "api:db" "cannot connect to ${db_host:-127.0.0.1} as ${db_user:-root}"
  fi
else
  fail "api:env" "missing $API/.env"
fi
if (cd "$API" && php artisan --version >/dev/null 2>&1); then
  pass "api:artisan" "$(cd "$API" && php artisan --version 2>/dev/null | head -1)"
else
  fail "api:artisan" "php artisan is not runnable in $API"
fi

# ---------- 7. client prerequisites ----------
if [ -d "$CLIENT/node_modules" ]; then pass "client:node_modules" "installed"; else fail "client:node_modules" "run npm ci in $CLIENT"; fi
if [ -f "$CLIENT/package.json" ] && node -e 'const p=require(process.argv[1]);process.exit(p.dependencies&&p.dependencies.expo?0:1)' "$CLIENT/package.json" 2>/dev/null; then
  pass "client:expo" "$(node -e 'console.log(require(process.argv[1]).dependencies.expo)' "$CLIENT/package.json")"
else
  fail "client:expo" "expo dependency not found"
fi
if [ -d "$CLIENT/android" ] && [ -d "$CLIENT/ios" ]; then
  pass "client:native" "android + ios prebuild dirs present"
else
  warn "client:native" "android/ios dirs missing (local build needs expo prebuild; never EAS)"
fi

# ---------- 8. native toolchain (needed only for local APK builds) ----------
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$sdk" ] && [ -d "$HOME/Android/Sdk" ]; then sdk="$HOME/Android/Sdk"; fi
if [ -n "$sdk" ] && [ -d "$sdk" ]; then
  pass "android:sdk" "$sdk"
  [ -d "$sdk/build-tools" ] && pass "android:build-tools" "$(ls "$sdk/build-tools" | tail -1)" || warn "android:build-tools" "none installed"
  [ -f "$sdk/platform-tools/adb" ] || have adb && pass "android:adb" "$(command -v adb || echo "$sdk/platform-tools/adb")"
else
  warn "android:sdk" "ANDROID_HOME not set and ~/Android/Sdk missing"
fi
if java -version 2>&1 | grep -q 'version "17'; then pass "java:17" "ok"; else warn "java:17" "expected JDK 17 for this RN build"; fi

# ---------- 9. verification tooling ----------
chrome="$(ls -1 "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)"
if [ -n "$chrome" ] && [ -x "$chrome" ]; then pass "verify:chromium" "$chrome"; else warn "verify:chromium" "no playwright chromium found"; fi

# ---------- 10. git cleanliness (warn only) ----------
for d in "$API" "$CLIENT"; do
  name="$(basename "$d")"
  if [ -d "$d/.git" ]; then
    dirty="$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    branch="$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    if [ "$dirty" = "0" ]; then pass "git:clean:$name" "$branch"; else warn "git:clean:$name" "$dirty uncommitted file(s) on $branch"; fi
  fi
done

# ---------- 11. runtime endpoints (informational, opt-in) ----------
if [ -n "${API_HEALTH_URL:-}" ]; then
  api_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$API_HEALTH_URL" 2>/dev/null || true)"
  if [ -n "$api_code" ] && [ "$api_code" != "000" ]; then pass "runtime:api" "HTTP $api_code"; else warn "runtime:api" "API not reachable at $API_HEALTH_URL"; fi
fi
if [ -n "${FRONTEND_URL:-}" ]; then
  if curl -s -o /dev/null --max-time 3 "$FRONTEND_URL" 2>/dev/null; then
    pass "runtime:frontend" "dev server up at $FRONTEND_URL"
  else
    warn "runtime:frontend" "dev server down at $FRONTEND_URL"
  fi
fi

# ---------- output ----------
if [ "$JSON" = "1" ]; then
  printf '%s\n' "${ROWS[@]}" | jq -R -s 'split("\n")|map(select(length>0)|split("|")|{status:.[0],check:.[1],detail:.[2]})|{ok:(map(select(.status=="FAIL"))|length==0),failures:(map(select(.status=="FAIL"))|length),warnings:(map(select(.status=="WARN"))|length),checks:.}'
else
  printf '%-5s %-26s %s\n' "STATE" "CHECK" "DETAIL"
  printf '%-5s %-26s %s\n' "-----" "--------------------------" "----------------------------------------"
  for row in "${ROWS[@]}"; do
    IFS='|' read -r st check detail <<<"$row"
    printf '%-5s %-26s %s\n' "$st" "$check" "$detail"
  done
  echo
  echo "required failures: $FAILS   warnings: $WARNS"
fi
[ "$FAILS" -eq 0 ]
