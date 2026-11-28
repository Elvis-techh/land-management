import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const repo = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(repo, path), "utf8");

/*
 * /etc/os-release as Ubuntu ships it, every kind of line included. A shorter
 * stand-in once hid a bug: the file sets NAME, and reading it into the setup
 * script replaced the machine's new name with "Ubuntu".
 */
const osRelease = (id: string, version: string, name: string) =>
  [
    `PRETTY_NAME="${name} ${version} LTS"`,
    `NAME="${name}"`,
    `VERSION_ID="${version}"`,
    `VERSION="${version} LTS (Noble Numbat)"`,
    "VERSION_CODENAME=noble",
    `ID=${id}`,
    "ID_LIKE=debian",
    'HOME_URL="https://www.ubuntu.com/"',
    "UBUNTU_CODENAME=noble",
    "LOGO=ubuntu-logo",
    "",
  ].join("\n");

/*
 * deploy/setup-new-droplet.sh and deploy/setup-claude-access.sh run as root on
 * droplet 2. These run the REAL scripts against a throwaway copy of a new
 * machine, with stand-ins that log every command; a marker file makes one
 * misbehave.
 */

/** A folder that plays the machine, with the scripts' system paths moved into it. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "second-droplet-"));
  const logFile = join(root, "commands.log");
  const env = { PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: root, ROOT: root, LOG: logFile };

  const write = (path: string, text: string, mode = 0o644) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    chmodSync(file, mode);
  };
  const stub = (name: string, body: string) =>
    write(`bin/${name}`, `#!/usr/bin/env bash\necho "${name} $*" >> "$LOG"\n${body}\n`, 0o755);

  /*
   * One system path left unmoved would let a test touch this computer, so the
   * script is refused here, before anything runs, if any is still there.
   */
  const contained = (script: string) => {
    const MOVED = "@SANDBOX@";
    const text = script
      .replace(/(?<![\w}.-])\/(etc|root|opt|var|swapfile|usr\/local)(?![\w-])/g, `${MOVED}/$1`)
      .replace("[[ $EUID -eq 0 ]]", "true");
    const code = text.split("\n").filter((line) => !line.trim().startsWith("#"));
    for (const line of code) {
      assert.doesNotMatch(line, /(?<![\w}.@-])\/(etc|root|opt|var|swapfile|usr\/(?!bin\/env)|run|home|boot|dev(?!\/null))/, `not moved: ${line}`);
    }
    assert.doesNotMatch(text, /\[\[ \$EUID/);
    return text.replaceAll(MOVED, root);
  };

  return {
    root,
    env,
    write,
    stub,
    contained,
    log: () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : ""),
    clearLog: () => writeFileSync(logFile, ""),
    mark: (name: string, text = "") => write(name, text),
    read: (path: string) => readFileSync(join(root, path), "utf8"),
    exists: (path: string) => existsSync(join(root, path)),
    mode: (path: string) => (statSync(join(root, path)).mode & 0o777).toString(8),
  };
}

function newMachine() {
  const machine = sandbox();
  const { root, write, stub, contained } = machine;

  // A real Node archive in the shape nodejs.org ships, with a stand-in inside.
  const version = "node-v22.99.0-linux-x64";
  write(`download/${version}/bin/node`, '#!/bin/sh\nif [ "$1" = -v ]; then echo v22.99.0; fi\n', 0o755);
  const packed = spawnSync("tar", ["-cJf", `${version}.tar.xz`, version], { cwd: join(root, "download"), encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const checksum = createHash("sha256").update(readFileSync(join(root, `download/${version}.tar.xz`))).digest("hex");
  write("download/SHASUMS256.txt", `${"0".repeat(64)}  node-v22.99.0-linux-arm64.tar.xz\n${checksum}  ${version}.tar.xz\n`);

  for (const quiet of ["cloud-init", "apt-get", "sysctl", "mkswap"]) {
    stub(quiet, `[[ ! -e "$ROOT/${quiet}-fails" ]]`);
  }
  stub("hostnamectl", `[[ -e "$ROOT/name-does-not-stick" ]] || echo "$2" > "$ROOT/hostname"`);
  stub("hostname", `cat "$ROOT/hostname" 2>/dev/null || echo ubuntu`);
  stub("uname", `cat "$ROOT/arch" 2>/dev/null || echo x86_64`);
  stub("fallocate", `echo swap > "\${@: -1}"`);
  stub("swapon", `
    if [[ "$1" == --show ]]; then cat "$ROOT/swap-on" 2>/dev/null || true
    else echo "$1" > "$ROOT/swap-on"; fi`);
  stub("ufw", `
    case "$1" in
      status) if [[ -e "$ROOT/firewall-stays-off" ]]; then echo "Status: inactive"; else echo "Status: active"; fi ;;
    esac`);
  stub("systemctl", "exit 0");
  stub("nginx", `[[ ! -e "$ROOT/nginx-refuses" ]]`);
  stub("curl", `
    out="\${*: -1}"
    url="\${*: -3:1}"
    cp "$ROOT/download/\${url##*/}" "$out"
    if [[ -e "$ROOT/download-damaged" && "$url" == *.tar.xz ]]; then echo damage >> "$out"; fi`);
  stub("sshd", `cat "$ROOT/sshd" 2>/dev/null || echo "passwordauthentication no"`);
  stub("free", "echo 'Mem: 961 200'");
  stub("df", "echo '/dev/vda1 25G 3G 22G 12% /'");
  stub("reboot", "exit 0");
  stub("shutdown", "exit 0");

  write("etc/os-release", osRelease("ubuntu", "24.04", "Ubuntu"));
  write("etc/hosts", "127.0.0.1 localhost\n");
  write("etc/fstab", "LABEL=cloudimg-rootfs / ext4 defaults 0 1\n");
  mkdirSync(join(root, "etc/sysctl.d"), { recursive: true });
  mkdirSync(join(root, "opt"), { recursive: true });

  write("setup-new-droplet.sh", contained(source("deploy/setup-new-droplet.sh")));
  return {
    ...machine,
    run: (...args: string[]) =>
      spawnSync("bash", [join(root, "setup-new-droplet.sh"), ...args], { env: machine.env, encoding: "utf8" }),
  };
}

/** Only look-only commands ran. */
function assertUntouched(machine: ReturnType<typeof newMachine>) {
  assert.doesNotMatch(machine.log(), /^(hostnamectl|apt-get|fallocate|mkswap|swapon \/|sysctl|systemctl|ufw|curl) /m);
  assert.equal(machine.read("etc/hosts"), "127.0.0.1 localhost\n");
  assert.ok(!machine.exists("swapfile"));
  assert.ok(!machine.exists("opt/node22"));
}

describe("setup-new-droplet.sh before it changes anything", () => {
  it("needs a plain name for the machine", () => {
    for (const args of [[], [""], ["Apps-02"], ["apps 02"], ["-apps"], ["apps;id"]]) {
      const machine = newMachine();
      const result = machine.run(...args);
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.match(result.stderr, /Give the machine's name/);
      assertUntouched(machine);
    }
  });

  for (const sign of ["root/weight_software", "root/.pm2", "opt/zoilabe-test"]) {
    it(`refuses droplet 1, known by ${sign}`, () => {
      const machine = newMachine();
      mkdirSync(join(machine.root, sign), { recursive: true });
      const result = machine.run("apps-02");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /This is droplet 1/);
      assert.match(result.stderr, /Nothing was changed/);
      assertUntouched(machine);
    });
  }

  for (const [why, file, text, message] of [
    ["another Ubuntu", "etc/os-release", osRelease("ubuntu", "26.04", "Ubuntu"), /needs Ubuntu 24\.04; this is Ubuntu 26\.04 LTS/],
    ["another system", "etc/os-release", osRelease("debian", "24.04", "Debian"), /needs Ubuntu 24\.04; this is Debian/],
    ["another processor", "arch", "aarch64\n", /64-bit Intel or AMD/],
  ] as const) {
    it(`refuses ${why}`, () => {
      const machine = newMachine();
      machine.write(file, text);
      const result = machine.run("apps-02");
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assertUntouched(machine);
    });
  }
});

describe("setup-new-droplet.sh on a new machine", () => {
  it("sets everything up and says it is ready", () => {
    const machine = newMachine();
    const result = machine.run("apps-02");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.doesNotMatch(result.stdout, /PROBLEM {2}/);
    assert.match(result.stdout, /LISTO\. No restart needed/);

    assert.match(machine.log(), /^hostnamectl set-hostname apps-02$/m);
    assert.match(machine.read("etc/hosts"), /^127\.0\.1\.1 apps-02$/m);
    assert.match(machine.read("etc/fstab"), /swapfile none swap sw 0 0$/m);
    assert.equal(machine.mode("swapfile"), "600");
    assert.match(machine.read("etc/systemd/journald.conf.d/50-lindero-guardrails.conf"), /^SystemMaxUse=200M$/m);
    assert.match(machine.read("etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh"), /^systemctl reload nginx$/m);
    assert.equal(machine.mode("etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh"), "755");
    // The apps run as their own users, so they must be able to run Node.
    assert.equal(machine.mode("opt/node22"), "755");
    assert.ok(machine.exists("opt/node22/bin/node"));
    for (const name of ["nginx", "certbot", "rclone", "git", "rsync", "ufw", "build-essential"]) {
      assert.match(machine.log(), new RegExp(`^apt-get .* install -y .*\\b${name}\\b`, "m"), name);
    }
  });

  it("gives the machine the name it was asked to, not the system's own", () => {
    const machine = newMachine();
    const result = machine.run("apps-02");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual([...machine.log().matchAll(/^hostnamectl set-hostname (.*)$/gm)].map((match) => match[1]), ["apps-02"]);
    assert.equal(machine.read("hostname").trim(), "apps-02");
    assert.doesNotMatch(machine.read("etc/hosts"), /Ubuntu/);
    assert.match(result.stdout, /ok {7}name is apps-02/);
  });

  it("does not say it is ready if the name did not take", () => {
    const machine = newMachine();
    machine.mark("name-does-not-stick");
    const result = machine.run("apps-02");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /PROBLEM {2}name is apps-02/);
    assert.doesNotMatch(result.stdout, /LISTO/);
  });

  it("adds no second line for a name the droplet already lists", () => {
    // The line a new droplet writes itself, with the name twice.
    const machine = newMachine();
    machine.write("etc/hosts", "127.0.1.1 apps-02 apps-02\n127.0.0.1 localhost\n");
    assert.equal(machine.run("apps-02").status, 0);
    assert.equal(machine.read("etc/hosts"), "127.0.1.1 apps-02 apps-02\n127.0.0.1 localhost\n");
  });

  it("opens SSH before it turns the firewall on, and opens nothing but the web besides", () => {
    const machine = newMachine();
    assert.equal(machine.run("apps-02").status, 0);
    const log = machine.log();
    assert.deepEqual([...log.matchAll(/^ufw allow (\S+)$/gm)].map((match) => match[1]), ["22/tcp", "80/tcp", "443/tcp"]);
    assert.ok(log.indexOf("ufw allow 22/tcp") < log.indexOf("ufw --force enable"));
  });

  it("never restarts the machine and never touches SSH's settings", () => {
    const machine = newMachine();
    machine.mark("var/run/reboot-required");
    const result = machine.run("apps-02");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /need a restart: type 'reboot'/);
    assert.doesNotMatch(machine.log(), /^(reboot|shutdown)/m);
    assert.doesNotMatch(machine.log(), /^systemctl .*(reboot|\bssh)/m);
    assert.ok(!machine.exists("etc/ssh"));
  });

  it("can run twice: nothing is added or downloaded a second time", () => {
    const machine = newMachine();
    assert.equal(machine.run("apps-02").status, 0);
    machine.clearLog();

    const result = machine.run("apps-02");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(machine.read("etc/hosts").match(/apps-02/g)!.length, 1);
    assert.equal(machine.read("etc/fstab").match(/swapfile/g)!.length, 1);
    assert.doesNotMatch(machine.log(), /^(curl|fallocate|mkswap) /m);
  });

  it("makes the swap properly after a run that was cut short while making it", () => {
    const machine = newMachine();
    machine.mark("mkswap-fails");
    assert.notEqual(machine.run("apps-02").status, 0);
    // A half-made file under the real name would be taken for a finished one.
    assert.ok(!machine.exists("swapfile"));

    spawnSync("rm", [join(machine.root, "mkswap-fails")]);
    machine.clearLog();
    const again = machine.run("apps-02");
    assert.equal(again.status, 0, again.stderr);
    assert.match(machine.log(), /^mkswap /m);
    assert.ok(machine.exists("swapfile"));
  });

  it("installs nothing from a Node download that does not match its checksum", () => {
    const machine = newMachine();
    machine.mark("download-damaged");
    const result = machine.run("apps-02");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match its checksum/);
    assert.ok(!machine.exists("opt/node22"));
  });

  it("will not write over something else that is in Node's place", () => {
    const machine = newMachine();
    machine.write("opt/node22/bin/node", '#!/bin/sh\necho v18.0.0\n', 0o755);
    const result = machine.run("apps-02");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exists but is not Node 22/);
    assert.match(machine.read("opt/node22/bin/node"), /v18/);
  });

  it("does not say it is ready if the firewall stayed off", () => {
    const machine = newMachine();
    machine.mark("firewall-stays-off");
    const result = machine.run("apps-02");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /PROBLEM {2}firewall on/);
    assert.doesNotMatch(result.stdout, /LISTO/);
  });

  it("says so if SSH still accepts passwords, without changing it", () => {
    const machine = newMachine();
    machine.mark("sshd", "passwordauthentication yes\n");
    const result = machine.run("apps-02");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SSH still accepts passwords/);
  });
});

// --- Claude's key -------------------------------------------------------------

const PINNED_LINE = (root: string) => `restrict,command="${root}/usr/local/sbin/lindero-claude-ops" `;

/** A real public key, made for the test. */
function publicKey(folder: string, name: string, type = "ed25519") {
  const file = join(folder, name);
  const made = spawnSync("ssh-keygen", ["-q", "-t", type, "-N", "", "-C", name, "-f", file], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  return { file: `${file}.pub`, line: readFileSync(`${file}.pub`, "utf8").trim(), private: file };
}

function keyedMachine() {
  const machine = sandbox();
  const { root, write, stub, contained } = machine;
  // Without root, the stand-in drops the owner and group.
  stub("install", `
    args=()
    while [[ $# -gt 0 ]]; do
      case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
    done
    exec /usr/bin/install "\${args[@]}"`);
  mkdirSync(join(root, "usr/local/sbin"), { recursive: true });
  write("upload/setup-claude-access.sh", contained(source("deploy/setup-claude-access.sh")));
  write("upload/claude-ops.sh", source("deploy/claude-ops.sh"));

  const owner = publicKey(root, "owner");
  const claude = publicKey(root, "claude-ops-2");
  write("root/.ssh/authorized_keys", `${owner.line}\n`, 0o600);
  return {
    ...machine,
    owner,
    claude,
    keys: () => machine.read("root/.ssh/authorized_keys"),
    run: (...args: string[]) =>
      spawnSync("bash", [join(root, "upload/setup-claude-access.sh"), ...args], { env: machine.env, encoding: "utf8" }),
  };
}

describe("setup-claude-access.sh", () => {
  it("adds the key locked to the pinned program, and leaves the owner's key alone", () => {
    const machine = keyedMachine();
    const result = machine.run(machine.claude.file);
    assert.equal(result.status, 0, result.stderr);

    assert.equal(machine.keys(), `${machine.owner.line}\n${PINNED_LINE(machine.root)}${machine.claude.line}\n`);
    assert.equal(machine.mode("root/.ssh/authorized_keys"), "600");
    assert.equal(machine.mode("usr/local/sbin/lindero-claude-ops"), "755");
    assert.equal(machine.read("usr/local/sbin/lindero-claude-ops"), source("deploy/claude-ops.sh"));
  });

  it("can run twice, and a new key takes the old one's place", () => {
    const machine = keyedMachine();
    assert.equal(machine.run(machine.claude.file).status, 0);
    const once = machine.keys();
    assert.equal(machine.run(machine.claude.file).status, 0);
    assert.equal(machine.keys(), once);

    const newer = publicKey(machine.root, "claude-newer");
    assert.equal(machine.run(newer.file).status, 0);
    assert.equal(machine.keys(), `${machine.owner.line}\n${PINNED_LINE(machine.root)}${newer.line}\n`);
  });

  it("works on a machine that has no key file yet", () => {
    const machine = keyedMachine();
    spawnSync("rm", ["-r", join(machine.root, "root/.ssh")]);
    const result = machine.run(machine.claude.file);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(machine.keys(), `${PINNED_LINE(machine.root)}${machine.claude.line}\n`);
  });

  /** Nothing was installed and the key file is as it was. */
  const refuses = (machine: ReturnType<typeof keyedMachine>, file: string, message: RegExp) => {
    const before = machine.keys();
    const result = machine.run(file);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, message);
    assert.match(result.stderr, /Nothing was changed/);
    assert.equal(machine.keys(), before);
    assert.ok(!machine.exists("usr/local/sbin/lindero-claude-ops"));
  };

  it("refuses the owner's own key, which locking would shut them out with", () => {
    const machine = keyedMachine();
    refuses(machine, machine.owner.file, /may be your own key/);
  });

  it("refuses a key that is already there without the lock", () => {
    const machine = keyedMachine();
    machine.write("root/.ssh/authorized_keys", `${machine.owner.line}\n${machine.claude.line}\n`, 0o600);
    refuses(machine, machine.claude.file, /without the lock/);
  });

  it("refuses anything but one ssh-ed25519 public key", () => {
    const machine = keyedMachine();
    const rsa = publicKey(machine.root, "rsa-key", "rsa");
    const files: [string, string][] = [
      ["two lines", `${machine.claude.line}\n${machine.owner.line}\n`],
      ["options in front", `command="/bin/sh" ${machine.claude.line}\n`],
      ["not a key", "ssh-ed25519 AAAAnotakey someone\n"],
      ["empty", ""],
    ];
    for (const [name, text] of files) {
      machine.write(`bad/${name}`, text);
      refuses(machine, join(machine.root, "bad", name), /public key/);
    }
    refuses(machine, rsa.file, /ssh-ed25519 public key/);
    refuses(machine, machine.claude.private, /ssh-ed25519 public key/);
    refuses(machine, join(machine.root, "nowhere.pub"), /is not there/);
  });

  it("refuses droplet 1", () => {
    const machine = keyedMachine();
    mkdirSync(join(machine.root, "root/weight_software"));
    refuses(machine, machine.claude.file, /This is droplet 1/);
  });

  it("refuses without the program the key is to be locked to", () => {
    const machine = keyedMachine();
    spawnSync("rm", [join(machine.root, "upload/claude-ops.sh")]);
    refuses(machine, machine.claude.file, /copy claude-ops\.sh/);
  });
});
