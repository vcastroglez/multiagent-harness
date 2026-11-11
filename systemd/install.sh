#!/usr/bin/env bash
# install.sh - install/enable the multi-agent stack as systemd --user units.
#
#   mah-herdr.service      herdr headless server (owns panes + pi agents)
#   mah-agents.service     oneshot: bootstrap.sh --start-agents (idempotent)
#   mah-dashboard.service  dashboard on 127.0.0.1:7788 (PAM login)
#
# The .service files in this directory are templates: @HARNESS@, @WORKSPACE@,
# @BACKEND@ and @FRONTEND@ are replaced with the paths of this checkout and the
# workspace it serves, then written to the user unit directory.
#
# usage: systemd/install.sh [--no-linger] [--no-restart]
#   --no-linger   do not call loginctl enable-linger (needs one-time root)
#   --no-restart  only install + enable; leave running units alone
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$(cd "$HERE/.." && pwd)"
BASE="${WORKSPACE_ROOT:-$(cd "$HARNESS/../.." && pwd)}"
API="${BACKEND_DIR:-$BASE/backend}"
CLIENT="${FRONTEND_DIR:-$BASE/frontend}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNITS=(mah-herdr.service mah-agents.service mah-dashboard.service)
LINGER=1
RESTART=1

while [ $# -gt 0 ]; do
  case "$1" in
    --no-linger) LINGER=0;;
    --no-restart) RESTART=0;;
    *) echo "unknown option: $1" >&2; exit 64;;
  esac
  shift
done

log() { printf '[install] %s\n' "$*"; }

render() {
  sed -e "s|@HARNESS@|$HARNESS|g" \
      -e "s|@WORKSPACE@|$BASE|g" \
      -e "s|@BACKEND@|$API|g" \
      -e "s|@FRONTEND@|$CLIENT|g" \
      "$HERE/$1" >"$UNIT_DIR/$1"
}

mkdir -p "$UNIT_DIR"
for u in "${UNITS[@]}"; do
  render "$u"
  log "installed $u"
done
systemctl --user daemon-reload

# linger keeps the user manager alive without an interactive login (and thus
# after a reboot); it is a one-time, root/polkit-guarded switch
if [ "$LINGER" = "1" ]; then
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
    loginctl enable-linger "$USER" 2>/dev/null \
      && log "linger enabled for $USER" \
      || log "could not enable linger (needs root): sudo loginctl enable-linger $USER"
  else
    log "linger already enabled for $USER"
  fi
fi

for u in "${UNITS[@]}"; do systemctl --user enable "$u" >/dev/null; done
log "enabled: ${UNITS[*]}"

if [ "$RESTART" = "1" ]; then
  systemctl --user restart mah-herdr.service
  log "herdr + agents starting (agents are pulled in by mah-herdr.service)"
  systemctl --user restart mah-dashboard.service
  sleep 2
fi

systemctl --user is-active mah-herdr.service mah-agents.service mah-dashboard.service || true
curl -s -o /dev/null -w 'dashboard health: %{http_code}\n' --max-time 3 http://127.0.0.1:7788/api/health || true
log "done. status: systemctl --user status mah-herdr mah-agents mah-dashboard"
