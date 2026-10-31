#!/usr/bin/env bash
#
# Runbook step 13: the guard rails that let more programs share this droplet.
#
# Run once, as root, in the droplet console (it logs you in as root):
#
#   bash /opt/lindero/deploy/droplet-guardrails.sh
#
# What it changes, each one checked and reported:
#
#   1. bascula-central is the last program the kernel ends when memory runs
#      out. Its PM2 daemon and everything PM2 runs get oom_score_adj -500: on
#      the running processes now, so nothing restarts, and after every reboot
#      through a drop-in for pm2-root.service.
#   2. The system journal is capped at 200 MB, so logs can never fill the disk.
#
# What it never does: restart bascula-central, PM2, Lindero or nginx, or read
# bascula's files, environment or process arguments. It reports PM2's own log
# folder and the DigitalOcean metrics agent, and changes neither.
#
# Running it twice is safe. To take both changes out again:
#
#   bash /opt/lindero/deploy/droplet-guardrails.sh --undo

set -euo pipefail

PM2_PID_FILE=/root/.pm2/pm2.pid
PM2_UNIT=pm2-root.service
PM2_DROPIN=/etc/systemd/system/pm2-root.service.d/50-lindero-guardrails.conf
JOURNAL_DROPIN=/etc/systemd/journald.conf.d/50-lindero-guardrails.conf
LINDERO_PORT=3001

# -500 rather than -1000: -1000 would forbid the kernel from ever ending it,
# and a bascula-central that leaked memory would then take everything else
# down with it. -500 only puts it behind every other program.
BASCULA_OOM=-500
JOURNAL_MAX=200M

# --- Pure helpers (also used by backend/test/droplet-guardrails.test.ts) -----

# PID and every process below it, one per line, parents first.
process_tree() {
  local child
  echo "$1"
  for child in $(ps -o pid= --ppid "$1"); do
    process_tree "$child"
  done
}

pm2_dropin() {
  printf '%s\n' \
    "# bascula-central is the last program the kernel ends when memory runs out." \
    "# Written by /opt/lindero/deploy/droplet-guardrails.sh; --undo removes it." \
    "[Service]" \
    "OOMScoreAdjust=$BASCULA_OOM"
}

journal_dropin() {
  printf '%s\n' \
    "# Logs may never fill the disk this droplet's applications share." \
    "# Written by /opt/lindero/deploy/droplet-guardrails.sh; --undo removes it." \
    "[Journal]" \
    "SystemMaxUse=$JOURNAL_MAX"
}

# Writes stdin to FILE unless FILE already says exactly that. Prints which.
write_if_changed() {
  local content
  content=$(cat)
  if [[ -f $1 && "$(cat "$1")" == "$content" ]]; then
    echo "unchanged"
    return 0
  fi
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$content" >"$1"
  echo "written"
}

# Removes FILE if it is there. Prints which.
remove_if_present() {
  if [[ -e $1 ]]; then
    rm -f "$1"
    echo "removed"
  else
    echo "not there"
  fi
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

pm2_pid() {
  local pid
  [[ -f $PM2_PID_FILE ]] || return 1
  pid=$(cat "$PM2_PID_FILE")
  [[ $pid =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

# One line per process: pid, its short name, and its place in the line.
# The short name only; process arguments are never read.
show_tree() {
  local pid
  for pid in $1; do
    printf '    pid %-7s %-16s oom_score_adj %s\n' "$pid" "$(cat "/proc/$pid/comm" 2>/dev/null || echo gone)" \
      "$(cat "/proc/$pid/oom_score_adj" 2>/dev/null || echo -)"
  done
}

health() {
  echo "    bascula-central: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/ || true)   expect 401"
  echo "    Lindero:         $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$LINDERO_PORT/api/health" || true)   expect 200"
}

PM2=$(pm2_pid) || fail "PM2 is not running, so bascula-central could not be found. Nothing was changed. Send Claude a screenshot."
TREE_BEFORE=$(process_tree "$PM2")

echo "==> Before"
show_tree "$TREE_BEFORE"
health

if [[ $mode == apply ]]; then
  target=$BASCULA_OOM
  echo "==> 1. bascula-central: last in line when memory runs out"
else
  target=0
  echo "==> 1. bascula-central: back to the normal place in line"
fi
for pid in $TREE_BEFORE; do
  { echo "$target" >"/proc/$pid/oom_score_adj"; } 2>/dev/null || echo "!!  pid $pid could not be set (it may have just ended)"
done
echo "    running processes: set to $target, nothing restarted"
if systemctl cat "$PM2_UNIT" >/dev/null 2>&1; then
  if [[ $mode == apply ]]; then
    echo "    after a reboot:    $(pm2_dropin | write_if_changed "$PM2_DROPIN") ($PM2_DROPIN)"
  else
    echo "    after a reboot:    $(remove_if_present "$PM2_DROPIN") ($PM2_DROPIN)"
  fi
  # Re-reads unit files only. It starts and stops nothing.
  systemctl daemon-reload
  echo "    $PM2_UNIT starts at boot: $(systemctl is-enabled "$PM2_UNIT" 2>/dev/null || true)   expect enabled"
else
  echo "!!  $PM2_UNIT does not exist, so PM2 is not started by systemd. The running"
  echo "    processes are set, but a reboot puts bascula-central back in the normal"
  echo "    place in line. Send Claude a screenshot."
fi

if [[ $mode == apply ]]; then
  echo "==> 2. System journal: capped at $JOURNAL_MAX"
  echo "    before: $(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]' | head -n 1 || echo unknown)"
  echo "    cap:    $(journal_dropin | write_if_changed "$JOURNAL_DROPIN") ($JOURNAL_DROPIN)"
else
  echo "==> 2. System journal: back to Ubuntu's own limit"
  echo "    before: $(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]' | head -n 1 || echo unknown)"
  echo "    cap:    $(remove_if_present "$JOURNAL_DROPIN") ($JOURNAL_DROPIN)"
fi
# The journal keeps every service's output connection open across a restart,
# so no program loses its logging and none restarts. Restarting is what makes
# it read the cap and trim to it.
systemctl restart systemd-journald
echo "    after:  $(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]' | head -n 1 || echo unknown)"

echo "==> Reported only, not changed"
echo "    PM2's own log files: $(du -sh /root/.pm2/logs 2>/dev/null | cut -f1 || echo unknown) in /root/.pm2/logs"
if compgen -G "/root/.pm2/modules/pm2-logrotate*" >/dev/null; then
  echo "    pm2-logrotate:       installed"
else
  echo "    pm2-logrotate:       not installed (PM2's logs grow until someone empties them)"
fi
echo "    DigitalOcean agent:  $(systemctl is-active do-agent 2>/dev/null || true)   needed for memory and disk alerts"

TREE_AFTER=$(process_tree "$PM2")
echo "==> After"
show_tree "$TREE_AFTER"
health
if [[ "$(sort <<<"$TREE_BEFORE")" == "$(sort <<<"$TREE_AFTER")" ]]; then
  echo "==> Done. bascula-central was not restarted: the same processes are running."
else
  echo "!!  PM2's process list changed while this ran. PM2 restarts programs on its"
  echo "    own sometimes, so this is not necessarily a problem. Send Claude a screenshot."
fi
