/**
 * Collecting a comprobante shared into Lindero from another app.
 *
 * The other half of this lives in public/sw.js, and the split is forced by a
 * limitation rather than chosen: a share arrives as a POST that the service
 * worker must answer on the device (a `SameSite=Lax` session cookie is not
 * reliably attached to a cross-app POST, so sending it to the server would
 * arrive unauthenticated), and the redirect that follows cannot carry a file.
 * So the worker parks the payload in IndexedDB under a one-time id, redirects
 * with only that id in the query string, and this module picks it up.
 *
 * Reading is destructive on purpose. See `takeSharedPayload`.
 */

const DB_NAME = "lindero-share";
const DB_VERSION = 1;
const STORE = "incoming";

/** The query parameter the service worker's redirect carries. */
export const SHARE_PARAM = "compartido";

/** The worker's own signal that it could not read what was shared. */
export const SHARE_FAILED = "error";

export interface SharedPayload {
  /** Images or PDFs. Possibly empty — text-only shares are legitimate. */
  files: File[];
  /**
   * The shared message text.
   *
   * Often where the figures actually are: plenty of confirmations arrive as a
   * forwarded bank notification rather than a screenshot. Nothing reads it yet;
   * it is carried so that when something does, the share does not have to be
   * repeated to get it back.
   */
  text: string;
  title: string;
}

/**
 * What the URL is asking us to do, if anything.
 *
 * Returns `null` for an ordinary page load — which is almost every load, so
 * this stays cheap and never touches IndexedDB to find that out.
 */
export function readShareRequest(search: string): { id: string } | "failed" | null {
  const value = new URLSearchParams(search).get(SHARE_PARAM);

  if (!value) {
    return null;
  }

  return value === SHARE_FAILED ? "failed" : { id: value };
}

/**
 * Take the URL's share marker out of the address bar.
 *
 * Without this, reloading the page — or restoring the tab tomorrow — asks for
 * the same share again. The second attempt finds nothing (the record is
 * deleted on the first) and the form would open empty for no visible reason.
 * `replaceState` rather than `pushState` so the Back button is not left
 * pointing at a URL that no longer means anything.
 */
export function clearShareFromUrl(): void {
  try {
    window.history.replaceState({}, "", window.location.pathname);
  } catch {
    // Some embedded browsers refuse replaceState. A stale query parameter is
    // harmless next to a thrown error during startup.
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // The worker normally creates the store first, but the page can win the
    // race on a cold start, so both sides have to be able to create it.
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Read the shared payload and delete it, in one transaction.
 *
 * DESTRUCTIVE, and that is the point. This runs on a page load whose URL says
 * a share is waiting; if the read left the record behind, the same photo would
 * be offered again on the next load, and a second receipt for a payment that
 * was already recorded is a genuinely expensive mistake. Read-and-delete
 * together means the payload is handed over exactly once.
 *
 * Returns `null` rather than throwing for every failure — no record, private
 * browsing with IndexedDB disabled, a quota error. The caller's fallback is to
 * open the form empty, which is the app working normally, so none of these are
 * worth interrupting anybody over.
 */
export async function takeSharedPayload(id: string): Promise<SharedPayload | null> {
  if (typeof indexedDB === "undefined") {
    return null;
  }

  let database: IDBDatabase | null = null;

  try {
    database = await openDatabase();
    const db = database;

    return await new Promise<SharedPayload | null>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.get(id);
      let found: SharedPayload | null = null;

      request.onsuccess = () => {
        const record = request.result as
          | { files?: unknown; text?: unknown; title?: unknown }
          | undefined;

        if (!record) {
          return;
        }

        found = {
          files: Array.isArray(record.files)
            ? record.files.filter((entry): entry is File => entry instanceof File)
            : [],
          text: typeof record.text === "string" ? record.text : "",
          title: typeof record.title === "string" ? record.title : "",
        };

        // Inside the same transaction as the read, so there is no window in
        // which the payload has been handed over but still exists on disk.
        store.delete(id);
      };

      transaction.oncomplete = () => resolve(found);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    return null;
  } finally {
    database?.close();
  }
}
