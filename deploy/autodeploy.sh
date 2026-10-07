#!/usr/bin/env bash
#
# Deploy a new build when one appears on `deploy-build`.
#
# Run every two minutes by lindero-autodeploy.timer. The droplet reaches out
# to GitHub rather than GitHub reaching in, so no key or secret has to be
# copied anywhere. `deploy-build` only changes when the Deploy workflow runs,
# after the tests pass, so this deploys exactly what that workflow built.
#
# Each build is tried once: the commit is recorded before deploying, so a build
# the deploy refuses (a Drive settings mismatch, say) is not retried every two
# minutes. Run the next Deploy workflow, or delete the state file, to try again.
#
#   sudo bash deploy/autodeploy.sh --mark-current   # record the current build without deploying
#   journalctl -u lindero-autodeploy -n 50          # what it last did
#
# Wrapped in a block so bash has read all of it before `git pull` can replace
# this file underneath it.
{
  set -euo pipefail

  REPO=/opt/lindero
  STATE_DIR=/var/lib/lindero-autodeploy
  STATE="$STATE_DIR/last-build"

  cd "$REPO"
  sudo -u lindero -H git fetch --quiet origin deploy-build
  NEW=$(sudo -u lindero -H git rev-parse FETCH_HEAD)
  OLD=$(cat "$STATE" 2>/dev/null || true)

  mkdir -p "$STATE_DIR"

  if [[ "${1:-}" == "--mark-current" ]]; then
    echo "$NEW" > "$STATE"
    echo "Recorded $NEW as already deployed."
    exit 0
  fi

  if [[ "$NEW" == "$OLD" ]]; then
    exit 0
  fi

  echo "$NEW" > "$STATE"
  echo "New build $NEW on deploy-build; deploying."
  sudo -u lindero -H git pull --ff-only
  exec bash deploy/update-from-build.sh
}
