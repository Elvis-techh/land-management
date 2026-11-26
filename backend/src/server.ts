import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { openAccounts } from "./db/accounts.js";
import { FIRST_COMPANY, companyRegistry } from "./db/companies.js";
import { refreshEveryCompany } from "./lib/exchangeRate.js";

const config = loadConfig();

// Which companies exist and which company each email signs in to. Created on
// the first start, with company 1 in it.
const accounts = openAccounts(config.accountsPath);

const companies = companyRegistry(config, accounts.db, {
  // Forwarded, because the app's logger exists only once the app is built.
  log: {
    info: (details, message) => app.log.info(details, message),
    warn: (details, message) => app.log.warn(details, message),
  },
  // A company opened after a while gets today's exchange rate straight away
  // rather than at the timer's next round.
  onOpen: (company) => {
    if (config.exchangeRateRefreshHours > 0) {
      void refreshEveryCompany([company], app.log);
    }
  },
});

const app = await buildApp(config, companies);

// Company 1 is opened now rather than on its first request: opening brings
// its schema up to date (see `openCompany`), and a failure here stops
// startup, which is what you want — serving traffic against a half-built
// schema is worse than a restart loop a service manager will surface. Safe on
// every boot: drizzle skips migrations already applied. Other companies are
// opened, and upgraded, the first time someone uses them.
companies.get(FIRST_COMPANY);

// Close the companies nobody is using, so memory follows the ones in use.
const idleTimer = setInterval(() => {
  const closed = companies.closeIdle();
  if (closed.length > 0) {
    app.log.info({ companyIds: closed }, "Closed idle companies");
  }
}, 5 * 60 * 1000);
idleTimer.unref();

/**
 * Keep the displayed exchange rate current.
 *
 * Runs once at boot and then on a timer. It is deliberately fire-and-forget: a
 * provider that is down must never stop the server from starting or serving —
 * the last known rate stays on screen, labelled with its age.
 *
 * A manually set rate is left alone until a supervisor asks for automatic
 * updates again; `refreshAutomaticRate` is where that rule lives.
 */
const refreshRate = () => {
  void refreshEveryCompany(companies.open(), app.log);
};

if (config.exchangeRateRefreshHours > 0) {
  refreshRate();

  const timer = setInterval(refreshRate, config.exchangeRateRefreshHours * 60 * 60 * 1000);
  // `unref` so a pending timer never holds the process open on shutdown.
  timer.unref();
}

let stopping = false;

/**
 * Close in-flight work and exit.
 *
 * `exitCode` is not cosmetic: the unit says `Restart=on-failure`, so systemd
 * restarts Lindero after a non-zero exit and leaves it stopped after a zero
 * one. A stop that was asked for exits 0; a crash must exit 1.
 */
const shutdown = async (signal: string, exitCode = 0) => {
  if (stopping) {
    return;
  }
  stopping = true;

  app.log.info({ signal }, "Shutting down");

  // Whatever else might hold the server open, exit well inside systemd's
  // TimeoutStopSec rather than waiting to be killed. `unref` so the timer
  // itself never keeps the process alive.
  const deadline = setTimeout(() => {
    app.log.error("Shutdown took longer than 10 s; exiting anyway");
    process.exit(1);
  }, 10_000);
  deadline.unref();

  await app.close();
  // Closing SQLite cleanly checkpoints the write-ahead log.
  companies.closeAll();
  accounts.sqlite.close();
  process.exit(exitCode);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

/*
 * Last resort, for whatever nothing else caught.
 *
 * Node ends the process on either of these anyway; this makes the last line in
 * journald a structured one that says what happened, instead of a bare stack
 * trace. Exiting is deliberate, with code 1 so systemd restarts it: a clean
 * process beats one running on in an unknown state. A rejection still lets
 * in-flight requests finish; after an uncaught exception nothing is trusted.
 */
process.on("unhandledRejection", (reason) => {
  app.log.fatal({ err: reason }, "Unhandled promise rejection");
  void shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (error) => {
  app.log.fatal({ err: error }, "Uncaught exception");
  process.exit(1);
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
