import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Transaction } from "../src/types";
import { contractTag } from "../src/features/receipts/contractTag";

/** Only the fields the tag reads — see `contractTag`. */
const payment = (fields: Partial<Transaction>) =>
  ({
    contractCode: "CT-2026-011",
    contractStatus: "active",
    replacesContractCode: null,
    ...fields,
  }) as Transaction;

describe("the contract tag on a transaction row", () => {
  it("says nothing for a contract that was never renegotiated", () => {
    // Most rows. A code repeated down the whole list would be noise beside the
    // lot and project the row already names.
    assert.equal(contractTag(payment({})), null);
    assert.equal(contractTag(payment({ contractStatus: "paid_off" })), null);
    assert.equal(contractTag(payment({ contractStatus: "cancelled" })), null);
  });

  it("marks money paid on the contract an adenda wrote, and names where it came from", () => {
    const tag = contractTag(
      payment({ contractCode: "CT-2026-011-A1", replacesContractCode: "CT-2026-011" }),
    );

    assert.equal(tag?.side, "adenda");
    assert.equal(tag?.code, "CT-2026-011-A1");
    assert.match(tag!.title, /CT-2026-011\b/);
  });

  it("marks money paid before the adenda, on the contract it closed", () => {
    const tag = contractTag(payment({ contractStatus: "replaced" }));

    assert.equal(tag?.side, "replaced");
    assert.equal(tag?.code, "CT-2026-011");
  });

  it("calls a contract between two adendas an adenda, since it came from another", () => {
    // CT-2026-011-A1 after A2 replaced it: replaced, but also somebody's
    // successor. Where it came from is the more useful of the two.
    const tag = contractTag(
      payment({
        contractCode: "CT-2026-011-A1",
        contractStatus: "replaced",
        replacesContractCode: "CT-2026-011",
      }),
    );

    assert.equal(tag?.side, "adenda");
  });

  it("goes by the link the server sends, not by the -A1 in the code", () => {
    // The suffix is a display convention. A contract that merely looks like a
    // successor is not one.
    assert.equal(contractTag(payment({ contractCode: "CT-2026-011-A1" })), null);
  });
});
