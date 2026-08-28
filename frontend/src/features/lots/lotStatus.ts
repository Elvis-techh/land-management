import type { Lot, LotStatus } from "../../types";

/**
 * Derives a lot's availability from what is holding it.
 *
 * This is the frontend mirror of a rule the backend will own once contracts
 * exist. It is written as a function rather than a stored field so that a lot
 * can never be "Disponible" while a contract sits against it.
 */
export function lotStatus(lot: Lot): LotStatus {
  if (lot.holding === null) {
    return "available";
  }

  return lot.holding.kind === "reservation" ? "reserved" : "sold";
}
