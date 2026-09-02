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

    const source = new EventSource(`/api/events?clientId=${encodeURIComponent(CLIENT_ID)}`);

    source.addEventListener("change", schedule);

    /*
     * A RE-opened stream means one was lost, and anything written while it was
     * down was never announced. The first open is not one of those: the hooks
     * have just loaded, and refreshing on top of that is the same data twice.
     */
    let hasConnected = false;

    source.addEventListener("open", () => {
      if (hasConnected) {
        schedule();
      }

      hasConnected = true;
    });

    /*
     * No `onerror` handler on purpose.
     *
     * `EventSource` reconnects by itself, on the interval the server sends, and
     * a dropped connection is completely ordinary — a laptop lid, a phone
     * changing cell, a backend restart during a deploy. There is nothing to
     * report and nothing to do; the `open` above is what puts things right, and
     * the tab-focus path below covers the case where the stream never comes
     * back at all.
     */

    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        schedule();
      }
    };

    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);

    return () => {
      window.clearTimeout(timer);
      source.close();
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [enabled]);
}
