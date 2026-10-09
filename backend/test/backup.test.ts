import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
