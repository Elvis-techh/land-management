import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const repo = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(repo, path), "utf8");
const HOST = "prueba-lindero.basculacentral.com";

/*
 * deploy/setup-test-site.sh runs as root on the machine the scale stations
 * depend on, and it edits the Nginx they come in through. These run the REAL
 * script against a throwaway copy of the droplet, with stand-ins for everything
 * that needs root or the real machine. Each stand-in writes to a log, and a
 * marker file makes it misbehave, so each failure can be walked through.
 */
function droplet() {
  const root = mkdtempSync(join(tmpdir(), "setup-test-site-"));
  const logFile = join(root, "commands.log");
  const env = {
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    HOME: root,
    ROOT: root,
    LOG: logFile,
  };

  const write = (path: string, text: string, mode = 0o644) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    chmodSync(file, mode);
  };
  const stub = (name: string, body: string) =>
    write(name, `#!/usr/bin/env bash\necho "${name.split("/").pop()} $*" >> "$LOG"\n${body}\n`, 0o755);

  stub("bin/chown", "exit 0");
  stub("bin/renice", "exit 0");
  stub("bin/ionice", "exit 0");
  stub("bin/journalctl", "exit 0");
  stub("bin/useradd", `touch "$ROOT/user-exists"`);
  stub("bin/userdel", `rm -f "$ROOT/user-exists"`);
  stub("bin/id", `[[ -e "$ROOT/user-exists" ]]`);
  // \`ps -o pid= --ppid N\`: a child of PM2 appears only if the test made one.
  stub("bin/ps", `[[ "$4" == 77777 ]] || cat "$ROOT/pm2-children" 2>/dev/null || true`);
  stub("bin/free", `echo "Mem: 961 465 74 3 593 $(cat "$ROOT/available-mb" 2>/dev/null || echo 496)"`);
  stub("bin/df", `printf 'Avail\\n18G\\n'`);
  stub("bin/ss", `cat "$ROOT/ports" 2>/dev/null || echo "LISTEN 0 511 127.0.0.1:3001 0.0.0.0:*"`);
  stub("bin/getent", `
    if [[ "$2" == ${HOST} ]]; then
      if [[ -e "$ROOT/address" ]]; then cat "$ROOT/address"; else echo "159.89.84.60 STREAM ${HOST}"; fi
    else
      echo "159.89.84.60 STREAM $2"
    fi`);
  stub("bin/install", `
    args=()
    while [[ $# -gt 0 ]]; do
      case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
    done
    exec /usr/bin/install "\${args[@]}"`);
  stub("bin/chmod", `
    if [[ "$1" == o-rx && ! -e "$ROOT/chmod-does-not-help" ]]; then rm -f "$ROOT/live-readable"; fi
    exec /usr/bin/chmod "$@"`);
  // Reads go through markers, because in the sandbox this user owns every file.
  stub("bin/sudo", `
    shift 3
    if [[ "$1" == test ]]; then
      case "$3" in
        */weight_software) [[ -e "$ROOT/bascula-readable" ]]; exit $? ;;
        *) [[ -e "$ROOT/live-readable" ]]; exit $? ;;
      esac
    fi
    exec "$@"`);
  stub("bin/nginx", `
    if [[ -e "$ROOT/nginx-refuses-everything" ]]; then echo "nginx: [emerg] refused"; exit 1; fi
    site="$ROOT/etc/nginx/sites-available/lindero-test"
    if [[ -e "$ROOT/nginx-refuses-whole-site" && -f "$site" ]] && grep -qE "^ +listen 443" "$site"; then
      echo "nginx: [emerg] refused"
      exit 1
    fi
    echo "nginx: the configuration file syntax is ok"`);
  stub("bin/systemctl", `
    case "$1" in
      show)
        if [[ "$2" == lindero-api ]]; then cat "$ROOT/lindero-pid" 2>/dev/null || echo 1234; else echo 52428800; fi ;;
      is-active) exit 1 ;;
      start)
        if [[ "$2" == lindero-test-autodeploy.service ]]; then
          touch "$ROOT/deploy-ran"
          [[ -e "$ROOT/pm2-restarts" ]] && echo 77777 > "$ROOT/pm2-children"
          [[ -e "$ROOT/lindero-restarts" ]] && echo 5678 > "$ROOT/lindero-pid"
          [[ ! -e "$ROOT/first-deploy-fails" ]]
          exit $?
        fi ;;
    esac`);
  stub("bin/certbot", `
    if [[ -e "$ROOT/certbot-fails" ]]; then echo "Challenge failed: connection refused"; exit 1; fi
    live="$ROOT/etc/letsencrypt/live/${HOST}"
    if [[ "$1" == certonly && "$*" != *--dry-run* ]]; then mkdir -p "$live"; touch "$live/fullchain.pem"; fi
    if [[ "$1" == delete ]]; then rm -rf "$live"; fi
    exit 0`);
  stub("bin/curl", `
    url="\${*: -1}"
    case "$url" in
      *://${HOST}/*)
        if [[ -e "$ROOT/test-site-down" || ! -e "$ROOT/deploy-ran" ]]; then echo -n 502; else echo -n 200; fi ;;
      *://lindero.*) if [[ -e "$ROOT/live-down" ]]; then echo -n 502; else echo -n 200; fi ;;
      *) echo -n 200 ;;
    esac`);
  stub("opt/node22/bin/node", `
    [[ -e "$ROOT/seed-fails" ]] && exit 1
    echo "Seeded $PWD/data/lindero.db"`);

  // The real scripts, pointed at this folder instead of the droplet's.
  const contained = (text: string) =>
    text
      .replaceAll("/opt/", `${root}/opt/`)
      .replaceAll("/var/www/", `${root}/www/`)
      .replaceAll("/var/lib/", `${root}/var/`)
      .replaceAll("/etc/systemd/system", `${root}/etc/systemd`)
      .replaceAll("/etc/nginx/", `${root}/etc/nginx/`)
      .replaceAll("/etc/letsencrypt/", `${root}/etc/letsencrypt/`)
      .replaceAll("/root/", `${root}/rootdir/`)
      .replace("[[ $EUID -eq 0 ]]", "true");

  for (const file of [
    "setup-test-site.sh",
    "site-settings.sh",
    "nginx-test-site.conf",
    "lindero-test-api.service",
    "lindero-test-autodeploy.service",
    "lindero-test-autodeploy.timer",
  ]) {
    write(`opt/lindero/deploy/${file}`, contained(source(`deploy/${file}`)));
  }
  mkdirSync(join(root, "etc/nginx/sites-available"), { recursive: true });
  mkdirSync(join(root, "etc/nginx/sites-enabled"), { recursive: true });
  mkdirSync(join(root, "etc/systemd"), { recursive: true });
  write("www/lindero/frontend/dist/index.html", "the live site\n");
  write("etc/nginx/sites-available/lindero", "the live site's nginx\n");
  // A process that really is running, for the script to find as bascula's PM2.
  write("rootdir/.pm2/pm2.pid", String(process.pid));

  const script = join(root, "opt/lindero/deploy/setup-test-site.sh");
  return {
    root,
    run: (...args: string[]) => spawnSync("bash", [script, ...args], { env, encoding: "utf8" }),
    log: () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : ""),
    clearLog: () => writeFileSync(logFile, ""),
    mark: (name: string, text = "") => writeFileSync(join(root, name), text),
    unmark: (name: string) => spawnSync("rm", ["-f", join(root, name)]),
    read: (path: string) => readFileSync(join(root, path), "utf8"),
    exists: (path: string) => existsSync(join(root, path)),
    isLink: (path: string) => {
      try {
        return lstatSync(join(root, path)).isSymbolicLink();
      } catch {
        return false;
      }
    },
    mode: (path: string) => (statSync(join(root, path)).mode & 0o777).toString(8),
    setMode: (path: string, mode: number) => {
      mkdirSync(join(root, path), { recursive: true });
      chmodSync(join(root, path), mode);
    },
  };
}

/** Nothing on the droplet has been changed: only look-only commands ran. */
function assertNothingChanged(site: ReturnType<typeof droplet>) {
  assert.doesNotMatch(site.log(), /^(useradd|certbot|install|chown|chmod) /m);
  assert.doesNotMatch(site.log(), /^systemctl (reload|restart|start|stop|enable|disable|daemon-reload)/m);
  assert.ok(!site.exists("opt/lindero-test"));
  assert.ok(!site.exists("etc/nginx/sites-available/lindero-test"));
}

describe("setup-test-site.sh before it changes anything", () => {
  it("refuses an option it does not know", () => {
    for (const option of ["--force", "undo", "-u"]) {
      const result = spawnSync("bash", [join(repo, "deploy/setup-test-site.sh"), option], { encoding: "utf8" });
      assert.equal(result.status, 1, option);
      assert.match(result.stderr, /Unknown option/, option);
    }
  });

  it("does nothing without root", { skip: process.getuid?.() === 0 }, () => {
    for (const args of [[], ["--undo"]]) {
      const result = spawnSync("bash", [join(repo, "deploy/setup-test-site.sh"), ...args], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Run it as root/);
    }
  });

  for (const [why, marker, text, message] of [
    ["the address does not point here", "address", "", /does not point at this droplet/],
    ["the address has the orange cloud", "address", `104.21.0.1 STREAM ${HOST}`, /grey cloud/],
    ["memory is short", "available-mb", "299", /Not enough memory/],
    ["its port is taken", "ports", "LISTEN 0 511 127.0.0.1:3101 0.0.0.0:*", /port 3101/],
    ["Nginx already refuses its configuration", "nginx-refuses-everything", "", /before this script touched it/],
    ["the live site is not answering", "live-down", "", /live site is not answering/],
  ] as const) {
    it(`stops when ${why}, having changed nothing`, () => {
      const site = droplet();
      site.mark(marker, text);
      const result = site.run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assert.match(result.stderr, /Nothing was changed/);
      assertNothingChanged(site);
    });
  }

  it("stops when bascula's PM2 cannot be found, because it could not prove it left it alone", () => {
    const site = droplet();
    site.mark("rootdir/.pm2/pm2.pid", "not a number");
    const result = site.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PM2 could not be found/);
    assertNothingChanged(site);
  });
});

describe("setup-test-site.sh when all goes well", () => {
  it("does things in the order that keeps Nginx valid at every moment", () => {
    const site = droplet();
    const result = site.run();
    assert.equal(result.status, 0, result.stderr);

    const log = site.log();
    const steps = [
      /^useradd /m,
      /^certbot certonly (?!.*--dry-run)/m,
      /^certbot renew --dry-run/m,
      /^install -m 644 .*lindero-test-api\.service/m,
      /^systemctl enable --now lindero-test-autodeploy\.timer/m,
      /^systemctl start lindero-test-autodeploy\.service/m,
    ];
    let position = -1;
    for (const step of steps) {
      const found = log.search(step);
      assert.ok(found > position, `${step} comes after what is before it`);
      position = found;
    }
    // Checked and reloaded for the plain-http part, then for the whole site.
    assert.equal([...log.matchAll(/^systemctl reload nginx$/gm)].length, 2);
    assert.ok(log.indexOf("nginx -t") < log.indexOf("systemctl reload nginx"));

    assert.match(result.stdout, /Done\. The test site is at https:\/\/prueba-lindero/);
    assert.match(result.stdout, /bascula-central was not restarted/);
    assert.match(result.stdout, /the live site was not restarted/);
  });

  it("never restarts Nginx or the live site, and never goes near bascula", () => {
    const site = droplet();
    assert.equal(site.run().status, 0);
    const log = site.log();
    assert.doesNotMatch(log, /^systemctl restart/m);
    assert.doesNotMatch(log, /^systemctl (stop|start|reload|enable|disable) lindero-api/m);
    assert.doesNotMatch(log, /pm2/);
    assert.equal(site.read("etc/nginx/sites-available/lindero"), "the live site's nginx\n");
    assert.equal(site.read("www/lindero/frontend/dist/index.html"), "the live site\n");
  });

  it("asks for a certificate that reloads Nginx when it renews", () => {
    const site = droplet();
    assert.equal(site.run().status, 0);
    assert.match(site.log(), /^certbot certonly (?!.*--dry-run).*--webroot.*--deploy-hook systemctl reload nginx/m);
  });

  it("does not rehearse the certificate seconds before rehearsing its renewal", () => {
    const site = droplet();
    assert.equal(site.run().status, 0);
    assert.doesNotMatch(site.log(), /^certbot certonly .*--dry-run/m);
    assert.match(site.log(), /^certbot renew --dry-run/m);
  });

  it("writes its own secrets, readable only by its own user, and never prints them", () => {
    const site = droplet();
    const result = site.run();
    assert.equal(result.status, 0, result.stderr);

    const file = "opt/lindero-test/backend/.env";
    assert.equal(site.mode(file), "600");
    const settings = Object.fromEntries(
      site.read(file).split("\n").filter((line) => line.includes("=")).map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
    );
    assert.equal(settings.LINDERO_SITE, "test");
    assert.equal(settings.NODE_ENV, "production");
    assert.equal(settings.PORT, "3101");
    assert.equal(settings.HOST, "127.0.0.1");
    assert.equal(settings.FRONTEND_ORIGIN, `https://${HOST}`);
    assert.ok(settings.DATABASE_PATH!.endsWith("/opt/lindero-test/backend/data/lindero.db"));
    assert.ok(settings.COOKIE_SECRET!.length >= 32);

    const secrets = [settings.COOKIE_SECRET!, settings.TEST_SITE_SUPERVISOR_PASSWORD!, settings.TEST_SITE_ASSOCIATE_PASSWORD!];
    assert.equal(new Set(secrets).size, 3);
    for (const password of secrets.slice(1)) {
      assert.ok(password.length >= 12, "seed.ts refuses anything shorter");
    }
    for (const secret of secrets) {
      assert.ok(!result.stdout.includes(secret));
      assert.ok(!result.stderr.includes(secret));
      assert.ok(!site.log().includes(secret));
    }
  });

  it("fills in the demo data as the test site's user, in its own folder", () => {
    const site = droplet();
    const result = site.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /demo data: Seeded data\/lindero\.db/);
    assert.ok(site.log().indexOf("systemctl start lindero-test-autodeploy.service") < site.log().indexOf("node --env-file=.env dist/db/seed.js"));
  });

  it("can run twice: it keeps the passwords and does not ask for a second certificate", () => {
    const site = droplet();
    assert.equal(site.run().status, 0);
    const first = site.read("opt/lindero-test/backend/.env");
    site.clearLog();

    const result = site.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(site.read("opt/lindero-test/backend/.env"), first);
    assert.doesNotMatch(site.log(), /^certbot certonly/m);
    assert.doesNotMatch(site.log(), /^useradd/m);
  });
});

describe("keeping the test site away from the live site's files", () => {
  it("leaves the live folder alone when the test site's user already cannot read into it", () => {
    const site = droplet();
    assert.equal(site.run().status, 0);
    assert.doesNotMatch(site.log(), /^chmod o-rx/m);
    assert.ok(!site.exists("var/lindero-autodeploy/live-folder-mode-before-test-site"));
  });

  it("closes the live folder to other users if they can read into it, and remembers how it was", () => {
    const site = droplet();
    site.setMode("opt/lindero", 0o755);
    site.mark("live-readable");
    const result = site.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(site.log(), /^chmod o-rx .*\/opt\/lindero$/m);
    assert.equal(site.mode("opt/lindero"), "750");
    assert.equal(site.read("var/lindero-autodeploy/live-folder-mode-before-test-site").trim(), "755");
  });

  it("stops before anything runs as that user if it still can", () => {
    const site = droplet();
    site.mark("live-readable");
    site.mark("chmod-does-not-help");
    const result = site.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /can still be read/);
    assert.doesNotMatch(site.log(), /^certbot/m);
    assert.doesNotMatch(site.log(), /lindero-test-autodeploy/);
  });

  it("stops if bascula's folder can be read", () => {
    const site = droplet();
    site.mark("bascula-readable");
    const result = site.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bascula-central's folder/);
    assert.doesNotMatch(site.log(), /^certbot/m);
  });
});

describe("setup-test-site.sh when something goes wrong", () => {
  it("takes its site back out if Nginx refuses it, so the next reboot still starts Nginx", () => {
    const site = droplet();
    // Passes the first look, refuses once the test site's file is there.
    site.mark("nginx-refuses-whole-site");
    writeFileSync(join(site.root, "opt/lindero/deploy/nginx-test-site.conf"), "server {\n    listen 443 ssl http2;\n}\n");
    const result = site.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /plain-http part/);
    assert.ok(!site.isLink("etc/nginx/sites-enabled/lindero-test"));
    assert.doesNotMatch(site.log(), /^systemctl reload/m);
    assert.doesNotMatch(site.log(), /^certbot/m);
  });

  it("goes back to the plain-http part if Nginx refuses the whole site", () => {
    const site = droplet();
    site.mark("nginx-refuses-whole-site");
    const result = site.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /full configuration/);
    assert.doesNotMatch(site.read("etc/nginx/sites-available/lindero-test"), /^ +listen 443/m);
    assert.ok(site.isLink("etc/nginx/sites-enabled/lindero-test"));
    assert.equal([...site.log().matchAll(/^systemctl reload nginx$/gm)].length, 1);
    assert.doesNotMatch(site.log(), /lindero-test-autodeploy/);
  });

  it("carries on from where it stopped if the certificate cannot be issued", () => {
    const site = droplet();
    site.mark("certbot-fails");
    const result = site.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /certificate could not be issued/);
    assert.match(result.stderr, /carries on from here/);
    assert.match(result.stderr, /Challenge failed: connection refused/, "the screenshot says why");
    assert.ok(!site.exists(`etc/letsencrypt/live/${HOST}/fullchain.pem`));
    assert.doesNotMatch(site.read("etc/nginx/sites-available/lindero-test"), /^ +listen 443/m);

    site.unmark("certbot-fails");
    const again = site.run();
    assert.equal(again.status, 0, again.stderr);
    assert.match(site.read("etc/nginx/sites-available/lindero-test"), /^ +listen 443/m);
  });

  it("says so if the first deploy fails, and tries that build again on the next run", () => {
    const site = droplet();
    site.mark("first-deploy-fails");
    const result = site.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /first deploy failed/);
    assert.doesNotMatch(site.log(), /dist\/db\/seed\.js/);

    mkdirSync(join(site.root, "var/lindero-autodeploy"), { recursive: true });
    site.mark("var/lindero-autodeploy/last-build-test", "a build that was tried");
    site.unmark("first-deploy-fails");
    site.unmark("deploy-ran");
    assert.equal(site.run().status, 0);
    assert.ok(!site.exists("var/lindero-autodeploy/last-build-test"), "the record is cleared so the build is tried again");
  });

  it("says so if the demo data cannot be added", () => {
    const site = droplet();
    site.mark("seed-fails");
    const result = site.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /demo data could not be added/);
    assert.doesNotMatch(result.stdout, /==> Done/);
  });

  it("fails loudly if the test site does not answer at the end", () => {
    const site = droplet();
    site.mark("test-site-down");
    const result = site.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Something above is not as expected/);
    assert.doesNotMatch(result.stdout, /==> Done/);
  });

  it("fails loudly if bascula's processes changed while it ran", () => {
    const site = droplet();
    site.mark("pm2-restarts");
    const result = site.run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /PM2's process list changed/);
  });

  it("fails loudly if the live site restarted while it ran", () => {
    const site = droplet();
    site.mark("lindero-restarts");
    const result = site.run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /live site's process changed/);
  });
});

describe("setup-test-site.sh --undo", () => {
  it("takes out everything of the test site and nothing else", () => {
    const site = droplet();
    site.setMode("opt/lindero", 0o755);
    site.mark("live-readable");
    assert.equal(site.run().status, 0);
    site.clearLog();

    const result = site.run("--undo");
    assert.equal(result.status, 0, result.stderr);

    for (const gone of [
      "opt/lindero-test",
      "www/lindero-test",
      "etc/nginx/sites-available/lindero-test",
      "etc/systemd/lindero-test-api.service",
      "etc/systemd/lindero-test-autodeploy.service",
      "etc/systemd/lindero-test-autodeploy.timer",
      `etc/letsencrypt/live/${HOST}`,
      "user-exists",
    ]) {
      assert.ok(!site.exists(gone), gone);
    }
    assert.ok(!site.isLink("etc/nginx/sites-enabled/lindero-test"));
    assert.match(site.log(), /^systemctl reload nginx$/m);
    assert.doesNotMatch(site.log(), /^systemctl restart/m);
    assert.doesNotMatch(site.log(), /^systemctl \S+( --now)? lindero-api/m);

    assert.equal(site.read("www/lindero/frontend/dist/index.html"), "the live site\n");
    assert.equal(site.read("etc/nginx/sites-available/lindero"), "the live site's nginx\n");
    assert.ok(site.exists("opt/lindero/deploy/setup-test-site.sh"));
    assert.equal(site.mode("opt/lindero"), "755", "the live folder is back to how it was");
  });

  it("can run when there is nothing to take out", () => {
    const site = droplet();
    const result = site.run("--undo");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /The test site is gone/);
  });
});

describe("the test site's Nginx file", () => {
  const conf = source("deploy/nginx-test-site.conf");
  const code = conf.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");

  it("sends everything to its own port and never to the live site's", () => {
    const ports = [...code.matchAll(/proxy_pass http:\/\/127\.0\.0\.1:(\d+)/g)].map((match) => match[1]);
    assert.deepEqual(ports, ["3101", "3101"]);
    assert.doesNotMatch(code, /lindero-api-documents/);
    assert.doesNotMatch(code, /3001|3000|3003/);
    assert.match(code, /root \/var\/www\/lindero-test\/frontend\/dist;/);
    assert.doesNotMatch(code, /\/var\/www\/lindero\//);
  });

  it("uses the form of http2 this droplet's nginx 1.24 accepts", () => {
    assert.equal([...code.matchAll(/^\s*listen (\[::\]:)?443 ssl http2;$/gm)].length, 2);
    assert.doesNotMatch(code, /http2 on;/);
  });

  it("hides every answer from search engines", () => {
    const secure = code.slice(code.indexOf("listen 443"));
    const locations = [...secure.matchAll(/^ {4}location [^\n]*\{\n((?:.|\n)*?)^ {4}\}/gm)];
    assert.equal(locations.length, 6);
    for (const location of locations) {
      assert.match(location[1]!, /add_header X-Robots-Tag "noindex, nofollow" always;/, location[0].split("\n")[0]);
    }
  });

  it("keeps the headers off the API, where the document viewer frames files", () => {
    const api = code.slice(code.indexOf("location /api/"));
    assert.doesNotMatch(api, /lindero-headers/);
    assert.equal([...code.matchAll(/include snippets\/lindero-headers\.conf;/g)].length, 5);
  });

  it("lets the same files through as the live site", () => {
    assert.match(code, /client_max_body_size 13m;/);
    assert.match(code, /location ~ \^\/api\/contracts\/\[\^\/\]\+\/documents\$ \{\n\s+proxy_pass http:\/\/127\.0\.0\.1:3101;\n\s+client_max_body_size 31m;/);
  });

  it("has a plain-http part that is valid before there is a certificate", () => {
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; NGINX_SOURCE="$2"; http_half', "setup-test", join(repo, "deploy/setup-test-site.sh"), join(repo, "deploy/nginx-test-site.conf")],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const half = result.stdout;
    assert.match(half, /listen 80;/);
    assert.match(half, /\.well-known\/acme-challenge/);
    assert.match(half, /root \/var\/www\/certbot;/);
    assert.doesNotMatch(half.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n"), /443|ssl|letsencrypt/);
    assert.equal(half.trimEnd().split("\n").at(-1), "}");
  });
});
