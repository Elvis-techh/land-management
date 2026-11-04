import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const repo = join(import.meta.dirname, "..", "..");
const script = join(repo, "deploy", "bascula-node-move.sh");
const source = readFileSync(script, "utf8");
const scratch = mkdtempSync(join(tmpdir(), "bascula-node-move-"));

/** Runs one of the script's helpers, with the script sourced (which stops before the run). */
function helper(call: string): string {
  const result = spawnSync("bash", ["-c", `source "$1"; ${call}`, "node-move-test", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/*
 * deploy/bascula-node-move.sh is run as root on the machine the scale stations
 * depend on, and it restarts their server. The whole script was rehearsed against
 * a copy of bascula-central under PM2 and systemd (runbook step 15). These pin
 * down what that rehearsal found, so a later edit cannot quietly undo it.
 */
describe("moving bascula-central's Node (runbook step 15)", () => {
  it("does nothing unless told exactly which step to run", () => {
    for (const args of [[], ["--force"], ["move"], ["-m"], ["--moved"]]) {
      const result = spawnSync("bash", [script, ...args], { encoding: "utf8" });
      assert.equal(result.status, 1, args.join(" "));
      assert.match(result.stderr, /Choose one/, args.join(" "));
    }
  });

  it("does nothing without root", { skip: process.getuid?.() === 0 }, () => {
    for (const option of ["--check", "--prepare", "--move", "--undo"]) {
      const result = spawnSync("bash", [script, option], { encoding: "utf8" });
      assert.equal(result.status, 1, option);
      assert.match(result.stderr, /Run it as root/, option);
    }
  });

  it("installs one exact Node, checked against its published checksum", () => {
    assert.equal(helper('echo "$NEW_VERSION"').trim(), "24.22.2");
    assert.equal(helper('echo "$NEW_DIR"').trim(), "/opt/node24");
    assert.match(helper('echo "$NEW_SHA256"').trim(), /^[0-9a-f]{64}$/);
    assert.ok(helper('echo "$NEW_URL"').includes("/v24.22.2/node-v24.22.2-linux-x64.tar.xz"));
    assert.ok(source.includes("sha256sum -c"), "the download is checked");
    assert.ok(source.indexOf("sha256sum -c") < source.indexOf("tar -xJf"), "before it is unpacked");
  });

  it("goes beside the old Node, and never compiles or replaces anything", () => {
    assert.equal(helper('echo "$OLD_NODE"').trim(), "/usr/bin/node");
    const commands = source.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    for (const forbidden of [/\bnpm\b/, /node-gyp/, /\bapt\b/, />\s*"?\$OLD_NODE/, /rm [^\n]*\$OLD_NODE/, /rm [^\n]*\$NEW_DIR/]) {
      assert.ok(!commands.some((line) => forbidden.test(line)), String(forbidden));
    }
  });

  it("gives PM2 the new Node first on its PATH, once, keeping the rest", () => {
    const before = "/usr/bin:/bin:/usr/local/sbin";
    const dropin = helper(`pm2_node_dropin "${before}"`);
    assert.match(dropin, /^\[Service\]$/m);
    assert.match(dropin, /^Environment=PATH=\/opt\/node24\/bin:\/usr\/bin:\/bin:\/usr\/local\/sbin$/m);
    assert.equal(helper(`path_with_new_node "/opt/node24/bin:${before}"`).trim(), `/opt/node24/bin:${before}`);
    assert.equal(helper('path_with_new_node ""').trim(), "/opt/node24/bin");
  });

  it("reads the PATH in force from what systemd reports, the last one winning", () => {
    assert.equal(helper('unit_path "PATH=/usr/bin:/bin PM2_HOME=/root/.pm2"').trim(), "/usr/bin:/bin");
    assert.equal(helper('unit_path "PATH=/usr/bin PM2_HOME=/root/.pm2 PATH=/opt/node24/bin:/usr/bin"').trim(), "/opt/node24/bin:/usr/bin");
    assert.equal(helper('unit_path "PM2_HOME=/root/.pm2"').trim(), "");
  });

  it("clears the backup's old command before giving it the new one", () => {
    const lines = helper("backup_node_dropin").trim().split("\n");
    const service = lines.indexOf("[Service]");
    assert.ok(service >= 0);
    // Without the empty line, a oneshot unit would run both, old Node first.
    assert.deepEqual(lines.slice(service + 1), ["ExecStart=", "ExecStart=/opt/node24/bin/node scripts/backup-database.js"]);
  });

  it("finds which program a service runs in what systemd reports", () => {
    const shown =
      "{ path=/usr/bin/node ; argv[]=/usr/bin/node scripts/backup-database.js ; ignore_errors=no ; start_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }";
    assert.equal(helper(`exec_path "${shown}"`).trim(), "/usr/bin/node");
    assert.equal(helper('exec_path ""').trim(), "");
  });

  it("sees through the note Linux adds when a running program's file was replaced", () => {
    assert.equal(helper('strip_deleted "/usr/bin/node (deleted)"').trim(), "/usr/bin/node");
    assert.equal(helper('strip_deleted "/usr/bin/node"').trim(), "/usr/bin/node");
  });

  it("writes its service changes once, leaves them the second time, and removes them on undo", () => {
    const file = join(scratch, "nested", "60-node-move.conf");
    assert.equal(helper(`backup_node_dropin | write_if_changed "${file}"`).trim(), "written");
    assert.equal(readFileSync(file, "utf8"), helper("backup_node_dropin"));
    assert.equal(helper(`backup_node_dropin | write_if_changed "${file}"`).trim(), "unchanged");
    assert.equal(helper(`remove_if_present "${file}"`).trim(), "removed");
    assert.equal(helper(`remove_if_present "${file}"`).trim(), "not there");
  });

  /*
   * The rehearsal's main finding. Changing only PM2's PATH moves PM2 and leaves
   * bascula-central on the old Node, with nothing to say so: PM2 saved the old
   * PATH with the program. It has to be told the full path, and saved.
   */
  it("tells PM2 the new Node's full path, and saves that, before touching PM2's service", () => {
    const body = source.slice(source.indexOf("move_server() {"));
    const told = body.indexOf('--interpreter "$NEW_NODE"');
    const saved = body.indexOf("pm2 save", told);
    const verified = body.indexOf("saved_interpreter", saved);
    const service = body.indexOf('restart "$PM2_UNIT"');
    assert.ok(told > 0, "the program is told the full path");
    assert.ok(told < saved && saved < verified && verified < service, "told, saved, checked, then the service");
  });

  it("will not restart a PM2 service that does not own the running PM2", () => {
    // Doing so would start a second bascula-central next to the first.
    const check = source.slice(source.indexOf("preflight() {"));
    assert.ok(check.includes('$state == active && -n $pm2 && $main == "$pm2"'));
  });

  it("proves the packages and a real backup on the new Node before any restart", () => {
    const prepare = source.slice(source.indexOf("  prepare)\n"), source.indexOf("  move)\n"));
    assert.ok(prepare.indexOf("install_node") < prepare.indexOf("prove_packages"));
    assert.ok(prepare.indexOf("prove_packages") < prepare.indexOf("real_backup"));
    assert.ok(!/pm2 restart|restart "\$PM2_UNIT"/.test(prepare), "--prepare restarts nothing");
    const move = source.slice(source.indexOf("  move)\n"), source.indexOf("  undo)\n"));
    assert.ok(move.indexOf("prove_packages") < move.indexOf("real_backup"), "--move proves the packages first");
    assert.ok(move.indexOf("real_backup") < move.indexOf("move_server"), "and backs up before the first restart");
  });

  it("goes back by itself if any step of the move fails", () => {
    const steps = source.slice(source.indexOf("move_server() {"), source.indexOf("# --- The run ---"));
    assert.ok((steps.match(/go_back "/g) ?? []).length >= 8);
    assert.ok(!/\bfail "/.test(steps), "a failure mid-move never just stops");
  });

  it("never prints what PM2 keeps about a program, because that holds the API key", () => {
    const commands = source.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    const jlist = commands.filter((line) => line.includes("pm2 jlist"));
    assert.equal(jlist.length, 1);
    assert.ok(jlist[0].includes('| "$OLD_NODE" -e'), "goes through the filter");
    const fromFilter = source.slice(source.indexOf("pm2_apps() {"), source.indexOf("backup_node() {"));
    assert.ok(!/pm2_env\.env|p\.env|\.env\b/.test(fromFilter), "the filters name their fields");
    assert.ok(!commands.some((line) => /\bcat\b[^\n]*(dump\.pm2|\.env)/.test(line)));
  });

  it("is not reached by a deploy: only a person runs it, and it waits for deploys", () => {
    for (const other of ["autodeploy.sh", "update-from-build.sh", "setup-test-site.sh", "claude-ops.sh"]) {
      assert.ok(!readFileSync(join(repo, "deploy", other), "utf8").includes("bascula-node-move"), other);
    }
    assert.equal(helper('echo "$LOCK_FILE"').trim(), "/run/lock/droplet-deploy.lock");
    for (const mode of ["  prepare)\n", "  move)\n", "  undo)\n"]) {
      const start = source.indexOf(mode);
      assert.ok(source.indexOf("take_lock", start) > start, mode);
    }
  });
});
