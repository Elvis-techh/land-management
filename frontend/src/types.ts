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
  | "permissions"
  | "users";

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
  /**
   * Número de identidad, or `null` when the customer has not given one.
   *
   * Optional: an identidad is confidential and is often not available when
   * somebody is first written down. Unique among those who HAVE given one, so
   * a real number still cannot be entered twice. Never render it without
   * checking — an "Identidad" label with nothing after it reads as lost data.
   */
  identification: string | null;
  /**
   * Stored in E.164, e.g. "+50499824471" — see lib/phone.ts.
   *
   * Never printed raw. Run it through `formatPhone` first, which writes it back
   * out as "9982-4471". It is stored with its country code because this is the
   * number a WhatsApp receipt will be sent to.
   */
  phone: string;
  email: string | null;
  address: string | null;
  /** Year this person became a customer. */
  customerSince: number;
  /**
   * Free text: how they pay, who to call instead, what was agreed verbally.
   * The column that stops people keeping a second list somewhere else.
   */
  notes: string | null;
}

/**
 * One contract a customer currently holds, as the Clientes screen needs it.
 *
 * Assembled by the server from the contract, its lot and its payments. Like
 * `LotHolding`, none of this is stored on the customer: a "2 contratos" written
 * on the customer row would be wrong the moment a contract was cancelled, and
 * nobody would find out.
 */
export interface CustomerContract {
  contractId: string;
  /** Human-facing contract number, e.g. "CT-2026-014". */
  contractCode: string;
  kind: HoldingKind;
  lotCode: string;
  projectName: string;
  /** Agreed sale price, in lempira centavos. */
  salePrice: Cents;
  /** Total posted payments, in lempira centavos. Summed, never stored. */
  paidToDate: Cents;
}

/** A customer with everything they are currently holding. */
export interface CustomerRecord extends Customer {
  /**
   * ACTIVE contracts only. Cancelled, defaulted and paid-off contracts belong
   * to the customer's history rather than to "what are they holding now".
   */
  contracts: CustomerContract[];
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

/* -------------------------------------------------------------------------- */
/* Contracts                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How the lot is being paid for — the Crédito / Comprado / Donación split.
 *
 * A separate question from `HoldingKind`, which asks whether this is a hold or
 * a signed sale. A reservation can be on credit, and a donation is still a
 * contract; collapsing the two axes into one column is what made the old
 * spreadsheet unable to answer either.
 */
export type SaleType = "financed" | "cash" | "donation";

/** The contract's own lifecycle. Stored on the row. */
export type ContractStatus = "draft" | "active" | "paid_off" | "cancelled" | "defaulted";

/**
 * Payment health, the THIRD concept, computed by the server from the schedule
 * and the posted payments on every read.
 *
 * Never stored, and deliberately not merged with `ContractStatus`: a contract
 * can be perfectly active and two months behind, and one word cannot say both.
 */
export type PaymentHealth = "current" | "due_soon" | "overdue" | "at_risk";

/** What was agreed. Only `financed` is computed — the rest is on the contract. */
export interface ContractTerms {
  salePrice: Cents;
  /** The prima as AGREED. Whether it arrived is `downPaymentPaid`. */
  downPayment: Cents;
  /** Derived: salePrice − downPayment. Never a stored column. */
  financed: Cents;
  /** Null on a cash sale or a donation, which have no schedule. */
  termMonths: number | null;
  monthlyPayment: Cents | null;
  dueDay: number | null;
  /** YYYY-MM-DD. The date the schedule counts from, not the row's insert date. */
  signedOn: string;
  /** When the first installment falls due. Derived from `signedOn` if not agreed. */
  firstDueOn: string | null;
  /**
   * The date that was NEGOTIATED, or `null` when it simply follows from the
   * signing date.
   *
   * Kept apart from `firstDueOn` because the edit form has to know which of the
   * two it is looking at: saving a derived date back would pin it, and the
   * schedule would then stop following a later correction to `signedOn`.
   */
  firstDueOnAgreed: string | null;
  /** Only meaningful on a reservation: the date the hold lapses. */
  expiresOn: string | null;
}

/** Where the contract stands today. Every field is computed by the server. */
export interface ContractHealth {
  status: PaymentHealth;
  /** What is late right now, after the five-day grace. Zero when up to date. */
  arrears: Cents;
  monthsBehind: number;
  /** Customers here routinely pay two months at once. */
  monthsAhead: number;
  nextDueOn: string | null;
  nextDueAmount: Cents;
  /** Nothing further is owed. Kept apart from the lifecycle above. */
  settled: boolean;
}

/**
 * One contract: one customer, one lot.
 *
 * A customer who bought three lots at once has three of these sharing a
 * `saleGroupId` — one purchase, three balances, because lots are released and
 * titled one at a time. The Contratos screen groups them back together for
 * display; the money stays separate underneath.
 */
export interface Contract {
  id: string;
  /** Human-facing number, e.g. "CT-2026-014". Assigned by the server. */
  code: string;
  /** The purchase this belongs to, or null when the lot was bought alone. */
  saleGroupId: string | null;
  kind: HoldingKind;
  saleType: SaleType;
  status: ContractStatus;
  /**
   * A reservation whose `expiresOn` has passed. The `status` is still
   * `"active"` — nothing rewrites the row — but the hold has lapsed: the lot is
   * available again and this contract reads as "Vencida". Derived by the server
   * on every request, like the payment health.
   */
  expired: boolean;
  lot: {
    id: string;
    code: string;
    projectName: string;
    areaM2: number;
  };
  customer: {
    id: string;
    fullName: string;
    /** E.164 — run it through `formatPhone` before showing it. */
    phone: string;
    /** `null` when none was given. The Escribir action is disabled, not hidden. */
    email: string | null;
  };
  terms: ContractTerms;
  /** Summed from payments of type `down_payment`, not the agreed figure. */
  downPaymentPaid: Cents;
  paidToDate: Cents;
  /** salePrice − paidToDate, computed server-side. Never typed in. */
  balance: Cents;
  health: ContractHealth;
  /** How many installments the schedule works out to. */
  installmentCount: number;
  closedAt: string | null;
  closedReason: string | null;
  /**
   * What was decided about money already paid, when the contract was
   * cancelled: `"none"` (kept as income), `"held"` (retained, decision
   * pending), or `"refunded"` (payments reversed). `null` when nothing had
   * been paid, or the contract is still active.
   */
  closedSettlement: "none" | "held" | "refunded" | null;
  notes: string | null;
  /**
   * How many files of signed paperwork this contract has on file.
   *
   * A COUNT, not the documents — the list is every contract in the business and
   * each can carry a dozen scans. The panel asks for the actual list when a
   * contract is opened. Zero for everything written before documents existed,
   * which is why the screen marks the contracts that HAVE their paperwork
   * rather than flagging the ones that do not.
   */
  documentCount: number;
}

/**
 * One file of signed paperwork behind a contract.
 *
 * The legal instrument itself, or something that travelled with it: an adenda,
 * a copy of a party's identidad, the plano. Distinct from `ReceiptAttachment`
 * in meaning rather than in shape — that one is a customer's evidence for a
 * payment and can be removed when it is the wrong screenshot; this is the
 * document a dispute is settled by, which is why removing it takes a
 * capability an associate does not have.
 */
export interface ContractDocument {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  /** The name of whoever filed it — the question asked of a document later. */
  uploadedBy: string;
}

/* -------------------------------------------------------------------------- */
/* Receipts                                                                    */
/* -------------------------------------------------------------------------- */

/** One cuota a payment went towards, in whole or in part. */
export interface AppliedInstallment {
  /** 1-based, as a person would say it: "la cuota 7 de 24". */
  number: number;
  dueOn: string;
  /** What this payment put towards it — not the installment's full amount. */
  applied: Cents;
  /** Was the cuota left fully covered afterwards? */
  settled: boolean;
}

/**
 * One lot's line on a receipt.
 *
 * A customer holding three lots hands over a single amount and gets a single
 * document, but the money lands on three contracts and each keeps its own
 * balance — so the receipt carries a line per lot rather than one merged total.
 */
export interface ReceiptLine {
  paymentId: string;
  contractId: string;
  contractCode: string | null;
  lotCode: string | null;
  projectName: string | null;
  amount: Cents;
  type: string;
  /** The sale price of this lot's contract — "Valor Total del Contrato". */
  contractTotal: Cents;
  /** How many cuotas the contract has in all. Zero for a cash sale. */
  installmentCount: number;
  /** Derived by replaying the ledger, never stored. */
  previousBalance: Cents;
  newBalance: Cents;
  /** Which cuotas this money went towards. */
  appliedTo: AppliedInstallment[];
}

/**
 * A receipt: the document, not the money.
 *
 * Every balance on it is DERIVED by the server on read, by replaying the
 * customer's transactions in order — see backend/src/lib/ledger.ts. None of
 * them is a stored column, which is what lets a correction to an older payment
 * flow through into every receipt after it instead of leaving frozen numbers
 * that no longer add up.
 */
export interface Receipt {
  id: string;
  /** The sequence, as an integer. Never reused, even after a void. */
  number: number;
  /** What is printed on the paper: "IM-482739156034". Random, always 12 digits. */
  code: string;
  /**
   * A short, random, unguessable code for looking the receipt up.
   *
   * Deliberately not the sequence: this one goes in a link sent over WhatsApp,
   * and a predictable code would let anybody holding one receipt walk the
   * numbers and read every other customer's.
   */
  lookupCode: string;
  issuedOn: string;
  note: string | null;
  /** Set when the receipt was voided. The row and the number both survive. */
  voidedAt: string | null;
  voidReason: string | null;
  supersededById: string | null;
  customer: { id: string; fullName: string; identification: string | null; phone: string };
  issuedBy: { id: string; name: string };
  /** What the customer handed over. Unaffected by a later void. */
  totalPaid: Cents;
  previousBalance: Cents;
  newBalance: Cents;
  /** Everything this customer has ever paid, across every lot, up to this receipt. */
  cumulativePaid: Cents;
  transactionCount: number;
  method: string | null;
  /** Empty on the list endpoint, populated on the detail one. */
  lines: ReceiptLine[];
  /** The customer's proof of transfer. Empty on the list endpoint. */
  attachments: ReceiptAttachment[];
}


/**
 * One posted transaction, with everything needed to make sense of it on screen.
 *
 * The Recibos screen is transaction-first: both of its views — the flat list by
 * date and the grouped list by customer — are built from one ordered array of
 * these, because grouping is a question about presentation and answering it
 * twice on the server is how two lists end up disagreeing about what exists.
 *
 * `receiptId` is null for money recorded before the receipts screen existed.
 * That is the truth, and it counts in every balance regardless.
 */
export interface Transaction {
  id: string;
  amount: Cents;
  /** What the customer handed over, before conversion. */
  originalAmount: Cents;
  originalCurrency: string;
  exchangeRate: string;
  /** YYYY-MM-DD — the day the money moved, not the day it was typed in. */
  paidOn: string;
  method: string;
  type: string;
  /** The bank's confirmation number, for a transfer. */
  reference: string | null;
  notes: string | null;
  /** Set once reversed. The row keeps its amount but stops counting. */
  reversedAt: string | null;
  reversalReason: string | null;
  createdAt: string;
  contractId: string;
  contractCode: string;
  contractStatus: string;
  lotCode: string;
  projectName: string;
  customerId: string;
  customerName: string;
  customerIdentification: string;
  /** Null when this money has never been printed on a receipt. */
  receiptId: string | null;
  receiptCode: string | null;
  receiptVoidedAt: string | null;
  recordedByName: string;
  /**
   * The comprobantes behind THIS row — its own, plus any filed against the
   * receipt as a whole.
   *
   * Sent with the list rather than fetched when a row is opened, because the
   * thumbnail is the feature: checking that the right slip is attached should
   * cost a glance down the column, not a click and a wait per row. Metadata
   * only; the bytes are fetched per file and lazily by the browser.
   */
  attachments: ReceiptAttachment[];
}

/** A file attached to a receipt — the customer's proof of transfer. */
export interface ReceiptAttachment {
  id: string;
  /**
   * The payment — and so the lot — this file is evidence for, or null for one
   * that stands behind the whole receipt.
   *
   * Null is the ordinary case and always will be: one customer, one transfer,
   * one slip. It earns its place on the receipts that cover three lots at once,
   * where "which of these is the deposit for A-14" is a real question and the
   * answer used to live in somebody's memory.
   */
  paymentId: string | null;
  fileName: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
}
