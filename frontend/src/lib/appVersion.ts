/**
 * Noticing that a newer Lindero is on the server.
 *
 * The problem, as it was reported: «Enviar por WhatsApp» was deployed, and the
 * phone did not show it. The phone was fine and so was the deploy; the app had
 * simply been open since before it. A page loaded once keeps the code it
 * loaded, and an app installed to the home screen is rarely reloaded at all —
 * it has no reload button, and Android keeps it alive in the background.
 *
 * So the app asks. When it comes back to the screen, and every few minutes
 * while it stays there, it fetches index.html and compares the scripts it
 * names with the ones this page was started from. A build changes their file
 * names (`/assets/index-<hash>.js`), so a difference means a new version.
 * Nothing is reloaded behind anybody's back: somebody may be halfway through a
 * receipt. A bar offers the reload, and the person decides when.
 *
 * Under the Vite dev server the page names `/src/main.tsx`, which never
 * changes, so this never fires there except in the browser test that fakes it.
 */

import { useEffect, useState } from "react";

/** How often to ask while the app stays on screen. */
const CHECK_EVERY_MS = 10 * 60 * 1000;

/**
 * The module scripts an index.html names, as one comparable string. In the
 * order they are written, which is the order a build writes them.
 */
export function moduleScripts(html: string): string {
  const sources: string[] = [];

  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) {
      continue;
    }

    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];

    if (src !== undefined) {
      sources.push(src);
    }
  }

  return sources.join(" ");
}

/**
 * The same, for the page that is running. Read once, when this module loads:
 * that is the version on screen, whatever the document gains later. Empty
 * outside a browser, where the unit tests import this file.
 */
const RUNNING =
  typeof document === "undefined"
    ? ""
    : moduleScripts(
        Array.from(document.querySelectorAll("script[type='module'][src]"), (script) => script.outerHTML).join(""),
      );

/** Whether the server's index.html names other scripts than this page did. */
async function isNewerOnServer(): Promise<boolean> {
  try {
    const response = await fetch("/", { cache: "no-store", headers: { Accept: "text/html" } });

    if (!response.ok) {
      // A 502 while a deploy restarts the server is not a new version.
      return false;
    }

    const served = moduleScripts(await response.text());

    // Empty: not index.html at all (a proxy's error page, say).
    return served !== "" && RUNNING !== "" && served !== RUNNING;
  } catch {
    // Offline. Ask again next time.
    return false;
  }
}

/**
 * Whether to offer the reload, and how to put the offer away for now. Put
 * away, it comes back at the next check that still finds a newer version.
 */
export function useNewVersion(): { isAvailable: boolean; dismiss: () => void } {
  const [isAvailable, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      void isNewerOnServer().then((isNewer) => {
        if (!cancelled && isNewer) {
          setAvailable(true);
        }
      });
    };

    const timer = window.setInterval(check, CHECK_EVERY_MS);

    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
    };
  }, []);

  return { isAvailable, dismiss: () => setAvailable(false) };
}
