#!/usr/bin/env bash
#
# The only thing Claude's SSH key may run on the droplet.
#
# Installed as a forced command in /root/.ssh/authorized_keys, from a PINNED
# copy at /usr/local/sbin/lindero-claude-ops (see docs/claude-ops-key.md). The
# copy is deliberate: merging a change to this file does not widen what the key
# can do until the owner copies it in again by hand.
#
# Whatever the caller sends is ignored except for one word, read from
# SSH_ORIGINAL_COMMAND, which must be one of the actions below. Anything else,
# including extra words, is refused. Nothing the caller sends is ever run.
#
#   help             this list
#   status           both apps' health, memory, disk, Lindero's service, the live build,
#                    the step 13 guard rails (bascula's place in line, the journal cap)
#   nginx            Lindero's nginx site, its snippets, and `nginx -t`
#   logs             recent Lindero, autodeploy and backup logs, secrets masked
#   install-headers  runbook step 9d: the browser security headers
#   undo-headers     takes the step 9d include lines out again
#
# Every run is logged: journalctl -t lindero-claude-ops

set -euo pipefail

SITE=/etc/nginx/sites-available/lindero
SITE_LINK=/etc/nginx/sites-enabled/lindero
REPO=/opt/lindero
HEADERS_SOURCE=$REPO/deploy/nginx-headers.conf
HEADERS_SNIPPET=/etc/nginx/snippets/lindero-headers.conf
BACKUPS=/root/lindero-nginx-backups
LINDERO_HOST=lindero.basculacentral.com
BASCULA_HOST=api.basculacentral.com
INCLUDE_LINE='include snippets/lindero-headers.conf;'

ACTIONS=(help status nginx logs install-headers undo-headers)

# --- Pure helpers (also used by backend/test/claude-ops.test.ts) -------------

# Masks anything that looks like a secret, so logs and config can be shown.
redact() {
  sed -E \
    -e "s/(bearer[[:space:]]+)[^[:space:],;\"']+/\1[hidden]/Ig" \
    -e "s/((secret|token|password|passwd|api[_-]?key|cookie|authorization)[A-Za-z0-9_-]*[\"']?[[:space:]]*[=:][[:space:]]*[\"']?)[^[:space:],;\"']+/\1[hidden]/Ig"
}

# Prints FILE with the headers include added inside each static location of
# the HTTPS block, exactly as in runbook step 9d. Unchanged if already there.
with_header_includes() {
  if grep -qE "^[[:space:]]*${INCLUDE_LINE//./\\.}" "$1"; then
    cat "$1"
    return
  fi
  sed -E '/listen[^;]*443/,$ s#^([[:space:]]*)location (/|= /index\.html|/assets/|= /sw\.js|= /manifest\.webmanifest) \{$#&\n\1    include snippets/lindero-headers.conf;#' "$1"
}

# Prints FILE without the headers include lines.
without_header_includes() {
  sed -E "\\#^[[:space:]]*${INCLUDE_LINE//./\\.}[[:space:]]*\$#d" "$1"
}

include_count() {
  grep -cE "^[[:space:]]*${INCLUDE_LINE//./\\.}" "$1" || true
}

# Sourced by the tests: stop here, before anything touches the machine.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

# --- The actions --------------------------------------------------------------

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
exec </dev/null

fail() {
  echo "!! $*" >&2
  exit 1
}

# HTTP status of https://HOST/PATH through this machine's own nginx.
code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    --resolve "$1:443:127.0.0.1" "https://$1$2" || true
}

headers() {
  curl -sI --max-time 10 --resolve "$1:443:127.0.0.1" "https://$1$2" || true
}

show_help() {
  echo "Actions: ${ACTIONS[*]}"
  echo "Send exactly one, e.g.: ssh lindero-ops status"
}

show_status() {
  echo "==> Machine"
  uptime
  free -m
  df -h / | tail -n 1
  echo "journal:         $(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]' | head -n 1 || echo unknown), cap $(grep -hs '^SystemMaxUse=' /etc/systemd/journald.conf.d/*.conf | tail -n 1 || echo none)   expect SystemMaxUse=200M"

  echo "==> Lindero"
  systemctl show lindero-api -p ActiveState -p MainPID -p NRestarts \
    -p ActiveEnterTimestamp -p MemoryCurrent -p MemoryMax
  echo "health (local):  $(curl -s --max-time 5 http://127.0.0.1:3001/api/health || echo 'no answer')"
  echo "health (nginx):  $(code "$LINDERO_HOST" /api/health)   expect 200"
  for unit in lindero-autodeploy.timer lindero-backup.timer nginx; do
    echo "$unit: $(systemctl is-active "$unit" || true)"
  done
  echo "checkout:        $(sudo -u lindero -H git -C "$REPO" log -1 --format='%h %s' || echo unknown)"
  echo "deployed build:  $(cat /var/lib/lindero-autodeploy/last-build 2>/dev/null || echo unknown)"
  echo "live page uses:  $(grep -o 'assets/index-[^"]*\.js' /var/www/lindero/frontend/dist/index.html || echo unknown)"

  echo "==> bascula-central"
  echo "port 3000:       $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/ || true)   expect 401"
  echo "through nginx:   $(code "$BASCULA_HOST" /api/health)"
  # `pm2 jlist` would START a pm2 daemon if none is running, and its output
  # carries bascula's environment (the API key), so only selected fields leave
  # the node filter, and only when the daemon is already up.
  if [[ -f /root/.pm2/pm2.pid ]] && kill -0 "$(cat /root/.pm2/pm2.pid)" 2>/dev/null; then
    timeout 20 pm2 jlist 2>/dev/null | /usr/bin/node -e '
      let text = ""; process.stdin.on("data", (d) => (text += d)).on("end", () => {
        const list = JSON.parse(text.slice(text.indexOf("[")));
        for (const p of list) {
          const e = p.pm2_env || {};
          console.log(`pm2 ${p.name}: ${e.status} pid=${p.pid} restarts=${e.restart_time} since=${new Date(e.pm_uptime).toISOString()} mem=${Math.round((p.monit?.memory || 0) / 1048576)}MB`);
        }
      });' 2>/dev/null || echo "pm2: could not read the list"
    # Its place in line when memory runs out (deploy/droplet-guardrails.sh).
    # Short process names only, never their arguments.
    local pm2 child
    pm2=$(cat /root/.pm2/pm2.pid)
    echo "oom_score_adj:   pm2 $(cat "/proc/$pm2/oom_score_adj")$(for child in $(ps -o pid= --ppid "$pm2"); do printf ', %s %s' "$(cat "/proc/$child/comm")" "$(cat "/proc/$child/oom_score_adj")"; done)   expect -500"
    echo "after a reboot:  $(grep -hs '^OOMScoreAdjust=' /etc/systemd/system/pm2-root.service.d/*.conf | tail -n 1 || echo 'not set')   expect OOMScoreAdjust=-500"
  else
    echo "pm2: daemon not running (not started from here)"
  fi
}

show_nginx() {
  echo "==> $SITE"
  redact <"$SITE"
  echo "==> sites-enabled/lindero -> $(readlink -f "$SITE_LINK")"
  echo "==> Lindero snippets (installed vs repository)"
  for snippet in /etc/nginx/snippets/lindero-*.conf; do
    [[ -e $snippet ]] || continue
    echo "$(sha256sum "$snippet" | cut -c1-12)  $snippet"
  done
  for source in "$REPO"/deploy/nginx-*.conf; do
    echo "$(sha256sum "$source" | cut -c1-12)  $source"
  done
  echo "==> nginx -t"
  nginx -t 2>&1
}

show_logs() {
  for unit in lindero-api:60 lindero-autodeploy:30 lindero-backup:15; do
    echo "==> ${unit%%:*}"
    journalctl -u "${unit%%:*}" -n "${unit##*:}" --no-pager -o short-iso | redact
  done
}

# Puts the site file (and the snippet, if one was saved) back as they were.
restore_nginx() {
  echo "==> Putting the previous nginx files back" >&2
  cat "$1" >"$SITE"
  if [[ -n $2 ]]; then
    cat "$2" >"$HEADERS_SNIPPET"
  elif [[ $3 == new ]]; then
    rm -f "$HEADERS_SNIPPET"
  fi
}

backup_site() {
  install -d -m 700 "$BACKUPS"
  local copy
  copy="$BACKUPS/lindero.$(date +%Y%m%d-%H%M%S)"
  cp -p "$SITE" "$copy"
  echo "$copy"
}

# The edits below assume this link; a copied file would be edited and ignored.
check_site_link() {
  [[ "$(readlink -f "$SITE_LINK")" == "$SITE" ]] ||
    fail "$SITE_LINK is not a link to $SITE; nothing changed."
}

install_headers() {
  check_site_link
  [[ -f $HEADERS_SOURCE ]] ||
    fail "$HEADERS_SOURCE is not on the droplet yet: run the Deploy workflow first. Nothing changed."

  echo "==> Before"
  local lindero_before bascula_before
  lindero_before=$(code "$LINDERO_HOST" /api/health)
  bascula_before=$(code "$BASCULA_HOST" /api/health)
  echo "Lindero $lindero_before, bascula $bascula_before"
  [[ $lindero_before == 200 ]] || fail "Lindero is not answering 200 before the change. Nothing changed."

  # HSTS makes browsers refuse the site outright if the certificate lapses.
  # With no terminal on stdin, certbot first waits a silent random 1-480 s to
  # spread load on Let's Encrypt; the option skips that, as at the console.
  echo "==> Certificate renewal (dry run, about ten seconds)"
  timeout 300 certbot renew --dry-run --no-random-sleep-on-renew --cert-name "$LINDERO_HOST" 2>&1 | tail -n 5 ||
    fail "certbot renew --dry-run failed: fix renewal before promising HSTS. Nothing changed."

  echo "==> Editing"
  local site_copy snippet_copy="" snippet_state=existing new_site
  site_copy=$(backup_site)
  if [[ -f $HEADERS_SNIPPET ]]; then
    snippet_copy="$site_copy.headers-snippet"
    cp -p "$HEADERS_SNIPPET" "$snippet_copy"
  else
    snippet_state=new
  fi
  echo "backup: $site_copy"

  new_site=$(mktemp)
  with_header_includes "$SITE" >"$new_site"
  local count
  count=$(include_count "$new_site")
  if [[ $count != 5 ]]; then
    rm -f "$new_site"
    fail "Expected 5 include lines, got $count: the site file is shaped differently from the example. Nothing changed."
  fi

  install -m 644 "$HEADERS_SOURCE" "$HEADERS_SNIPPET"
  cat "$new_site" >"$SITE"
  rm -f "$new_site"

  if ! nginx -t 2>&1; then
    restore_nginx "$site_copy" "$snippet_copy" "$snippet_state"
    fail "nginx -t refused the new config. Files restored, nginx was not reloaded."
  fi
  systemctl reload nginx
  sleep 2

  echo "==> After"
  local lindero_after bascula_after page_headers api_frame
  lindero_after=$(code "$LINDERO_HOST" /api/health)
  bascula_after=$(code "$BASCULA_HOST" /api/health)
  page_headers=$(headers "$LINDERO_HOST" / | grep -ciE '^(strict-transport-security|x-frame-options|x-content-type-options|referrer-policy|permissions-policy|content-security-policy-report-only):' || true)
  api_frame=$(headers "$LINDERO_HOST" /api/health | grep -ci '^x-frame-options:' || true)
  echo "Lindero $lindero_after, bascula $bascula_after, page headers $page_headers (expect 6), X-Frame-Options on /api/ $api_frame (expect 0)"

  if [[ $lindero_after != 200 || $bascula_after != "$bascula_before" || $page_headers != 6 || $api_frame != 0 ]]; then
    restore_nginx "$site_copy" "$snippet_copy" "$snippet_state"
    nginx -t 2>&1 && systemctl reload nginx
    fail "The check after reloading failed. Previous config restored and reloaded."
  fi
  echo "==> Done. Now open a receipt's comprobante and a contract's scan in the app."
}

undo_headers() {
  check_site_link
  local site_copy new_site bascula_before
  bascula_before=$(code "$BASCULA_HOST" /api/health)
  site_copy=$(backup_site)
  echo "backup: $site_copy"

  new_site=$(mktemp)
  without_header_includes "$SITE" >"$new_site"
  cat "$new_site" >"$SITE"
  rm -f "$new_site"

  if ! nginx -t 2>&1; then
    cat "$site_copy" >"$SITE"
    fail "nginx -t refused the config. File restored, nginx was not reloaded."
  fi
  systemctl reload nginx
  sleep 2
  echo "Lindero $(code "$LINDERO_HOST" /api/health), bascula $(code "$BASCULA_HOST" /api/health) (was $bascula_before)"
  echo "Browsers that already saw HSTS keep it for up to a year; see runbook step 9d."
}

# --- Dispatch -----------------------------------------------------------------

request=${SSH_ORIGINAL_COMMAND:-help}
client=${SSH_CLIENT:-local}
logger -t lindero-claude-ops "request=${request@Q} from=${client%% *}" 2>/dev/null || true

action=""
for known in "${ACTIONS[@]}"; do
  if [[ $request == "$known" ]]; then
    action=$known
  fi
done
if [[ -z $action ]]; then
  echo "Refused: not one of the allowed actions." >&2
  show_help >&2
  exit 2
fi

if [[ $action == help ]]; then
  show_help
  exit 0
fi
[[ $EUID -eq 0 ]] || fail "Runs as root, from the forced command only."

# Lowest priority, so bascula-central's work always comes first, and one run
# at a time.
renice -n 19 -p $$ >/dev/null
ionice -c 3 -p $$ 2>/dev/null || true
exec 9>/run/lock/lindero-claude-ops.lock
flock -n 9 || fail "Another run is still going."

case $action in
  status) show_status ;;
  nginx) show_nginx ;;
  logs) show_logs ;;
  install-headers) install_headers ;;
  undo-headers) undo_headers ;;
esac
