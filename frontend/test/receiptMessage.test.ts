import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { receiptMessage } from "../src/features/receipts/receiptMessage";
import { receiptCaption } from "../src/features/receipts/whatsapp";
import { cents } from "../src/lib/money";
import type { AppliedInstallment, NextDue, Receipt, ReceiptLine } from "../src/types";

const L = (amount: number) => cents(Math.round(amount * 100));

/** Cuota `number` of L 25,000, due the 5th of the month after September. */
function cuota(number: number, applied: number, remaining = 0): AppliedInstallment {
  return {
    number,
    dueOn: `2026-${String(number + 6).padStart(2, "0")}-05`,
    applied: L(applied),
    settled: remaining === 0,
    installment: L(25_000),
    remaining: L(remaining),
  };
}

function next(dueOn: string, amount: number, extra: Partial<NextDue> = {}): NextDue {
  return { dueOn, amount: L(amount), credit: L(0), isDownPayment: false, monthsAhead: 0, ...extra };
}

function line(fields: Partial<ReceiptLine>): ReceiptLine {
  return {
    paymentId: "p1",
    contractId: "c1",
    contractCode: "SAN-B12",
    lotCode: "B-12",
    projectName: "Proyecto Santiago Etapa 1",
    amount: L(25_000),
    type: "installment",
    contractTotal: L(345_800),
    installmentCount: 12,
    previousBalance: L(225_000),
    newBalance: L(200_000),
    appliedTo: [],
    moraPaid: [],
    moraPending: L(0),
    nextDue: null,
    ...fields,
  };
}

function receipt(paid: number, newBalance: number, lines: ReceiptLine[]): Receipt {
  return {
    id: "r1",
    number: 1,
    code: "IM-402215338901",
    lookupCode: "KC32-D2AJ",
    issuedOn: "2026-10-03",
    note: null,
    voidedAt: null,
    voidReason: null,
    customer: { id: "u1", fullName: "María López", identification: null, phone: "+50498765432" },
    issuedBy: { id: "s1", name: "Elvis" },
    totalPaid: L(paid),
    previousBalance: L(225_000),
    newBalance: L(newBalance),
    cumulativePaid: L(0),
    moraCharged: L(0),
    transactionCount: lines.length,
    method: "transfer",
    lines,
    attachments: [],
  };
}

describe("receiptMessage", () => {
  it("names the cuota paid and the next one", () => {
    const message = receiptMessage(
      receipt(25_000, 200_000, [
        line({ appliedTo: [cuota(4, 25_000)], nextDue: next("2026-11-05", 25_000) }),
      ]),
    );

    assert.equal(
      message,
      "Gracias por su pago de *L. 25,000.00* (cuota 4 de 12). Su próxima cuota es el *5 de noviembre* por *L. 25,000.00*. Cualquier duda me deja saber.",
    );
  });

  it("says what a part-paid cuota still needs, and when", () => {
    const message = receiptMessage(
      receipt(15_000, 210_000, [
        line({
          amount: L(15_000),
          newBalance: L(210_000),
          appliedTo: [{ ...cuota(4, 15_000, 10_000), dueOn: "2026-10-05" }],
          nextDue: next("2026-10-05", 10_000, { credit: L(15_000) }),
        }),
      ]),
    );

    assert.equal(
      message,
      "Gracias por su abono de *L. 15,000.00* a la cuota 4. Le quedan *L. 10,000.00* para completarla, con vencimiento el *5 de octubre*. Cualquier duda me deja saber.",
    );
  });

  it("says when a customer is ahead, and what of the next cuota is already paid", () => {
    const message = receiptMessage(
      receipt(55_000, 170_000, [
        line({
          amount: L(55_000),
          newBalance: L(170_000),
          appliedTo: [cuota(4, 25_000), cuota(5, 25_000), cuota(6, 5_000, 20_000)],
          nextDue: next("2026-12-05", 20_000, { credit: L(5_000), monthsAhead: 1 }),
        }),
      ]),
    );

    assert.equal(
      message,
      "Gracias por su pago de *L. 55,000.00* (cuotas 4 y 5 de 12). Va adelantado: su próxima cuota es el *5 de diciembre* por *L. 20,000.00* (ya abonó L. 5,000.00). Cualquier duda me deja saber.",
    );
  });

  it("congratulates on the payment that pays the lot off", () => {
    const message = receiptMessage(
      receipt(225_000, 0, [
        line({
          amount: L(225_000),
          newBalance: L(0),
          appliedTo: [4, 5, 6, 7, 8, 9, 10, 11, 12].map((number) => cuota(number, 25_000)),
        }),
      ]),
    );

    assert.equal(
      message,
      "¡Felicidades! Con su pago de *L. 225,000.00* el lote B-12 queda *pagado en su totalidad*. Cualquier duda me deja saber.",
    );
  });

  it("says what is left of the prima", () => {
    const message = receiptMessage(
      receipt(10_000, 335_800, [
        line({ nextDue: next("2026-06-15", 35_800, { isDownPayment: true, credit: L(10_000) }) }),
      ]),
    );

    assert.equal(
      message,
      "Gracias por su abono de *L. 10,000.00* a la prima. Le quedan *L. 35,800.00* para completarla. Cualquier duda me deja saber.",
    );
  });

  it("names the first cuota once the prima is complete", () => {
    const message = receiptMessage(
      receipt(45_800, 300_000, [line({ nextDue: next("2026-11-05", 25_000) })]),
    );

    assert.equal(
      message,
      "Gracias por su pago de *L. 45,800.00* (prima). Su próxima cuota es el *5 de noviembre* por *L. 25,000.00*. Cualquier duda me deja saber.",
    );
  });

  it("gives the year when the next cuota falls in another one", () => {
    const message = receiptMessage(
      receipt(25_000, 200_000, [
        line({ appliedTo: [cuota(4, 25_000)], nextDue: next("2027-01-05", 25_000) }),
      ]),
    );

    assert.match(message, /el \*5 de enero de 2027\*/);
  });

  it("does not call a cuota whose date has gone by «próxima»", () => {
    const behind = receiptMessage(
      receipt(25_000, 200_000, [
        line({ appliedTo: [cuota(4, 25_000)], nextDue: next("2026-09-05", 25_000) }),
      ]),
    );
    const abono = receiptMessage(
      receipt(15_000, 210_000, [
        line({
          amount: L(15_000),
          newBalance: L(210_000),
          appliedTo: [{ ...cuota(4, 15_000, 10_000), dueOn: "2026-09-05" }],
          nextDue: next("2026-09-05", 10_000, { credit: L(15_000) }),
        }),
      ]),
    );

    assert.equal(
      behind,
      "Gracias por su pago de *L. 25,000.00* (cuota 4 de 12). Tiene pendiente la cuota del *5 de septiembre* por *L. 25,000.00*. Cualquier duda me deja saber.",
    );
    assert.equal(
      abono,
      "Gracias por su abono de *L. 15,000.00* a la cuota 4. Le quedan *L. 10,000.00* para completarla; venció el *5 de septiembre*. Cualquier duda me deja saber.",
    );
  });

  it("gives each lot its own line on a receipt for several", () => {
    const message = receiptMessage(
      receipt(31_000, 260_000, [
        line({ appliedTo: [cuota(4, 25_000)], nextDue: next("2026-11-05", 25_000) }),
        line({
          paymentId: "p2",
          lotCode: "B-13",
          amount: L(6_000),
          newBalance: L(60_000),
          appliedTo: [{ ...cuota(4, 6_000, 4_000), dueOn: "2026-10-05" }],
          nextDue: next("2026-10-05", 4_000, { credit: L(6_000) }),
        }),
      ]),
    );

    assert.equal(
      message,
      [
        "Gracias por su pago de *L. 31,000.00*.",
        "• B-12: cuota 4 de 12 · próxima cuota el 5 de noviembre por L. 25,000.00",
        "• B-13: abono a la cuota 4 · le quedan L. 4,000.00, vence el 5 de octubre",
        "",
        "Cualquier duda me deja saber.",
      ].join("\n"),
    );
  });

  it("says how much of the payment was mora, and on which cuota", () => {
    const message = receiptMessage(
      receipt(25_500, 200_000, [
        line({
          amount: L(25_500),
          appliedTo: [cuota(4, 25_000)],
          moraPaid: [{ installment: 4, amount: L(500) }],
          nextDue: next("2026-11-05", 25_000),
        }),
      ]),
    );

    assert.equal(
      message,
      "Gracias por su pago de *L. 25,500.00* (cuota 4 de 12). Su próxima cuota es el *5 de noviembre* por *L. 25,000.00*. De este pago, *L. 500.00* fueron recargo por mora de la cuota 4. Cualquier duda me deja saber.",
    );
  });

  it("thanks for a payment that only covered mora, and says what mora is left", () => {
    const message = receiptMessage(
      receipt(500, 225_500, [
        line({
          amount: L(500),
          moraPaid: [{ installment: 4, amount: L(300) }, { installment: 5, amount: L(200) }],
          moraPending: L(500),
          nextDue: next("2026-10-05", 25_000),
        }),
      ]),
    );

    assert.equal(
      message,
      "Gracias por su pago de *L. 500.00* de recargo por mora de las cuotas 4 y 5. Tiene pendiente *L. 500.00* de recargo por mora. Cualquier duda me deja saber.",
    );
  });

  it("names the mora on each lot of a receipt for several", () => {
    const message = receiptMessage(
      receipt(50_500, 400_000, [
        line({
          amount: L(25_500),
          appliedTo: [cuota(4, 25_000)],
          moraPaid: [{ installment: 4, amount: L(500) }],
          nextDue: next("2026-11-05", 25_000),
        }),
        line({
          paymentId: "p2",
          lotCode: "B-13",
          amount: L(25_000),
          appliedTo: [cuota(4, 25_000)],
          moraPending: L(500),
          nextDue: next("2026-11-05", 25_000),
        }),
      ]),
    );

    assert.equal(
      message,
      [
        "Gracias por su pago de *L. 50,500.00*.",
        "• B-12: cuota 4 de 12 · próxima cuota el 5 de noviembre por L. 25,000.00 · mora L. 500.00",
        "• B-13: cuota 4 de 12 · próxima cuota el 5 de noviembre por L. 25,000.00 · mora pendiente L. 500.00",
        "",
        "Cualquier duda me deja saber.",
      ].join("\n"),
    );
  });

  it("states the balance on a sale with no cuotas", () => {
    const message = receiptMessage(
      receipt(50_000, 100_000, [line({ installmentCount: 0, newBalance: L(100_000) })]),
    );

    assert.equal(
      message,
      "Gracias por su pago de *L. 50,000.00*. Su saldo pendiente es *L. 100,000.00*. Cualquier duda me deja saber.",
    );
  });
});

describe("receiptCaption", () => {
  it("never thanks the customer for a voided receipt", () => {
    const voided = {
      ...receipt(25_000, 200_000, [line({ appliedTo: [cuota(4, 25_000)] })]),
      voidedAt: "2026-10-04T10:00:00.000Z",
      voidReason: "Pago duplicado",
    };

    assert.equal(receiptCaption(voided), "*RECIBO ANULADO* — Pago duplicado");
  });
});
