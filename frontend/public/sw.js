/*
 * Lindero's service worker.
 *
 * ============================================================================
 * IT CACHES NOTHING. Read this whole comment before adding anything that does.
 * ============================================================================
 *
 * A service worker sits between the app and the network and can answer requests
 * from its own storage. That is how offline support works, and it is also how a
 * web app gets permanently broken: ship a worker that caches a bad build, and
 * every phone that installed it keeps serving that bad build — from its own
 * disk, without asking the server. Deploying the fix does not dislodge it,
 * because the broken worker is the thing deciding whether to ask for the fix.
 * The usual reaction is to deploy again, which changes nothing, on a device you
 * are not holding.
 *
 * This worker exists for exactly two reasons, neither of them offline support:
 *
 *   1. Chrome will not offer "Install app" without a service worker that has a
 *      `fetch` handler. Installation is what the share target in the next phase
 *      depends on — the OS share sheet only lists installed apps.
 *   2. That `fetch` handler is where the shared comprobante will be caught,
 *      once Phase 2 lands. A share arrives as a POST from another app, and
 *      handling it here keeps it on the device, where the session cookie still
 *      applies. See docs/receipt-intake.md.
 *
 * So the handler below is deliberately empty. Not calling `respondWith` means
 * every request goes to the network exactly as it would with no service worker
 * installed at all, which is the entire point: all of the installability, none
 * of the risk.
 *
 * ---------------------------------------------------------------------------
 * THE KILL SWITCH
 *
 * If a worker ever does get stuck on a device, replace the whole body of this
 * file with these two lines and deploy:
 *
 *     self.addEventListener("install", () => self.skipWaiting());
 *     self.addEventListener("activate", () => self.registration.unregister());
 *
 * Every browser picks that up on its next navigation, unregisters itself, and
 * goes back to being an ordinary web page. Knowing this exists is what makes a
 * service worker a safe thing to ship.
 * ---------------------------------------------------------------------------
 */

/*
 * Take over immediately instead of waiting for every tab to close.
 *
 * The default is cautious for a caching worker — two versions serving different
 * assets to different tabs is a real hazard. This one serves no assets, so
 * there is nothing to be inconsistent about, and the caution would only mean a
 * fix sitting unused behind a tab somebody left open last week.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/* ==========================================================================
 * The share target.
 *
 * Sharing a comprobante from WhatsApp arrives here as a POST to /compartir,
 * made by the BROWSER on another app's behalf. Two things about that shape the
 * code below.
 *
 * First, it must not go to the server. A share POST is a cross-app navigation,
 * and a `SameSite=Lax` session cookie is not reliably attached to it — so the
 * upload would arrive unauthenticated and be refused. Handling it here keeps
 * the request on the device entirely; the 303 that follows is an ordinary
 * same-origin GET, which carries the session normally.
 *
 * Second, a redirect cannot carry a file. So the file is parked in IndexedDB
 * under a one-time id and the redirect carries only that id. The page picks it
 * up and deletes it — see src/lib/sharedIntake.ts.
 * ========================================================================== */

const SHARE_PATH = "/compartir";
const DB_NAME = "lindero-share";
const DB_VERSION = 1;
const STORE = "incoming";

/* A share left unclaimed — the redirect never followed, the app force-closed —
 * would otherwise sit in IndexedDB holding a photo forever. Anything older than
 * this is swept on the next share. Generous, because the only cost of keeping
 * one too long is a few megabytes, while sweeping one too early loses a
 * customer's proof of payment. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storePayload(db, payload) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);

    store.put(payload);

    // Sweep stale entries inside the SAME transaction, so a share is never
    // half-written next to a half-deleted one.
    const cursorRequest = store.openCursor();

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;

      if (!cursor) {
        return;
      }

      if (payload.receivedAt - (cursor.value.receivedAt ?? 0) > STALE_AFTER_MS) {
        cursor.delete();
      }

      cursor.continue();
    };

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function receiveShare(request) {
  const id =
    self.crypto && typeof self.crypto.randomUUID === "function"
      ? self.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const form = await request.formData();

    /* `getAll`, not `get`: WhatsApp can share several images at once, and the
     * manifest declares the field so the browser may deliver more than one.
     * Empty entries are filtered because some Android builds include a
     * zero-byte placeholder when the user shares text with no attachment. */
    const files = form.getAll("comprobante").filter((entry) => entry instanceof File && entry.size > 0);

    /* Text matters as much as the files. Plenty of confirmations arrive as a
     * forwarded message rather than a screenshot — the BAC notification, for
     * one — and the reference number is in that text. It is carried through
     * even though nothing reads it yet, because dropping it here would mean
     * the share had to be repeated later to get it back. */
    const text = String(form.get("text") ?? "");
    const title = String(form.get("title") ?? "");

    const database = await openDatabase();

    await storePayload(database, { id, files, text, title, receivedAt: Date.now() });
    database.close();

    return Response.redirect(`/?compartido=${encodeURIComponent(id)}`, 303);
  } catch (error) {
    /* Land in the app regardless, with a flag rather than a payload.
     *
     * The alternative is an error page owned by nobody, reached from inside
     * WhatsApp, on a phone. Better to open Lindero and say the share did not
     * arrive — from there the file is still in the chat, and the dropzone is
     * two taps away. */
    return Response.redirect("/?compartido=error", 303);
  }
}

/*
 * One branch, and everything else falls through to the network.
 *
 * The listener must exist even for requests it ignores — Chrome checks for a
 * registered `fetch` handler when deciding whether the app is installable.
 * Returning without calling `event.respondWith()` hands the request straight to
 * the network, which is the behaviour of a page with no worker at all.
 */
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "POST") {
    return;
  }

  const url = new URL(event.request.url);

  if (url.origin === self.location.origin && url.pathname === SHARE_PATH) {
    event.respondWith(receiveShare(event.request));
  }
});
