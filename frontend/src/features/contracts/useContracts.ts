import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../lib/api";
import type { Contract } from "../../types";
import { fetchContracts } from "./api";

type ContractsState =
  | { status: "loading" }
  | { status: "ready"; contracts: Contract[] }
  | { status: "error"; message: string };

/**
 * Loads the contracts from the API and hands back a `reload` function.
 *
 * After any write, call `reload()` rather than patching the local array. Almost
 * everything on this screen — the balance, the arrears, the payment health, the
 * next due date — is computed by the server at the moment of the request, so
 * re-reading is the only way the numbers stay true. A 401 on refresh goes to
 * `onSessionExpired`, not the error card.
 */
export function useContracts(enabled: boolean, onSessionExpired: () => void) {
  const [state, setState] = useState<ContractsState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", contracts: await fetchContracts() });
    } catch (caught) {
      if (caught instanceof ApiError && caught.isUnauthenticated) {
        onSessionExpired();
        return;
      }
      setState({
        status: "error",
        message: caught instanceof Error ? caught.message : "No se pudo cargar los contratos.",
      });
    }
  }, [onSessionExpired]);

  useEffect(() => {
    if (enabled) {
      void reload();
    }
  }, [enabled, reload]);

  return { state, reload };
}
