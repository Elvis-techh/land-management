import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const repo = join(import.meta.dirname, "..", "..");
const script = join(repo, "deploy", "droplet-guardrails.sh");
const scratch = mkdtempSync(join(tmpdir(), "droplet-guardrails-"));

/** Runs one of the script's helpers, with the script sourced (which stops before the run). */
function helper(call: string): string {
  const result = spawnSync("bash", ["-c", `source "$1"; ${call}`, "guardrails-test", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/*
 * deploy/droplet-guardrails.sh is pasted into the droplet console as root, on
 * the machine the scale stations depend on. These pin down what it writes and
 * that it refuses to start on anything unexpected.
 */
describe("droplet guard rails (runbook step 13)", () => {
  it("refuses an option it does not know, before doing anything", () => {
    for (const option of ["--force", "undo", "-u"]) {
      const result = spawnSync("bash", [script, option], { encoding: "utf8" });
      assert.equal(result.status, 1, option);
      assert.match(result.stderr, /Unknown option/, option);
    }
  });

  it("does nothing without root", { skip: process.getuid?.() === 0 }, () => {
    for (const args of [[], ["--undo"]]) {
      const result = spawnSync("bash", [script, ...args], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Run it as root/);
    }
  });

  it("puts bascula-central behind every other program, without forbidding the kernel to end it", () => {
    const dropin = helper("pm2_dropin");
    assert.match(dropin, /^\[Service\]$/m);
    assert.match(dropin, /^OOMScoreAdjust=-500$/m);
  });

  it("caps the journal at 200 MB", () => {
    const dropin = helper("journal_dropin");
    assert.match(dropin, /^\[Journal\]$/m);
    assert.match(dropin, /^SystemMaxUse=200M$/m);
  });

  it("writes a drop-in once, leaves it alone the second time, and removes it on undo", () => {
    const file = join(scratch, "nested", "50-test.conf");
    assert.equal(helper(`pm2_dropin | write_if_changed "${file}"`).trim(), "written");
    assert.equal(readFileSync(file, "utf8"), helper("pm2_dropin"));
    assert.equal(helper(`pm2_dropin | write_if_changed "${file}"`).trim(), "unchanged");
    assert.equal(helper(`remove_if_present "${file}"`).trim(), "removed");
    assert.equal(helper(`remove_if_present "${file}"`).trim(), "not there");
  });

  it("finds a process and everything below it, parent first", async () => {
    const parent = spawn("bash", ["-c", "sleep 30 & sleep 30 & wait"], { stdio: "ignore" });
    try {
      // Give bash a moment to start both children.
      let tree: string[] = [];
      for (let attempt = 0; attempt < 50 && tree.length < 3; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        tree = helper(`process_tree ${parent.pid}`).trim().split("\n");
      }
      assert.equal(tree.length, 3);
      assert.equal(tree[0], String(parent.pid));
    } finally {
      spawnSync("pkill", ["-P", String(parent.pid)]);
      parent.kill();
    }
  });

  it("makes every deploy wait for any other deploy on the droplet", () => {
    const deploy = readFileSync(join(repo, "deploy", "update-from-build.sh"), "utf8");
    const lock = deploy.indexOf("flock -w 600 9");
    assert.ok(deploy.includes("exec 9>/run/lock/droplet-deploy.lock"));
    assert.ok(lock > 0 && lock < deploy.indexOf("git fetch"), "the lock is taken before the deploy starts");
  });
});
