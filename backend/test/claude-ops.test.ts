import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    // This computer has no weight software, so only the actions that read.
    assert.match(request("").stdout, /^Actions: help status nginx logs$/m);
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

  it("runs the renewal check without certbot's random wait, which outlasts the time limit", () => {
    // With no terminal on stdin, certbot first sleeps 1–480 s, silently; the
    // first install-headers on the droplet was killed by `timeout 300` in it.
    const renewal = readFileSync(script, "utf8").match(/^.*certbot renew .*$/m)?.[0] ?? "";
    assert.match(renewal, /--dry-run/);
    assert.match(renewal, /--no-random-sleep-on-renew/);
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

/*
 * The same program runs on both droplets. These run the REAL script against a
 * throwaway copy of each, with stand-ins that log every command, so what the
 * key can change on each one is pinned down.
 */
function droplet({ weightSoftware }: { weightSoftware: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "claude-ops-droplet-"));
  const logFile = join(root, "commands.log");
  const write = (path: string, text: string, mode = 0o644) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    chmodSync(file, mode);
  };
  const stub = (name: string, body: string) =>
    write(name, `#!/usr/bin/env bash\necho "${name.split("/").pop()} $*" >> "$LOG"\n${body}\n`, 0o755);

  for (const quiet of ["logger", "renice", "ionice", "flock", "certbot"]) stub(`bin/${quiet}`, "exit 0");
  stub("bin/hostname", "echo apps-02");
  stub("bin/uptime", "echo up 1 day");
  stub("bin/free", "echo 'Mem: 961 465 74 3 593 496'");
  stub("bin/df", "echo '/dev/vda1 25G 3G 22G 12% /'");
  stub("bin/swapon", "echo '/swapfile   2G'");
  stub("bin/sshd", "echo 'passwordauthentication no'");
  stub("bin/ufw", "echo 'Status: active'");
  stub("bin/ss", "echo 'LISTEN 0 511 127.0.0.1:3001 0.0.0.0:*'");
  stub("bin/ps", "echo '51200 node'");
  stub("bin/nginx", "echo 'nginx: configuration file test is successful'");
  stub("bin/journalctl", "echo '-- No entries --'");
  stub("bin/sudo", "echo 'abc1234 a commit'");
  stub("bin/curl", "echo -n 200");
  stub("bin/systemctl", `
    case "$1" in
      cat) [[ -e "$ROOT/unit-$2" ]] ;;
      is-active) echo active ;;
      show) echo "ActiveState=active" ;;
    esac`);
  stub("opt/node22/bin/node", "echo v22.99.0");

  const text = readFileSync(script, "utf8")
    // The script sets its own PATH: the stand-ins go in front of it.
    .replace(/^export PATH=.*$/m, 'export PATH="$ROOT/bin:/usr/bin:/bin"')
    .replace(/\/(etc|root|opt|var|run)\//g, (_, folder) => `${root}/${folder}/`)
    .replace("[[ $EUID -eq 0 ]]", "true");
  write("claude-ops.sh", text, 0o755);
  mkdirSync(join(root, "etc/nginx/sites-available"), { recursive: true });
  mkdirSync(join(root, "etc/nginx/sites-enabled"), { recursive: true });
  mkdirSync(join(root, "run/lock"), { recursive: true });
  if (weightSoftware) mkdirSync(join(root, "root/weight_software"), { recursive: true });

  return {
    write,
    ask: (command: string) =>
      spawnSync("bash", [join(root, "claude-ops.sh")], {
        env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, ROOT: root, LOG: logFile, SSH_ORIGINAL_COMMAND: command },
        encoding: "utf8",
      }),
    log: () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : ""),
    exists: (path: string) => existsSync(join(root, path)),
    /** Puts a site on the droplet: its Nginx file and its service. */
    install: (name: "lindero" | "lindero-test", host: string) => {
      write(`etc/nginx/sites-available/${name}`, `server {\n    listen 80;\n    server_name ${host};\n}\n`);
      write(name === "lindero" ? "unit-lindero-api" : "unit-lindero-test-api", "");
    },
  };
}

/** Every command a look-only action ran is one that only looks. */
function assertOnlyLooked(log: string) {
  for (const line of log.split("\n")) {
    if (line.startsWith("systemctl ")) assert.match(line, /^systemctl (cat|show|is-active) /, line);
    if (line.startsWith("ufw ")) assert.equal(line, "ufw status");
    if (line.startsWith("sshd ")) assert.equal(line, "sshd -T");
    if (line.startsWith("nginx ")) assert.equal(line, "nginx -t");
    if (line.startsWith("swapon ")) assert.match(line, /^swapon --show/, line);
  }
  assert.doesNotMatch(log, /^certbot/m);
}

describe("claude-ops on the droplet without the weight software", () => {
  it("only reads: the actions that edit Nginx do not exist there", () => {
    const machine = droplet({ weightSoftware: false });
    machine.install("lindero", "app.example.com");
    assert.match(machine.ask("help").stdout, /^Actions: help status nginx logs$/m);
    for (const command of ["install-headers", "undo-headers"]) {
      const result = machine.ask(command);
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /Refused/, command);
    }
    assert.doesNotMatch(machine.log(), /^(certbot|systemctl|nginx|curl)/m);
  });

  it("answers every action before anything is installed on it", () => {
    const machine = droplet({ weightSoftware: false });
    for (const command of ["status", "nginx", "logs"]) {
      const result = machine.ask(command);
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    }
    const status = machine.ask("status").stdout;
    assert.match(status, /==> Lindero\nnot set up\n/);
    assert.match(status, /==> Lindero test site\nnot set up\n/);
    assert.match(machine.ask("nginx").stdout, /sites-available\/lindero: not set up\n[^]*test is successful/);
    assert.doesNotMatch(status, /bascula/i);
    assert.doesNotMatch(machine.log(), /^curl/m);
    assertOnlyLooked(machine.log());
  });

  it("reports what the new droplet's setup left behind", () => {
    const status = droplet({ weightSoftware: false }).ask("status").stdout;
    assert.match(status, /^name: +apps-02$/m);
    assert.match(status, /^swap: +\/swapfile 2G/m);
    assert.match(status, /^nginx: +active/m);
    assert.match(status, /^certbot\.timer: +active/m);
    assert.match(status, /^Node: +v22\.99\.0/m);
    assert.match(status, /^SSH passwords: +no /m);
    assert.match(status, /^restart needed: +no$/m);
    assert.match(status, /^ {2}Status: active$/m);
  });

  it("checks each site at the address in that site's own Nginx file", () => {
    const machine = droplet({ weightSoftware: false });
    machine.install("lindero", "app.example.com");
    machine.install("lindero-test", "prueba.example.com");
    const result = machine.ask("status");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /health \(nginx\): +200 +expect 200 +\(app\.example\.com\)/);
    assert.match(result.stdout, /health \(nginx\): +200 +expect 200 +\(prueba\.example\.com\)/);
    assert.match(machine.log(), /^curl .*--resolve app\.example\.com:443:127\.0\.0\.1 https:\/\/app\.example\.com\/api\/health$/m);
    assert.doesNotMatch(machine.log(), /basculacentral/);
    assertOnlyLooked(machine.log());
  });
});

describe("claude-ops on the droplet with the weight software", () => {
  it("keeps all its actions, and still reports the weight software", () => {
    const machine = droplet({ weightSoftware: true });
    machine.install("lindero", "lindero.basculacentral.com");
    machine.install("lindero-test", "prueba-lindero.basculacentral.com");
    assert.match(machine.ask("help").stdout, /^Actions: help status nginx logs install-headers undo-headers$/m);

    const result = machine.ask("status");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /==> bascula-central\n/);
    assert.match(result.stdout, /\(lindero\.basculacentral\.com\)/);
    assert.match(result.stdout, /\(prueba-lindero\.basculacentral\.com\)/);
    assert.doesNotMatch(result.stdout, /==> Setup/);
    assert.match(machine.log(), /^curl .*https:\/\/api\.basculacentral\.com\/api\/health$/m);
    assertOnlyLooked(machine.log());
  });
});
