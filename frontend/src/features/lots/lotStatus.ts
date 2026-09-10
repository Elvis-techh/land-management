import type { Lot, LotStatus } from "../../types";

/**
 * Derives a lot's standing from what is holding it.
 *
 * Two questions, answered together: can this lot be sold, and do we still own
 * it? The second one is the reason this function reads the contract's sale type
 * rather than only its kind.
 *
 * A crédito is not a completed sale. The customer is paying monthly and the
 * land stays ours until they finish, so it cannot wear the same word as a lot
 * bought outright — that is precisely what made a live crédito and a contado
 * sale indistinguishable on this screen. A donación is the opposite case: the
 * lot really is gone, but nobody bought it, so calling it "Vendido" would count
 * a giveaway as revenue.
 *
 * The one case the sale type cannot settle by itself is a crédito that has been
 * paid off. Nothing is left to collect and the land has changed hands, so it
 * reads as sold — the same as a contado sale, which is what it has become.
 *
 * This is the frontend mirror of a rule the backend also applies when counting
 * a project's lots (routes/projects.ts). It is written as a function rather
 * than a stored field so that a lot can never be "Disponible" while a contract
 * sits against it.
 */
export function lotStatus(lot: Lot): LotStatus {
  if (lot.holding === null) {
    return "available";
  }

  // A hold, whatever it was going to be paid with. It has not been sold on any
  // terms yet, so the terms do not get a say here.
  if (lot.holding.kind === "reservation") {
    return "reserved";
  }

  if (lot.holding.saleType === "donation") {
    return "donated";
  }

  if (lot.holding.saleType === "cash") {
    return "sold";
  }

  return lot.holding.status === "paid_off" ? "sold" : "financed";
}
