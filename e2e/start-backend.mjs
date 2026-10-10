// Starts a throwaway Lindero backend for the browser tests: a fresh database
// filled with the demo data from `db:seed`, on its own port, with nothing read
// from backend/.env. Each test run starts from the same data, and a dev server
// already running on port 3000 (and its database) is never touched.
//
// Playwright runs this (see playwright.config.ts) and stops it after the tests.

import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const backend = join(import.meta.dirname, "..", "backend");
const data = join(import.meta.dirname, ".data");
const tsx = join(import.meta.dirname, "..", "node_modules", ".bin", "tsx");

const env = {
  ...process.env,
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: process.env.E2E_API_PORT ?? "3100",
  FRONTEND_ORIGIN: `http://localhost:${process.env.E2E_WEB_PORT ?? "5174"}`,
  DATABASE_PATH: join(data, "lindero.db"),
  UPLOADS_PATH: join(data, "uploads"),
  // No calls to the exchange-rate provider: the tests must not depend on it.
  EXCHANGE_RATE_REFRESH_HOURS: "0",
  // Every test logs in; the real limit (10 a minute) would lock the run out.
  LOGIN_ATTEMPTS_PER_MINUTE: "1000",
};

rmSync(data, { recursive: true, force: true });

for (const script of ["src/db/migrate.ts", "src/db/seed.ts"]) {
  const result = spawnSync(tsx, [script], { cwd: backend, env, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const server = spawn(tsx, ["src/server.ts"], { cwd: backend, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}
server.on("exit", (code) => process.exit(code ?? 0));
