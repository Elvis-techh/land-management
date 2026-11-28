#!/usr/bin/env bash
#
# Prepare a NEW, empty droplet for Lindero, its test site and later the POS.
# It installs no application: it only gives the machine what droplet 1 has
# under them.
#
# Run as root, from the laptop (IP is the new droplet's address):
#
#   scp deploy/setup-new-droplet.sh root@$IP:/root/
#   ssh root@$IP bash /root/setup-new-droplet.sh apps-02
#
# What it does:
#
#   1. Refuses to run on the droplet that has the weight software.
#   2. Names the machine, installs system updates and the programs needed.
#   3. 2 GB of swap, the system journal capped at 200 MB.
#   4. Firewall: only SSH, HTTP and HTTPS.
#   5. Nginx, certbot, and a hook that reloads Nginx when a certificate renews.
#   6. Node 22 in /opt/node22, the same place as on droplet 1.
#
# Running it twice is safe. It never restarts the machine; it says when a
# restart is needed. It changes no SSH setting, so it cannot lock anyone out.

set -euo pipefail

NODE_DIR=/opt/node22
NODE_URL=https://nodejs.org/dist/latest-v22.x
SWAP_FILE=/swapfile
SWAP_SIZE=2G
# The same file droplet-guardrails.sh writes, so there is one place to look.
JOURNAL_DROPIN=/etc/systemd/journald.conf.d/50-lindero-guardrails.conf
RENEW_HOOK=/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
PACKAGES=(nginx certbot rclone sqlite3 git rsync curl ufw xz-utils
  python3 build-essential unattended-upgrades)

fail() {
  echo "!! $*" >&2
  exit 1
}

# --- 1. The right machine. Nothing changes until this has passed. -------------

NAME=${1:-}
[[ $NAME =~ ^[a-z][a-z0-9-]{1,30}$ ]] ||
  fail "Give the machine's name, e.g.: bash setup-new-droplet.sh apps-02"
[[ $EUID -eq 0 ]] || fail "Run it as root."

# A wrong IP address must not set up the machine the scale stations depend on.
for sign in /root/weight_software /root/.pm2 /opt/zoilabe-test; do
  [[ ! -e $sign ]] ||
    fail "This is droplet 1 ($sign is here). Nothing was changed. Check the IP address."
done

# shellcheck disable=SC1091
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] ||
  fail "This needs Ubuntu 24.04; this is $PRETTY_NAME. Nothing was changed."
[[ $(uname -m) == x86_64 ]] || fail "This needs a 64-bit Intel or AMD droplet. Nothing was changed."

# --- 2. Name, updates and programs. -------------------------------------------

echo "==> Waiting for the new droplet to finish starting"
cloud-init status --wait >/dev/null 2>&1 || true

echo "==> Name: $NAME"
hostnamectl set-hostname "$NAME"
# Without these, a restart puts the old name back and sudo cannot find the new one.
mkdir -p /etc/cloud/cloud.cfg.d
echo "preserve_hostname: true" >/etc/cloud/cloud.cfg.d/99-hostname.cfg
grep -qE "^127\.0\.1\.1[[:space:]]+$NAME\$" /etc/hosts || echo "127.0.1.1 $NAME" >>/etc/hosts

echo "==> System updates and programs (a few minutes)"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
apt_get() {
  # A new droplet runs its own updates for a while: wait for them. Settings
  # files already on the machine are kept, so nothing stops to ask.
  apt-get -qq -o DPkg::Lock::Timeout=600 \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}
apt_get update
apt_get upgrade -y >/dev/null
apt_get install -y "${PACKAGES[@]}" >/dev/null

# --- 3. Swap and the journal. -------------------------------------------------

echo "==> Swap"
if [[ -z $(swapon --show --noheadings) ]]; then
  # Made under another name first: a run cut short must not leave a half-made
  # file that the next run would take for a finished one.
  if [[ ! -f $SWAP_FILE ]]; then
    rm -f "$SWAP_FILE.new"
    fallocate -l "$SWAP_SIZE" "$SWAP_FILE.new"
    chmod 600 "$SWAP_FILE.new"
    mkswap "$SWAP_FILE.new" >/dev/null
    mv "$SWAP_FILE.new" "$SWAP_FILE"
  fi
  swapon "$SWAP_FILE"
fi
if [[ -f $SWAP_FILE ]] && ! grep -qE "^$SWAP_FILE[[:space:]]" /etc/fstab; then
  echo "$SWAP_FILE none swap sw 0 0" >>/etc/fstab
fi
echo "vm.swappiness=10" >/etc/sysctl.d/99-swap.conf
sysctl -q vm.swappiness=10

echo "==> Journal capped at 200 MB"
mkdir -p "$(dirname "$JOURNAL_DROPIN")"
printf '%s\n' "[Journal]" "SystemMaxUse=200M" >"$JOURNAL_DROPIN"
systemctl restart systemd-journald

# --- 4. Firewall. -------------------------------------------------------------

echo "==> Firewall: SSH, HTTP and HTTPS only"
# SSH first: enabling the firewall without it would close this very door.
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# --- 5. Nginx and certificates. -----------------------------------------------

echo "==> Nginx and certificate renewal"
install -d -m 755 /var/www/certbot "$(dirname "$RENEW_HOOK")"
# Browsers that saw a site's HSTS header refuse it outright with an old
# certificate, so Nginx must pick up each renewal.
printf '%s\n' '#!/bin/sh' 'systemctl reload nginx' >"$RENEW_HOOK"
chmod 755 "$RENEW_HOOK"
nginx -t >/dev/null 2>&1 || fail "Nginx refuses its configuration. Send Claude a screenshot."
systemctl enable --now nginx >/dev/null 2>&1
systemctl enable --now certbot.timer >/dev/null 2>&1

# --- 6. Node 22. --------------------------------------------------------------

echo "==> Node 22 in $NODE_DIR"
if [[ ! -x $NODE_DIR/bin/node || $("$NODE_DIR/bin/node" -v) != v22.* ]]; then
  [[ ! -e $NODE_DIR ]] || fail "$NODE_DIR exists but is not Node 22. Send Claude a screenshot."
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT
  curl -fsSL "$NODE_URL/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
  FILE=$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ { print $2 }' "$WORK/SHASUMS256.txt")
  [[ -n $FILE ]] || fail "Could not find the Node 22 download. Send Claude a screenshot."
  curl -fsSL "$NODE_URL/$FILE" -o "$WORK/$FILE"
  # The download must be exactly the file nodejs.org lists.
  (cd "$WORK" && grep -F "  $FILE" SHASUMS256.txt | sha256sum --check --quiet) ||
    fail "The Node download does not match its checksum. Nothing of it was installed."
  mkdir "$WORK/node"
  tar -xJf "$WORK/$FILE" -C "$WORK/node" --strip-components=1 --no-same-owner
  # mktemp's folders are private; the apps' users must be able to run Node.
  chmod 755 "$WORK/node"
  mv "$WORK/node" "$NODE_DIR"
fi

# --- Report. ------------------------------------------------------------------

echo "==> Report"
problem=0
check() {
  local label=$1
  shift
  if "$@" >/dev/null 2>&1; then
    echo "    ok       $label"
  else
    echo "    PROBLEM  $label"
    problem=1
  fi
}
has_swap() { [[ -n $(swapon --show --noheadings) ]]; }
firewall_on() { ufw status | grep -q '^Status: active'; }

check "swap on" has_swap
check "firewall on" firewall_on
check "nginx running" systemctl is-active --quiet nginx
check "certificate renewal timer running" systemctl is-active --quiet certbot.timer
check "Node $("$NODE_DIR/bin/node" -v 2>/dev/null || echo missing)" "$NODE_DIR/bin/node" -e 0

# Only reported: turning it off from here could lock out whoever has no key.
if sshd -T 2>/dev/null | grep -qx 'passwordauthentication yes'; then
  echo "    NOTE     SSH still accepts passwords. Tell Claude."
else
  echo "    ok       SSH does not accept passwords"
fi

echo
free -m
df -h / | tail -n 1

((problem == 0)) || fail "Something above says PROBLEM. Send Claude a screenshot."
if [[ -f /var/run/reboot-required ]]; then
  echo "==> LISTO. The updates need a restart: type 'reboot', wait a minute, then log in again."
else
  echo "==> LISTO. No restart needed."
fi
