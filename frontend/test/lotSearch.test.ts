import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { searchLots } from "../src/features/lots/lotFilters";
import { cents } from "../src/lib/money";
import type { Customer, Lot } from "../src/types";

/*
 * #5: the Lotes search box. It finds a lot by its own code and project, and by
 * who holds it, so "¿qué lote tiene Elena?" works from the inventory too.
 */

const elena = { id: "cu1", fullName: "Elena Castillo", phone: "+50499447781" } as Customer;
const customersById = new Map([[elena.id, elena]]);

function lot(code: string, projectName: string, held = false): Lot {
  return {
    id: code,
    code,
    projectName,
    areaM2: 300,
    basePrice: cents(10_000_000),
    archivedAt: null,
    holding: held
      ? {
          contractId: "c1",
          contractCode: "CT-2024-007",
          customerId: elena.id,
          kind: "contract",
          saleType: "financed",
          status: "active",
          salePrice: cents(10_000_000),
          paidToDate: cents(0),
        }
      : null,
  };
}

const lots = [lot("A-07", "Valle Verde"), lot("D-04", "Monte Real", true), lot("B-14", "Monte Real")];
const codes = (search: string) => searchLots(lots, search, customersById).map((found) => found.code);

describe("the Lotes search", () => {
  it("shows every lot when the box is empty", () => {
    assert.deepEqual(codes("  "), ["A-07", "D-04", "B-14"]);
  });

  it("finds a lot by its code or its project, whatever the capitals", () => {
    assert.deepEqual(codes("a-07"), ["A-07"]);
    assert.deepEqual(codes("monte"), ["D-04", "B-14"]);
  });

  it("finds a lot by who holds it: name, phone or contract number", () => {
    assert.deepEqual(codes("elena"), ["D-04"]);
    assert.deepEqual(codes("CT-2024-007"), ["D-04"]);
    assert.deepEqual(codes("9944"), ["D-04"]);
  });

  it("needs every word to match, so more words narrow the list", () => {
    assert.deepEqual(codes("monte castillo"), ["D-04"]);
    assert.deepEqual(codes("valle castillo"), []);
  });
});
