import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { afterPaymentBoxes } from "../src/features/receipts/afterPaymentBoxes";
import type { AfterPayment } from "../src/features/receipts/api";
import type { MoneyView } from "../src/lib/money";
import { cents } from "../src/lib/money";
import type { AppliedInstallment } from "../src/types";

/*
 * The «Después de este pago» boxes under a lot in «Registrar un pago». The
 * first is the receipt's own wording, so what is read while typing is what the
 * receipt will print.
 */

const HNL: MoneyView = { currency: "HNL", usdRate: 25 };

/** Each box as "tone: text (note)", with plain spaces for readability: the boxes keep "L." with its figure. */
const boxes = (value: AfterPayment, paidOn?: string) =>
  afterPaymentBoxes(value, HNL, paidOn).map((box) =>
    `${box.tone}: ${box.text}${box.note ? ` (${box.note})` : ""}`.replace(/\u00a0/g, " "),
  );
const L = (amount: number) => cents(Math.round(amount * 100));

function cuota(number: number, applied: number, remaining = 0): AppliedInstallment {
  return {
    number,
    dueOn: "2026-11-05",
    applied: L(applied),
    settled: remaining === 0,
    installment: L(25_000),
    remaining: L(remaining),
  };
}

function after(overrides: Partial<AfterPayment>): AfterPayment {
  return {
    appliedTo: [],
    installmentCount: 12,
    mora: L(0),
    toDownPayment: L(0),
    moraPending: L(0),
    moraPendingLater: L(0),
    moraLaterInstallments: [],
    newBalance: L(200_000),
    settled: false,
    nextDueAmount: L(25_000),
    nextInstallment: L(25_000),
    nextDueCredit: L(0),
    nextDueIsDownPayment: false,
    ...overrides,
  };
}

describe("afterPaymentBoxes", () => {
  it("keeps «L.» on the same line as its figure", () => {
    const [, next] = afterPaymentBoxes(after({ appliedTo: [cuota(4, 25_000)] }), HNL);
    assert.match(next!.text, /cuota L\.\u00a025,000$/);
  });

  it("a full cuota in green, then the next cuota", () => {
    assert.deepEqual(boxes(after({ appliedTo: [cuota(4, 25_000)] })), [
      "ok: Cuota 4 de 12 · completa",
      "plain: Próxima cuota L. 25,000",
    ]);
  });

  it("says how much of the next cuota is already covered", () => {
    assert.deepEqual(
      boxes(
        after({
          appliedTo: [cuota(4, 25_000), cuota(5, 25_000), cuota(6, 5_000, 20_000)],
          newBalance: L(170_000),
          nextDueAmount: L(20_000),
          nextDueCredit: L(5_000),
        }),
      ),
      ["ok: Cuotas 4 y 5 de 12 · completas", "plain: Próxima cuota L. 25,000 · adelanto L. 5,000"],
    );
  });

  it("a cuota left short in red, then the balance, without repeating what it needs", () => {
    assert.deepEqual(
      boxes(
        after({
          appliedTo: [cuota(4, 15_000, 10_000)],
          newBalance: L(210_000),
          nextDueAmount: L(10_000),
          nextDueCredit: L(15_000),
        }),
      ),
      ["due: Abono a cuota 4 de 12 · faltan L. 10,000.00", "plain: Saldo L. 210,000"],
    );
  });

  it("says the contract is paid when the balance reaches zero", () => {
    assert.deepEqual(
      boxes(
        after({
          appliedTo: [cuota(12, 25_000)],
          newBalance: L(0),
          settled: true,
          nextDueAmount: L(0),
          nextInstallment: L(0),
        }),
      ),
      ["ok: Cuota 12 de 12 · última cuota", "ok: Contrato pagado"],
    );
  });

  it("says what is left of the prima while the prima is still owed", () => {
    assert.deepEqual(
      boxes(after({ nextDueIsDownPayment: true, nextDueAmount: L(30_000), nextInstallment: L(50_000) })),
      ["due: Faltan L. 30,000 de prima"],
    );
  });

  it("leaves the part that pays mora to the list above it, and any mora left in a red box last", () => {
    assert.deepEqual(boxes(after({ appliedTo: [cuota(4, 25_000)], mora: L(500) })), [
      "ok: Cuota 4 de 12 · completa",
      "plain: Próxima cuota L. 25,000",
    ]);
    assert.deepEqual(boxes(after({ appliedTo: [cuota(4, 25_000)], moraPending: L(500) })), [
      "ok: Cuota 4 de 12 · completa",
      "plain: Próxima cuota L. 25,000",
      "due: Mora por pagar L. 500",
    ]);
  });

  it("on an earlier date, says which mora was charged after it (the owner's M-03, 13 Nov 2026)", () => {
    // Paid on 5 Oct with its L 200 of mora; cuotas 2 and 3 were charged since.
    const m03 = after({
      appliedTo: [cuota(1, 2_000)],
      installmentCount: 24,
      mora: L(200),
      moraPending: L(600),
      moraPendingLater: L(600),
      moraLaterInstallments: [2, 3],
    });
    assert.deepEqual(boxes(m03, "2026-10-05").at(-1), "due: Mora por pagar L. 600 (Cargada después del 5 oct, en las cuotas 2 y 3)");
    // Part of it from before the date, part after; and the prima.
    assert.deepEqual(
      boxes({ ...m03, moraPending: L(800), moraPendingLater: L(300), moraLaterInstallments: [0, 2] }, "2026-10-05").at(-1),
      "due: Mora por pagar L. 800 (L. 300 cargada después del 5 oct, en la prima y la cuota 2)",
    );
    // Dated today: no date given, nothing to explain.
    assert.deepEqual(boxes(m03).at(-1), "due: Mora por pagar L. 600");
  });
});
