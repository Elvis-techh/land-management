import { useCallback, useEffect, useState } from "react";

import type { LotsData } from "./api";
import { fetchLots } from "./api";

type LotsState =
  | { status: "loading" }
  | { status: "ready"; data: LotsData }
  | { status: "error"; message: string };

/**
 * Loads the inventory from the API and hands back a `reload` function.
 *
 * After any write — an edit, an archive — call `reload()` rather than patching
 * the local array by hand. The server is the authority on derived values like
 * lot status and paid-to-date, so re-reading it is how the screen stays honest.
 */
export function useLots(enabled: boolean) {
  const [state, setState] = useState<LotsState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", data: await fetchLots() });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "No se pudo cargar el inventario.";

      /*
       * A failed REFRESH leaves what is on screen alone.
       *
       * This used to be unconditional, and it was safe while `reload` only ever
       * ran because somebody pressed something — an error then was an answer to
       * a question they had just asked. Since lib/liveUpdates.ts, it also runs
       * on its own, when a teammate writes and when the tab comes back to the
       * front. Blanking a working screen into an error card because one
       * background request lost the wifi for a second would be a worse bug than
       * the staleness it replaced.
       *
       * The first load has nothing to keep, so it still reports the failure —
       * which is the case the error card and its Reintentar button are for.
       */
      setState((current) =>
        current.status === "ready" ? current : { status: "error", message },
      );
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      void reload();
    }
  }, [enabled, reload]);

  return { state, reload };
}
