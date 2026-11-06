#!/usr/bin/env bash
#
# Runbook step 15: move bascula-central off Node 20, whose security updates ended
# in April 2026. The new Node goes in beside the old one, never over it.
#
# Run as root in the droplet console (it logs you in as root), one at a time:
#
#   bash /opt/lindero/deploy/bascula-node-move.sh --check
#     Reads only. Says which Node each part runs on and whether the move can go
#     ahead. Run it as often as you like.
#
#   bash /opt/lindero/deploy/bascula-node-move.sh --prepare
#     Installs the new Node in /opt/node24 and runs a real backup on it, database
#     and upload. Nothing restarts, so it is safe during a working day.
#
#   bash /opt/lindero/deploy/bascula-node-move.sh --move
#     After 7 p.m., the rule for any bascula-central deploy (its DESARROLLO.md). It
#     backs up, then bascula-central restarts twice, a few seconds each. If anything
#     does not check out, it goes back to the old Node by itself.
#
#   bash /opt/lindero/deploy/bascula-node-move.sh --undo
#     Back to the old Node, with the same two short restarts.
#
# Why it works this way. Each of these was seen in a rehearsal on PM2 5.4, 6.0
# and 7.1 (docs/deployment-shared-droplet.md, step 15):
#
#   - Pointing PM2's service at the new Node moves PM2 but NOT bascula-central,
#     silently, because PM2 saved the old PATH along with the program. The
#     program has to be told the new Node's full path, then `pm2 save`.
#   - `pgrep -x node` finds neither of them, because PM2 renames both. Only
#     /proc/PID/exe says which Node a process really runs on.
#   - The first restart moves the program. The second, through PM2's service,
#     moves PM2 and is the same path a reboot takes, so it proves that too.
#
# What it never does: compile anything, change /usr/bin/node, restart Lindero or
# nginx, or read bascula's .env, environment or process arguments.

set -euo pipefail

source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/droplet-guardrails.sh"

NEW_VERSION=24.22.2
# From https://nodejs.org/dist/v24.22.2/SHASUMS256.txt. Moving to another version
# means changing these two lines and NEW_DIR, and rehearsing again.
NEW_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
NEW_DIR=/opt/node24
NEW_URL=https://nodejs.org/dist/v$NEW_VERSION/node-v$NEW_VERSION-linux-x64.tar.xz

OLD_NODE=/usr/bin/node
BASCULA_DIR=/root/weight_software/backend
BASCULA_APP=bascula-backend
BASCULA_PORT=3000
BASCULA_HOST=api.basculacentral.com
PM2_HOME_DIR=/root/.pm2
PM2_UNIT=pm2-root.service
BACKUP_UNIT=bascula-backup.service
UNIT_DIR=/etc/systemd/system
SYSTEMCTL=(systemctl)
LOCK_FILE=/run/lock/droplet-deploy.lock
MIN_MEMORY_MB=150
MIN_DISK_MB=1024
# How long bascula-central gets to answer after a restart, and how long it must
# then stay up. A program that starts and then crashes would pass the first alone.
SETTLE_SECONDS=30
STEADY_SECONDS=5

# --- Pure helpers (also used by backend/test/bascula-node-move.test.ts) -------

# Takes the Node's own directory off the list and puts it first, so running this
# twice cannot add it twice.
path_with_new_node() {
  local rest
  rest=$(tr ':' '\n' <<<"$1" | grep -vxF "$NEW_DIR/bin" | paste -sd: - || true)
  echo "$NEW_DIR/bin${rest:+:$rest}"
}

# The PATH inside `systemctl show -p Environment --value`. A later line in a unit
# wins over an earlier one, so the last PATH is the one in force.
unit_path() {
  tr ' ' '\n' <<<"$1" | sed -n 's/^PATH=//p' | tail -n 1
}

# $1 is the PATH the service has now.
pm2_node_dropin() {
  printf '%s\n' \
    "# PM2 itself runs on the new Node. bascula-central's own Node is in PM2's list." \
    "# Written by /opt/lindero/deploy/bascula-node-move.sh; --undo removes it." \
    "[Service]" \
    "Environment=PATH=$(path_with_new_node "$1")"
}

backup_node_dropin() {
  printf '%s\n' \
    "# bascula-central's backup runs on the new Node." \
    "# Written by /opt/lindero/deploy/bascula-node-move.sh; --undo removes it." \
    "[Service]" \
    "ExecStart=" \
    "ExecStart=$NEW_DIR/bin/node scripts/backup-database.js"
}

# The first program path in `systemctl show -p ExecStart --value`.
exec_path() {
  grep -o 'path=[^ ;]*' <<<"$1" | head -n 1 | cut -d= -f2 || true
}

# A process's program, without the note Linux adds if the file was since replaced.
strip_deleted() {
  echo "${1% (deleted)}"
}

# Stops here when sourced by the tests.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

# --- Reading the machine ------------------------------------------------------

fail() {
  echo "!! $*" >&2
  exit 1
}

PROBLEMS=0
ok() { printf '    ok  %s\n' "$*"; }
bad() {
  printf '    !!  %s\n' "$*"
  PROBLEMS=$((PROBLEMS + 1))
}

pm2_pid() {
  local pid
  [[ -f $PM2_HOME_DIR/pm2.pid ]] || return 1
  pid=$(cat "$PM2_HOME_DIR/pm2.pid")
  [[ $pid =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

children() {
  ps -o pid= --ppid "$1" | tr -d ' ' || true
}

exe_of() {
  strip_deleted "$(readlink "/proc/$1/exe" 2>/dev/null || echo gone)"
}

version_of() {
  "$1" -v 2>/dev/null || echo "version unknown"
}

same_program() {
  [[ "$(readlink -f "$1")" == "$(readlink -f "$2")" ]]
}

answers() {
  [[ $(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$BASCULA_PORT/" || true) == 401 ]]
}

# The way the scale stations come in.
through_nginx() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    --resolve "$BASCULA_HOST:443:127.0.0.1" "https://$BASCULA_HOST/api/health" || true
}

listening_on() {
  ss -ltnH "sport = :$BASCULA_PORT" | awk '{ print $4 }' | sort -u | tr '\n' ' ' || true
}

# One line per program in PM2's list: name and state. These are the only fields
# that leave the filter, because the rest of `pm2 jlist` holds the API key.
pm2_apps() {
  timeout 20 pm2 jlist 2>/dev/null | "$OLD_NODE" -e '
    let text = ""; process.stdin.on("data", (d) => (text += d)).on("end", () => {
      for (const p of JSON.parse(text.slice(text.indexOf("[")))) console.log(`${p.name} ${p.pm2_env.status}`);
    });' 2>/dev/null || true
}

# What a reboot would start: name and Node only. The saved list holds the API key too.
saved_interpreter() {
  "$OLD_NODE" -e '
    for (const p of JSON.parse(require("fs").readFileSync(process.argv[1]))) console.log(`${p.name} ${p.exec_interpreter}`);
  ' "$PM2_HOME_DIR/dump.pm2" 2>/dev/null || echo "unreadable"
}

backup_node() {
  exec_path "$("${SYSTEMCTL[@]}" show "$BACKUP_UNIT" -p ExecStart --value 2>/dev/null || true)"
}

other_lindero_pids() {
  local unit
  for unit in lindero-api lindero-test-api; do
    printf '%s=%s ' "$unit" "$("${SYSTEMCTL[@]}" show "$unit" -p MainPID --value 2>/dev/null || echo none)"
  done
}

node_installed() {
  [[ -x $NEW_NODE && "$(version_of "$NEW_NODE")" == "v$NEW_VERSION" ]]
}

show_nodes() {
  local pm2 pid exe old p
  echo "==> Which Node each part runs on"
  if pm2=$(pm2_pid); then
    exe=$(exe_of "$pm2")
    printf '    %-17s %s (%s)\n' "PM2" "$exe" "$(version_of "$exe")"
    for pid in $(children "$pm2"); do
      exe=$(exe_of "$pid")
      printf '    %-17s %s (%s)\n' "bascula-central" "$exe" "$(version_of "$exe")"
    done
  else
    echo "    PM2 is not running"
  fi
  printf '    %-17s %s\n' "its backup" "$(backup_node)"
  printf '    %-17s %s\n' "after a reboot" "$(saved_interpreter)"

  old=$(readlink -f "$OLD_NODE")
  for p in /proc/[0-9]*; do
    [[ "$(strip_deleted "$(readlink "$p/exe" 2>/dev/null || true)")" == "$old" ]] || continue
    [[ ${p#/proc/} == "${pm2:-}" ]] && continue
    grep -qx "${p#/proc/}" <<<"$(children "${pm2:-1}")" && continue
    echo "    also on the old Node: pid ${p#/proc/} $(cat "$p/comm" 2>/dev/null || true)"
  done
}

# Everything the move depends on. Prints each one and counts what is wrong.
preflight() {
  local pm2="" kids exe state main enabled result memory disk here

  echo "==> Can it go ahead"
  [[ -x $OLD_NODE ]] && ok "the old Node is there: $(version_of "$OLD_NODE")" || bad "$OLD_NODE is missing"
  [[ $(uname -m) == x86_64 ]] && ok "this machine takes the x64 download" || bad "this machine is $(uname -m), and the download is for x64"
  [[ -d $BASCULA_DIR/node_modules/sqlite3 ]] && ok "$BASCULA_DIR is where bascula-central lives" || bad "no sqlite3 under $BASCULA_DIR/node_modules"

  if pm2=$(pm2_pid); then
    kids=$(children "$pm2")
    if [[ $(pm2_apps) == "$BASCULA_APP online" && -n $kids && $kids != *$'\n'* ]]; then
      ok "PM2 runs one program, $BASCULA_APP, and it is online"
    else
      bad "PM2 should run exactly $BASCULA_APP, online. It has: $(pm2_apps | tr '\n' ';')"
    fi
    for exe in "$(exe_of "$pm2")" "$(exe_of "${kids%%$'\n'*}")"; do
      same_program "$exe" "$OLD_NODE" || same_program "$exe" "$NEW_NODE" ||
        bad "something runs on $exe, which is neither the old Node nor the new one"
    done
  else
    bad "PM2 is not running"
  fi

  state=$("${SYSTEMCTL[@]}" show "$PM2_UNIT" -p ActiveState --value 2>/dev/null || true)
  main=$("${SYSTEMCTL[@]}" show "$PM2_UNIT" -p MainPID --value 2>/dev/null || true)
  enabled=$("${SYSTEMCTL[@]}" show "$PM2_UNIT" -p UnitFileState --value 2>/dev/null || true)
  # Restarting the service when it does not own the running PM2 would start a
  # second copy of bascula-central next to the first.
  if [[ $state == active && -n $pm2 && $main == "$pm2" ]]; then
    ok "$PM2_UNIT is what runs PM2"
  else
    bad "$PM2_UNIT is '$state' with main process '$main', but PM2 is pid '${pm2:-none}'"
  fi
  [[ $enabled == enabled ]] && ok "$PM2_UNIT starts at boot" || bad "$PM2_UNIT starts at boot: '$enabled', expected enabled"

  answers && ok "bascula-central answers on port $BASCULA_PORT" || bad "bascula-central does not answer 401 on port $BASCULA_PORT"
  here=$(through_nginx)
  [[ $here == 200 ]] && ok "the stations' way in, through nginx, answers" || bad "through nginx: $here, expected 200"

  result=$("${SYSTEMCTL[@]}" show "$BACKUP_UNIT" -p Result --value 2>/dev/null || true)
  [[ $result == success ]] && ok "the last backup succeeded" || bad "the last backup says '$result', expected success"
  exe=$(backup_node)
  if [[ -n $exe ]] && { same_program "$exe" "$OLD_NODE" || same_program "$exe" "$NEW_NODE"; }; then
    ok "the backup service names a Node this script knows"
  else
    bad "the backup service runs '$exe'"
  fi

  memory=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)
  ((memory >= MIN_MEMORY_MB)) && ok "$memory MB of memory available" || bad "only $memory MB of memory available, $MIN_MEMORY_MB needed"
  disk=$(df -Pm "$(dirname "$NEW_DIR")" | awk 'NR == 2 { print $4 }')
  ((disk >= MIN_DISK_MB)) && ok "$disk MB of disk free" || bad "only $disk MB of disk free, $MIN_DISK_MB needed"

  if node_installed; then
    ok "Node $NEW_VERSION is installed in $NEW_DIR"
  elif [[ -e $NEW_DIR ]]; then
    bad "$NEW_DIR is there, but it is not Node $NEW_VERSION"
  else
    echo "    --  Node $NEW_VERSION is not installed yet"
  fi
}

# --- Changing things ----------------------------------------------------------

take_lock() {
  # Lindero's deploys wait for this too, so the two never share the one CPU.
  exec 9>"$LOCK_FILE"
  echo "==> Waiting for any deploy to finish"
  flock -w 600 9 || fail "A deploy is still running after ten minutes. Nothing changed. Try again later."
}

WORK=""
cleanup() {
  if [[ -n $WORK ]]; then
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

install_node() {
  echo "==> Node $NEW_VERSION in $NEW_DIR"
  if node_installed; then
    echo "    already there"
    return 0
  fi
  [[ ! -e $NEW_DIR ]] || fail "$NEW_DIR is there, but it is not Node $NEW_VERSION. Nothing changed. Send Claude a screenshot."
  # On the same disk as the final folder, so it appears there all at once.
  WORK=$(mktemp -d "$(dirname "$NEW_DIR")/.node-move.XXXXXX")
  curl -fsSL --max-time 300 -o "$WORK/node.tar.xz" "$NEW_URL" ||
    fail "Could not download Node. Nothing changed. Try again later."
  echo "$NEW_SHA256  $WORK/node.tar.xz" | sha256sum -c --quiet - ||
    fail "The download does not match its checksum. Nothing changed. Send Claude a screenshot."
  mkdir "$WORK/node"
  tar -xJf "$WORK/node.tar.xz" -C "$WORK/node" --strip-components=1 --no-same-owner
  [[ "$(version_of "$WORK/node/bin/node")" == "v$NEW_VERSION" ]] ||
    fail "The new Node does not start here. Nothing changed. Send Claude a screenshot."
  mv "$WORK/node" "$NEW_DIR"
  rm -rf "$WORK"
  WORK=""
  echo "    installed, checksum verified: $(version_of "$NEW_NODE")"
  echo "    the old Node is untouched:    $(version_of "$OLD_NODE")"
}

# Every package the server needs, and sqlite3 doing real work on an empty database
# in memory. Opens no file of bascula's. If this fails, compiling here is not the
# answer: a compile can take the machine's memory from the scale stations.
prove_packages() {
  echo "==> bascula-central's packages on the new Node"
  (
    cd "$BASCULA_DIR"
    "$NEW_NODE" --check server.js
    "$NEW_NODE" -e '
      const names = Object.keys(require("./package.json").dependencies || {});
      for (const name of names) require(name);
      const sqlite3 = require("sqlite3");
      const db = new sqlite3.Database(":memory:");
      db.get("select 41 + 1 as answer", (error, row) => {
        if (error || row.answer !== 42) {
          console.error(error || row);
          process.exit(1);
        }
        console.log(`    ${names.length} packages load, and sqlite3 works`);
        db.close();
      });'
  ) || fail "bascula-central's packages do not load on Node $NEW_VERSION. Nothing restarted. Do NOT compile anything here. Send Claude a screenshot."
}

# The real script on the real database and the real bucket, which also makes this
# the backup to come back to. It is what the hourly timer runs anyway.
real_backup() {
  local out
  echo "==> A real backup, on the new Node"
  if ! out=$(cd "$BASCULA_DIR" && "$NEW_NODE" scripts/backup-database.js 2>&1); then
    tail -n 8 <<<"$out"
    fail "The backup failed on Node $NEW_VERSION. Nothing restarted. Send Claude a screenshot."
  fi
  grep -q '^Respaldo subido a Spaces' <<<"$out" || {
    tail -n 8 <<<"$out"
    fail "The backup ran but did not say it reached the bucket. Nothing restarted. Send Claude a screenshot."
  }
  grep -E '^(Respaldo|Copia)' <<<"$out" | sed 's/^/    /'
}

# True when bascula-central answers on the given Node, in one process, both ways in.
settled_on() {
  local pm2 pid
  pm2=$(pm2_pid) || return 1
  pid=$(children "$pm2")
  [[ -n $pid && $pid != *$'\n'* ]] || return 1
  same_program "$(exe_of "$pid")" "$1" || return 1
  answers || return 1
  [[ $(through_nginx) == 200 ]]
}

# Waits for it to settle on the given Node and then to stay up.
wait_settled() {
  local i pid
  for ((i = 0; i < SETTLE_SECONDS; i++)); do
    if settled_on "$1"; then
      pid=$(children "$(pm2_pid)")
      sleep "$STEADY_SECONDS"
      if settled_on "$1" && [[ $(children "$(pm2_pid)") == "$pid" ]]; then
        echo "    answering within ${i}s and still up ${STEADY_SECONDS}s later"
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

service_owns_pm2() {
  [[ "$("${SYSTEMCTL[@]}" show "$PM2_UNIT" -p MainPID --value 2>/dev/null || true)" == "$(pm2_pid || echo none)" ]]
}

# After a restart through the service its OOMScoreAdjust applies; this makes sure.
keep_place_in_line() {
  local pm2 pid current
  pm2=$(pm2_pid) || return 0
  for pid in $(process_tree "$pm2"); do
    current=$(cat "/proc/$pid/oom_score_adj" 2>/dev/null || echo "$BASCULA_OOM")
    [[ $current == "$BASCULA_OOM" ]] && continue
    { echo "$BASCULA_OOM" >"/proc/$pid/oom_score_adj"; } 2>/dev/null || echo "!!  pid $pid: could not set its place in line"
  done
}

show_outcome() {
  local pm2 pid
  show_nodes
  echo "==> Both ways in"
  echo "    port $BASCULA_PORT: $(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$BASCULA_PORT/" || true)   expect 401"
  echo "    nginx:     $(through_nginx)   expect 200"
  echo "    listening: $(listening_on)  was: $ADDRESS_BEFORE"
  if pm2=$(pm2_pid); then
    for pid in $(process_tree "$pm2"); do
      echo "    place in line, pid $pid: $(cat "/proc/$pid/oom_score_adj" 2>/dev/null || echo gone)   expect $BASCULA_OOM"
    done
  fi
  if [[ $(other_lindero_pids) == "$LINDERO_BEFORE" ]]; then
    echo "    Lindero and its test site: not restarted, same processes"
  else
    echo "!!  Lindero's process changed while this ran (before: $LINDERO_BEFORE, now: $(other_lindero_pids))."
    echo "    A deploy can do that. Send Claude a screenshot."
  fi
}

# Back to the old Node from any state. Drop-ins come out first, so any restart from
# here on takes the old path. Restarts only what is not on the old Node yet.
to_old_node() {
  local pm2
  echo "    PM2's service:  $(remove_if_present "$PM2_DROPIN")"
  echo "    backup service: $(remove_if_present "$BACKUP_DROPIN")"
  "${SYSTEMCTL[@]}" daemon-reload

  if ! pm2=$(pm2_pid); then
    "${SYSTEMCTL[@]}" start "$PM2_UNIT" || true
    sleep 2
    pm2=$(pm2_pid) || return 1
  fi
  if ! same_program "$(exe_of "$(children "$pm2")")" "$OLD_NODE"; then
    pm2 restart "$BASCULA_APP" --interpreter "$OLD_NODE" >/dev/null 2>&1 || echo "!!  pm2 restart reported an error"
  fi
  wait_settled "$OLD_NODE" || return 1
  pm2 save >/dev/null 2>&1 || echo "!!  pm2 save reported an error"

  pm2=$(pm2_pid) || return 1
  if ! same_program "$(exe_of "$pm2")" "$OLD_NODE"; then
    "${SYSTEMCTL[@]}" restart "$PM2_UNIT" || return 1
    wait_settled "$OLD_NODE" || return 1
  fi
  keep_place_in_line
}

go_back() {
  echo "!! $1"
  echo "==> Going back to the old Node"
  if to_old_node; then
    show_outcome
    fail "Back on the old Node, and it answers. Nothing is lost. Send Claude a screenshot."
  fi
  show_outcome
  fail "GOING BACK DID NOT FINISH, and bascula-central may be down. Run 'pm2 list' and send Claude a screenshot now."
}

move_server() {
  local pm2
  echo "==> 1. bascula-central onto the new Node (a few seconds)"
  pm2=$(pm2_pid)
  if same_program "$(exe_of "$(children "$pm2")")" "$NEW_NODE"; then
    echo "    already there"
  else
    pm2 restart "$BASCULA_APP" --interpreter "$NEW_NODE" >/dev/null 2>&1 || echo "!!  pm2 restart reported an error"
    wait_settled "$NEW_NODE" || go_back "bascula-central did not settle on Node $NEW_VERSION."
  fi
  pm2 save >/dev/null 2>&1 || go_back "pm2 save failed, so a reboot would not know about the new Node."
  [[ "$(saved_interpreter)" == "$BASCULA_APP $NEW_NODE" ]] ||
    go_back "PM2's saved list says '$(saved_interpreter)', so a reboot would go back to the old Node."
  echo "    saved, so a reboot starts it on the new Node"
}

move_backup() {
  echo "==> 2. The backup service onto the new Node"
  echo "    $(backup_node_dropin | write_if_changed "$BACKUP_DROPIN") ($BACKUP_DROPIN)"
  "${SYSTEMCTL[@]}" daemon-reload
  same_program "$(backup_node)" "$NEW_NODE" || go_back "The backup service still runs $(backup_node)."
  # A backup that fails is invisible until the day it is needed, so run one now.
  "${SYSTEMCTL[@]}" start "$BACKUP_UNIT" || go_back "The backup service failed on the new Node."
  echo "    ran once through its service: $("${SYSTEMCTL[@]}" show "$BACKUP_UNIT" -p Result --value)"
}

move_pm2() {
  local current
  echo "==> 3. PM2 onto the new Node, the way a reboot would (a few seconds)"
  if same_program "$(exe_of "$(pm2_pid)")" "$NEW_NODE"; then
    echo "    already there"
    return 0
  fi
  current=$(unit_path "$("${SYSTEMCTL[@]}" show "$PM2_UNIT" -p Environment --value)")
  [[ -n $current ]] || go_back "$PM2_UNIT has no PATH to add the new Node to."
  echo "    $(pm2_node_dropin "$current" | write_if_changed "$PM2_DROPIN") ($PM2_DROPIN)"
  "${SYSTEMCTL[@]}" daemon-reload
  "${SYSTEMCTL[@]}" restart "$PM2_UNIT" || go_back "$PM2_UNIT did not restart."
  wait_settled "$NEW_NODE" || go_back "bascula-central did not come back after PM2's service restarted."
  same_program "$(exe_of "$(pm2_pid)")" "$NEW_NODE" || go_back "PM2 runs on $(exe_of "$(pm2_pid)")."
  service_owns_pm2 || go_back "$PM2_UNIT no longer owns the running PM2."
  keep_place_in_line
}

# --- The run ------------------------------------------------------------------

case ${1:-} in
  --check) mode=check ;;
  --prepare) mode=prepare ;;
  --move) mode=move ;;
  --undo) mode=undo ;;
  "") fail "Choose one: --check (reads only), --prepare, --move or --undo." ;;
  *) fail "Unknown option '$1'. Choose one: --check, --prepare, --move or --undo." ;;
esac

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PM2_HOME=$PM2_HOME_DIR
REQUIRE_ROOT=1

# A rehearsal on a laptop points everything above at a scratch copy (step 15 in
# the runbook). This is never set on the droplet.
if [[ -n ${BASCULA_MOVE_REHEARSAL:-} ]]; then
  source "$BASCULA_MOVE_REHEARSAL"
fi

if [[ $REQUIRE_ROOT == 1 && $EUID -ne 0 ]]; then
  fail "Run it as root (the droplet console logs you in as root)."
fi

NEW_NODE=$NEW_DIR/bin/node
PM2_DROPIN=$UNIT_DIR/$PM2_UNIT.d/60-node-move.conf
BACKUP_DROPIN=$UNIT_DIR/$BACKUP_UNIT.d/60-node-move.conf

# Lowest priority, so bascula-central's work always comes first.
renice -n 19 -p $$ >/dev/null
ionice -c 3 -p $$ 2>/dev/null || true

case $mode in
  check)
    show_nodes
    preflight
    if ((PROBLEMS > 0)); then
      fail "$PROBLEMS to look at. Nothing was changed. Send Claude a screenshot."
    elif same_program "$(exe_of "$(pm2_pid)")" "$NEW_NODE" && same_program "$(exe_of "$(children "$(pm2_pid)")")" "$NEW_NODE" && same_program "$(backup_node)" "$NEW_NODE"; then
      echo "==> Everything is on Node $NEW_VERSION. Nothing was changed."
    elif node_installed; then
      echo "==> Ready for --move, after 7 p.m. Nothing was changed."
    else
      echo "==> Ready for --prepare. Nothing was changed."
    fi
    ;;

  prepare)
    preflight
    ((PROBLEMS == 0)) || fail "$PROBLEMS to look at. Nothing was changed. Send Claude a screenshot."
    take_lock
    BEFORE=$(children "$(pm2_pid)")
    install_node
    prove_packages
    real_backup
    [[ $(children "$(pm2_pid)") == "$BEFORE" ]] && echo "==> Done. bascula-central was not restarted: same process, still on $(exe_of "$BEFORE")." ||
      fail "bascula-central's process changed while this ran. PM2 restarts programs on its own sometimes. Send Claude a screenshot."
    echo "    Next, after 7 p.m.: bash /opt/lindero/deploy/bascula-node-move.sh --move"
    ;;

  move)
    preflight
    ((PROBLEMS == 0)) || fail "$PROBLEMS to look at. Nothing was changed. Send Claude a screenshot."
    node_installed || fail "Node $NEW_VERSION is not installed. Run --prepare first. Nothing was changed."
    take_lock
    prove_packages
    # bascula-central's own deploy routine starts with a backup too (DESARROLLO.md).
    real_backup
    ADDRESS_BEFORE=$(listening_on)
    LINDERO_BEFORE=$(other_lindero_pids)
    # The list as it is now, so a reboot before this run would have started the same thing.
    pm2 save >/dev/null 2>&1 || fail "pm2 save failed. Nothing was changed. Send Claude a screenshot."
    if [[ ! -e $PM2_HOME_DIR/dump.pm2.before-node-move ]]; then
      cp -p "$PM2_HOME_DIR/dump.pm2" "$PM2_HOME_DIR/dump.pm2.before-node-move"
    fi
    move_server
    move_backup
    move_pm2
    [[ $(listening_on) == "$ADDRESS_BEFORE" ]] || go_back "It now listens on $(listening_on), and it was $ADDRESS_BEFORE."
    show_outcome
    echo "==> Done. Now weigh something on a scale station: that is the real proof. Then send Claude a screenshot."
    ;;

  undo)
    [[ -x $OLD_NODE ]] || fail "$OLD_NODE is missing, so there is nothing to go back to. Nothing was changed."
    take_lock
    ADDRESS_BEFORE=$(listening_on)
    LINDERO_BEFORE=$(other_lindero_pids)
    echo "==> Back to the old Node"
    to_old_node || {
      show_outcome
      fail "GOING BACK DID NOT FINISH, and bascula-central may be down. Run 'pm2 list' and send Claude a screenshot now."
    }
    show_outcome
    echo "==> Done. $NEW_DIR stays where it is and nothing uses it, so running --move later is quick."
    ;;
esac
