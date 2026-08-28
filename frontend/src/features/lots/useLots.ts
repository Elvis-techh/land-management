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
      setState({
        status: "error",
        message: caught instanceof Error ? caught.message : "No se pudo cargar el inventario.",
      });
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      void reload();
    }
  }, [enabled, reload]);

  return { state, reload };
}
