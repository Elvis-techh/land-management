import { useCallback, useEffect, useState } from "react";

import { fetchCustomers } from "./api";
import type { CustomerRecord } from "../../types";

type CustomersState =
  | { status: "loading" }
  | { status: "ready"; customers: CustomerRecord[] }
  | { status: "error"; message: string };

/**
 * Loads the customers and hands back a `reload`.
 *
 * Like `useLots` and `useProjects`, this re-reads after every write rather than
 * patching the local array: each customer's contracts and paid-to-date are
 * derived server-side, so only the server knows the state after a change.
 */
export function useCustomers(enabled: boolean) {
  const [state, setState] = useState<CustomersState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", customers: await fetchCustomers() });
    } catch (caught) {
      setState({
        status: "error",
        message: caught instanceof Error ? caught.message : "No se pudieron cargar los clientes.",
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
