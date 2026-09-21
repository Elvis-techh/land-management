import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareLotCodes, sortLots } from "../src/features/lots/lotSort";
import type { Customer, Lot } from "../src/types";

const held = (code: string, customerId: string): Lot =>
  ({ code, holding: { customerId } } as unknown as Lot);

const unheld = (code: string): Lot => ({ code, holding: null }) as unknown as Lot;

const customersById = new Map<string, Customer>([
  ["cu-1", { fullName: "Beatriz" } as Customer],
  ["cu-2", { fullName: "Ana" } as Customer],
]);

describe("sortLots — a lot with nobody on it", () => {
  it("sinks to the bottom sorted A → Z", () => {
    const lots = [unheld("A-01"), held("A-02", "cu-1"), held("A-03", "cu-2")];
    const ordered = sortLots(lots, [{ field: "customer", direction: "asc" }], customersById);

    assert.deepEqual(
      ordered.map((lot) => lot.code),
      ["A-03", "A-02", "A-01"],
    );
  });

  it("still sinks to the bottom sorted Z → A — not the top", () => {
    // The regression this guards: applying the rule's direction to the blank
    // check the same way every other field is flipped would send the empty
    // lot to the TOP of a descending sort instead.
    const lots = [unheld("A-01"), held("A-02", "cu-1"), held("A-03", "cu-2")];
    const ordered = sortLots(lots, [{ field: "customer", direction: "desc" }], customersById);

    assert.deepEqual(
      ordered.map((lot) => lot.code),
      ["A-02", "A-03", "A-01"],
    );
  });
});

describe("sortLots — multiple levels", () => {
  it("breaks a tie on the primary field using the secondary one", () => {
    const lots = [
      { code: "B-01", projectName: "Valle Verde", areaM2: 500, holding: null },
      { code: "A-01", projectName: "Valle Verde", areaM2: 300, holding: null },
    ] as unknown as Lot[];

    const ordered = sortLots(
      lots,
      [
        { field: "project", direction: "asc" },
        { field: "area", direction: "asc" },
      ],
      customersById,
    );

    assert.deepEqual(
      ordered.map((lot) => lot.code),
      ["A-01", "B-01"],
    );
  });
});

describe("compareLotCodes", () => {
  it("sorts A-2 before A-10, not as plain text", () => {
    assert.equal(compareLotCodes("A-2", "A-10") < 0, true);
    assert.equal("A-2".localeCompare("A-10") < 0, false, "plain text sorts these the other way");
  });
});
