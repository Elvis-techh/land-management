/**
 * Keeping the screen up to date with what everybody else is doing.
 *
 * The problem this solves, in the words it was reported in: a payment recorded
 * on a phone was not on the desktop until the site was restarted. Two people
 * were looking at one customer and disagreeing about what they owed, and
 * neither had any way to know. For a book of receipts that is not a stale
 * cache, it is the spreadsheet problem coming back in a nicer font.
 *
 * The fix is deliberately small, because the app was already built for it.
 * Every screen here re-reads from the server after a write rather than patching
 * its own copy — see the note in `useLots` — so "live" does not need optimistic
 * updates, a client-side cache, or a second way to read the ledger. It needs
 * one thing: somebody else's write has to call the same `reload` that your own
 * write already calls. That is all this file does.
 *
 * Two independent ways of hearing about it, because they fail differently:
 *
 *  - The stream (`/api/events`). Immediate, and the one that matters. It can be
 *    defeated by something in the middle that buffers or forbids a long-lived
 *    response.
 *  - Coming back to the tab. Costs one round of GETs when somebody switches to
 *    the window, and it works when nothing else does. On its own it would have
 *    fixed the reported case: the desktop was sitting in a background tab.
 */

import { useEffect, useRef } from "react";

/**
 * This tab's identity, for the length of this page load.
 *
 * Sent as `X-Client-Id` on every request (see lib/api.ts) so the server can
 * leave this tab out of the audience for its own writes — it re-reads when the
 * response lands, and does not need telling a moment later.
 *
 * NOT a security token and nothing is trusted to it: the worst a forged value
 * achieves is missing a refresh in somebody else's tab. Which matters, because
 * `crypto.randomUUID` is only defined in a secure context and Lindero is opened
 * over plain HTTP on the office network — so this uses `getRandomValues`, which
 * is available everywhere, and falls back again for good measure.
 */
export const CLIENT_ID: string = createClientId();

function createClientId(): string {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return `fallback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * How long to wait before acting on a nudge, in milliseconds.
 *
 * Refreshing is several requests, and the nudges arrive in bursts: issuing one
 * receipt for three lots is one write, but a teammate correcting a payment and
 * then voiding a receipt is two, a second apart, and switching to the tab can
 * land a `focus` and a `visibilitychange` in the same instant. Coalescing them
 * costs a delay nobody can perceive and saves reloading the whole screen three
 * times over.
 */
const COALESCE_MS = 200;

/**
 * How long to wait before reopening a stream the browser has given up on, in
 * milliseconds: the first wait, and the longest any wait grows to.
 *
 * The first matches the server's `retry: 3000`. Each failure in a row doubles
 * it, so a server that is down for ten minutes is asked about once a minute per
 * tab rather than every three seconds.
 */
const REOPEN_FIRST_MS = 3_000;
const REOPEN_MAX_MS = 60_000;

/**
 * `EventSource.CLOSED`, spelled out so this file also runs where `EventSource`
 * does not exist — the tests, under Node.
 */
const CLOSED = 2;

/** The parts of an `EventSource` the stream below uses. */
export interface StreamSource {
  readonly readyState: number;
  addEventListener(type: "open" | "change" | "error", listener: () => void): void;
  close(): void;
}

/** The parts of `window` the stream below uses for its waits. */
export interface StreamTimers {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
}

/**
 * Keep one live stream open for as long as the caller wants it.
 *
 * `EventSource` reconnects by itself after a dropped connection — a laptop lid,
 * a phone changing cell, the server ending the stream at a deploy. What it does
 * NOT survive is an answer that is not the stream: a 502 from Nginx while the
 * new process is still starting, a 503 during an outage. The browser then gives
 * up for good (`readyState` CLOSED) and the tab stops hearing about anybody
 * else's writes until it is reloaded, without telling anyone. This reopens it.
 *
 * `reconnected` is called when a stream opens after an earlier one was lost,
 * whichever of the two reopened it: anything written while it was down was
 * never announced. The very first open is not one of those — the screens have
 * just loaded.
 *
 * Plain rather than a hook so the rule can be tested without a browser.
 */
export function openLiveStream(
  connect: () => StreamSource,
  on: { change: () => void; reconnected: () => void },
  timers: StreamTimers,
): { close: () => void } {
  let stopped = false;
  let hasConnected = false;
  let wait = REOPEN_FIRST_MS;
  let reopenTimer: number | undefined;

  const start = (): StreamSource => {
    const source = connect();

    source.addEventListener("change", on.change);

    source.addEventListener("open", () => {
      if (hasConnected) {
        on.reconnected();
      }

      hasConnected = true;
      wait = REOPEN_FIRST_MS;
    });

    source.addEventListener("error", () => {
      // CONNECTING means the browser is already retrying on its own.
      if (stopped || source.readyState !== CLOSED) {
        return;
      }

      reopenTimer = timers.setTimeout(() => {
        reopenTimer = undefined;
        current = start();
      }, wait);
      wait = Math.min(wait * 2, REOPEN_MAX_MS);
    });

    return source;
  };

  let current = start();

  return {
    close: () => {
      stopped = true;
      timers.clearTimeout(reopenTimer);
      current.close();
    },
  };
}

/**
 * Re-read when somebody else writes, and when this tab comes back to the front.
 *
 * `onChange` is called with no arguments and is expected to reload whatever the
 * caller owns. It is read through a ref, so a caller that rebuilds the function
 * on every render does not tear down and rebuild the connection with it — an
 * `EventSource` that reconnects on every keystroke is worse than no stream.
 */
export function useLiveUpdates(enabled: boolean, onChange: () => void): void {
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let timer: number | undefined;

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => latest.current(), COALESCE_MS);
    };

    const stream = openLiveStream(
      () => new EventSource(`/api/events?clientId=${encodeURIComponent(CLIENT_ID)}`),
      { change: schedule, reconnected: schedule },
      window,
    );

    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        schedule();
      }
    };

    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);

    return () => {
      window.clearTimeout(timer);
      stream.close();
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [enabled]);
}
