import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { holderNote } from "../src/features/receipts/holderNote";
import type { Receipt } from "../src/types";

const previous = { id: "c-1", fullName: "Titular Anterior", identification: null, phone: null };
const next = { id: "c-2", fullName: "Titular Nuevo" };

const receipt = (lines: Array<{ lotCode: string; holder: { id: string; fullName: string } | null }>) =>
  ({ customer: previous, lines }) as unknown as Pick<Receipt, "customer" | "lines">;

describe("the note beside a receipt issued before a traspaso", () => {
  it("says nothing while every lot is still the receipt's customer's", () => {
    assert.equal(holderNote(receipt([{ lotCode: "D-06", holder: { id: "c-1", fullName: "Titular Anterior" } }])), null);
  });

  it("says nothing when the server did not say who holds the lot", () => {
    assert.equal(holderNote(receipt([{ lotCode: "D-06", holder: null }])), null);
  });

  it("names whose name the paper carries and who holds the lot now", () => {
    assert.equal(
      holderNote(receipt([{ lotCode: "D-06", holder: next }])),
      "Este recibo se emitió a nombre de Titular Anterior, antes de un traspaso: " +
        "hoy el lote D-06 es de Titular Nuevo. Se queda con el nombre que se le dio.",
    );
  });

  it("names only the lots that changed hands on a receipt of several", () => {
    const note = holderNote(
      receipt([
        { lotCode: "D-06", holder: next },
        { lotCode: "D-07", holder: { id: "c-1", fullName: "Titular Anterior" } },
      ]),
    );
    assert.match(note!, /el lote D-06 es de Titular Nuevo\./);
    assert.doesNotMatch(note!, /D-07/);
  });
});
