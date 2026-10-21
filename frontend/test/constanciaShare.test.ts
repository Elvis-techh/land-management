import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Constancia, ConstanciaPart } from "../src/features/constancias/api";
import { constanciaCaption } from "../src/features/constancias/constanciaShare";
import { cents } from "../src/lib/money";

function part(lotCode: string): ConstanciaPart {
  return {
    contract: { id: lotCode, code: `CT-${lotCode}`, salePrice: cents(5_000_000), signedOn: null },
    lot: { code: lotCode, projectName: "Proyecto Santiago" },
    payments: [],
    totalPaid: cents(5_000_000),
    lastPaidOn: null,
  };
}

function constancia(parts: ConstanciaPart[]): Constancia {
  return {
    id: "c1",
    code: "CC-48273915",
    lookupCode: "K7M2-9XQR",
    issuedOn: "2026-10-21",
    issuedBy: { name: "Gerencia" },
    voidedAt: null,
    voidReason: null,
    customer: { fullName: "María López", identification: null, phone: "+50498765432" },
    parts,
    salePrice: cents(5_000_000 * parts.length),
    totalPaid: cents(5_000_000 * parts.length),
    lastPaidOn: null,
  };
}

describe("constanciaCaption", () => {
  it("names the lot and the code to verify it with", () => {
    assert.equal(
      constanciaCaption(constancia([part("B-12")])),
      "Adjunto su *Constancia de Cancelación Total* del Lote B-12 del Proyecto Santiago. " +
        "Para verificarla, comuníquese con nosotros y dé el código *K7M2-9XQR*. Cualquier duda me deja saber.",
    );
  });

  it("names every lot of a combined one", () => {
    assert.match(
      constanciaCaption(constancia([part("B-12"), part("B-13")])),
      /^Adjunto su \*Constancia de Cancelación Total\* de sus 2 lotes: B-12 y B-13 del Proyecto Santiago\. /,
    );
  });
});
