import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CUSTOMER_FIELD,
  TOTAL_FIELD,
  amountFieldId,
  receiptBlocker,
} from "../src/features/receipts/receiptBlocker";

/*
 * The rule behind the notice on "Registrar y emitir recibo".
 *
 * Worth pinning because the failure it replaced was silent: an incomplete
 * draft used to disable the button and say nothing, so the form being wrong
 * was invisible to a test AND to the user. Every case below is a sentence
 * somebody at the window needs to read.
 */

const ONE_LOT = [{ id: "c1" }];
const THREE_LOTS = [{ id: "c1" }, { id: "c2" }, { id: "c3" }];

/** A draft that is ready to go, so each test can spoil exactly one thing. */
const ready = {
  customerId: "cust-1",
  payable: ONE_LOT,
  lineCount: 1,
  amountByContract: { c1: "5,000" },
  totalText: "",
};

describe("receiptBlocker", () => {
  it("lets a complete draft through", () => {
    assert.equal(receiptBlocker(ready), null);
  });

  it("asks for the customer first, before anything else is knowable", () => {
    const blocker = receiptBlocker({ ...ready, customerId: "", payable: [], lineCount: 0 });

    assert.equal(blocker?.focus, CUSTOMER_FIELD);
    assert.match(blocker!.message, /cliente/i);
  });

  it("names the missing monto, and points at the field that takes it", () => {
    const blocker = receiptBlocker({ ...ready, lineCount: 0, amountByContract: {} });

    assert.equal(blocker?.focus, amountFieldId("c1"));
    assert.match(blocker!.message, /monto/i);
  });

  it("says a typed zero is not an amount, rather than repeating 'falta el monto'", () => {
    const blocker = receiptBlocker({ ...ready, lineCount: 0, amountByContract: { c1: "0" } });

    assert.match(blocker!.message, /mayor que cero/i);
    assert.equal(blocker?.focus, amountFieldId("c1"));
  });

  it("treats whitespace as nothing typed at all", () => {
    const blocker = receiptBlocker({ ...ready, lineCount: 0, amountByContract: { c1: "   " } });

    assert.match(blocker!.message, /Falta el monto/i);
  });

  it("tells a customer with no payable contracts apart from one with no monto", () => {
    const blocker = receiptBlocker({ ...ready, payable: [], lineCount: 0 });

    assert.equal(blocker?.focus, CUSTOMER_FIELD);
    assert.match(blocker!.message, /no tiene contratos/i);
  });

  describe("several lots", () => {
    it("sends an empty form to the total, which is the fast path", () => {
      const blocker = receiptBlocker({
        ...ready,
        payable: THREE_LOTS,
        lineCount: 0,
        amountByContract: {},
      });

      assert.equal(blocker?.focus, TOTAL_FIELD);
    });

    it("catches a total that was typed but never distributed", () => {
      const blocker = receiptBlocker({
        ...ready,
        payable: THREE_LOTS,
        lineCount: 0,
        amountByContract: {},
        totalText: "25,000",
      });

      assert.match(blocker!.message, /repartir/i);
    });

    it("is satisfied by one lot receiving money, not all of them", () => {
      assert.equal(
        receiptBlocker({
          ...ready,
          payable: THREE_LOTS,
          lineCount: 1,
          amountByContract: { c2: "5,000" },
        }),
        null,
      );
    });

    it("reports a zero typed into any lot, not only the first", () => {
      const blocker = receiptBlocker({
        ...ready,
        payable: THREE_LOTS,
        lineCount: 0,
        amountByContract: { c3: "0" },
      });

      assert.match(blocker!.message, /mayor que cero/i);
    });
  });
});
