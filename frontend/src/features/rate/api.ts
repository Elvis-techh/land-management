import { api } from "../../lib/api";

/** Where the rate on screen came from. `default` means nobody has set one yet. */
export type RateSource = "auto" | "manual" | "default";

export interface ExchangeRate {
  /** Lempiras per one US dollar. */
  rate: number;
  source: RateSource;
  provider: string | null;
  /** ISO timestamp of the reading, or `null` for the built-in placeholder. */
  capturedAt: string | null;
  /** The server's verdict: older than two days, or never set at all. */
  isStale: boolean;
  providerName: string;
}

export function fetchExchangeRate() {
  return api.get<ExchangeRate>("/api/exchange-rate");
}

/** Set the rate by hand. It then holds until someone asks for automatic again. */
export function setManualRate(rate: number) {
  return api.post<ExchangeRate>("/api/exchange-rate", { rate });
}

/** Hand control back to the market feed, taking a reading immediately. */
export function useMarketRate() {
  return api.post<ExchangeRate>("/api/exchange-rate/auto");
}
