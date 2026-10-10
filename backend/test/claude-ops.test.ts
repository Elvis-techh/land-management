import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const repo = join(import.meta.dirname, "..", "..");
const script = join(repo, "deploy", "claude-ops.sh");
const example = join(repo, "docs", "nginx.conf.example");
const scratch = mkdtempSync(join(tmpdir(), "claude-ops-"));

/** Runs one of the script's helpers, with the script sourced (which stops before any action). */
function helper(call: string, input = ""): string {
  const result = spawnSync("bash", ["-c", `source "$1"; ${call}`, "claude-ops-test", script], { input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** Runs the script the way the forced command does, with SSH_ORIGINAL_COMMAND as the request. */
function request(command: string) {
  return spawnSync("bash", [script], {
    env: { PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: command },
    encoding: "utf8",
  });
}

/*
 * deploy/claude-ops.sh is the only program Claude's SSH key may run on the
 * droplet, as root. These pin down the two things that make that safe: it
 * runs nothing the caller sends, and its one edit to nginx is exactly
 * runbook step 9d.
 */
describe("claude-ops forced command", () => {
  it("refuses anything that is not exactly one known action", () => {
    for (const command of ["status; id", "$(id)", "logs 999", "install-headers --force", "STATUS", " status", "bash"]) {
      const result = request(command);
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /Refused/, command);
    }
  });

  it("answers help to a bare login, and does nothing else without root", () => {
    assert.match(request("").stdout, /Actions: help status nginx logs install-headers undo-headers/);
    if (process.getuid?.() !== 0) {
      const result = request("status");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Runs as root/);
    }
  });

  it("adds the headers include to exactly the five static locations, as in the example", () => {
    const stripped = join(scratch, "stripped.conf");
    writeFileSync(stripped, helper(`without_header_includes "${example}"`));
    assert.equal(helper(`include_count "${stripped}"`).trim(), "0");

    assert.equal(helper(`with_header_includes "${stripped}"`), readFileSync(example, "utf8"));
  });

  it("leaves a site that already has the include unchanged, so running it twice is safe", () => {
    assert.equal(helper(`with_header_includes "${example}"`), readFileSync(example, "utf8"));
    assert.equal(helper(`include_count "${example}"`).trim(), "5");
  });

  it("masks secrets in what it prints, but keeps file paths readable", () => {
    const masked = helper(
      "redact",
      [
        "COOKIE_SECRET=abc123",
        "Authorization: Bearer xyz789",
        '{"password":"hunter2","user":"ana"}',
        "X-API-Key: k3y",
        "ssl_certificate_key /etc/letsencrypt/live/lindero/privkey.pem;",
      ].join("\n"),
    );

    for (const secret of ["abc123", "xyz789", "hunter2", "k3y"]) {
      assert.doesNotMatch(masked, new RegExp(secret));
    }
    assert.match(masked, /"user":"ana"/);
    assert.match(masked, /ssl_certificate_key \/etc\/letsencrypt\/live\/lindero\/privkey\.pem;/);
  });
});
