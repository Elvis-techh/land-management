import { randomUUID } from "node:crypto";

import { eq, max } from "drizzle-orm";

import { syncContractLifecycle } from "../lib/contractLifecycle.js";
import { shiftDays } from "../lib/contracts.js";
import { allocateReceiptCode, generateLookupCode, nextReceiptNumber } from "../lib/receipts.js";
import type { MoraSettings, OwnMoraRules } from "../lib/settings.js";
import { writeMoraVersion, writeSection } from "../lib/settings.js";
import type { Db } from "./client.js";
import {
  auditEvents,
  contracts,
  customers,
  lots,
  moraContractRules,
  moraForgiveness,
  moraManualCharges,
  payments,
  projects,
  receipts,
} from "./schema.js";

/**
 * Every situation «Perdonar» can meet, as fake contracts on the test site.
 *
 * Search «Caso» in Contratos: each contract's notes say what to try and what
 * should happen, so a person can walk through them on a phone. The two cancelled
 * ones are under Filtros → Cancelado. Only seed.ts on the test site calls this. The browser tests and a laptop keep mora switched
 * off, which is what they assume.
 *
 * Every date counts back from the day of the seed, because mora is worked out
 * up to today: fixed dates would keep charging and leave the notes wrong. They
 * are spaced so the charges come out the same in any month, 28 days or 31 (see
 * backend/test/mora-cases.test.ts). After a month or so the amounts drift, as
 * real ones would; a reset puts them back.
 */

const FIRST_DUE_MAX_DAYS_AGO = 70;

/**
 * The real site's rule as far as it is known (10 %, at most L. 500 per cuota,
 * 5 days' grace), charged every month so the cases can show a charge coming
 * back. On a L. 10,000 cuota it reaches the L. 500 at once; on a L. 2,000 cuota
 * it charges L. 200 a month.
 */
const RULE: Omit<MoraSettings, "startsOn"> = {
  enabled: true,
  calculation: "percent",
  percent: 10,
  fixedCents: 0,
  graceDays: 5,
  capCents: 50_000,
  minUnpaidCents: null,
  frequency: "monthly",
  chargeDownPayment: true,
  paymentOrder: "mora",
};

const SMALL_CUOTA = 2_000;
const BIG_CUOTA = 10_000;

interface MoraCase {
  /** After "CM-": the contract's code, and the lot's after "M-". */
  code: string;
  customer: string;
  /** What to try and what should happen. Shown on the contract's panel. */
  notes: string;
  cuota: number;
  /** How many cuotas. 1 keeps a later cuota's mora out of the case. */
  months: number;
  /** Negative: not due yet. */
  firstDueDaysAgo: number;
  /** The prima, in lempiras. Paid at signing unless `primaUnpaid`. */
  down?: number;
  primaUnpaid?: boolean;
  signedDaysAgo?: number;
  /** Payments after the prima, each on its own receipt. */
  paid?: Array<{ daysAgo: number; amount: number; enteredDaysAgo?: number }>;
  manual?: Array<{ installment: number; daysAgo: number; amount: number; reason: string }>;
  rule?: { daysAgo: number; mode: "none" } | { daysAgo: number; mode: "own"; rules: OwnMoraRules };
  ruleReason?: string;
  forgiven?: Array<{ installment: number; daysAgo: number; amount: number; reason: string }>;
  /** Cancelled this many days ago, with the money kept as income. */
  cancelledDaysAgo?: number;
  group?: string;
}

const FORGIVEN_REASON = "Se puso al día y se acordó perdonarle esta mora.";

const CASES: MoraCase[] = [
  {
    code: "01",
    customer: "Caso 01 Perdonar toda",
    cuota: SMALL_CUOTA,
    months: 24,
    firstDueDaysAgo: 20,
    notes:
      "Caso 01. La cuota 1 está atrasada, con L. 200 de mora. Pruebe: «Perdonar», deje el monto y escriba un motivo. Debe pasar: desaparece «Mora pendiente», el saldo baja L. 200 y el Historial dice «Mora perdonada». La cuota sigue atrasada, así que el próximo mes se cobra otra vez.",
  },
  {
    code: "02",
    customer: "Caso 02 Perdonar una parte",
    cuota: BIG_CUOTA,
    months: 24,
    firstDueDaysAgo: 20,
    notes:
      "Caso 02. La cuota 1 tiene L. 500 de mora. Pruebe: escriba L. 600 (no debe dejar) y un motivo corto (no debe dejar). Luego perdone L. 300. Debe pasar: quedan L. 200 pendientes. Perdone L. 100 más: la lista muestra dos perdones. «Quitar» deshace uno solo.",
  },
  {
    code: "03",
    customer: "Caso 03 Varias cuotas",
    cuota: SMALL_CUOTA,
    months: 24,
    firstDueDaysAgo: FIRST_DUE_MAX_DAYS_AGO,
    notes:
      "Caso 03. Tres cuotas atrasadas: cuota 1 L. 500 (ya en el máximo), cuota 2 L. 400, cuota 3 L. 200. Pruebe: en «Perdonar», cambie de cuota: el monto cambia solo. Perdone la cuota 2. Debe pasar: las cuotas 1 y 3 no cambian y Mora pendiente queda en L. 700.",
  },
  {
    code: "04",
    customer: "Caso 04 Mora de la prima",
    cuota: SMALL_CUOTA,
    months: 24,
    firstDueDaysAgo: -10,
    signedDaysAgo: 20,
    primaUnpaid: true,
    notes:
      "Caso 04. No ha pagado la prima de L. 5,000 y tiene L. 500 de mora. Pruebe: «Perdonar» debe ofrecer «Prima». Perdónela. Debe pasar: desaparece «Mora pendiente», y la prima se sigue debiendo.",
  },
  {
    code: "05",
    customer: "Caso 05 Ya pagó una parte",
    cuota: BIG_CUOTA,
    months: 24,
    firstDueDaysAgo: 20,
    paid: [{ daysAgo: 5, amount: 300 }],
    notes:
      "Caso 05. Mora de L. 500, de la que ya pagó L. 300. Pruebe: «Perdonar» debe ofrecer solo L. 200; con L. 300 no debe dejar. Debe pasar: lo pagado no se toca y el recibo de esos L. 300 no cambia.",
  },
  {
    code: "06",
    customer: "Caso 06 Ya pagó toda",
    cuota: BIG_CUOTA,
    months: 24,
    firstDueDaysAgo: 20,
    paid: [{ daysAgo: 5, amount: 500 }],
    notes:
      "Caso 06. Mora de L. 500, toda pagada. Debe pasar: no aparece «Perdonar», porque lo pagado no se perdona. Pruebe: anule el recibo de L. 500 en Recibos. Debe pasar: la mora se vuelve a deber, y ahora sí aparece «Perdonar».",
  },
  {
    code: "07",
    customer: "Caso 07 Al día, solo debe mora",
    cuota: SMALL_CUOTA,
    months: 24,
    firstDueDaysAgo: 20,
    paid: [{ daysAgo: 20, amount: SMALL_CUOTA }],
    manual: [{ installment: 1, daysAgo: 3, amount: 300, reason: "Mora acordada con el cliente por un atraso anterior." }],
    notes:
      "Caso 07. Va al día con las cuotas, pero debe L. 300 de mora cargada a mano. Debe pasar: el contrato no sale «Atrasado». Pruebe: perdónela. Debe pasar: desaparece «Mora pendiente», y sigue al día. Fíjese qué dice la entrada en «Mora cargada a mano».",
  },
  {
    code: "08",
    customer: "Caso 08 Solo falta la mora",
    cuota: 5_000,
    months: 2,
    down: 0,
    firstDueDaysAgo: 50,
    paid: [
      { daysAgo: 50, amount: 5_000 },
      { daysAgo: 18, amount: 5_000 },
    ],
    manual: [{ installment: 2, daysAgo: 3, amount: 500, reason: "Mora acordada al terminar de pagar las cuotas." }],
    notes:
      "Caso 08. Todas las cuotas están pagadas y solo falta L. 500 de mora. Pruebe: perdónela. Debe pasar: el contrato queda pagado. Sin cerrar esta ventana, «Quitar» el perdón. Debe pasar: el contrato se vuelve a abrir, debiendo L. 500. Si la cierra, búsquelo con Filtros → Pagado.",
  },
  {
    code: "09",
    customer: "Caso 09 Automática y a mano",
    cuota: SMALL_CUOTA,
    months: 24,
    firstDueDaysAgo: 20,
    manual: [{ installment: 1, daysAgo: 10, amount: 300, reason: "Mora acordada además de la automática." }],
    notes:
      "Caso 09. La cuota 1 tiene L. 200 de mora automática y L. 300 cargados a mano. Pruebe: perdone L. 200. Debe pasar: se borra primero la más antigua, la automática, y la de a mano sigue «Pendiente». Perdone L. 100 más: la de a mano dice «Faltan L. 200».",
  },
  {
    code: "10",
    customer: "Caso 10 Se vuelve a cobrar",
    cuota: SMALL_CUOTA,
    months: 1,
    firstDueDaysAgo: 40,
    forgiven: [{ installment: 1, daysAgo: 20, amount: 200, reason: FORGIVEN_REASON }],
    notes:
      "Caso 10. Hace 20 días se perdonaron L. 200, pero la cuota sigue atrasada y este mes se cobraron L. 200 otra vez. Debe pasar: se ven los dos, Mora perdonada L. 200 y Mora pendiente L. 200. Perdonar no detiene la mora; para eso está «Sin mora».",
  },
  {
    code: "11",
    customer: "Caso 11 Llegó al máximo",
    cuota: BIG_CUOTA,
    months: 1,
    firstDueDaysAgo: 40,
    forgiven: [{ installment: 1, daysAgo: 20, amount: 500, reason: FORGIVEN_REASON }],
    notes:
      "Caso 11. La cuota llegó al máximo de L. 500, se perdonó todo y sigue atrasada. Debe pasar: no hay «Mora pendiente» y no se cobra más, porque lo perdonado cuenta para el máximo. No aparece «Perdonar». Pruebe: «Quitar» el perdón. Debe pasar: se vuelven a deber L. 500.",
  },
  {
    code: "12",
    customer: "Caso 12 Sin mora",
    cuota: SMALL_CUOTA,
    months: 1,
    firstDueDaysAgo: 40,
    rule: { daysAgo: 20, mode: "none" },
    ruleReason: "Se acordó que este contrato ya no lleva mora.",
    notes:
      "Caso 12. Tiene «Sin mora» desde hace 20 días y debe L. 200 de antes. Debe pasar: esos L. 200 se siguen debiendo y no se cobra más. Pruebe: perdónelos. Debe pasar: desaparece «Mora pendiente», y no vuelve.",
  },
  {
    code: "13",
    customer: "Caso 13 Regla propia",
    cuota: SMALL_CUOTA,
    months: 1,
    firstDueDaysAgo: 40,
    rule: {
      daysAgo: 60,
      mode: "own",
      rules: {
        calculation: "fixed",
        percent: 0,
        fixedCents: 30_000,
        capCents: null,
        minUnpaidCents: null,
        frequency: "monthly",
      },
    },
    ruleReason: "El contrato firmado dice L. 300 fijos cada mes.",
    notes:
      "Caso 13. Regla propia: L. 300 fijos cada mes, sin máximo. Lleva L. 600. Pruebe: perdone todo. Debe pasar: desaparece «Mora pendiente», pero el próximo mes se cobran L. 300 otra vez.",
  },
  {
    code: "14",
    customer: "Caso 14 Una sola vez",
    cuota: SMALL_CUOTA,
    months: 1,
    firstDueDaysAgo: 40,
    rule: {
      daysAgo: 60,
      mode: "own",
      rules: {
        calculation: "percent",
        percent: 10,
        fixedCents: 0,
        capCents: null,
        minUnpaidCents: null,
        frequency: "once",
      },
    },
    ruleReason: "El contrato firmado cobra la mora una sola vez por cuota.",
    forgiven: [{ installment: 1, daysAgo: 20, amount: 200, reason: FORGIVEN_REASON }],
    notes:
      "Caso 14. Regla propia que cobra una sola vez. Se cobraron L. 200 y se perdonaron. Debe pasar: aunque sigue atrasada, no se cobra más y no aparece «Perdonar». Compárelo con el caso 10.",
  },
  {
    code: "15",
    customer: "Caso 15 Recibo de antes",
    cuota: BIG_CUOTA,
    months: 24,
    firstDueDaysAgo: 20,
    paid: [{ daysAgo: 8, amount: 100 }],
    forgiven: [{ installment: 1, daysAgo: 5, amount: 200, reason: FORGIVEN_REASON }],
    notes:
      "Caso 15. Un recibo de L. 100 pagó mora, y después se perdonaron L. 200. Quedan L. 200. Pruebe: abra ese recibo y anote los montos, perdone el resto y ábralo otra vez. Debe pasar: el recibo es igual. Luego registre un pago: el recibo nuevo no debe cobrar mora.",
  },
  {
    code: "16",
    customer: "Caso 16 Pago con fecha anterior",
    cuota: BIG_CUOTA,
    months: 24,
    firstDueDaysAgo: 20,
    paid: [{ daysAgo: 8, amount: 400, enteredDaysAgo: 2 }],
    forgiven: [{ installment: 1, daysAgo: 5, amount: 500, reason: FORGIVEN_REASON }],
    notes:
      "Caso 16. Se perdonaron L. 500, y después se registró un pago de L. 400 con fecha anterior al perdón. Debe pasar: el perdón muestra L. 100 y dice «De L. 500: un pago ya había cubierto el resto». No hay «Mora pendiente».",
  },
  {
    code: "17",
    customer: "Caso 17 Quitar con pago después",
    cuota: BIG_CUOTA,
    months: 24,
    firstDueDaysAgo: 20,
    forgiven: [{ installment: 1, daysAgo: 8, amount: 300, reason: FORGIVEN_REASON }],
    paid: [{ daysAgo: 4, amount: 200 }],
    notes:
      "Caso 17. Se perdonaron L. 300 y después pagó L. 200, que cubrió el resto de la mora. Pruebe: «Quitar» el perdón. Debe pasar: Mora pendiente L. 300 y el saldo sube L. 300.",
  },
  {
    code: "18",
    customer: "Caso 18 Contrato cancelado",
    cuota: BIG_CUOTA,
    months: 24,
    firstDueDaysAgo: 20,
    cancelledDaysAgo: 3,
    notes:
      "Caso 18. Contrato cancelado con L. 500 de mora sin pagar. Debe pasar: no aparece «Perdonar», porque un contrato cerrado no se toca.",
  },
  {
    code: "19",
    customer: "Caso 19 Cancelado con perdón",
    cuota: BIG_CUOTA,
    months: 24,
    firstDueDaysAgo: 20,
    forgiven: [{ installment: 1, daysAgo: 8, amount: 200, reason: FORGIVEN_REASON }],
    cancelledDaysAgo: 3,
    notes:
      "Caso 19. Se perdonaron L. 200 y después se canceló el contrato. Debe pasar: «Cómo va» muestra Mora perdonada L. 200 y Mora pendiente L. 300, sin «Perdonar» ni «Quitar», porque un contrato cerrado no se toca.",
  },
  {
    code: "20A",
    customer: "Caso 20 Dos lotes",
    cuota: SMALL_CUOTA,
    months: 24,
    firstDueDaysAgo: 20,
    group: "dos-lotes",
    notes:
      "Caso 20, primer lote. El cliente tiene dos lotes, cada uno con L. 200 de mora. Pruebe: perdone aquí. Debe pasar: CM-20B no cambia. Luego registre un solo pago para los dos lotes y mire el recibo.",
  },
  {
    code: "20B",
    customer: "Caso 20 Dos lotes",
    cuota: SMALL_CUOTA,
    months: 24,
    firstDueDaysAgo: 20,
    group: "dos-lotes",
    notes: "Caso 20, segundo lote. Debe seguir con L. 200 de mora después de perdonar en CM-20A.",
  },
];

/** 10:00 in Honduras, so the day never slips whichever way it is read back. */
const instant = (date: string) => `${date}T16:00:00.000Z`;

export function seedMoraCases(
  tx: Pick<Db, "insert" | "select" | "update">,
  { actorId, today, timeZone }: { actorId: string; today: string; timeZone: string },
): void {
  const daysAgo = (days: number) => shiftDays(today, -days);

  // On from before the oldest cuota here, and in force since then, as if it had
  // been switched on back then.
  const startsOn = daysAgo(FIRST_DUE_MAX_DAYS_AGO + 5);
  const rule: MoraSettings = { ...RULE, startsOn };

  writeSection(tx, "mora", rule, actorId);
  writeMoraVersion(tx, rule, shiftDays(startsOn, -1), actorId);

  const projectId = randomUUID();
  tx.insert(projects).values({ id: projectId, name: "Casos de mora", areaUnit: "m2" }).run();

  const customerIds = new Map<string, string>();
  const groupIds = new Map<string, string>();

  const file = (
    contractId: string,
    at: string,
    action: string,
    reason: string,
    change: { before?: unknown; after?: unknown },
  ) => {
    tx.insert(auditEvents)
      .values({
        id: randomUUID(),
        actorId,
        entityType: "contract",
        entityId: contractId,
        action,
        reason,
        beforeJson: change.before === undefined ? null : JSON.stringify(change.before),
        afterJson: change.after === undefined ? null : JSON.stringify(change.after),
        createdAt: at,
      })
      .run();
  };

  const pay = (
    customerId: string,
    contractId: string,
    paidOn: string,
    amount: number,
    type: "down_payment" | "installment",
    enteredOn = paidOn,
  ) => {
    const highest = tx.select({ value: max(receipts.number) }).from(receipts).get();
    const receiptId = randomUUID();
    const code = allocateReceiptCode(
      (candidate) => tx.select({ id: receipts.id }).from(receipts).where(eq(receipts.code, candidate)).get() !== undefined,
    );

    tx.insert(receipts)
      .values({
        id: receiptId,
        number: nextReceiptNumber(highest?.value),
        code,
        lookupCode: generateLookupCode(),
        customerId,
        issuedOn: paidOn,
        issuedBy: actorId,
        createdAt: instant(enteredOn),
      })
      .run();

    tx.insert(payments)
      .values({
        id: randomUUID(),
        contractId,
        receiptId,
        amountCents: amount * 100,
        originalAmountCents: amount * 100,
        originalCurrency: "HNL",
        exchangeRate: "1",
        paidOn,
        method: "cash",
        type,
        recordedBy: actorId,
        createdAt: instant(enteredOn),
      })
      .run();
  };

  for (const spec of CASES) {
    const down = spec.down ?? 5_000;
    const price = down + spec.cuota * spec.months;
    const firstDueOn = daysAgo(spec.firstDueDaysAgo);
    const signedOn = daysAgo(spec.signedDaysAgo ?? 100);
    const lotId = randomUUID();
    const contractId = randomUUID();

    let customerId = customerIds.get(spec.customer);

    if (!customerId) {
      customerId = randomUUID();
      customerIds.set(spec.customer, customerId);
      tx.insert(customers)
        .values({ id: customerId, fullName: spec.customer, customerSince: Number(today.slice(0, 4)) })
        .run();
    }

    if (spec.group && !groupIds.has(spec.group)) {
      groupIds.set(spec.group, randomUUID());
    }

    tx.insert(lots)
      .values({ id: lotId, projectId, code: `M-${spec.code}`, areaM2: 300, basePriceCents: price * 100 })
      .run();

    tx.insert(contracts)
      .values({
        id: contractId,
        code: `CM-${spec.code}`,
        lotId,
        customerId,
        saleGroupId: spec.group ? groupIds.get(spec.group)! : null,
        kind: "contract",
        saleType: "financed",
        status: "active",
        salePriceCents: price * 100,
        downPaymentCents: down * 100,
        termMonths: spec.months,
        monthlyPaymentCents: spec.cuota * 100,
        dueDay: Number(firstDueOn.slice(8, 10)),
        signedOn,
        firstDueOn,
        notes: spec.notes,
        createdAt: instant(signedOn),
      })
      .run();

    if (down > 0 && !spec.primaUnpaid) {
      pay(customerId, contractId, signedOn, down, "down_payment");
    }

    for (const payment of spec.paid ?? []) {
      pay(
        customerId,
        contractId,
        daysAgo(payment.daysAgo),
        payment.amount,
        "installment",
        payment.enteredDaysAgo === undefined ? undefined : daysAgo(payment.enteredDaysAgo),
      );
    }

    for (const entry of spec.manual ?? []) {
      const incurredOn = daysAgo(entry.daysAgo);

      tx.insert(moraManualCharges)
        .values({
          id: randomUUID(),
          contractId,
          installment: entry.installment,
          incurredOn,
          amountCents: entry.amount * 100,
          reason: entry.reason,
          recordedBy: actorId,
          recordedAt: instant(incurredOn),
        })
        .run();

      file(contractId, instant(incurredOn), "mora_charge", entry.reason, {
        after: { moraInstallment: entry.installment, moraIncurredOn: incurredOn, amountCents: entry.amount * 100 },
      });
    }

    if (spec.rule) {
      const effectiveFrom = daysAgo(spec.rule.daysAgo);
      const recordedAt = instant(shiftDays(effectiveFrom, -1));
      const rules = spec.rule.mode === "own" ? spec.rule.rules : null;
      const reason = spec.ruleReason!;

      tx.insert(moraContractRules)
        .values({
          id: randomUUID(),
          contractId,
          effectiveFrom,
          mode: spec.rule.mode,
          value: rules === null ? null : JSON.stringify(rules),
          reason,
          recordedBy: actorId,
          recordedAt,
        })
        .run();

      file(contractId, recordedAt, "mora_rule", reason, {
        before: { moraRule: "general" },
        after: { moraRule: spec.rule.mode, ...rules, moraRuleFrom: effectiveFrom },
      });
    }

    for (const entry of spec.forgiven ?? []) {
      const forgivenOn = daysAgo(entry.daysAgo);

      tx.insert(moraForgiveness)
        .values({
          id: randomUUID(),
          contractId,
          installment: entry.installment,
          forgivenOn,
          amountCents: entry.amount * 100,
          reason: entry.reason,
          recordedBy: actorId,
          recordedAt: instant(forgivenOn),
        })
        .run();

      file(contractId, instant(forgivenOn), "mora_forgive", entry.reason, {
        after: { moraInstallment: entry.installment, moraForgivenOn: forgivenOn, amountCents: entry.amount * 100 },
      });
    }

    if (spec.cancelledDaysAgo !== undefined) {
      const closedAt = instant(daysAgo(spec.cancelledDaysAgo));
      const reason = "El cliente desistió de la compra.";

      tx.update(contracts)
        .set({ status: "cancelled", closedAt, closedReason: reason, closedSettlement: "none", updatedAt: closedAt })
        .where(eq(contracts.id, contractId))
        .run();

      file(contractId, closedAt, "cancel", reason, {
        before: { status: "active", closedAt: null },
        after: { status: "cancelled", closedAt, closedSettlement: "none" },
      });
    }

    syncContractLifecycle(tx, contractId, { asOf: today, timeZone });
  }
}
