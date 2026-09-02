// `tsc` emits .js from .ts and nothing else — it does not copy data files.
// The drizzle migration folder (SQL statements plus the meta/ journal) has to
// be carried into dist/ by hand, or a compiled install started with
// `--omit=dev` has no migration files and no tsx to run the generator.
//
// Runs as the second half of `npm run build` (see package.json).
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(backendRoot, "drizzle");
const destination = join(backendRoot, "dist", "drizzle");

// Clear first so a migration file deleted or renamed in source does not linger
// in the build output and get re-applied.
rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });

console.log(`Copied migrations -> ${destination}`);
