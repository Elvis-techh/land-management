import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const repo = join(import.meta.dirname, "..", "..");

/** A file in the repository, as text. */
const source = (path: string) => readFileSync(join(repo, path), "utf8");

/*
 * The deploy scripts run as root on the machine the scale stations depend on.
 * These run the REAL scripts against a throwaway copy of the droplet: a local
 * "GitHub", both sites' folders, and stand-ins for the commands that would need
 * root (sudo, systemctl, chown, install) and the two that need a real server
 * (curl, node). Every command is written to a log, so a test can say exactly what
 * a deploy did to each site, and what it never touched.
 */
function droplet() {
  const root = mkdtempSync(join(tmpdir(), "test-site-deploy-"));
  const log = join(root, "commands.log");
  const env = {
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    HOME: root,
    ROOT: root,
    LOG: log,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };

  const write = (path: string, text: string, mode = 0o644) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    chmodSync(file, mode);
  };
  const stub = (name: string, body: string) => write(name, `#!/usr/bin/env bash\n${body}\n`, 0o755);

  stub("bin/sudo", `echo "as $2: \${*:4}" >> "$LOG"; shift 3; exec "$@"`);
  stub("bin/chown", `echo "chown $*" >> "$LOG"`);
  stub("bin/journalctl", "exit 0");
  stub("bin/sleep", "exit 0");
  stub("bin/install", `
    echo "install $*" >> "$LOG"
    args=()
    while [[ $# -gt 0 ]]; do
      case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
    done
    exec /usr/bin/install "\${args[@]}"`);
  stub("bin/systemctl", `
    echo "systemctl $*" >> "$LOG"
    if [[ "$1" == restart ]]; then echo x >> "$ROOT/restarts"; fi`);
  // Answers, except on the first start if the test asked for a build that does not come up.
  stub("bin/curl", `
    echo "curl \${*: -1}" >> "$LOG"
    if [[ -e "$ROOT/first-start-fails" && "$(wc -l < "$ROOT/restarts")" == 1 ]]; then exit 22; fi
    echo '{"status":"ok"}'`);
  stub("opt/node22/bin/node", `
    if [[ "$1" == -v ]]; then echo v22.0.0; exit 0; fi
    if [[ "$1" == -e ]]; then exit 0; fi
    echo "node $* (in $PWD)" >> "$LOG"`);
  stub("opt/node22/bin/npm", `echo "npm $*" >> "$LOG"; mkdir -p node_modules`);

  // The real scripts, pointed at this folder instead of the droplet's.
  const contained = (text: string) =>
    text
      .replaceAll("/opt/", `${root}/opt/`)
      .replaceAll("/var/www/", `${root}/www/`)
      .replaceAll("/var/lib/", `${root}/var/`)
      .replaceAll("/etc/systemd/system", `${root}/etc`)
      .replaceAll("/run/lock/", `${root}/`)
      .replace("[[ $EUID -ne 0 ]]", "false");

  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };

  /** What GitHub holds on `main`: the source, with the real deploy scripts. */
  const source_ = join(root, "source");
  mkdirSync(source_);
  git(source_, "init", "-q", "-b", "main");
  writeFileSync(join(source_, "package-lock.json"), "live lockfile\n");
  mkdirSync(join(source_, "deploy"));
  for (const file of ["autodeploy.sh", "update-from-build.sh", "site-settings.sh", "lindero-api.service", "lindero-test-api.service"]) {
    writeFileSync(join(source_, "deploy", file), contained(source(`deploy/${file}`)));
  }
  git(source_, "add", "-A");
  git(source_, "commit", "-q", "-m", "main");

  const github = join(root, "github.git");
  git(root, "clone", "-q", "--bare", source_, github);

  /** Publishes a build the way the workflows do: one new commit, replacing the branch. */
  const publish = (branch: string, name: string, readme = "") => {
    const build = mkdtempSync(join(root, "build-"));
    const put = (path: string, text: string) => {
      mkdirSync(dirname(join(build, path)), { recursive: true });
      writeFileSync(join(build, path), text);
    };
    put("README.md", `Source commit: ${name}\n${readme}`);
    put("frontend/dist/index.html", `${name}\n`);
    put("backend/dist/server.js", `${name}\n`);
    if (branch === "deploy-build-test") {
      put("package.json", `${name} package\n`);
      put("package-lock.json", `${name} lockfile\n`);
      put("backend/package.json", `${name} backend package\n`);
      put("frontend/package.json", `${name} frontend package\n`);
    }
    git(build, "init", "-q", "-b", branch);
    git(build, "add", "-A");
    git(build, "commit", "-q", "-m", name);
    git(build, "push", "-q", "--force", github, branch);
  };

  // The live site: a checkout of main, already running a first build.
  const live = join(root, "opt", "lindero");
  git(root, "clone", "-q", github, live);
  write("opt/lindero/backend/.env", "PORT=3001  # NOT 3000\n");
  write("www/lindero/frontend/dist/index.html", "running live\n");
  write("opt/lindero/backend/dist/server.js", "running live\n");
  write("etc/lindero-api.service", readFileSync(join(live, "deploy", "lindero-api.service"), "utf8"));

  // The test site: no source, only a place to fetch builds into.
  const test = join(root, "opt", "lindero-test");
  mkdirSync(test, { recursive: true });
  git(test, "init", "-q");
  git(test, "remote", "add", "origin", github);
  write("opt/lindero-test/backend/.env", "PORT=3101\n");
  write("www/lindero-test/frontend/dist/index.html", "running test\n");
  write("opt/lindero-test/backend/dist/server.js", "running test\n");
  write("etc/lindero-test-api.service", readFileSync(join(live, "deploy", "lindero-test-api.service"), "utf8"));

  publish("deploy-build", "first live build");
  publish("deploy-build-test", "first test build");

  return {
    root,
    git,
    publish,
    autodeploy: (...args: string[]) =>
      spawnSync("bash", [join(live, "deploy", "autodeploy.sh"), ...args], { env, encoding: "utf8" }),
    deploy: (...args: string[]) =>
      spawnSync("bash", [join(live, "deploy", "update-from-build.sh"), ...args], { cwd: live, env, encoding: "utf8" }),
    log: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
    clearLog: () => writeFileSync(log, ""),
    read: (path: string) => readFileSync(join(root, path), "utf8"),
    exists: (path: string) => existsSync(join(root, path)),
    /** A new commit on GitHub's main, which a deploy may or may not pull. */
    moveMain: () => {
      writeFileSync(join(source_, "moved"), "moved");
      git(source_, "add", "-A");
      git(source_, "commit", "-q", "-m", "moved");
      git(source_, "push", "-q", github, "main");
    },
  };
}

describe("a live deploy", () => {
  it("installs the live build and touches nothing of the test site", () => {
    const site = droplet();
    site.publish("deploy-build", "new live build");
    const result = site.autodeploy();
    assert.equal(result.status, 0, result.stderr);

    assert.equal(site.read("www/lindero/frontend/dist/index.html"), "new live build\n");
    assert.equal(site.read("opt/lindero/backend/dist/server.js"), "new live build\n");
    assert.match(site.log(), /^systemctl restart lindero-api$/m);
    assert.match(site.log(), /curl http:\/\/127\.0\.0\.1:3001\/api\/health/);

    assert.doesNotMatch(site.log(), /lindero-test/);
    assert.equal(site.read("www/lindero-test/frontend/dist/index.html"), "running test\n");
    assert.equal(site.read("opt/lindero-test/backend/dist/server.js"), "running test\n");
  });

  it("still pulls main, so the scripts stay current", () => {
    const site = droplet();
    site.moveMain();
    site.publish("deploy-build", "new live build");
    assert.equal(site.autodeploy().status, 0);
    assert.ok(site.exists("opt/lindero/moved"));
  });

  it("is what a plain update-from-build.sh does, with no site named", () => {
    const site = droplet();
    site.publish("deploy-build", "new live build");
    assert.equal(site.deploy().status, 0);
    assert.equal(site.read("www/lindero/frontend/dist/index.html"), "new live build\n");
    assert.match(site.log(), /^systemctl restart lindero-api$/m);
  });

  it("never erases data, even if a build's README asks for it", () => {
    const site = droplet();
    site.publish("deploy-build", "new live build", "Reset test data: yes\n");
    assert.equal(site.autodeploy().status, 0);
    assert.doesNotMatch(site.log(), /dist\/db\//);
    assert.doesNotMatch(site.log(), /systemctl stop/);
  });
});

describe("a test-site deploy", () => {
  it("installs the test build and touches nothing of the live site", () => {
    const site = droplet();
    site.publish("deploy-build-test", "new test build");
    const before = site.git(join(site.root, "opt", "lindero"), "rev-parse", "HEAD");
    site.moveMain();
    const result = site.autodeploy("test");
    assert.equal(result.status, 0, result.stderr);

    assert.equal(site.read("www/lindero-test/frontend/dist/index.html"), "new test build\n");
    assert.equal(site.read("opt/lindero-test/backend/dist/server.js"), "new test build\n");
    assert.match(site.log(), /^systemctl restart lindero-test-api$/m);
    assert.match(site.log(), /curl http:\/\/127\.0\.0\.1:3101\/api\/health/);

    assert.doesNotMatch(site.log(), /systemctl \S+ lindero-api/);
    assert.doesNotMatch(site.log(), /^as lindero:/m);
    assert.doesNotMatch(site.log(), /127\.0\.0\.1:3001/);
    assert.equal(site.read("www/lindero/frontend/dist/index.html"), "running live\n");
    assert.equal(site.read("opt/lindero/backend/dist/server.js"), "running live\n");
    // It does not move the live checkout either.
    assert.equal(site.git(join(site.root, "opt", "lindero"), "rev-parse", "HEAD"), before);
  });

  it("runs everything as its own user", () => {
    const site = droplet();
    site.publish("deploy-build-test", "new test build");
    assert.equal(site.autodeploy("test").status, 0);
    const users = new Set([...site.log().matchAll(/^as (\S+):/gm)].map((match) => match[1]));
    assert.deepEqual([...users], ["lindero-test"]);
  });

  it("installs the packages of the branch it was sent, not the live site's", () => {
    const site = droplet();
    site.publish("deploy-build-test", "new test build");
    assert.equal(site.autodeploy("test").status, 0);
    assert.equal(site.read("opt/lindero-test/package-lock.json"), "new test build lockfile\n");
    assert.equal(site.read("opt/lindero-test/backend/package.json"), "new test build backend package\n");
    assert.match(site.log(), /npm ci --omit=dev/);
    assert.equal(site.read("opt/lindero/package-lock.json"), "live lockfile\n");
  });

  it("checks its own port even if its .env does not name one", () => {
    const site = droplet();
    writeFileSync(join(site.root, "opt/lindero-test/backend/.env"), "NODE_ENV=production\n");
    site.publish("deploy-build-test", "new test build");
    assert.equal(site.autodeploy("test").status, 0);
    assert.match(site.log(), /127\.0\.0\.1:3101/);
    assert.doesNotMatch(site.log(), /127\.0\.0\.1:3001/, "the live site answering must not pass for the test site being up");
  });

  it("deploys each build once, and keeps its record apart from the live site's", () => {
    const site = droplet();
    site.publish("deploy-build-test", "new test build");
    assert.equal(site.autodeploy("test").status, 0);
    site.clearLog();

    assert.equal(site.autodeploy("test").status, 0);
    assert.doesNotMatch(site.log(), /systemctl/);
    assert.ok(site.exists("var/lindero-autodeploy/last-build-test"));
    assert.ok(!site.exists("var/lindero-autodeploy/last-build"));
  });

  it("puts the previous version back if the new one does not come up", () => {
    const site = droplet();
    writeFileSync(join(site.root, "first-start-fails"), "");
    site.publish("deploy-build-test", "broken test build");
    const result = site.autodeploy("test");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Rolled back/);
    assert.equal(site.read("www/lindero-test/frontend/dist/index.html"), "running test\n");
    assert.equal(site.read("opt/lindero-test/backend/dist/server.js"), "running test\n");
    assert.doesNotMatch(site.log(), /systemctl \S+ lindero-api/);
  });

  it("refuses a site it does not know, before doing anything", () => {
    const site = droplet();
    for (const result of [site.deploy("staging"), site.deploy("Live")]) {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Unknown site/);
    }
    assert.equal(site.log(), "");
  });
});

describe("putting fresh demo data back", () => {
  const steps = (log: string) => [...log.matchAll(/node --env-file=\.env dist\/db\/(\w+)\.js \(in (.*)\)/g)];

  it("runs when the build asks, as the test site's user, in its own folder, with the service stopped", () => {
    const site = droplet();
    site.publish("deploy-build-test", "new test build", "Reset test data: yes\n");
    const result = site.autodeploy("test");
    assert.equal(result.status, 0, result.stderr);

    const log = site.log();
    assert.deepEqual(steps(log).map((match) => match[1]), ["reset", "migrate", "seed"]);
    for (const match of steps(log)) {
      assert.equal(match[2], join(site.root, "opt/lindero-test/backend"));
    }
    assert.ok(log.indexOf("systemctl stop lindero-test-api") < log.indexOf("dist/db/reset.js"));
    assert.ok(log.indexOf("dist/db/seed.js") < log.indexOf("systemctl restart lindero-test-api"));
    // After the new build is in place, so the data matches the code being tried.
    assert.ok(log.indexOf("install") < log.indexOf("dist/db/reset.js"));
  });

  it("does not run unless the build asks", () => {
    const site = droplet();
    site.publish("deploy-build-test", "new test build");
    assert.equal(site.autodeploy("test").status, 0);
    assert.deepEqual(steps(site.log()), []);
    assert.doesNotMatch(site.log(), /systemctl stop/);
  });

  it("is not set off by a branch whose name merely mentions it", () => {
    const site = droplet();
    site.publish("deploy-build-test", "new test build", "Source branch: Reset test data: yes\n");
    assert.equal(site.autodeploy("test").status, 0);
    assert.deepEqual(steps(site.log()), []);
  });
});

describe("the test site's service", () => {
  const unit = source("deploy/lindero-test-api.service");

  it("gives way first, within the caps the plan sets", () => {
    assert.match(unit, /^MemoryMax=150M$/m);
    assert.match(unit, /^MemorySwapMax=0$/m);
    assert.match(unit, /^CPUQuota=50%$/m);
    const score = Number(/^OOMScoreAdjust=(\d+)$/m.exec(unit)?.[1]);
    assert.ok(score > 0, "shut down before anything with the default score");
  });

  it("keeps its heap inside its memory cap", () => {
    assert.match(unit, /--max-old-space-size=96/);
  });

  it("cannot read or write the real site", () => {
    assert.match(unit, /^User=lindero-test$/m);
    assert.match(unit, /^InaccessiblePaths=\/opt\/lindero$/m);
    assert.match(unit, /^ReadWritePaths=\/opt\/lindero-test\/backend\/data$/m);
    assert.match(unit, /^ProtectSystem=strict$/m);
  });

  it("will not start without its own .env, which is what says it is the test site", () => {
    assert.match(unit, /^EnvironmentFile=\/opt\/lindero-test\/backend\/\.env$/m);
  });

  it("deploys from the live checkout's scripts, never from a branch's", () => {
    assert.match(source("deploy/lindero-test-autodeploy.service"), /^ExecStart=\/bin\/bash \/opt\/lindero\/deploy\/autodeploy\.sh test$/m);
    assert.match(source("deploy/site-settings.sh"), /^SCRIPTS=\/opt\/lindero\/deploy$/m);
  });
});

describe("the Deploy test workflow", () => {
  const workflow = source(".github/workflows/deploy-test.yml");
  const [, buildJob = "", publishJob = ""] = /\n {2}build:\n([\s\S]*)\n {2}publish:\n([\s\S]*)$/.exec(workflow) ?? [];

  it("only ever writes to the test site's branch", () => {
    const pushes = [...workflow.matchAll(/git push[^\n]*/g)].map((match) => match[0]);
    assert.equal(pushes.length, 1);
    assert.match(pushes[0]!, / deploy-build-test$/);
    const code = workflow.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    assert.doesNotMatch(code, /deploy-build(?!-test)/);
  });

  it("runs the branch's code with no way to write to the repository", () => {
    assert.match(workflow, /^permissions: \{\}$/m);
    assert.match(buildJob, /permissions:\n\s+contents: read/);
    assert.match(buildJob, /persist-credentials: false/);
    assert.doesNotMatch(buildJob, /github\.token|contents: write/);
  });

  it("runs nothing from the branch where it can write", () => {
    assert.match(publishJob, /contents: write/);
    assert.doesNotMatch(publishJob, /actions\/checkout|npm /);
  });

  it("builds as the test site, without the live site's Google settings", () => {
    assert.match(buildJob, /VITE_SITE: test/);
    assert.doesNotMatch(workflow, /VITE_GOOGLE/);
  });

  it("does not put what was typed straight into a script", () => {
    const script = workflow.replace(/env:\n(?:\s+\w+: .*\n)+/g, "");
    assert.doesNotMatch(script.replace(/ref: \$\{\{ inputs\.branch \}\}/, ""), /\$\{\{ inputs\./);
  });

  it("packs every file a test-site deploy expects to find", () => {
    for (const file of ["package.json", "package-lock.json", "frontend/package.json", "backend/package.json"]) {
      assert.ok(source("deploy/update-from-build.sh").includes(file), file);
    }
    assert.match(workflow, /cp package\.json package-lock\.json "\$OUT\/"/);
    assert.match(workflow, /cp frontend\/package\.json "\$OUT\/frontend\/"/);
    assert.match(workflow, /cp backend\/package\.json "\$OUT\/backend\/"/);
  });
});
