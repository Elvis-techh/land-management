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
#
# `update-from-build.sh test` does the same for the test site, from
# `deploy-build-test`. See site-settings.sh for why it runs from this checkout.

set -euo pipefail

source "$(dirname "$(readlink -f "$0")")/site-settings.sh" "${1:-live}"

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/update-from-build.sh" >&2
  exit 1
fi

# One deploy at a time on this droplet. A deploy that reinstalls packages
# briefly takes about 200 MB, and two at once (the live site and a test site,
# say) would push the machine into swap beside bascula-central. Every site's
# deploy takes this same lock and waits its turn.
exec 9>/run/lock/droplet-deploy.lock
if ! flock -w 600 9; then
  echo "!! Another deploy has been running on this droplet for 10 minutes; not deploying." >&2
  exit 1
fi

as_site() { sudo -u "$SITE_USER" -H env "PATH=$NODE_BIN:$PATH" "$@"; }

cd "$REPO"

echo "==> Fetching the built app"
as_site git fetch --quiet origin "$BUILD_BRANCH"
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
as_site git archive FETCH_HEAD | tar -x -C "$BUILD"

if [[ $SITE == live ]]; then
  echo "    source checkout: $(as_site git log -1 --format='%h %s')"
fi
echo "    build:           $(grep -m1 '^Source commit:' "$BUILD/README.md" || echo 'unknown')"

# The Google Drive settings are baked into the frontend at build time, so a
# build made without them, or with a mistyped one, breaks "Desde Google Drive"
# with no error anywhere. Refuse to swap a frontend that has them for one whose
# settings differ in any way.
# `|| true`: finding none is an answer, not an error that should stop the script.
drive_settings() { { grep -ohE "VITE_GOOGLE_[A-Z_]+:[\`\"'][^\`\"']+" "$1"/assets/*.js 2>/dev/null || true; } | sort -u; }
LIVE_DRIVE=$(drive_settings "$FRONTEND_DEST")
NEW_DRIVE=$(drive_settings "$BUILD/frontend/dist")
if [[ -n "$LIVE_DRIVE" && "$LIVE_DRIVE" != "$NEW_DRIVE" ]]; then
  if [[ "${ALLOW_DROP_DRIVE:-}" != "1" ]]; then
    echo "!! This build's Google Drive settings do not match the live site's." >&2
    diff <(echo "$LIVE_DRIVE") <(echo "$NEW_DRIVE") | sed 's/^</   live:/; s/^>/   new: /' | grep -E 'live:|new:' >&2 || true
    echo "   Fix the VITE_GOOGLE_* variables on GitHub and rebuild, or rerun with" >&2
    echo "   ALLOW_DROP_DRIVE=1 if the change is intended." >&2
    exit 1
  fi
fi

# Reinstalling is the one heavy step of a deploy on a 512 MB machine shared
# with bascula-central, so it is skipped unless the lockfile or Node changed.
echo "==> Runtime dependencies (Node 22)"
# The live site's come from its checkout. The test site has no checkout of the
# source, because it runs whichever branch was sent to it, and that branch's
# packages arrive with its build.
if [[ $SITE == test ]]; then
  for file in package.json package-lock.json backend/package.json frontend/package.json; do
    install -D -o "$SITE_USER" -g "$SITE_USER" -m 644 "$BUILD/$file" "$REPO/$file"
  done
fi
DEPS_ID="$(sha256sum package-lock.json | cut -d' ' -f1) $("$NODE_BIN/node" -v)"
DEPS_STAMP="$REPO/node_modules/.lindero-deps"
if [[ -f "$DEPS_STAMP" && "$(cat "$DEPS_STAMP")" == "$DEPS_ID" ]] &&
  as_site "$NODE_BIN/node" -e "require('$REPO/node_modules/better-sqlite3')" 2>/dev/null; then
  echo "    unchanged, not reinstalled"
else
  as_site "$NODE_BIN/npm" ci --omit=dev --no-audit --no-fund
  as_site "$NODE_BIN/node" -e "require('$REPO/node_modules/better-sqlite3')"
  echo "$DEPS_ID" | as_site tee "$DEPS_STAMP" >/dev/null
fi

# Kept so a build that fails to start can be put back (see the end).
echo "==> Keeping the current version for rollback"
mkdir -p "$FRONTEND_DEST" "$REPO/backend/dist"
rsync -a --delete "$FRONTEND_DEST/" "$FRONTEND_DEST.prev/"
rsync -a --delete "$REPO/backend/dist/" "$REPO/backend/dist.prev/"

echo "==> Copying the build into place"
rsync -a --delete "$BUILD/frontend/dist/" "$FRONTEND_DEST/"
rsync -a --delete "$BUILD/backend/dist/" "$REPO/backend/dist/"
chown -R "$SITE_USER:$SITE_USER" "$REPO/backend/dist"

# Before the restart, so the stop of the OLD process already uses the new
# unit's settings (TimeoutStopSec). The droplet's own settings live in the
# drop-in under lindero-api.service.d/, which this does not touch.
echo "==> Systemd unit"
UNIT_CHANGED=0
if ! cmp -s "$UNIT_SOURCE" "$UNIT"; then
  UNIT_CHANGED=1
  cp "$UNIT" "$UNIT.bak"
  install -m 644 "$UNIT_SOURCE" "$UNIT"
  systemctl daemon-reload
  echo "    updated (previous copy at $UNIT.bak)"
else
  echo "    unchanged"
fi

# The .env line can carry a trailing comment ("PORT=3001  # NOT 3000 ...").
PORT=$(grep -E '^PORT=' backend/.env | cut -d= -f2 | sed 's/#.*//' | tr -d '[:space:]' || true)
PORT=${PORT:-$DEFAULT_PORT}

# Only the test site, and only when the Deploy test workflow was asked to. It
# erases that site's database and uploads, and seed.ts refuses to run anywhere
# without LINDERO_SITE=test in the site's .env. After the build is in place, so
# the data is made by the code being tried.
if [[ $SITE == test ]] && grep -qx 'Reset test data: yes' "$BUILD/README.md"; then
  echo "==> Putting fresh demo data back"
  systemctl stop "$SERVICE"
  for script in reset migrate seed; do
    (cd backend && as_site "$NODE_BIN/node" --env-file=.env "dist/db/$script.js")
  done
fi

healthy() {
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "==> Restarting (migrations run on start)"
time systemctl restart "$SERVICE"

if healthy; then
  echo "==> Up: $(curl -fsS "http://127.0.0.1:$PORT/api/health")"
  exit 0
fi

# The new version did not come up. Put the previous one back rather than
# leave Lindero down until somebody notices.
echo "!! Not answering on port $PORT after 20 s. Recent log:" >&2
journalctl -u "$SERVICE" -n 30 --no-pager >&2

echo "==> Rolling back to the previous version" >&2
rsync -a --delete "$FRONTEND_DEST.prev/" "$FRONTEND_DEST/"
rsync -a --delete "$REPO/backend/dist.prev/" "$REPO/backend/dist/"
chown -R "$SITE_USER:$SITE_USER" "$REPO/backend/dist"
if [[ $UNIT_CHANGED == 1 ]]; then
  cp "$UNIT.bak" "$UNIT"
  systemctl daemon-reload
fi
systemctl restart "$SERVICE"

if healthy; then
  echo "!! Rolled back: the previous version is running again. The new build was NOT deployed." >&2
else
  echo "!! Rollback did not come up either. Lindero is down: send the log above to Claude." >&2
fi
exit 1
