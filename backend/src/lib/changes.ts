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
 * IN PROCESS, deliberately. One Node process owns one SQLite file — that is
 * already true of every other assumption in this codebase, from the gapless
 * receipt sequence allocated under the write lock to the in-memory exchange
 * rate timer. A second process would need Redis or LISTEN/NOTIFY to do this,
 * and it would need them for the receipt sequence first. A `Set` of callbacks
 * is the honest shape of the problem we actually have.
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

const listeners = new Set<ChangeListener>();

/**
 * Listen for writes. Returns the function that stops listening.
 *
 * The caller MUST call it — one open SSE connection is one entry in this set,
 * and a connection that closes without unsubscribing is a listener writing to a
 * dead socket forever.
 */
export function subscribeToChanges(listener: ChangeListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Announce a write to every open stream.
 *
 * Synchronous and best-effort. A subscriber that throws — a socket that died
 * between the check and the write — is dropped on the floor rather than allowed
 * to escape: this runs after the response to somebody's payment has already
 * been sent, and a broken listener must never turn a successful write into a
 * failed request.
 */
export function publishChange(event: ChangeEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Deliberately swallowed. See above.
    }
  }
}

/** How many streams are open. Exported for the tests and the health log. */
export function changeListenerCount(): number {
  return listeners.size;
}
