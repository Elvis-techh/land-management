import { useCallback, useEffect, useState } from "react";

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
 * re-reading is the only way the numbers stay true.
 */
export function useContracts(enabled: boolean) {
  const [state, setState] = useState<ContractsState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", contracts: await fetchContracts() });
    } catch (caught) {
      setState({
        status: "error",
        message: caught instanceof Error ? caught.message : "No se pudo cargar los contratos.",
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
