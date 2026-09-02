import { api } from "../../lib/api";
import type { Cents } from "../../lib/money";
import { cents } from "../../lib/money";
import type { PaymentHealth, SaleType } from "../../types";
import type { DashboardLayout } from "./dashboardSections";

/**
 * The Panel General, as GET /api/dashboard sends it.
 *
 * One request for the whole screen rather than one per band. Every figure is
 * derived from the same contracts and the same payments in a single pass on the
 * server, so the bands cannot contradict each other — which eight separate
 * requests, read at eight slightly different moments, absolutely could.
 *
 * Money crosses the wire as plain JSON numbers, because JSON has no way to say
 * "these are centavos". The branding to `Cents` happens in `fetchDashboard`
 * below, at the boundary; past that point TypeScript refuses to let a raw
 * number stand in for money.
 */

/** One month of the history chart, or of the forward projection. */
export interface DashboardMonth {
  month: string;
  collectedCents: Cents;
  expectedCents: Cents;
  signedCount: number;
}

export interface ProjectionMonth {
  month: string;
  expectedCents: Cents;
  /** How many contracts have something falling due that month. */
  contracts: number;
}

/** A contract on the debtor worklist, or on one of the two change lists. */
export interface Debtor {
  contractId: string;
  contractCode: string;
  customerId: string;
  customerName: string;
  phone: string;
  lotCode: string;
  projectName: string;
  status: PaymentHealth;
  arrearsCents: Cents;
  balanceCents: Cents;
  monthsBehind: number;
  /** `null` for somebody who has never paid anything at all. */
  lastPaymentOn: string | null;
}

/**
 * One payment of the reported month, as it was counted into every total.
 *
 * The two breakdowns that open on the Panel General are groupings of this one
 * array — by customer for "Clientes que pagaron", by project for a project's
 * "Cobrado" — rather than lists fetched separately. That is what guarantees a
 * breakdown adds up to the figure it hangs under.
 */
export interface MonthPayment {
  id: string;
  customerId: string;
  customerName: string;
  contractId: string;
  contractCode: string;
  lotCode: string;
  projectId: string;
  projectName: string;
  amountCents: Cents;
  paidOn: string;
  /** "down_payment" | "installment" | "full_payment" | "adjustment". */
  type: string;
  /** "cash" | "transfer" | "card" — same open shape the Recibos tab uses. */
  method: string;
}

/** One contract signed in the reported month. */
export interface SignedContract {
  contractId: string;
  contractCode: string;
  customerId: string;
  customerName: string;
  lotCode: string;
  projectName: string;
  saleType: SaleType;
  signedOn: string;
  salePriceCents: Cents;
  downPaymentCents: Cents;
}

export interface HealthBucket {
  status: PaymentHealth;
  contracts: number;
  customers: number;
  balanceCents: Cents;
  arrearsCents: Cents;
}

export interface ProjectSummary {
  projectId: string;
  projectName: string;
  collectedCents: Cents;
  /** The previous month over the same span — see `income.previousToDateCents`. */
  previousToDateCents: Cents;
  outstandingCents: Cents;
  arrearsCents: Cents;
  activeContracts: number;
  behindContracts: number;
  lotsTotal: number;
  lotsAvailable: number;
  soldInWindow: number;
  /** `null` when nothing has sold, or nothing is left — never a misleading 0. */
  monthsOfStock: number | null;
}

export interface Dashboard {
  month: string;
  previousMonth: string;
  today: string;
  /** The date every "as of" figure was computed at. Today, or a month's end. */
  asOf: string;
  isCurrentMonth: boolean;

  income: {
    collectedCents: Cents;
    /**
     * The previous month counted only as far into it as we have got into this
     * one, so the first nine days of September are compared against the first
     * nine of August rather than against all thirty-one.
     */
    previousToDateCents: Cents;
    /** How many days of the previous month that span covers. */
    comparisonDays: number;
    expectedCents: Cents;
    /** Scheduled through this month's end and not yet received. */
    stillDueCents: Cents;
    stillDueContracts: number;
    payingCustomers: number;
    previousPayingCustomers: number;
    signedCount: number;
    signedValueCents: Cents;
    /** The rows behind `collectedCents` and `payingCustomers`. */
    payments: MonthPayment[];
    /** The rows behind `signedCount` and `signedValueCents`. */
    signed: SignedContract[];
    byType: {
      downPayment: Cents;
      installment: Cents;
      fullPayment: Cents;
      adjustment: Cents;
    };
    byMethod: { cash: Cents; transfer: Cents; card: Cents };
  };

  history: DashboardMonth[];

  collections: {
    buckets: HealthBucket[];
    /** Active contracts that owe nothing. Kept apart so the buckets add up. */
    settledContracts: number;
    worklist: Debtor[];
    slipped: Debtor[];
    recovered: Debtor[];
  };

  projects: ProjectSummary[];

  upcoming: {
    projection: ProjectionMonth[];
    expiringReservations: Array<{
      contractId: string;
      contractCode: string;
      customerName: string;
      lotCode: string;
      projectName: string;
      expiresOn: string;
    }>;
    finishingSoon: Array<{
      contractId: string;
      contractCode: string;
      customerName: string;
      lotCode: string;
      projectName: string;
      balanceCents: Cents;
      installmentsLeft: number;
    }>;
    unpaidPrimas: { contracts: number; amountCents: Cents };
  };

  /**
   * How this user has arranged the bands, or `null` if they never have.
   *
   * `null` is not the same as the default order and has to stay different: a
   * user who has never chosen follows the default as it changes in later
   * releases, and one who has chosen does not.
   */
  layout: DashboardLayout | null;

  /** `null` for anyone without `audit:view` — the server decides, not the UI. */
  control: {
    byUser: Array<{
      userId: string;
      userName: string;
      collectedCents: Cents;
      cashCents: Cents;
      payments: number;
    }>;
    voidedReceipts: Array<{
      id: string;
      code: string;
      issuedOn: string;
      voidedAt: string | null;
      voidReason: string | null;
      customerName: string;
      wasSuperseded: boolean;
    }>;
    unprovenTransfers: { count: number; amountCents: Cents };
  } | null;
}

/**
 * The same shape with money as plain numbers — what actually arrives.
 *
 * Spelled out rather than inferred so that adding a money field to the server
 * response and forgetting to brand it below is a compile error here, not a
 * number that quietly renders as "L. 0".
 */
type Raw<T> = T extends Cents
  ? number
  : T extends Array<infer Item>
    ? Array<Raw<Item>>
    : T extends object
      ? { [K in keyof T]: Raw<T[K]> }
      : T;

/** Brand a plain JSON number as centavos. */
const c = (value: number): Cents => cents(value);

export async function fetchDashboard(month?: string): Promise<Dashboard> {
  const raw = await api.get<Raw<Dashboard>>(
    month ? `/api/dashboard?month=${month}` : "/api/dashboard",
  );

  return {
    ...raw,
    // Reconciled where it is used, not here: this is what the server stored,
    // and `resolveLayout` is what turns it into something renderable.
    layout: raw.layout,

    income: {
      ...raw.income,
      collectedCents: c(raw.income.collectedCents),
      previousToDateCents: c(raw.income.previousToDateCents),
      expectedCents: c(raw.income.expectedCents),
      stillDueCents: c(raw.income.stillDueCents),
      signedValueCents: c(raw.income.signedValueCents),
      byType: {
        downPayment: c(raw.income.byType.downPayment),
        installment: c(raw.income.byType.installment),
        fullPayment: c(raw.income.byType.fullPayment),
        adjustment: c(raw.income.byType.adjustment),
      },
      byMethod: {
        cash: c(raw.income.byMethod.cash),
        transfer: c(raw.income.byMethod.transfer),
        card: c(raw.income.byMethod.card),
      },
      payments: raw.income.payments.map((row) => ({
        ...row,
        amountCents: c(row.amountCents),
      })),
      signed: raw.income.signed.map((row) => ({
        ...row,
        salePriceCents: c(row.salePriceCents),
        downPaymentCents: c(row.downPaymentCents),
      })),
    },

    history: raw.history.map((row) => ({
      ...row,
      collectedCents: c(row.collectedCents),
      expectedCents: c(row.expectedCents),
    })),

    collections: {
      ...raw.collections,
      buckets: raw.collections.buckets.map((bucket) => ({
        ...bucket,
        balanceCents: c(bucket.balanceCents),
        arrearsCents: c(bucket.arrearsCents),
      })),
      worklist: raw.collections.worklist.map(brandDebtor),
      slipped: raw.collections.slipped.map(brandDebtor),
      recovered: raw.collections.recovered.map(brandDebtor),
    },

    projects: raw.projects.map((project) => ({
      ...project,
      collectedCents: c(project.collectedCents),
      previousToDateCents: c(project.previousToDateCents),
      outstandingCents: c(project.outstandingCents),
      arrearsCents: c(project.arrearsCents),
    })),

    upcoming: {
      ...raw.upcoming,
      projection: raw.upcoming.projection.map((row) => ({
        ...row,
        expectedCents: c(row.expectedCents),
      })),
      finishingSoon: raw.upcoming.finishingSoon.map((row) => ({
        ...row,
        balanceCents: c(row.balanceCents),
      })),
      unpaidPrimas: {
        ...raw.upcoming.unpaidPrimas,
        amountCents: c(raw.upcoming.unpaidPrimas.amountCents),
      },
    },

    control: raw.control
      ? {
          ...raw.control,
          byUser: raw.control.byUser.map((row) => ({
            ...row,
            collectedCents: c(row.collectedCents),
            cashCents: c(row.cashCents),
          })),
          unprovenTransfers: {
            ...raw.control.unprovenTransfers,
            amountCents: c(raw.control.unprovenTransfers.amountCents),
          },
        }
      : null,
  };
}

function brandDebtor(row: Raw<Debtor>): Debtor {
  return {
    ...row,
    arrearsCents: c(row.arrearsCents),
    balanceCents: c(row.balanceCents),
  };
}

/**
 * Save this user's arrangement.
 *
 * The server takes no user id — it writes for whoever the session says you are,
 * which is why there is no shape of this call that rearranges somebody else's
 * screen.
 */
export function saveDashboardLayout(layout: DashboardLayout) {
  return api.put<{ layout: DashboardLayout }>("/api/dashboard/layout", layout);
}

/**
 * Go back to following the default order.
 *
 * A DELETE rather than a save of today's default, so this user keeps tracking
 * the default as it changes rather than freezing the version they reset to.
 */
export function resetDashboardLayout() {
  return api.delete<{ layout: null }>("/api/dashboard/layout");
}
