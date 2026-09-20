import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sortCustomers } from "../src/features/customers/customerSort";
import type { CustomerRecord } from "../src/types";

const customer = (overrides: Partial<CustomerRecord>): CustomerRecord =>
  ({
    id: overrides.fullName ?? "id",
    fullName: "Sin nombre",
    identification: null,
    customerSince: 2020,
    contracts: [],
    ...overrides,
  }) as CustomerRecord;

describe("sortCustomers — identification", () => {
  it("orders by identidad, blanks sinking in both directions", () => {
    const rows = [
      customer({ fullName: "Sin identidad", identification: null }),
      customer({ fullName: "Beatriz", identification: "0801-1990-00002" }),
      customer({ fullName: "Ana", identification: "0801-1985-00001" }),
    ];

    const ascending = sortCustomers(rows, [{ field: "identification", direction: "asc" }]);
    assert.deepEqual(
      ascending.map((row) => row.fullName),
      ["Ana", "Beatriz", "Sin identidad"],
    );

    // Reversing the sort must not send the blank identidad to the top — it
    // has nothing to rank, in either direction. See compareBlankSinking.
    const descending = sortCustomers(rows, [{ field: "identification", direction: "desc" }]);
    assert.deepEqual(
      descending.map((row) => row.fullName),
      ["Beatriz", "Ana", "Sin identidad"],
    );
  });
});

describe("sortCustomers — lot and project", () => {
  const rows = [
    customer({ fullName: "Sin contrato", contracts: [] }),
    customer({
      fullName: "Beatriz",
      contracts: [{ lotCode: "B-02", projectName: "Valle Verde" } as CustomerRecord["contracts"][number]],
    }),
    customer({
      fullName: "Ana",
      contracts: [{ lotCode: "A-01", projectName: "Monte Real" } as CustomerRecord["contracts"][number]],
    }),
  ];

  it("orders by the first contract's lot code, blanks sinking either way", () => {
    const ordered = sortCustomers(rows, [{ field: "lot", direction: "desc" }]);

    assert.deepEqual(
      ordered.map((row) => row.fullName),
      ["Beatriz", "Ana", "Sin contrato"],
    );
  });

  it("orders by the first contract's project, blanks sinking either way", () => {
    const ordered = sortCustomers(rows, [{ field: "project", direction: "asc" }]);

    assert.deepEqual(
      ordered.map((row) => row.fullName),
      ["Ana", "Beatriz", "Sin contrato"],
    );
  });
});
