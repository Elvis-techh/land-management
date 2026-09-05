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

/*
 * Empty on purpose. See the top of this file.
 *
 * The listener must exist — Chrome checks for a registered `fetch` handler when
 * deciding whether the app is installable — but it must not answer. Returning
 * without calling `event.respondWith()` hands the request straight to the
 * network, which is the behaviour of a page with no worker at all.
 */
self.addEventListener("fetch", () => {
  // Intentionally does nothing. Phase 2 adds ONE branch here, for the share
  // target POST, and leaves everything else falling through to the network.
});
