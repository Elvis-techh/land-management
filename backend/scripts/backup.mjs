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
// Every company is backed up (docs/later-versions.md, section 1). Company 1,
// the business that used Lindero before there were several, keeps its files
// and its snapshot names: `lindero-<stamp>.db` in BACKUP_PATH. Every other
// company has a folder under COMPANIES_PATH (`<id>/lindero.db`, `<id>/uploads/`;
// see `companyFiles` in src/db/companies.ts), and its snapshots go to
// `companies/<id>/` in BACKUP_PATH, with the same names. The rclone line in
// lindero-backup.service copies those too: its pattern matches in subfolders.
// One company that fails does not stop the others; the run still exits 1.
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
// The same default as the server's: a `companies` folder beside the database.
const companiesPath = resolve(
  process.env.COMPANIES_PATH ?? join(dirname(databasePath), "companies"),
);
const backupDir = resolve(process.env.BACKUP_PATH ?? join(backendRoot, "backups"));
const keepDays = Number(process.env.BACKUP_KEEP_DAYS ?? 14);
const wantsTarball = process.env.BACKUP_UPLOADS_TARBALL === "1";

if (!existsSync(databasePath)) {
  console.error(`No database at ${databasePath} — nothing to back up.`);
  process.exit(1);
}

// 2026-09-01T18-30-05 — filesystem-safe, still sorts chronologically.
const stamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");

// Company 1 first, exactly as before there were several; then every other
// company with a database file. A folder name that is not a company id is
// left alone.
const companies = [{ id: "1", database: databasePath, uploads: uploadsPath, target: backupDir }];

if (existsSync(companiesPath)) {
  const ids = readdirSync(companiesPath)
    .filter((name) => /^[1-9][0-9]{0,9}$/.test(name))
    .filter((id) => existsSync(join(companiesPath, id, "lindero.db")))
    .sort((left, right) => Number(left) - Number(right));

  for (const id of ids) {
    companies.push({
      id,
      database: join(companiesPath, id, "lindero.db"),
      uploads: join(companiesPath, id, "uploads"),
      target: join(backupDir, "companies", id),
    });
  }
}

let failed = false;

for (const company of companies) {
  try {
    if (!backUpCompany(company.id, company.database, company.uploads, company.target)) {
      failed = true;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : error;
    console.error(`${labelFor(company.id)}Backup failed: ${reason}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

/**
 * Snapshot one company's database into `targetDir`, check it, write its uploads
 * tarball when asked, and prune its old snapshots. False when the snapshot
 * failed its check.
 */
function backUpCompany(id, companyDatabase, companyUploads, targetDir) {
  const label = labelFor(id);

  mkdirSync(targetDir, { recursive: true });

  const dbTarget = join(targetDir, `lindero-${stamp}.db`);

  // `VACUUM INTO` needs a path that does not exist yet.
  const db = new Database(companyDatabase, { readonly: true });
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
    console.error(`${label}Snapshot failed quick_check and was removed: ${checkResult}`);
    return false;
  }
  console.log(`${label}Database  -> ${dbTarget} (${mb(dbTarget)} MB, quick_check ok)`);

  if (!wantsTarball) {
    console.log(
      `${label}Uploads   -> mirrored to the bucket, no local tarball (BACKUP_UPLOADS_TARBALL=1 for one)`,
    );
  } else if (existsSync(companyUploads) && readdirSync(companyUploads).length > 0) {
    const uploadsTarget = join(targetDir, `uploads-${stamp}.tar.gz`);
    // -C so the archive holds "uploads/..." rather than an absolute path.
    execFileSync(
      "tar",
      ["-czf", uploadsTarget, "-C", dirname(companyUploads), basename(companyUploads)],
      { stdio: "inherit" },
    );
    console.log(`${label}Uploads   -> ${uploadsTarget} (${mb(uploadsTarget)} MB)`);
  } else {
    console.log(`${label}Uploads   -> none yet, skipped`);
  }

  // Prune old snapshots, and old tarballs whether or not this run made one, so the
  // ones written before the tarball became opt-in clear themselves away. A run a
  // day means `keepDays` days of history.
  if (Number.isFinite(keepDays) && keepDays > 0) {
    const cutoff = Date.now() - keepDays * 86_400_000;
    let pruned = 0;
    for (const name of readdirSync(targetDir)) {
      if (!/^(lindero|uploads)-.*\.(db|tar\.gz)$/.test(name)) {
        continue;
      }
      const full = join(targetDir, name);
      if (statSync(full).mtimeMs < cutoff) {
        rmSync(full);
        pruned += 1;
      }
    }
    if (pruned > 0) {
      console.log(`${label}Pruned ${pruned} snapshot file(s) older than ${keepDays} days`);
    }
  }

  return true;
}

// Company 1's lines read as they always have.
function labelFor(id) {
  return id === "1" ? "" : `Company ${id}: `;
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
