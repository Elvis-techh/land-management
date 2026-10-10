// A consistent snapshot of the SQLite file. `VACUUM INTO` writes a fresh,
// defragmented copy while the database stays open for writes — no downtime, no
// half-written file — and the copy is then opened and checked.
//
// The uploads the receipt rows point at are backed up by MIRRORING the folder
// to the bucket, file by file (the rclone line in lindero-backup.service).
// Uploaded files never change, so the mirror sends only new ones. A nightly
// tarball of the whole folder is opt-in (BACKUP_UPLOADS_TARBALL=1), for a
// machine with no mirror: on the shared droplet it only filled the disk bascula
// writes to, with a full copy of every photo per night kept.
//
// This makes a LOCAL snapshot. Getting it OFF the machine is a second step
// (rclone / rsync / a provider's volume snapshot) — see docs/deployment.md.
// A backup that lives on the same disk as the thing it protects is not a backup.
//
// Run: `npm run db:backup` (from backend/), or on a timer — see
// deploy/lindero-backup.*.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load backend/.env if it is there, so this sees the same DATABASE_PATH the
// server does. `process.loadEnvFile` throws if the file is absent, hence the guard.
const envFile = join(backendRoot, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const databasePath = resolve(process.env.DATABASE_PATH ?? join(backendRoot, "data", "lindero.db"));
const uploadsPath = resolve(process.env.UPLOADS_PATH ?? join(backendRoot, "data", "uploads"));
const backupDir = resolve(process.env.BACKUP_PATH ?? join(backendRoot, "backups"));
const keepDays = Number(process.env.BACKUP_KEEP_DAYS ?? 14);
const wantsTarball = process.env.BACKUP_UPLOADS_TARBALL === "1";

if (!existsSync(databasePath)) {
  console.error(`No database at ${databasePath} — nothing to back up.`);
  process.exit(1);
}

mkdirSync(backupDir, { recursive: true });

// 2026-09-01T18-30-05 — filesystem-safe, still sorts chronologically.
const stamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");

const dbTarget = join(backupDir, `lindero-${stamp}.db`);

// `VACUUM INTO` needs a path that does not exist yet.
const db = new Database(databasePath, { readonly: true });
try {
  db.exec(`VACUUM INTO ${quote(dbTarget)}`);
} finally {
  db.close();
}

// A backup nobody has opened is a hope. Prove this one opens and is sound, and
// remove it if not, so the rclone copy can never send a broken one to the bucket.
const check = new Database(dbTarget, { readonly: true });
let checkResult;
try {
  checkResult = check.pragma("quick_check", { simple: true });
} finally {
  check.close();
}
if (checkResult !== "ok") {
  rmSync(dbTarget);
  console.error(`Snapshot failed quick_check and was removed: ${checkResult}`);
  process.exit(1);
}
console.log(`Database  -> ${dbTarget} (${mb(dbTarget)} MB, quick_check ok)`);

if (!wantsTarball) {
  console.log("Uploads   -> mirrored to the bucket, no local tarball (BACKUP_UPLOADS_TARBALL=1 for one)");
} else if (existsSync(uploadsPath) && readdirSync(uploadsPath).length > 0) {
  const uploadsTarget = join(backupDir, `uploads-${stamp}.tar.gz`);
  // -C so the archive holds "uploads/..." rather than an absolute path.
  execFileSync("tar", ["-czf", uploadsTarget, "-C", dirname(uploadsPath), basename(uploadsPath)], {
    stdio: "inherit",
  });
  console.log(`Uploads   -> ${uploadsTarget} (${mb(uploadsTarget)} MB)`);
} else {
  console.log("Uploads   -> none yet, skipped");
}

// Prune old snapshots, and old tarballs whether or not this run made one, so the
// ones written before the tarball became opt-in clear themselves away. A run a
// day means `keepDays` days of history.
if (Number.isFinite(keepDays) && keepDays > 0) {
  const cutoff = Date.now() - keepDays * 86_400_000;
  let pruned = 0;
  for (const name of readdirSync(backupDir)) {
    if (!/^(lindero|uploads)-.*\.(db|tar\.gz)$/.test(name)) {
      continue;
    }
    const full = join(backupDir, name);
    if (statSync(full).mtimeMs < cutoff) {
      rmSync(full);
      pruned += 1;
    }
  }
  if (pruned > 0) {
    console.log(`Pruned ${pruned} snapshot file(s) older than ${keepDays} days`);
  }
}

function quote(path) {
  return `'${path.replace(/'/g, "''")}'`;
}

function basename(path) {
  return path.split(/[\\/]/).pop();
}

function mb(path) {
  return (statSync(path).size / 1024 / 1024).toFixed(1);
}
