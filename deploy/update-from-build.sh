#!/usr/bin/env bash
#
# Update the droplet from the `deploy-build` branch — no laptop needed.
#
# `deploy-build` holds frontend/dist and backend/dist, built from `main`
# somewhere other than the droplet (building here can OOM-kill bascula-central;
# see docs/deployment-shared-droplet.md, "Building on the droplet can kill the
# neighbour"). This does the droplet half of "Deploying again, later", with the
# copy coming from git instead of rsync:
#
#   cd /opt/lindero && sudo -u lindero -H git pull --ff-only
#   sudo bash deploy/update-from-build.sh
#
# Pull first, so this script is itself the latest version when it runs.

set -euo pipefail

REPO=/opt/lindero
NODE_BIN=/opt/node22/bin
FRONTEND_DEST=/var/www/lindero/frontend/dist
UNIT=/etc/systemd/system/lindero-api.service

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/update-from-build.sh" >&2
  exit 1
fi

as_lindero() { sudo -u lindero -H env "PATH=$NODE_BIN:$PATH" "$@"; }

cd "$REPO"

echo "==> Fetching the built app"
as_lindero git fetch --quiet origin deploy-build
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
as_lindero git archive FETCH_HEAD | tar -x -C "$BUILD"

echo "    source checkout: $(as_lindero git log -1 --format='%h %s')"
echo "    build:           $(grep -m1 '^Source commit:' "$BUILD/README.md" || echo 'unknown')"

# The Google Drive settings are baked into the frontend at build time, so a
# build made without them hides "Desde Google Drive" with no error anywhere.
# Refuse to swap a frontend that has them for one that does not.
drive_settings() { grep -ohE "VITE_GOOGLE_[A-Z_]+:[\`\"'][^\`\"']+" "$1"/assets/*.js 2>/dev/null | sort -u; }
if [[ -n "$(drive_settings "$FRONTEND_DEST")" && -z "$(drive_settings "$BUILD/frontend/dist")" ]]; then
  if [[ "${ALLOW_DROP_DRIVE:-}" != "1" ]]; then
    echo "!! The live site has Google Drive settings and this build does not." >&2
    echo "   Rebuild with VITE_GOOGLE_* set (see docs/github-actions-deploy.md)," >&2
    echo "   or rerun with ALLOW_DROP_DRIVE=1 to deploy without Drive anyway." >&2
    exit 1
  fi
fi

echo "==> Runtime dependencies (Node 22)"
as_lindero "$NODE_BIN/npm" ci --omit=dev --no-audit --no-fund
as_lindero "$NODE_BIN/node" -e "require('$REPO/node_modules/better-sqlite3')"

echo "==> Copying the build into place"
mkdir -p "$FRONTEND_DEST" "$REPO/backend/dist"
rsync -a --delete "$BUILD/frontend/dist/" "$FRONTEND_DEST/"
rsync -a --delete "$BUILD/backend/dist/" "$REPO/backend/dist/"
chown -R lindero:lindero "$REPO/backend/dist"

# Before the restart, so the stop of the OLD process already uses the new
# unit's settings (TimeoutStopSec). The droplet's own settings live in the
# drop-in under lindero-api.service.d/, which this does not touch.
echo "==> Systemd unit"
if ! cmp -s deploy/lindero-api.service "$UNIT"; then
  cp "$UNIT" "$UNIT.bak"
  install -m 644 deploy/lindero-api.service "$UNIT"
  systemctl daemon-reload
  echo "    updated (previous copy at $UNIT.bak)"
else
  echo "    unchanged"
fi

echo "==> Restarting (migrations run on start)"
time systemctl restart lindero-api

# The .env line can carry a trailing comment ("PORT=3001  # NOT 3000 ...").
PORT=$(grep -E '^PORT=' backend/.env | cut -d= -f2 | sed 's/#.*//' | tr -d '[:space:]' || true)
PORT=${PORT:-3001}
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "==> Up: $(curl -fsS "http://127.0.0.1:$PORT/api/health")"
    exit 0
  fi
  sleep 1
done

echo "!! Not answering on port $PORT after 20 s. Recent log:" >&2
journalctl -u lindero-api -n 30 --no-pager >&2
exit 1
