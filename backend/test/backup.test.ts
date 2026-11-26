import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import Database from "better-sqlite3";

const script = join(import.meta.dirname, "..", "scripts", "backup.mjs");

/*
 * The nightly backup, run as systemd runs it: a separate process reading its
 * paths from the environment. On the droplet the uploads folder is mirrored to
 * the bucket file by file, so a nightly tarball of all of it only fills the
 * disk bascula shares (code review P1-6).
 */
describe("scripts/backup.mjs", () => {
  let root: string;
  let uploads: string;
  let backups: string;

  const run = (extra: Record<string, string> = {}) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_PATH: join(root, "lindero.db"),
      UPLOADS_PATH: uploads,
      BACKUP_PATH: backups,
      BACKUP_KEEP_DAYS: "3",
      ...extra,
    };
    if (!("BACKUP_UPLOADS_TARBALL" in extra)) {
      delete env.BACKUP_UPLOADS_TARBALL;
    }
    return execFileSync(process.execPath, [script], { env, encoding: "utf8" });
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), "lindero-backup-"));
    uploads = join(root, "uploads");
    backups = join(root, "backups");
    mkdirSync(uploads);
    writeFileSync(join(uploads, "receipt.jpg"), "a photo");

    const db = new Database(join(root, "lindero.db"));
    db.exec("CREATE TABLE lots (id TEXT PRIMARY KEY); INSERT INTO lots VALUES ('A-1');");
    db.close();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("snapshots the database, checks it, and leaves the uploads to the mirror", () => {
    rmSync(backups, { recursive: true, force: true });

    const log = run();
    const files = readdirSync(backups);

    assert.equal(files.filter((name) => /^lindero-.*\.db$/.test(name)).length, 1);
    assert.deepEqual(files.filter((name) => name.startsWith("uploads-")), []);
    assert.match(log, /quick_check ok/);

    const snapshot = new Database(join(backups, files.find((name) => name.endsWith(".db"))!), {
      readonly: true,
    });
    assert.deepEqual(snapshot.prepare("SELECT id FROM lots").all(), [{ id: "A-1" }]);
    snapshot.close();
  });

  it("still writes the tarball when asked to", () => {
    rmSync(backups, { recursive: true, force: true });

    run({ BACKUP_UPLOADS_TARBALL: "1" });

    assert.equal(readdirSync(backups).filter((name) => /^uploads-.*\.tar\.gz$/.test(name)).length, 1);
  });

  it("prunes the tarballs older runs left behind", () => {
    rmSync(backups, { recursive: true, force: true });
    mkdirSync(backups);
    const old = join(backups, "uploads-2026-09-01T02-15-00.tar.gz");
    writeFileSync(old, "");
    const fourDaysAgo = (Date.now() - 4 * 86_400_000) / 1000;
    utimesSync(old, fourDaysAgo, fourDaysAgo);

    run();

    assert.deepEqual(readdirSync(backups).filter((name) => name.startsWith("uploads-")), []);
  });
});

/*
 * One database file per company (docs/later-versions.md, section 1): every
 * company's file is snapshotted, company 1 exactly as before.
 */
describe("scripts/backup.mjs with several companies", () => {
  let root: string;
  let backups: string;

  const makeDb = (path: string, lot: string) => {
    const db = new Database(path);
    db.exec(`CREATE TABLE lots (id TEXT PRIMARY KEY); INSERT INTO lots VALUES ('${lot}');`);
    db.close();
  };

  const run = () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_PATH: join(root, "lindero.db"),
      UPLOADS_PATH: join(root, "uploads"),
      BACKUP_PATH: backups,
      BACKUP_KEEP_DAYS: "3",
    };
    delete env.BACKUP_UPLOADS_TARBALL;
    delete env.COMPANIES_PATH;
    return spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  };

  const lotsIn = (folder: string) => {
    const name = readdirSync(folder).find((entry) => /^lindero-.*\.db$/.test(entry));
    assert.ok(name, `no snapshot in ${folder}`);
    const snapshot = new Database(join(folder, name), { readonly: true });
    try {
      return snapshot.prepare("SELECT id FROM lots").all();
    } finally {
      snapshot.close();
    }
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), "lindero-backup-companies-"));
    backups = join(root, "backups");
    makeDb(join(root, "lindero.db"), "uno");
    // The default companies folder: beside the database.
    for (const [id, lot] of [["2", "dos"], ["10", "diez"]] as const) {
      mkdirSync(join(root, "companies", id), { recursive: true });
      makeDb(join(root, "companies", id, "lindero.db"), lot);
    }
    // Not a company: left alone.
    mkdirSync(join(root, "companies", "notes"));
    writeFileSync(join(root, "companies", "notes", "lindero.db"), "not a database");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("snapshots every company, each in its own folder, company 1 where it always was", () => {
    rmSync(backups, { recursive: true, force: true });

    const result = run();
    assert.equal(result.status, 0, result.stderr);

    assert.deepEqual(lotsIn(backups), [{ id: "uno" }]);
    assert.deepEqual(lotsIn(join(backups, "companies", "2")), [{ id: "dos" }]);
    assert.deepEqual(lotsIn(join(backups, "companies", "10")), [{ id: "diez" }]);
    assert.deepEqual(readdirSync(join(backups, "companies")).sort(), ["10", "2"]);
    assert.match(result.stdout, /Company 2: Database {2}-> .*quick_check ok/);
  });

  it("prunes each company's old snapshots", () => {
    rmSync(backups, { recursive: true, force: true });
    const folder = join(backups, "companies", "2");
    mkdirSync(folder, { recursive: true });
    const old = join(folder, "lindero-2026-09-01T02-15-00.db");
    writeFileSync(old, "");
    const fourDaysAgo = (Date.now() - 4 * 86_400_000) / 1000;
    utimesSync(old, fourDaysAgo, fourDaysAgo);

    assert.equal(run().status, 0);

    assert.equal(readdirSync(folder).length, 1);
    assert.ok(!readdirSync(folder).includes("lindero-2026-09-01T02-15-00.db"));
  });

  it("still backs up the others when one company's file is broken, and says it failed", () => {
    rmSync(backups, { recursive: true, force: true });
    const broken = join(root, "companies", "3");
    mkdirSync(broken);
    writeFileSync(join(broken, "lindero.db"), "not a database at all, just text");

    try {
      const result = run();

      assert.equal(result.status, 1);
      assert.match(result.stderr, /Company 3: Backup failed/);
      assert.deepEqual(lotsIn(backups), [{ id: "uno" }]);
      assert.deepEqual(lotsIn(join(backups, "companies", "10")), [{ id: "diez" }]);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
