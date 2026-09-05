export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  frontendOrigins: string[];
  /** Path to the SQLite file. One file = one database. */
  databasePath: string;
  /**
   * Where uploaded proof-of-payment files are written.
   *
   * Deliberately outside the database: a SQLite file holding the ledger AND
   * every customer's photo of a deposit slip is one nobody can back up or move.
   * See the note on `attachments` in src/db/schema.ts.
   */
  uploadsPath: string;
  /** Signs the session cookie so it cannot be tampered with. */
  cookieSecret: string;
  /** How long a login lasts, in days. */
  sessionDays: number;
  /** Failed-login protection: attempts allowed per minute, per IP address. */
  loginAttemptsPerMinute: number;
  /**
   * How often to ask the provider for the lempira/dollar rate, in hours.
   * `0` turns the scheduler off entirely — the rate then only changes when a
   * supervisor types one, and no outbound request is ever made.
   */
  exchangeRateRefreshHours: number;
  /**
   * How Fastify derives `request.ip` — see `parseTrustProxy` below. This is
   * what the global and per-login rate limits key on, so getting it wrong
   * either merges every visitor into one bucket (unset, behind a proxy) or
   * lets a visitor pick their own bucket by forging a header (`true`,
   * without a proxy actually enforcing what reaches this process).
   */
  trustProxy: boolean | string;
  /**
   * The timezone the BUSINESS keeps its calendar in — an IANA name.
   *
   * Not the server's timezone, and deliberately not the browser's. Lindero is
   * full of calendar DATES rather than instants: the day a payment was
   * received, the day an installment falls due, the month a figure belongs to.
   * Every one of those is a fact about a day in the office, so they all have to
   * be decided in one place's calendar or they disagree with each other.
   *
   * The failure this fixes: the server derived "today" from UTC, so from six in
   * the evening in Tegucigalpa onwards it had already rolled over. A payment
   * taken at 21:38 on 31 August was filed under 1 September, the Panel General
   * reported a month nobody had reached yet, and an installment due that day
   * was five hours late by the app's reckoning while the office was still open.
   *
   * Honduras keeps UTC−6 all year and has observed no daylight saving since
   * 2006, so this is a fixed offset in practice — but it is stored as an IANA
   * zone rather than as "−6" so that a change in the rules, or a second office
   * somewhere else, is a configuration change and not a rewrite.
   */
  timeZone: string;
};

const allowedEnvironments = new Set<AppConfig["nodeEnv"]>([
  "development",
  "test",
  "production",
]);

/** Only long enough to be meaningful; production is checked separately below. */
const MINIMUM_SECRET_LENGTH = 32;

const DEVELOPMENT_COOKIE_SECRET = "lindero-development-cookie-secret-change-me";

/**
 * `false` (unset) trusts nothing: `request.ip` is the direct TCP peer, which
 * is correct with no proxy in front — local development, or a server reached
 * directly. A string (or `"ip,ip/cidr"`) pins trust to the proxy's own
 * address, which still protects `request.ip` if this process is ever
 * reachable directly. `true` trusts every hop in whatever `X-Forwarded-For`
 * chain arrives, including a prefix an attacker attached themselves; only use
 * it if nothing can reach this process except through one proxy you control.
 *
 * A BARE NUMBER IS REFUSED, and that is a deliberate narrowing rather than an
 * oversight. Counting hops back from the peer says nothing about who that peer
 * is, so a request arriving directly — this port reachable without passing
 * Nginx — has its own forged `X-Forwarded-For` counted as the trusted hop, and
 * `request.ip` becomes whatever the caller wrote. That is CVE GHSA-3m5p-2c4r-
 * xxw2, and Fastify 5.12.3 removed the form from its own types in response. It
 * matters here because `request.ip` is what the login rate limit counts and
 * what the audit trail records: a spoofable one turns "10 attempts a minute"
 * into no limit at all, and signs somebody else's address to an action.
 *
 * Throwing rather than quietly substituting a safe value is the point. This is
 * read once at boot, and a security setting that silently does something other
 * than what the operator wrote is worse than one that refuses to start.
 */
function parseTrustProxy(raw: string | undefined): AppConfig["trustProxy"] {
  if (raw === undefined || raw.trim() === "") {
    return false;
  }

  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  if (/^\d+$/.test(raw)) {
    throw new Error(
      `TRUST_PROXY=${raw} counts proxy hops, which is spoofable if this port ` +
        "is ever reachable without passing the proxy. Name the proxy instead " +
        "— TRUST_PROXY=127.0.0.1 for an Nginx on the same host.",
    );
  }

  return raw;
}

export function loadConfig(environment = process.env): AppConfig {
  const rawNodeEnv = environment.NODE_ENV ?? "development";
  const nodeEnv = allowedEnvironments.has(rawNodeEnv as AppConfig["nodeEnv"])
    ? (rawNodeEnv as AppConfig["nodeEnv"])
    : "development";
  const port = Number(environment.PORT ?? 3000);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const cookieSecret = environment.COOKIE_SECRET ?? DEVELOPMENT_COOKIE_SECRET;

  // A predictable secret in production would let anyone forge a session cookie,
  // so refuse to start rather than run insecurely.
  if (nodeEnv === "production") {
    if (cookieSecret === DEVELOPMENT_COOKIE_SECRET) {
      throw new Error("COOKIE_SECRET must be set in production");
    }
    if (cookieSecret.length < MINIMUM_SECRET_LENGTH) {
      throw new Error(`COOKIE_SECRET must be at least ${MINIMUM_SECRET_LENGTH} characters`);
    }
  }

  const sessionDays = Number(environment.SESSION_DAYS ?? 7);

  if (!Number.isFinite(sessionDays) || sessionDays <= 0) {
    throw new Error("SESSION_DAYS must be a positive number");
  }

  const loginAttemptsPerMinute = Number(environment.LOGIN_ATTEMPTS_PER_MINUTE ?? 10);

  if (!Number.isInteger(loginAttemptsPerMinute) || loginAttemptsPerMinute < 1) {
    throw new Error("LOGIN_ATTEMPTS_PER_MINUTE must be a positive integer");
  }

  const exchangeRateRefreshHours = Number(environment.EXCHANGE_RATE_REFRESH_HOURS ?? 6);

  if (!Number.isFinite(exchangeRateRefreshHours) || exchangeRateRefreshHours < 0) {
    throw new Error("EXCHANGE_RATE_REFRESH_HOURS must be zero or a positive number");
  }

  const timeZone = environment.TIME_ZONE ?? "America/Tegucigalpa";

  // Asked of the platform rather than checked against a list: an unknown zone
  // name throws here, at boot, instead of silently falling back to UTC and
  // moving every date in the app by six hours.
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    throw new Error(`TIME_ZONE is not a known IANA timezone: ${timeZone}`);
  }

  return {
    nodeEnv,
    host: environment.HOST ?? "0.0.0.0",
    port,
    frontendOrigins: (environment.FRONTEND_ORIGIN ?? "http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    databasePath: environment.DATABASE_PATH ?? "./data/lindero.db",
    uploadsPath: environment.UPLOADS_PATH ?? "./data/uploads",
    cookieSecret,
    sessionDays,
    loginAttemptsPerMinute,
    exchangeRateRefreshHours,
    trustProxy: parseTrustProxy(environment.TRUST_PROXY),
    timeZone,
  };
}
