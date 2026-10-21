import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { accountStatus, shortDate } from "../src/features/receipts/accountStatus";
import type { Cents } from "../src/lib/money";
import type { LotStanding, NextDue, ReceiptLine } from "../src/types";

/*
 * «Estado de su cuenta» on the receipt, for the situations in «Recibos nuevos:
 * vista previa»: a whole cuota, part of one, more than one, behind, the prima,
 * and the last payment. The server measures; this decides the words.
 */

/** The receipt's own date in every case below. */
const ISSUED = "2026-10-03";

const L = (lempiras: number) => Math.round(lempiras * 100) as Cents;

function line(over: {
  nextDue?: Partial<NextDue> | null;
  standing?: Partial<LotStanding>;
  appliedTo?: ReceiptLine["appliedTo"];
  installmentCount?: number;
  lotCode?: string;
}): ReceiptLine {
  return {
    paymentId: `p-${over.lotCode ?? "B-12"}`,
    contractId: "c1",
    contractCode: "CT-2026-001",
    lotCode: over.lotCode ?? "B-12",
    projectName: "Santiago",
    amount: L(25_000),
    type: "installment",
    contractTotal: L(345_800),
    installmentCount: over.installmentCount ?? 12,
    previousBalance: L(225_000),
    newBalance: L(200_000),
    appliedTo: over.appliedTo ?? [],
    nextDue:
      over.nextDue === null
        ? null
        : {
            dueOn: "2026-11-05",
            number: 5,
            amount: L(25_000),
            credit: L(0),
            isDownPayment: false,
            monthsAhead: 0,
            ...over.nextDue,
          },
    standing: {
      installmentsPaidBefore: 3,
      installmentsPaid: 4,
      monthsBehind: 0,
      downPaymentLate: false,
      monthsAhead: 0,
      settled: false,
      ...over.standing,
    },
  };
}

const cuota = (number: number, settled: boolean) => ({
  number,
  dueOn: "2026-10-05",
  settled,
  applied: L(25_000),
  installment: L(25_000),
  remaining: settled ? L(0) : L(10_000),
});

describe("«Estado de su cuenta»", () => {
  it("a whole cuota on time: the next one, 4 of 12 with today's apart, and up to date", () => {
    const [row] = accountStatus([line({ appliedTo: [cuota(4, true)] })], ISSUED);

    assert.deepEqual(row!.next, { value: "5 nov 2026", note: "Cuota 5 · L. 25,000.00" });
    assert.deepEqual(row!.paid, { label: "4 de 12", before: 3, today: 1, total: 12 });
    assert.deepEqual(row!.status, { label: "Al día", tone: "ok", note: "Sin cuotas pendientes" });
  });

  it("part of a cuota: what is left of it, and when it falls due", () => {
    const [row] = accountStatus([
      line({
        appliedTo: [cuota(4, false)],
        nextDue: { dueOn: "2026-10-05", number: 4, amount: L(10_000), credit: L(15_000) },
        standing: { installmentsPaidBefore: 3, installmentsPaid: 3 },
      }),
    ], ISSUED);

    assert.deepEqual(row!.next, { value: "5 oct 2026", note: "Resto de cuota 4 · L. 10,000.00" });
    assert.equal(row!.paid.label, "3 de 12");
    assert.equal(row!.paid.today, 0);
    assert.deepEqual(row!.status, {
      label: "Al día",
      tone: "ok",
      note: "La cuota 4 vence el 5 oct 2026",
    });
  });

  it("two cuotas and some over: ahead, with the advance named on the next cuota", () => {
    const [row] = accountStatus([
      line({
        appliedTo: [cuota(4, true), cuota(5, true)],
        nextDue: { dueOn: "2026-12-05", number: 6, amount: L(20_000), credit: L(5_000), monthsAhead: 1 },
        standing: { installmentsPaidBefore: 3, installmentsPaid: 5, monthsAhead: 1 },
      }),
    ], ISSUED);

    assert.deepEqual(row!.next, {
      value: "5 dic 2026",
      note: "Cuota 6 · L. 20,000.00 (ya abonó L. 5,000.00)",
    });
    assert.equal(row!.paid.today, 2);
    assert.deepEqual(row!.status, { label: "Adelantado 1 cuota", tone: "ahead", note: "Sin cuotas pendientes" });
  });

  it("still behind after paying: late, with how many cuotas", () => {
    const [row] = accountStatus([line({ standing: { monthsBehind: 2 } })], ISSUED);

    assert.deepEqual(row!.status, { label: "Atrasado", tone: "late", note: "2 cuotas vencidas" });
  });

  it("a cuota whose date has gone by is called overdue, not next", () => {
    const [row] = accountStatus(
      [
        line({
          nextDue: { dueOn: "2026-08-05", number: 7, amount: L(6_600) },
          standing: { monthsBehind: 3 },
        }),
      ],
      "2026-10-21",
    );

    assert.deepEqual(row!.next, { value: "5 ago 2026", note: "Vencida · Cuota 7 · L. 6,600.00" });
    assert.deepEqual(row!.status, { label: "Atrasado", tone: "late", note: "3 cuotas vencidas" });
  });

  it("a late prima is named as the prima, not as months", () => {
    const [row] = accountStatus([
      line({
        nextDue: { dueOn: "2026-07-01", number: 0, amount: L(160_000), isDownPayment: true },
        standing: { installmentsPaidBefore: 0, installmentsPaid: 0, downPaymentLate: true, monthsBehind: 1 },
      }),
    ], ISSUED);

    assert.deepEqual(row!.next, { value: "1 jul 2026", note: "Vencida · Resto de la prima · L. 160,000.00" });
    assert.deepEqual(row!.status, { label: "Atrasado", tone: "late", note: "Prima pendiente · 1 cuota vencida" });
  });

  it("the last payment: nothing next, every cuota paid, and paid off", () => {
    const [row] = accountStatus([
      line({ nextDue: null, standing: { installmentsPaidBefore: 3, installmentsPaid: 12, settled: true } }),
    ], ISSUED);

    assert.deepEqual(row!.next, { value: "Ninguna", note: "No hay más cuotas" });
    assert.deepEqual(row!.paid, { label: "12 de 12", before: 3, today: 9, total: 12 });
    assert.deepEqual(row!.status, { label: "Pagado", tone: "paid", note: "Contrato pagado en su totalidad" });
  });

  it("names each lot on a receipt for several, and leaves out a cash sale", () => {
    const rows = accountStatus([
      line({ lotCode: "B-12" }),
      line({ lotCode: "B-13" }),
      line({ lotCode: "C-01", installmentCount: 0 }),
    ], ISSUED);

    assert.deepEqual(
      rows.map((row) => row.lotCode),
      ["B-12", "B-13"],
    );
  });

  it("has no box for more lots than fit on the page", () => {
    const lots = ["B-12", "B-13", "B-14", "B-15"].map((lotCode) => line({ lotCode }));

    assert.equal(accountStatus(lots.slice(0, 3), ISSUED).length, 3);
    assert.deepEqual(accountStatus(lots, ISSUED), []);
  });

  it("does not name the lot when the receipt has only one", () => {
    assert.equal(accountStatus([line({})], ISSUED)[0]!.lotCode, null);
  });
});

describe("shortDate", () => {
  it("writes the month short, without a full stop", () => {
    assert.match(shortDate("2026-11-05"), /^5 nov 2026$/);
  });
});
