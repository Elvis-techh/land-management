#!/usr/bin/env bash
#
# Runbook step 14: put Lindero's test site on this droplet.
#
# Run once, as root, in the droplet console (it logs you in as root). The address
# must already point here, with the grey cloud in Cloudflare:
#
#   bash /opt/lindero/deploy/setup-test-site.sh
#
# What it does, reporting each part and stopping at the first problem:
#
#   1. Checks there is room and nothing is in the way. This changes nothing.
#   2. Makes the test site's own user, folder and settings, with secrets made
#      here. It also makes sure that user cannot read the live site's files.
#   3. Adds its Nginx site and certificate. Nginx is checked first and reloaded,
#      never restarted, because the scale stations come in through it too.
#   4. Installs its services, runs the first deploy and adds the demo data.
#   5. Checks that bascula-central and the live site did not notice.
#
# What it never does: restart bascula-central, Lindero or Nginx, change their
# settings, or read bascula's files. It never prints a password.
#
# Running it twice is safe, and it keeps the test site's passwords. To take the
# test site out again, data and certificate included:
#
#   bash /opt/lindero/deploy/setup-test-site.sh --undo

set -euo pipefail

source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/site-settings.sh" test

HOST=prueba-lindero.basculacentral.com
LIVE_HOST=lindero.basculacentral.com
BASCULA_HOST=api.basculacentral.com
LIVE_REPO=/opt/lindero
ORIGIN=https://github.com/Elvis-techh/land-management.git
NGINX_SOURCE=$SCRIPTS/nginx-test-site.conf
NGINX_SITE=/etc/nginx/sites-available/lindero-test
NGINX_LINK=/etc/nginx/sites-enabled/lindero-test
CERT=/etc/letsencrypt/live/$HOST/fullchain.pem
WEBROOT=/var/www/certbot
PM2_PID_FILE=/root/.pm2/pm2.pid
LIVE_MODE_RECORD=$STATE_DIR/live-folder-mode-before-test-site
TIMER=lindero-test-autodeploy.timer
UPDATER=lindero-test-autodeploy.service

# The same "fine" line as the Warning signs table on the Droplet Room Check page.
MIN_AVAILABLE_MB=300
MIN_FREE_DISK_GB=2

# --- Pure helpers (also used by backend/test/setup-test-site.test.ts) ---------

# The site's .env. Arguments: the cookie secret and the two demo passwords.
env_file() {
  printf '%s\n' \
    "# Lindero's test site. Written once by deploy/setup-test-site.sh." \
    "NODE_ENV=production" \
    "LINDERO_SITE=test" \
    "HOST=127.0.0.1" \
    "PORT=$DEFAULT_PORT" \
    "TRUST_PROXY=127.0.0.1" \
    "FRONTEND_ORIGIN=https://$HOST" \
    "COOKIE_SECRET=$1" \
    "DATABASE_PATH=$REPO/backend/data/lindero.db" \
    "UPLOADS_PATH=$REPO/backend/data/uploads" \
    "TIME_ZONE=America/Tegucigalpa" \
    "EXCHANGE_RATE_REFRESH_HOURS=0" \
    "TEST_SITE_SUPERVISOR_PASSWORD=$2" \
    "TEST_SITE_ASSOCIATE_PASSWORD=$3"
}

# The plain-http part of the site alone: all a certificate check needs, and valid
# before there is a certificate to name.
http_half() {
  sed -n '1,/^}/p' "$NGINX_SOURCE"
}

# PID and every process below it, one per line, parents first.
process_tree() {
  local child
  echo "$1"
  for child in $(ps -o pid= --ppid "$1"); do
    process_tree "$child"
  done
}

# Stops here when sourced by the tests.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

# --- The run ------------------------------------------------------------------

fail() {
  echo "!! $*" >&2
  exit 1
}

case ${1:-} in
  "") mode=apply ;;
  --undo) mode=undo ;;
  *) fail "Unknown option '$1'. Run it with nothing, or with --undo." ;;
esac
[[ $EUID -eq 0 ]] || fail "Run it as root (the droplet console logs you in as root)."

# Lowest priority, so bascula-central's work always comes first.
renice -n 19 -p $$ >/dev/null
ionice -c 3 -p $$ 2>/dev/null || true

# HTTP status of https://HOST/PATH through this machine's own Nginx.
code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    --resolve "$1:443:127.0.0.1" "https://$1$2" || true
}

# Prints what Nginx said only if it refuses, because it warns about other sites.
nginx_accepts() {
  local said
  if said=$(nginx -t 2>&1); then
    return 0
  fi
  echo "$said" >&2
  return 1
}

pm2_tree() {
  local pid
  [[ -f $PM2_PID_FILE ]] || return 0
  pid=$(cat "$PM2_PID_FILE")
  [[ $pid =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 0
  process_tree "$pid"
}

lindero_pid() {
  systemctl show lindero-api -p MainPID --value 2>/dev/null || true
}

ipv4_of() {
  getent ahostsv4 "$1" | awk 'NR == 1 { print $1 }'
}

undo() {
  echo "==> Taking the test site out. bascula-central and the live site are not touched."
  systemctl disable --now "$TIMER" 2>/dev/null || true
  systemctl stop "$UPDATER" 2>/dev/null || true
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT" "$UNIT_DIR/$UPDATER" "$UNIT_DIR/$TIMER"
  systemctl daemon-reload

  rm -f "$NGINX_LINK" "$NGINX_SITE"
  if nginx_accepts; then
    systemctl reload nginx
  else
    echo "!! Nginx refuses its configuration for another reason, so it was not reloaded. Send Claude a screenshot."
  fi

  if [[ -f $CERT ]]; then
    certbot delete --cert-name "$HOST" --non-interactive || echo "!! The certificate could not be deleted. It does no harm."
  fi

  rm -rf "$REPO" "$(dirname "$(dirname "$FRONTEND_DEST")")"
  rm -f "$STATE"
  if id -u "$SITE_USER" >/dev/null 2>&1; then
    userdel "$SITE_USER"
  fi

  if [[ -f $LIVE_MODE_RECORD ]]; then
    chmod "$(cat "$LIVE_MODE_RECORD")" "$LIVE_REPO"
    rm -f "$LIVE_MODE_RECORD"
    echo "    live folder: back to how it was"
  fi
  echo "==> Done. The test site is gone."
  echo "    Live site: $(code "$LIVE_HOST" /api/health)   expect 200"
}

if [[ $mode == undo ]]; then
  undo
  exit 0
fi

# --- 1. Room, and nothing in the way. Nothing changes until this has passed. ---

echo "==> 1. Checking there is room"
[[ -x $NODE_BIN/node ]] || fail "$NODE_BIN/node is not there. Nothing was changed. Send Claude a screenshot."
for needed in "$NGINX_SOURCE" "$UNIT_SOURCE" "$SCRIPTS/$UPDATER" "$SCRIPTS/$TIMER"; do
  [[ -f $needed ]] || fail "$needed is not on the droplet yet: run 'cd $LIVE_REPO && sudo -u lindero -H git pull --ff-only' first. Nothing was changed."
done

AVAILABLE_MB=$(free -m | awk '/^Mem:/ { print $7 }')
echo "    memory available: $AVAILABLE_MB MB   need $MIN_AVAILABLE_MB"
((AVAILABLE_MB >= MIN_AVAILABLE_MB)) || fail "Not enough memory free beside the scale stations. Nothing was changed. Send Claude a screenshot."

FREE_DISK_GB=$(df --output=avail -BG / | tail -n 1 | tr -dc '0-9')
echo "    disk free:        $FREE_DISK_GB GB   need $MIN_FREE_DISK_GB"
((FREE_DISK_GB >= MIN_FREE_DISK_GB)) || fail "Not enough disk free. Nothing was changed. Send Claude a screenshot."

# The scale stations' own address is on this machine, so it is what the new
# address must match. A Cloudflare orange cloud shows up here as a different one.
THIS_MACHINE=$(ipv4_of "$BASCULA_HOST")
THE_ADDRESS=$(ipv4_of "$HOST")
echo "    $HOST: ${THE_ADDRESS:-not found}   expect $THIS_MACHINE"
[[ -n $THE_ADDRESS && $THE_ADDRESS == "$THIS_MACHINE" ]] ||
  fail "$HOST does not point at this droplet. In Cloudflare it needs an A record with this droplet's IP and the grey cloud (DNS only). Nothing was changed."

if ss -ltnH | awk '{ print $4 }' | grep -qE ":$DEFAULT_PORT\$" && ! systemctl is-active --quiet "$SERVICE"; then
  fail "Something else is using port $DEFAULT_PORT. Nothing was changed. Send Claude a screenshot."
fi

nginx_accepts || fail "Nginx refuses its configuration before this script touched it, so reloading could take every site down. Nothing was changed. Send Claude a screenshot."
echo "    nginx configuration: accepted"

BASCULA_BEFORE=$(code "$BASCULA_HOST" /api/health)
LIVE_BEFORE=$(code "$LIVE_HOST" /api/health)
TREE_BEFORE=$(pm2_tree)
LINDERO_BEFORE=$(lindero_pid)
echo "    bascula-central: $BASCULA_BEFORE, live site: $LIVE_BEFORE"
[[ $LIVE_BEFORE == 200 ]] || fail "The live site is not answering 200 before the change. Nothing was changed. Send Claude a screenshot."
[[ -n $TREE_BEFORE ]] || fail "bascula-central's PM2 could not be found, so this could not prove it was left alone. Nothing was changed. Send Claude a screenshot."

# --- 2. Its own user, folder and settings. -------------------------------------

echo "==> 2. The test site's user, folder and settings"
if id -u "$SITE_USER" >/dev/null 2>&1; then
  echo "    user $SITE_USER: already there"
else
  useradd --system --user-group --home-dir "$REPO" --shell /usr/sbin/nologin "$SITE_USER"
  echo "    user $SITE_USER: made"
fi

install -d -m 750 -o "$SITE_USER" -g "$SITE_USER" "$REPO" "$REPO/backend" "$REPO/backend/data"
install -d -m 755 "$FRONTEND_DEST" "$WEBROOT"

if [[ ! -d $REPO/.git ]]; then
  sudo -u "$SITE_USER" -H git -C "$REPO" init -q
  sudo -u "$SITE_USER" -H git -C "$REPO" remote add origin "$ORIGIN"
fi

ENV_FILE=$REPO/backend/.env
if [[ -f $ENV_FILE ]]; then
  echo "    settings: already there, passwords kept"
else
  # Hex, so the passwords are easy to type on a phone and need no quoting.
  (
    umask 077
    env_file "$(openssl rand -base64 48 | tr -d '\n')" "$(openssl rand -hex 8)" "$(openssl rand -hex 8)" >"$ENV_FILE"
  )
  chown "$SITE_USER:$SITE_USER" "$ENV_FILE"
  echo "    settings: written, with secrets made here"
fi

# Its service cannot reach the live folder (InaccessiblePaths in the unit), but
# package installs and demo data run as this user outside the service. So the
# folder is closed to other users as well, if it is open.
readable_by_test_site() {
  local path
  for path in "$LIVE_REPO/backend/.env" "$LIVE_REPO/backend/data/lindero.db" "$LIVE_REPO/backend/rclone.conf"; do
    if sudo -u "$SITE_USER" -H test -r "$path"; then
      echo "$path"
      return 0
    fi
  done
  return 1
}
if EXPOSED=$(readable_by_test_site); then
  echo "    live folder: $EXPOSED could be read by other users. Closing $LIVE_REPO to them."
  mkdir -p "$STATE_DIR"
  [[ -f $LIVE_MODE_RECORD ]] || stat -c '%a' "$LIVE_REPO" >"$LIVE_MODE_RECORD"
  chmod o-rx "$LIVE_REPO"
  if EXPOSED=$(readable_by_test_site); then
    fail "$EXPOSED can still be read by the test site's user. Stopping before anything runs as that user. Send Claude a screenshot."
  fi
fi
echo "    live site's secrets and database: closed to the test site"
if sudo -u "$SITE_USER" -H test -r /root/weight_software; then
  fail "bascula-central's folder can be read by the test site's user. Stopping. Send Claude a screenshot."
fi
echo "    bascula-central's folder:         closed to the test site"

# --- 3. Nginx and the certificate. ---------------------------------------------

echo "==> 3. Nginx and the certificate"
if [[ -f $CERT ]]; then
  echo "    certificate: already there"
else
  http_half >"$NGINX_SITE"
  ln -sf "$NGINX_SITE" "$NGINX_LINK"
  if ! nginx_accepts; then
    # Left in place, a refused file would stop Nginx starting at the next reboot,
    # and every site on this droplet with it.
    rm -f "$NGINX_LINK"
    fail "Nginx refused the test site's plain-http part. It was taken out and nothing was reloaded, so every site is as it was. Send Claude a screenshot."
  fi
  systemctl reload nginx
  echo "    plain-http part: added, Nginx reloaded"

  certificate() {
    certbot certonly --webroot -w "$WEBROOT" -d "$HOST" --non-interactive --agree-tos \
      --register-unsafely-without-email --keep-until-expiring --deploy-hook "systemctl reload nginx" "$@"
  }
  # A rehearsal first: real failures count against Let's Encrypt's hourly limit.
  if ! said=$(certificate --dry-run 2>&1); then
    tail -n 15 <<<"$said" >&2
    fail "The certificate check failed. Only the test site's plain-http part is in place, which harms nothing, and running this again carries on from here. Send Claude a screenshot."
  fi
  if ! said=$(certificate 2>&1); then
    tail -n 15 <<<"$said" >&2
    fail "The certificate could not be issued. Running this again carries on from here. Send Claude a screenshot."
  fi
  echo "    certificate: issued"
fi

# Browsers that have seen this site refuse it outright once its certificate lapses.
if ! said=$(timeout 300 certbot renew --dry-run --no-random-sleep-on-renew --cert-name "$HOST" 2>&1); then
  tail -n 15 <<<"$said" >&2
  fail "The certificate's renewal check failed. Running this again carries on from here. Send Claude a screenshot."
fi
echo "    renewal: rehearsed"

cp "$NGINX_SOURCE" "$NGINX_SITE"
ln -sf "$NGINX_SITE" "$NGINX_LINK"
if ! nginx_accepts; then
  http_half >"$NGINX_SITE"
  nginx_accepts || rm -f "$NGINX_LINK"
  fail "Nginx refused the test site's full configuration. It was taken back out and nothing was reloaded, so every site is as it was. Send Claude a screenshot."
fi
systemctl reload nginx
echo "    whole site: added, Nginx reloaded"

# --- 4. Services, the first deploy and the demo data. ---------------------------

echo "==> 4. Services, first deploy and demo data"
install -m 644 "$UNIT_SOURCE" "$SCRIPTS/$UPDATER" "$SCRIPTS/$TIMER" "$UNIT_DIR/"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl enable --now "$TIMER" >/dev/null
echo "    services: installed, checking for new builds every two minutes"

# A build is tried once, so a first deploy that failed needs its record cleared.
[[ $(code "$HOST" /api/health) == 200 ]] || rm -f "$STATE"
echo "    first deploy: starting. It installs packages at low priority, so it can take a few minutes."
if ! systemctl start "$UPDATER"; then
  journalctl -u "${UPDATER%.service}" -n 30 --no-pager >&2 || true
  fail "The first deploy failed. bascula-central and the live site are not part of it. Send Claude a screenshot."
fi
echo "    first deploy: done"

# Run by hand here so setup needs nothing from the workflow. It skips itself if
# the accounts already exist, and it never writes a password to the log.
if ! (cd "$REPO/backend" && sudo -u "$SITE_USER" -H env NODE_OPTIONS=--max-old-space-size=96 "$NODE_BIN/node" --env-file=.env dist/db/seed.js) |
  sed -E "s#^#    demo data: #; s#$REPO/backend/##"; then
  fail "The demo data could not be added. Running this again tries once more. Send Claude a screenshot."
fi

# --- 5. Did anyone notice? -------------------------------------------------------

echo "==> 5. Checking everything"
TEST_HEALTH=$(code "$HOST" /api/health)
TEST_PAGE=$(code "$HOST" /)
BASCULA_AFTER=$(code "$BASCULA_HOST" /api/health)
LIVE_AFTER=$(code "$LIVE_HOST" /api/health)
TREE_AFTER=$(pm2_tree)
LINDERO_AFTER=$(lindero_pid)

echo "    test site:       page $TEST_PAGE, API $TEST_HEALTH   expect 200, 200"
echo "    live site:       $LIVE_AFTER   expect 200"
echo "    bascula-central: $BASCULA_AFTER   expect $BASCULA_BEFORE"
TEST_MEMORY=$(systemctl show "$SERVICE" -p MemoryCurrent --value 2>/dev/null || true)
if [[ $TEST_MEMORY =~ ^[0-9]+$ ]]; then
  echo "    test site memory: $((TEST_MEMORY / 1048576)) MB   cap 150"
fi
echo "    memory available: $(free -m | awk '/^Mem:/ { print $7 }') MB"

problem=0
[[ $TEST_HEALTH == 200 && $TEST_PAGE == 200 ]] || problem=1
[[ $LIVE_AFTER == 200 && $BASCULA_AFTER == "$BASCULA_BEFORE" ]] || problem=1
if [[ "$(sort <<<"$TREE_BEFORE")" == "$(sort <<<"$TREE_AFTER")" ]]; then
  echo "    bascula-central was not restarted: the same processes are running."
else
  echo "!!  PM2's process list changed while this ran. PM2 restarts programs on its own sometimes."
  problem=1
fi
if [[ $LINDERO_BEFORE == "$LINDERO_AFTER" ]]; then
  echo "    the live site was not restarted: the same process is running."
else
  echo "!!  The live site's process changed while this ran."
  problem=1
fi

if ((problem)); then
  fail "Something above is not as expected. Send Claude a screenshot."
fi

echo "==> Done. The test site is at https://$HOST"
echo "    Log in as gerencia@lindero.hn (supervisor) or asociado@lindero.hn (associate)."
echo "    To see the passwords, run this. Do not send a screenshot of what it prints:"
echo "      grep TEST_SITE $ENV_FILE"
