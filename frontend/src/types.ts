import type { AreaUnit } from "./lib/area";
import type { Cents } from "./lib/money";

/** The five screens in the sidebar. */
export type TabId =
  | "dashboard"
  | "lots"
  | "projects"
  | "contracts"
  | "customers"
  | "receipts"
  | "audit"
  | "permissions";

/**
 * A project, with the counts the Proyectos screen shows.
 *
 * Every count is computed by the server from lots and contracts on each read —
 * none of it is stored. A cached "24 lotes" is wrong the moment somebody
 * archives a lot, and a project summary that disagrees with the Lotes tab is
 * worse than no summary at all.
 */
export interface Project {
  id: string;
  name: string;
  /**
   * The unit this project's areas are entered and shown in. Areas are always
   * STORED in square metres — see lib/area.ts.
   */
  areaUnit: AreaUnit;
  /** `null` while the project is active. Projects are archived, never deleted. */
  archivedAt: string | null;
  /** Active lots only; archived lots are not inventory. */
  lotCount: number;
  availableCount: number;
  reservedCount: number;
  soldCount: number;
  /** Sum of the BASE prices of its active lots, in centavos. */
  inventoryValue: Cents;
  /** Total land in the project, in square metres. */
  areaM2: number;
}

export interface Customer {
  id: string;
  fullName: string;
  /** Número de identidad. */
  identification: string;
  phone: string;
  email: string | null;
  address: string | null;
  /** Year this person became a customer. */
  customerSince: number;
}

/**
 * What is holding a lot right now.
 *
 * A reservation is a temporary hold; a contract is a signed sale. Either one
 * takes the lot off the market, which is why they are modelled together.
 */
export type HoldingKind = "reservation" | "contract";

/**
 * The link between a lot and the customer who has taken it.
 *
 * Note that this lives on the LOT side purely for display convenience. In the
 * database the relationship belongs to the contract: a contract references one
 * customer and one lot. The API will assemble this object for the lots list so
 * the table does not have to make a second request per row.
 */
export interface LotHolding {
  contractId: string;
  /** Human-facing contract number, e.g. "CT-2026-014". */
  contractCode: string;
  customerId: string;
  kind: HoldingKind;
  /** Agreed sale price, in lempira centavos. */
  salePrice: Cents;
  /**
   * Total posted payments, in lempira centavos.
   *
   * The backend computes this by summing the contract's payments. It is never
   * typed in by a user, and the remaining balance is `salePrice - paidToDate`.
   */
  paidToDate: Cents;
}

/**
 * Whether a lot can currently be sold.
 *
 * This is NOT a stored field. It is derived from `Lot.holding` — see
 * `features/lots/lotStatus.ts`. Storing it alongside the holding would create
 * two sources of truth that can disagree, which is exactly the spreadsheet
 * problem Lindero exists to remove.
 */
export type LotStatus = "available" | "reserved" | "sold";

export interface Lot {
  id: string;
  /** Lot number shown to staff, e.g. "A-07". */
  code: string;
  projectName: string;
  /** Surface area in square metres. */
  areaM2: number;
  /** Base price in lempira centavos. */
  basePrice: Cents;
  /** `null` means nobody has taken this lot — it is available. */
  holding: LotHolding | null;
  /**
   * ISO timestamp of when this lot was archived, or `null` if it is active.
   *
   * Lindero archives rather than deletes. A row that ever had a contract, a
   * payment, or a receipt against it must remain readable forever, or the
   * history stops adding up. Archived lots are hidden from the working list
   * and excluded from inventory counts.
   */
  archivedAt: string | null;
}
