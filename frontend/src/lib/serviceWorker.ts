/**
 * Registering the service worker — see public/sw.js for what it does and, more
 * importantly, what it deliberately does not do.
 *
 * Three conditions have to hold before this is even attempted, and each one is
 * a real failure the app would otherwise hit:
 *
 *  - PRODUCTION ONLY. A worker intercepting requests in front of the Vite dev
 *    server breaks hot reloading in ways that look like the app is broken. The
 *    dev server is also served over plain HTTP on the office network, where the
 *    API does not exist at all (see below).
 *  - A SECURE CONTEXT. `navigator.serviceWorker` is undefined on `http://`,
 *    with no error to catch — the same trap documented at length in
 *    features/receipts/whatsapp.ts. `localhost` counts as secure; a LAN address
 *    like http://192.168.1.37:5173 does not.
 *  - SUPPORT. Firefox in a private window, and older browsers, simply do not
 *    have it.
 *
 * Failing any of those is not an error worth showing anybody. Lindero works
 * fine without a service worker; it just cannot be installed to a home screen,
 * which matters only for sharing a comprobante into it from WhatsApp.
 */

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) {
    return;
  }

  // `isSecureContext` covers the http:// case; the `in` check covers browsers
  // that lack the API entirely. Both are needed — they are different failures.
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    return;
  }

  /*
   * After `load`, so registering never competes with the first render.
   *
   * A service worker registration is not urgent: nothing on screen depends on
   * it, and the only thing it unlocks — the install prompt — is not something
   * anybody does in the first second of a page view.
   */
  window.addEventListener("load", () => {
    navigator.serviceWorker
      /*
       * `updateViaCache: "none"` is what keeps a deploy from being invisible.
       *
       * By default the browser may serve sw.js itself from the ordinary HTTP
       * cache when checking for updates, so a new worker can sit undiscovered
       * behind a cached copy of the old one. "none" forces that check to hit
       * the network every time. It costs one small conditional request per
       * navigation and removes the whole class of "I deployed it and the phone
       * still has the old one".
       */
      .register("/sw.js", { updateViaCache: "none" })
      .catch((error: unknown) => {
        // Registration is best-effort. A failure here means no install prompt,
        // not a broken app, so it is logged for a developer and never surfaced
        // to whoever is trying to write a receipt.
        console.warn("No se pudo registrar el service worker:", error);
      });
  });
}
