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
# `autodeploy.sh test` does the same for the test site, from `deploy-build-test`,
# run by lindero-test-autodeploy.timer. See site-settings.sh for how the two differ.
#
# Wrapped in a block so bash has read all of it before `git pull` can replace
# this file underneath it.
{
  set -euo pipefail

  WHICH=live
  if [[ "${1:-}" == "test" ]]; then
    WHICH=test
    shift
  fi
  source "$(dirname "$(readlink -f "$0")")/site-settings.sh" "$WHICH"

  cd "$REPO"
  sudo -u "$SITE_USER" -H git fetch --quiet origin "$BUILD_BRANCH"
  NEW=$(sudo -u "$SITE_USER" -H git rev-parse FETCH_HEAD)
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
  echo "New build $NEW on $BUILD_BRANCH; deploying."
  if [[ $SITE == test ]]; then
    exec bash "$SCRIPTS/update-from-build.sh" test
  fi
  sudo -u "$SITE_USER" -H git pull --ff-only
  exec bash deploy/update-from-build.sh
}
