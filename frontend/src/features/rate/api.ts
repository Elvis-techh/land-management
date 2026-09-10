import { api } from "../../lib/api";

/** Where the rate on screen came from. `default` means nobody has set one yet. */
export type RateSource = "auto" | "manual" | "default";

export interface ExchangeRate {
  /** Lempiras per one US dollar, with the adjustment below already in it. */
  rate: number;
  /**
   * What the provider actually said, before the adjustment. Null on a rate
   * somebody typed, and on readings taken before adjustments existed.
   */
  providerRate: number | null;
  /** How far `rate` sits from the provider's figure, in percent. */
  adjustmentPercent: number;
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

/**
 * Set how far the displayed rate sits from the provider's figure.
 *
 * Unlike a manual rate this is not an override: it stays pinned to the feed
 * and moves with it, which is what makes it the right tool for a gap that is a
 * spread rather than a disagreement.
 */
export function setRateAdjustment(percent: number) {
  return api.post<ExchangeRate>("/api/exchange-rate/adjustment", { percent });
}
