#!/usr/bin/env bash
#
# The only thing the GitHub Actions deploy key may run on the droplet.
#
# Installed as a forced command in /root/.ssh/authorized_keys (see
# docs/github-actions-deploy.md), so whatever the workflow sends is ignored
# except for one word, "allow-drop-drive", read from SSH_ORIGINAL_COMMAND.
#
# Wrapped in a block so bash has read all of it before `git pull` can replace
# this file underneath it.
{
  set -euo pipefail
  cd /opt/lindero
  sudo -u lindero -H git pull --ff-only

  if [[ "${SSH_ORIGINAL_COMMAND:-}" == "allow-drop-drive" ]]; then
    export ALLOW_DROP_DRIVE=1
  fi

  exec bash deploy/update-from-build.sh
}
