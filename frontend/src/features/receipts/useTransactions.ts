import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../lib/api";
import { fetchTransactions } from "./api";
import type { Transaction } from "../../types";

type TransactionsState =
  | { status: "loading" }
  | { status: "ready"; transactions: Transaction[] }
  | { status: "error"; message: string };

/**
 * Loads every posted transaction and hands back a `reload`.
 *
 * Like `useCustomers` and `useContracts`, this re-reads after every write
 * rather than patching the local array — and here it matters more than anywhere
 * else in the app. Every balance on a receipt is derived from the whole ledger,
 * so issuing, correcting or voiding ONE transaction changes the figures on
 * every receipt after it. Only the server knows the state afterwards.
 *
 * One request feeds both views of the screen. Grouping by customer happens in
 * `transactionSort.ts`, from this same array, so the two can never disagree
 * about what exists. A 401 on refresh goes to `onSessionExpired`, not the error
 * card.
 */
export function useTransactions(enabled: boolean, onSessionExpired: () => void) {
  const [state, setState] = useState<TransactionsState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", transactions: await fetchTransactions() });
    } catch (caught) {
      if (caught instanceof ApiError && caught.isUnauthenticated) {
        onSessionExpired();
        return;
      }
      setState({
        status: "error",
        message:
          caught instanceof Error ? caught.message : "No se pudieron cargar las transacciones.",
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
