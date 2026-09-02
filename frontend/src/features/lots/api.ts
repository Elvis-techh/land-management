import { api } from "../../lib/api";
import { toAreaUnit } from "../../lib/area";
import type { AreaUnit } from "../../lib/area";
import { cents } from "../../lib/money";
import type { Customer, Lot } from "../../types";

/** Exactly what GET /api/lots sends back. Money arrives as whole centavos. */
interface LotsResponse {
  lots: Array<{
    id: string;
    code: string;
    projectName: string;
    areaM2: number;
    basePrice: number;
    archivedAt: string | null;
    holding: {
      contractId: string;
      contractCode: string;
      customerId: string;
      kind: "reservation" | "contract";
      salePrice: number;
      paidToDate: number;
    } | null;
  }>;
  customers: Customer[];
  projects: Array<{ id: string; name: string; areaUnit: string }>;
}

export interface LotsData {
  lots: Lot[];
  customersById: Map<string, Customer>;
  /** Every ACTIVE project, including ones with no lots yet — the new-lot form needs them. */
  projectNames: string[];
  /**
   * The area unit each project is written in, by project name.
   *
   * Areas are stored in square metres everywhere; this only says how to show
   * and capture them. See lib/area.ts.
   */
  unitByProject: Map<string, AreaUnit>;
}

/**
 * Fetch the inventory and brand every money field as `Cents`.
 *
 * JSON has no way to say "this number is centavos", so the branding happens
 * here, at the boundary. Past this point TypeScript will not let a plain number
 * be used where money is expected.
 *
 * Archived lots come along too — the Lotes screen keeps them out of the working
 * list itself and shows them only behind the "Archivados" toggle, so a lot
 * archived by mistake can be found and restored.
 */
export async function fetchLots(): Promise<LotsData> {
  const response = await api.get<LotsResponse>("/api/lots?includeArchived=true");

  return {
    lots: response.lots.map((lot) => ({
      id: lot.id,
      code: lot.code,
      projectName: lot.projectName,
      areaM2: lot.areaM2,
      basePrice: cents(lot.basePrice),
      archivedAt: lot.archivedAt,
      holding: lot.holding
        ? {
            contractId: lot.holding.contractId,
            contractCode: lot.holding.contractCode,
            customerId: lot.holding.customerId,
            kind: lot.holding.kind,
            salePrice: cents(lot.holding.salePrice),
            paidToDate: cents(lot.holding.paidToDate),
          }
        : null,
    })),
    customersById: new Map(response.customers.map((customer) => [customer.id, customer])),
    projectNames: response.projects.map((project) => project.name),
    unitByProject: new Map(
      response.projects.map((project) => [project.name, toAreaUnit(project.areaUnit)]),
    ),
  };
}

export interface LotUpdate {
  code: string;
  projectName: string;
  areaM2: number;
  basePriceCents: number;
}

export function createLot(lot: LotUpdate) {
  return api.post<{ lot: { id: string; code: string } }>("/api/lots", lot);
}

export function updateLot(lotId: string, changes: LotUpdate) {
  return api.patch<{ lot: { id: string; code: string } }>(`/api/lots/${lotId}`, changes);
}

export function archiveLot(lotId: string, reason: string) {
  return api.post<{ ok: boolean; archivedAt: string }>(`/api/lots/${lotId}/archive`, { reason });
}

export function restoreLot(lotId: string) {
  return api.post<{ ok: boolean }>(`/api/lots/${lotId}/restore`);
}
