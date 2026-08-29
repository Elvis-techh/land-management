import { randomUUID } from "node:crypto";

import { desc } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { exchangeRates } from "../db/schema.js";
import { parseTimestamp } from "./time.js";

/**
 * The lempira-per-dollar rate shown in the interface.
 *
 * DISPLAY ONLY, and worth repeating because the distinction is the whole
 * design: this converts figures on screen so a buyer can be told roughly what a
 * lot costs in dollars. It never computes a balance. Every payment stores the
 * rate it was actually settled at, and the accounts are built from those.
 *
 * The provider publishes an indicative market rate. It is not the rate a
 * Honduran bank pays out at, which carries a buy/sell spread, and it is not the
 * Banco Central's official rate. It is a good default for a price tag and a bad
 * one for a receipt.
 */
export const PROVIDER_NAME = "exchangerate-api.com";

const PROVIDER_URL = "https://open.er-api.com/v6/latest/USD";

const FETCH_TIMEOUT_MS = 8000;

/**
 * What to show before the first reading ever arrives — a fresh install with no
 * internet. Marked as `default` in the API response so the interface can say
 * the number is a placeholder rather than a quote.
 */
export const FALLBACK_RATE = 24.7;

/** A reading older than this is shown as stale rather than as today's number. */
const STALE_AFTER_HOURS = 48;

/**
 * Rates outside this range are refused. A provider outage that returns 0, or a
 * fat-fingered 2682 instead of 26.82, would otherwise quietly multiply every
 * dollar figure on screen by a hundred.
 */
const MIN_RATE = 1;
const MAX_RATE = 1000;

export type RateSource = "auto" | "manual";

export interface RateReading {
  rate: number;
  source: RateSource | "default";
  provider: string | null;
  capturedAt: string | null;
  setBy: string | null;
}

export function isPlausibleRate(rate: number): boolean {
  return Number.isFinite(rate) && rate > MIN_RATE && rate < MAX_RATE;
}

/**
 * Ask the provider what a dollar is worth in lempiras.
 *
 * Throws on anything unusable — a timeout, a bad payload, an implausible
 * number. Callers decide what to do about it; the one thing they must not do is
 * write a number they cannot vouch for.
 */
export async function fetchMarketRate(): Promise<number> {
  const response = await fetch(PROVIDER_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`El proveedor respondió ${response.status}.`);
  }

  const payload = (await response.json()) as { rates?: Record<string, unknown> };
  const value = payload.rates?.HNL;

  if (typeof value !== "number" || !isPlausibleRate(value)) {
    throw new Error("El proveedor no devolvió una tasa de lempiras utilizable.");
  }

  return value;
}

/** The rate in force: the most recent reading, whatever its source. */
export function readCurrentRate(db: Db): RateReading {
  const row = db
    .select()
    .from(exchangeRates)
    .orderBy(desc(exchangeRates.capturedAt))
    .limit(1)
    .get();

  if (!row) {
    return {
      rate: FALLBACK_RATE,
      source: "default",
      provider: null,
      capturedAt: null,
      setBy: null,
    };
  }

  return {
    rate: Number(row.rate),
    source: row.source === "manual" ? "manual" : "auto",
    provider: row.provider,
    capturedAt: row.capturedAt,
    setBy: row.setBy,
  };
}

export function isStale(reading: RateReading): boolean {
  if (reading.capturedAt === null) {
    return true;
  }

  const capturedAt = parseTimestamp(reading.capturedAt);

  if (Number.isNaN(capturedAt)) {
    return true;
  }

  return Date.now() - capturedAt > STALE_AFTER_HOURS * 60 * 60 * 1000;
}

interface RecordRateInput {
  rate: number;
  source: RateSource;
  /** Null for automatic readings — nobody typed them. */
  actorId: string | null;
}

/**
 * Append a reading. Nothing is ever overwritten; the newest row wins.
 *
 * Takes a transaction handle as readily as the database handle, so a rate and
 * its audit row commit together — the same arrangement `recordAudit` uses.
 */
export function recordRate(db: Pick<Db, "insert">, input: RecordRateInput): RateReading {
  const row = db
    .insert(exchangeRates)
    .values({
      id: randomUUID(),
      // `String(number)` keeps the provider's decimals without inventing any.
      rate: String(input.rate),
      source: input.source,
      provider: input.source === "auto" ? PROVIDER_NAME : null,
      setBy: input.actorId,
      capturedAt: new Date().toISOString(),
    })
    .returning()
    .get();

  return {
    rate: Number(row.rate),
    source: input.source,
    provider: row.provider,
    capturedAt: row.capturedAt,
    setBy: row.setBy,
  };
}

/**
 * Fetch and store today's rate, unless a supervisor has taken manual control.
 *
 * A manual rate is a deliberate decision — usually because the market feed
 * disagrees with what the bank is actually paying — so the scheduler leaves it
 * alone until somebody explicitly asks for automatic updates again. Silently
 * overwriting it a few hours later would make the override useless.
 */
export async function refreshAutomaticRate(
  db: Db,
): Promise<{ status: "updated" | "skipped_manual" | "failed"; rate?: number; error?: string }> {
  if (readCurrentRate(db).source === "manual") {
    return { status: "skipped_manual" };
  }

  try {
    const rate = await fetchMarketRate();
    recordRate(db, { rate, source: "auto", actorId: null });
    return { status: "updated", rate };
  } catch (caught) {
    // A failed fetch keeps the last known reading. Showing an old rate labelled
    // with its age is honest; showing nothing, or a guess, is not.
    return { status: "failed", error: caught instanceof Error ? caught.message : "desconocido" };
  }
}
