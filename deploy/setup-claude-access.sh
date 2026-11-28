#!/usr/bin/env bash
#
# Give Claude's locked, read-only key to a droplet without the weight software
# (droplet 2). See docs/claude-ops-key.md. Droplet 1's key was set up by hand.
#
# Run from the laptop (IP is the droplet's address). It works before Lindero is
# there, because it brings the program the key runs along:
#
#   scp deploy/claude-ops.sh deploy/setup-claude-access.sh ~/.ssh/lindero-claude-ops-2.pub root@$IP:/root/
#   ssh root@$IP bash /root/setup-claude-access.sh /root/lindero-claude-ops-2.pub
#
# What it does:
#
#   1. Copies claude-ops.sh to /usr/local/sbin/lindero-claude-ops, the pinned
#      copy the key runs.
#   2. Adds the public key to root's authorized_keys, locked to that program.
#      Every other line stays as it is.
#
# Running it twice is safe. Run it again when claude-ops.sh changes, or to
# replace the key: it keeps only the newest locked line.

set -euo pipefail

HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
SOURCE=$HERE/claude-ops.sh
PINNED=/usr/local/sbin/lindero-claude-ops
KEYS=/root/.ssh/authorized_keys
BASCULA_DIR=/root/weight_software
# "restrict" turns off everything but the command; "command=" is the lock.
LOCK="restrict,command=\"$PINNED\" "

fail() {
  echo "!! $*" >&2
  exit 1
}

# --- Checks. Nothing changes until they have all passed. ----------------------

[[ $# -eq 1 ]] || fail "Give the public key file, e.g.: bash setup-claude-access.sh /root/lindero-claude-ops-2.pub"
[[ $EUID -eq 0 ]] || fail "Run it as root."
[[ ! -e $BASCULA_DIR ]] ||
  fail "This is droplet 1 ($BASCULA_DIR is here). Nothing was changed. Check the IP address."
[[ -f $SOURCE ]] || fail "$SOURCE is not there: copy claude-ops.sh beside this script. Nothing was changed."
bash -n "$SOURCE" || fail "$SOURCE is not a complete script. Nothing was changed."
[[ -f $1 ]] || fail "$1 is not there. Nothing was changed."

# One line, a public key and nothing else. Options in front of it, a second
# line or a private key must not reach authorized_keys.
KEY=$(<"$1")
KEY=${KEY%$'\r'}
[[ $KEY != *$'\n'* && $KEY =~ ^ssh-ed25519\ (AAAA[A-Za-z0-9+/]+=*)(\ [A-Za-z0-9._@-]+)?$ ]] ||
  fail "$1 is not one ssh-ed25519 public key (the file ending in .pub). Nothing was changed."
BODY=${BASH_REMATCH[1]}
ssh-keygen -l -f "$1" >/dev/null 2>&1 || fail "$1 is not a working public key. Nothing was changed."

# SSH uses the first line that matches a key. If this one is already allowed
# without the lock, it is either somebody's own key, which locking would shut
# them out with, or a copy of Claude's that would stay unlocked.
# (Collected first: a pipeline that stops early can report failure and let the
# key through.)
UNLOCKED=""
if [[ -f $KEYS ]]; then
  UNLOCKED=$(grep -F -- "$BODY" "$KEYS" | grep -vF -- "$LOCK" || true)
fi
if [[ -n $UNLOCKED ]]; then
  fail "That key can already log in to this droplet without the lock. It may be your own key: give the one made for Claude. Nothing was changed."
fi

# --- The changes. -------------------------------------------------------------

install -m 755 -o root -g root "$SOURCE" "$PINNED"
echo "==> Program: $PINNED"

install -d -m 700 "$(dirname "$KEYS")"
NEW=$(mktemp)
trap 'rm -f "$NEW"' EXIT
if [[ -f $KEYS ]]; then
  # Every line except an earlier locked one. grep exits 1 when none are left.
  grep -vF -- "$LOCK" "$KEYS" >"$NEW" || [[ $? -eq 1 ]]
fi
echo "$LOCK$KEY" >>"$NEW"
if [[ -f $KEYS ]]; then
  cp -p "$KEYS" "$KEYS.before-claude"
fi
# Written into the same file, so its owner and permissions stay.
cat "$NEW" >"$KEYS"
chmod 600 "$KEYS"
echo "==> Key: added to $KEYS, locked to that program"

echo "==> LISTO. Tell Claude, so it can check the lock."
