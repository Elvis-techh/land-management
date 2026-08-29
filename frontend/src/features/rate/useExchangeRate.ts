import { useCallback, useEffect, useState } from "react";

import type { ExchangeRate } from "./api";
import { fetchExchangeRate } from "./api";
import { FALLBACK_USD_RATE } from "../../lib/money";

/**
 * The rate shown in the header, and used to convert every figure on screen when
 * the user switches to USD.
 *
 * Starts on the fallback so the first paint has a number rather than a gap, and
 * is replaced as soon as the server answers. A failed load is not an error
 * worth interrupting anybody over — money still displays in lempiras, which is
 * what it is stored in.
 */
const PLACEHOLDER: ExchangeRate = {
  rate: FALLBACK_USD_RATE,
  source: "default",
  provider: null,
  capturedAt: null,
  isStale: true,
  providerName: "",
};

export function useExchangeRate(enabled: boolean) {
  const [rate, setRate] = useState<ExchangeRate>(PLACEHOLDER);

  const reload = useCallback(async () => {
    setRate(await fetchExchangeRate());
  }, []);

  useEffect(() => {
    if (enabled) {
      void reload().catch(() => undefined);
    }
  }, [enabled, reload]);

  return { rate, setRate, reload };
}
