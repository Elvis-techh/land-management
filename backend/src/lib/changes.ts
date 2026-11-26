/**
 * "Something was written." The one signal that makes the app live.
 *
 * Lindero is used by several people at once, on a phone at the window and on a
 * computer in the office, and until now each browser only learned about a write
 * by making it. A payment taken on a phone was invisible on the desktop until
 * somebody reloaded the page — which is not a stale cache, it is two people
 * looking at the same customer and disagreeing about what they owe.
 *
 * This is the publisher half. `routes/events.ts` holds the streams open;
 * `app.ts` calls `publishChange` once, from an `onResponse` hook, so a route
 * cannot forget to announce its own write.
 *
 * IN PROCESS, deliberately. One Node process owns each company's SQLite file —
 * that is already true of every other assumption in this codebase, from the
 * gapless receipt sequence allocated under the write lock to the in-memory
 * exchange rate timer. A second process would need Redis or LISTEN/NOTIFY to
 * do this, and it would need them for the receipt sequence first. A `Set` of
 * callbacks per company is the honest shape of the problem we actually have.
 */

/** What a change announcement carries. */
export interface ChangeEvent {
  /**
   * The top-level resource that was written: "receipts", "lots", "contracts".
   *
   * A HINT, not a routing key. Clients re-read everything regardless — see
   * below — so this exists to be read in a log when somebody asks why a screen
   * refreshed, and to leave room for a client that one day wants to be
   * selective without changing the wire format.
   *
   * It is not a routing key because in this app it could not be a correct one.
   * Balances are DERIVED rather than stored (see lib/ledger.ts), so one payment
   * moves the transactions list, the contract's health, the lot's paid-to-date,
   * the customer's holdings and the project's totals. A table mapping each
   * route to "the screens it affects" would be a second description of the
   * domain, kept in a different file from the domain, and wrong the first time
   * somebody added a column. Telling every client to re-read is a few extra
   * GETs of a few hundred rows, and it cannot be wrong.
   */
  resource: string;
  /**
   * The browser tab that caused the write, when it said.
   *
   * Its own stream skips the event: that tab already re-reads after its own
   * writes, and a second refresh a moment later is pure duplicate. Purely an
   * optimisation — an unrecognised or absent id just means everybody hears it,
   * which is correct, only chattier.
   */
  origin: string | null;
  /** ISO-8601. For the log, and so a client can see how fresh the news is. */
  at: string;
}

type ChangeListener = (event: ChangeEvent) => void;

/**
 * The open streams, by company id.
 *
 * Each company hears only its own writes. A payment in one company's office
 * must not make another company's screens re-read, and the event's resource
 * name is itself a small fact about what that company is doing.
 */
const listeners = new Map<string, Set<ChangeListener>>();

/**
 * Listen for one company's writes. Returns the function that stops listening.
 *
 * The caller MUST call it — one open SSE connection is one entry here, and a
 * connection that closes without unsubscribing is a listener writing to a dead
 * socket forever.
 */
export function subscribeToChanges(companyId: string, listener: ChangeListener): () => void {
  let forCompany = listeners.get(companyId);
  if (!forCompany) {
    forCompany = new Set();
    listeners.set(companyId, forCompany);
  }
  forCompany.add(listener);

  return () => {
    forCompany.delete(listener);
    // So a company with no open tab leaves nothing behind.
    if (forCompany.size === 0 && listeners.get(companyId) === forCompany) {
      listeners.delete(companyId);
    }
  };
}

/**
 * Announce a write to every open stream of that company.
 *
 * Synchronous and best-effort. A subscriber that throws — a socket that died
 * between the check and the write — is dropped on the floor rather than allowed
 * to escape: this runs after the response to somebody's payment has already
 * been sent, and a broken listener must never turn a successful write into a
 * failed request.
 */
export function publishChange(companyId: string, event: ChangeEvent): void {
  for (const listener of listeners.get(companyId) ?? []) {
    try {
      listener(event);
    } catch {
      // Deliberately swallowed. See above.
    }
  }
}

/** How many streams are open, for every company. Exported for the tests and the health log. */
export function changeListenerCount(): number {
  let count = 0;
  for (const forCompany of listeners.values()) {
    count += forCompany.size;
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* "Has anything been written since you last asked?"                           */
/* -------------------------------------------------------------------------- */

/*
 * Every open tab re-reads its lists when it comes back to the front, and most
 * of the time nothing has been written in between. The transactions list is
 * by far the biggest of them (about 6 MB at five years of data, 18 MB at ten),
 * and rebuilding it only to send the browser what it already has costs the
 * single Node thread hundreds of milliseconds and tens of MB of memory.
 *
 * So a list can carry a version, sent as an ETag. The browser keeps the last
 * copy and asks "still this version?" on the next read; the answer "yes" is a
 * 304 with no body, decided before any query runs.
 *
 * The version changes on ANY write, not on writes "to the transactions", for
 * the same reason the change announcements go to everybody (see ChangeEvent):
 * every figure here is derived, so a narrower rule would be a second
 * description of the domain that could be wrong. A write anywhere costs one
 * full read, exactly as before; the saving is the reads with no write between.
 */

/** Differs on every start, so a version from before a restart never matches. */
const BOOT_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Each company's write counter, by company id.
 *
 * Per company, so one company's busy afternoon does not make every other
 * company's browsers download their lists again. An entry is never deleted,
 * not even when a company's file is closed: starting its count again from
 * zero could confirm a version handed out before as current. One number per
 * company that has written since the start is nothing to keep.
 */
const writeGenerations = new Map<string, number>();

/**
 * Called when a write STARTS and again when it has finished (see app.ts).
 *
 * Both, so a read that overlaps a write can never be confirmed later as
 * current: it was given the number from the start of the write, and by the
 * time the write is done the number has moved on again.
 */
export function noteWrite(companyId: string): void {
  writeGenerations.set(companyId, (writeGenerations.get(companyId) ?? 0) + 1);
}

/**
 * The version of everything a list can show, for this user of this company.
 *
 * - The company keeps one company's copy from ever being confirmed to another.
 * - The write counter covers every write to that company made through this
 *   process.
 * - SQLite's `data_version` covers a write by any OTHER connection to the file,
 *   such as somebody fixing a row by hand with the sqlite3 tool.
 * - The date covers anything that changes with the calendar alone.
 * - The user covers a shared office computer: one person's copy must never be
 *   confirmed as current to the next person who signs in on it.
 */
export function dataVersion(
  companyId: string,
  dataVersionOfDb: number,
  today: string,
  userId: string,
): string {
  const writes = writeGenerations.get(companyId) ?? 0;
  return `W/"${BOOT_ID}-${companyId}-${writes}-${dataVersionOfDb}-${today}-${userId}"`;
}
