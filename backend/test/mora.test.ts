import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ContractTerms } from "../src/lib/contracts.js";
import type { ContractMoraVersion, MoraContract, MoraCredit, MoraRuleVersion } from "../src/lib/mora.js";
import { contractHistory, moraAccount, moraPaidThrough, moraPendingThrough, rulesOn } from "../src/lib/mora.js";
import type { MoraSettings, OwnMoraRules } from "../src/lib/settings.js";

/** L 1 = 100 centavos, as everywhere else in the app. */
const lempiras = (amount: number) => Math.round(amount * 100);

/*
 * The contract of the preview's worked examples: a L 160,000 prima and twelve
 * cuotas of L 25,000 on the 5th, so cuota 4 falls due on 5 October 2026.
 */
const TERMS: ContractTerms = {
  saleType: "financed",
  salePriceCents: lempiras(460_000),
  downPaymentCents: lempiras(160_000),
  termMonths: 12,
  monthlyPaymentCents: lempiras(25_000),
  dueDay: 5,
  signedOn: "2026-06-15",
};

const CONTRACT: MoraContract = { terms: TERMS, kind: "contract", closedOn: null };

/** 2 % of what is unpaid, once, five days of grace, from 1 October. */
const RULES: MoraSettings = {
  enabled: true,
  startsOn: "2026-10-01",
  calculation: "percent",
  percent: 2,
  fixedCents: 0,
  graceDays: 5,
  capCents: null,
  minUnpaidCents: null,
  frequency: "once",
  chargeDownPayment: false,
  paymentOrder: "mora",
};

const since = (rules: Partial<MoraSettings> = {}, effectiveFrom = "2026-09-30"): MoraRuleVersion => ({
  effectiveFrom,
  rules: { ...RULES, ...rules },
});

let sequence = 0;

function pay(paidOn: string, amount: number): MoraCredit {
  sequence += 1;
  return {
    id: `p${sequence}`,
    amountCents: lempiras(amount),
    paidOn,
    createdAt: `${paidOn}T12:00:00.000Z`,
  };
}

/** The prima and cuotas 1 to 3, all on time. */
const onTimeThroughCuota3 = () => [
  pay("2026-06-15", 160_000),
  pay("2026-07-05", 25_000),
  pay("2026-08-05", 25_000),
  pay("2026-09-05", 25_000),
];

const chargesOf = (account: ReturnType<typeof moraAccount>) =>
  account.charges.map((entry) => [entry.installment, entry.incurredOn, entry.amountCents / 100]);

describe("mora charges", () => {
  it("charges a late cuota the day after its grace days, on what is unpaid", () => {
    const account = moraAccount(CONTRACT, onTimeThroughCuota3(), [since()], "2026-10-20");

    // Due 5 October, five days of grace to the 10th, charged on the 11th.
    assert.deepEqual(chargesOf(account), [[4, "2026-10-11", 500]]);
    assert.equal(account.pendingCents, lempiras(500));
  });

  it("charges nothing for a cuota paid on the last day of grace", () => {
    const credits = [...onTimeThroughCuota3(), pay("2026-10-10", 25_000)];
    const account = moraAccount(CONTRACT, credits, [since()], "2026-10-20");

    assert.deepEqual(account.charges, []);
  });

  it("charges a percentage of what is still unpaid of a part-paid cuota", () => {
    // Half of cuota 4 on time: 2 % of the L 12,500 still missing.
    const credits = [...onTimeThroughCuota3(), pay("2026-10-03", 12_500)];
    const account = moraAccount(CONTRACT, credits, [since()], "2026-10-20");

    assert.deepEqual(chargesOf(account), [[4, "2026-10-11", 250]]);
  });

  it("charges a fixed amount whatever is unpaid", () => {
    const credits = [...onTimeThroughCuota3(), pay("2026-10-03", 12_500)];
    const account = moraAccount(
      CONTRACT,
      credits,
      [since({ calculation: "fixed", fixedCents: lempiras(500) })],
      "2026-10-20",
    );

    assert.deepEqual(chargesOf(account), [[4, "2026-10-11", 500]]);
  });

  it("charges a fixed amount on centavos short while there is no minimum", () => {
    // All of cuota 4 on time but 49 centavos.
    const credits = [...onTimeThroughCuota3(), pay("2026-10-03", 24_999.51)];
    const account = moraAccount(
      CONTRACT,
      credits,
      [since({ calculation: "fixed", fixedCents: lempiras(500) })],
      "2026-10-20",
    );

    assert.deepEqual(chargesOf(account), [[4, "2026-10-11", 500]]);
  });

  it("charges nothing while less than the minimum is unpaid of the cuota", () => {
    const shortBy = (amount: number) => [...onTimeThroughCuota3(), pay("2026-10-03", 25_000 - amount)];
    const rules = [since({ calculation: "fixed", fixedCents: lempiras(500), minUnpaidCents: lempiras(100) })];

    // 49 centavos short: nothing. Exactly the minimum short: charged.
    assert.deepEqual(moraAccount(CONTRACT, shortBy(0.49), rules, "2026-10-20").charges, []);
    assert.deepEqual(chargesOf(moraAccount(CONTRACT, shortBy(100), rules, "2026-10-20")), [
      [4, "2026-10-11", 500],
    ]);
  });

  it("asks the minimum again every month with «Cada mes»", () => {
    // L 50 short of cuota 4 stays under the minimum every month, while cuota 5,
    // wholly unpaid, is over it.
    const credits = [...onTimeThroughCuota3(), pay("2026-10-03", 24_950)];
    const account = moraAccount(
      CONTRACT,
      credits,
      [since({ calculation: "fixed", fixedCents: lempiras(500), frequency: "monthly", minUnpaidCents: lempiras(100) })],
      "2026-11-20",
    );

    assert.deepEqual(chargesOf(account), [[5, "2026-11-11", 500]]);
  });

  it("charges once per cuota with «Una vez», however long it stays late", () => {
    const account = moraAccount(CONTRACT, onTimeThroughCuota3(), [since()], "2027-01-20");

    // Cuotas 4 to 7 are each late, and each is charged once.
    assert.deepEqual(chargesOf(account), [
      [4, "2026-10-11", 500],
      [5, "2026-11-11", 500],
      [6, "2026-12-11", 500],
      [7, "2027-01-11", 500],
    ]);
  });

  it("charges every month with «Cada mes», each time on what is unpaid then", () => {
    // Half of cuota 4 on time, L 6,000 more on 20 October. With the payment
    // order on «la cuota», all of it reaches the cuota.
    const credits = [
      ...onTimeThroughCuota3(),
      pay("2026-10-03", 12_500),
      pay("2026-10-20", 6_000),
    ];
    const account = moraAccount(
      CONTRACT,
      credits,
      [since({ frequency: "monthly", paymentOrder: "cuota" })],
      "2026-11-11",
    );

    assert.deepEqual(chargesOf(account), [
      [4, "2026-10-11", 250],
      // 2 % of the L 6,500 still missing on 11 November.
      [4, "2026-11-11", 130],
      // Cuota 5, due 5 November, is late on the same day.
      [5, "2026-11-11", 500],
    ]);
  });

  it("stops at the maximum per cuota", () => {
    const account = moraAccount(
      CONTRACT,
      onTimeThroughCuota3(),
      [since({ calculation: "fixed", fixedCents: lempiras(500), frequency: "monthly", capCents: lempiras(1_200) })],
      "2026-12-31",
    );

    const cuota4 = account.charges.filter((entry) => entry.installment === 4);

    // 500 + 500 + the 200 left under the maximum, then nothing more.
    assert.deepEqual(
      cuota4.map((entry) => [entry.incurredOn, entry.amountCents / 100]),
      [
        ["2026-10-11", 500],
        ["2026-11-11", 500],
        ["2026-12-11", 200],
      ],
    );
  });

  it("never charges a cuota that fell due before «Desde»", () => {
    // Cuota 3, due 5 September, is still unpaid. Mora started on 1 October.
    const credits = [pay("2026-06-15", 160_000), pay("2026-07-05", 25_000), pay("2026-08-05", 25_000)];
    const account = moraAccount(CONTRACT, credits, [since()], "2026-10-09");

    assert.deepEqual(account.charges, []);
  });

  it("after «Desde» is put back, charges a cuota from the in-between days no earlier than the undo", () => {
    // «Desde» 1 October, moved to 8 October, then put back from the 15th.
    // Cuota 4, due 5 October, would have been charged on the 11th.
    const history = [
      since(),
      since({ startsOn: "2026-10-08" }, "2026-10-07"),
      since({}, "2026-10-15"),
    ];
    const account = moraAccount(CONTRACT, onTimeThroughCuota3(), history, "2026-10-20");

    assert.deepEqual(chargesOf(account), [[4, "2026-10-15", 500]]);
  });

  it("charges a late prima only when the setting says so", () => {
    const terms = { ...TERMS, signedOn: "2026-10-15", firstDueOn: "2026-11-05" };
    const contract = { ...CONTRACT, terms };

    assert.deepEqual(moraAccount(contract, [], [since()], "2026-10-25").charges, []);

    const account = moraAccount(contract, [], [since({ chargeDownPayment: true })], "2026-10-25");

    // The prima is due on signing: 2 % of L 160,000 on the 21st.
    assert.deepEqual(chargesOf(account), [[0, "2026-10-21", 3_200]]);
  });

  it("charges nothing on a reservation, a cash sale or a donation", () => {
    const credits = onTimeThroughCuota3();

    assert.deepEqual(
      moraAccount({ ...CONTRACT, kind: "reservation" }, credits, [since()], "2026-12-31").charges,
      [],
    );
    assert.deepEqual(
      moraAccount({ ...CONTRACT, terms: { ...TERMS, saleType: "cash" } }, [], [since()], "2026-12-31")
        .charges,
      [],
    );
  });

  it("charges nothing from the day a contract was closed", () => {
    const account = moraAccount(
      { ...CONTRACT, closedOn: "2026-11-11" },
      onTimeThroughCuota3(),
      [since()],
      "2027-01-20",
    );

    assert.deepEqual(chargesOf(account), [[4, "2026-10-11", 500]]);
  });

  it("charges nothing while mora has never been switched on", () => {
    const account = moraAccount(CONTRACT, onTimeThroughCuota3(), [], "2027-01-20");

    assert.deepEqual(account.charges, []);
    assert.ok(account.splits.every((split) => split.toMoraCents === 0));
  });
});

describe("mora rules over time", () => {
  it("keeps a charge already made when the rules change later", () => {
    const history = [since(), since({ percent: 3 }, "2026-11-01")];
    const account = moraAccount(CONTRACT, onTimeThroughCuota3(), history, "2026-11-20");

    // Cuota 4 was charged in October at 2 %; cuota 5 in November at 3 %.
    assert.deepEqual(chargesOf(account), [
      [4, "2026-10-11", 500],
      [5, "2026-11-11", 750],
    ]);
  });

  it("stops charging from the day mora is switched off, and keeps what was charged", () => {
    const history = [since(), since({ enabled: false }, "2026-11-01")];
    const account = moraAccount(CONTRACT, onTimeThroughCuota3(), history, "2026-12-20");

    assert.deepEqual(chargesOf(account), [[4, "2026-10-11", 500]]);
  });

  it("counts grace days by the rules of each day", () => {
    // Five days of grace until the 9th, three from the 10th. Cuota 4 (due the
    // 5th) is first charged on the 10th: on the 9th, the rules of the 9th
    // still gave it until the 10th.
    const history = [since(), since({ graceDays: 3 }, "2026-10-10")];
    const account = moraAccount(CONTRACT, onTimeThroughCuota3(), history, "2026-10-20");

    assert.deepEqual(chargesOf(account), [[4, "2026-10-10", 500]]);
  });

  it("reads the rules in force on a day", () => {
    const history = [since(), since({ percent: 3 }, "2026-11-01")];

    assert.equal(rulesOn(history, "2026-09-29"), null);
    assert.equal(rulesOn(history, "2026-10-31")?.percent, 2);
    assert.equal(rulesOn(history, "2026-11-01")?.percent, 3);
  });
});

describe("what a payment covers", () => {
  it("covers the mora first when set to «La mora»", () => {
    const late = pay("2026-11-20", 25_000);
    const credits = [...onTimeThroughCuota3(), late];
    const account = moraAccount(CONTRACT, credits, [since()], "2026-11-20");
    const split = account.splits.find((entry) => entry.creditId === late.id)!;

    // L 500 on cuota 4 (11 Oct) and L 500 on cuota 5 (11 Nov) come off first.
    assert.equal(split.toMoraCents, lempiras(1_000));
    assert.equal(split.toPriceCents, lempiras(24_000));
    assert.deepEqual(split.moraPaid, [
      { installment: 4, amountCents: lempiras(500) },
      { installment: 5, amountCents: lempiras(500) },
    ]);
    assert.equal(account.pendingCents, 0);
  });

  it("covers the cuotas already due first when set to «La cuota»", () => {
    const late = pay("2026-10-20", 25_000);
    const credits = [...onTimeThroughCuota3(), late];
    const account = moraAccount(CONTRACT, credits, [since({ paymentOrder: "cuota" })], "2026-10-20");
    const split = account.splits.find((entry) => entry.creditId === late.id)!;

    // Cuota 4 is complete; the L 500 mora is still owed.
    assert.equal(split.toMoraCents, 0);
    assert.equal(split.toPriceCents, lempiras(25_000));
    assert.equal(split.moraPendingAfterCents, lempiras(500));
    assert.equal(account.pendingCents, lempiras(500));
  });

  it("puts what is left after the cuotas due on the mora, before any advance", () => {
    const late = pay("2026-10-20", 30_000);
    const credits = [...onTimeThroughCuota3(), late];
    const account = moraAccount(CONTRACT, credits, [since({ paymentOrder: "cuota" })], "2026-10-20");
    const split = account.splits.find((entry) => entry.creditId === late.id)!;

    assert.equal(split.toMoraCents, lempiras(500));
    assert.equal(split.toPriceCents, lempiras(29_500));
  });

  it("makes a smaller monthly charge when a payment covered the mora first", () => {
    // The L 6,000 of 20 October first pays the L 250 mora, so cuota 4 still
    // misses L 6,750 on 11 November, not L 6,500.
    const credits = [
      ...onTimeThroughCuota3(),
      pay("2026-10-03", 12_500),
      pay("2026-10-20", 6_000),
    ];
    const account = moraAccount(CONTRACT, credits, [since({ frequency: "monthly" })], "2026-11-11");

    assert.deepEqual(
      chargesOf(account).filter(([installment]) => installment === 4),
      [
        [4, "2026-10-11", 250],
        [4, "2026-11-11", 135],
      ],
    );
  });

  it("re-derives the mora when a late payment is entered with its real date", () => {
    // Typed in on the 20th, but the money arrived on the 8th: never late.
    const credits = [...onTimeThroughCuota3(), { ...pay("2026-10-08", 25_000), createdAt: "2026-10-20T15:00:00.000Z" }];
    const account = moraAccount(CONTRACT, credits, [since()], "2026-10-20");

    assert.deepEqual(account.charges, []);
  });

  it("reads what was paid and owed at an earlier date", () => {
    const credits = [...onTimeThroughCuota3(), pay("2026-11-20", 25_000)];
    const account = moraAccount(CONTRACT, credits, [since()], "2026-11-30");

    assert.equal(moraPendingThrough(account, "2026-10-31"), lempiras(500));
    assert.equal(moraPaidThrough(account, "2026-10-31"), 0);
    assert.equal(moraPaidThrough(account, "2026-11-30"), lempiras(1_000));
    assert.equal(moraPendingThrough(account, "2026-11-30"), 0);
  });
});

describe("mora put on by hand («Cargar mora»)", () => {
  it("turns part of a payment already made into mora, without mora ever switched on", () => {
    // Cuota 4 due 5 October. On the 20th the customer paid L 25,500: the cuota
    // and L 500 of mora in cash, entered as one payment.
    const credits = [...onTimeThroughCuota3(), pay("2026-10-20", 25_500)];

    const before = moraAccount(CONTRACT, credits, [], "2026-10-25");

    assert.deepEqual(before.charges, []);
    assert.equal(before.splits.at(-1)!.toMoraCents, 0);

    const manual = [{ id: "m1", installment: 4, incurredOn: "2026-10-20", amountCents: lempiras(500) }];
    const after = moraAccount(CONTRACT, credits, [], "2026-10-25", manual);

    assert.deepEqual(chargesOf(after), [[4, "2026-10-20", 500]]);
    assert.equal(after.charges[0]!.manualId, "m1");

    // Charged before the payment on the same day, so the payment covers it.
    const split = after.splits.at(-1)!;

    assert.equal(split.toMoraCents, lempiras(500));
    assert.equal(split.toPriceCents, lempiras(25_000));
    assert.deepEqual(split.moraPaid, [{ installment: 4, amountCents: lempiras(500) }]);
    assert.equal(after.pendingCents, 0);
    assert.deepEqual(after.pendingByCharge, {});
  });

  it("is owed from its day when nothing has paid it yet, and the next payment covers it", () => {
    // Cuota 3 paid late on 30 September, before mora existed. L 500 agreed on 25 October.
    const credits = [
      pay("2026-06-15", 160_000),
      pay("2026-07-05", 25_000),
      pay("2026-08-05", 25_000),
      pay("2026-09-30", 25_000),
    ];
    const manual = [{ id: "m2", installment: 3, incurredOn: "2026-10-25", amountCents: lempiras(500) }];

    const owed = moraAccount(CONTRACT, credits, [], "2026-10-25", manual);

    assert.equal(owed.pendingCents, lempiras(500));
    assert.deepEqual(owed.pendingByCharge, { "mora:manual:m2": lempiras(500) });

    const paid = moraAccount(CONTRACT, [...credits, pay("2026-11-05", 25_500)], [], "2026-11-06", manual);
    const split = paid.splits.at(-1)!;

    assert.equal(split.toMoraCents, lempiras(500));
    assert.deepEqual(split.moraPaid, [{ installment: 3, amountCents: lempiras(500) }]);
    assert.equal(paid.pendingCents, 0);
  });

  it("is not held to the rules: charged on top of the automatic mora, past the maximum", () => {
    const rules = [since({ calculation: "fixed", fixedCents: lempiras(500), capCents: lempiras(500) })];
    const manual = [{ id: "m3", installment: 4, incurredOn: "2026-10-15", amountCents: lempiras(300) }];

    const account = moraAccount(CONTRACT, onTimeThroughCuota3(), rules, "2026-10-20", manual);

    assert.deepEqual(chargesOf(account), [
      [4, "2026-10-11", 500],
      [4, "2026-10-15", 300],
    ]);
    assert.equal(account.pendingCents, lempiras(800));
  });

  it("waits for its day, and ignores a cuota the contract does not have", () => {
    const manual = [
      { id: "m4", installment: 4, incurredOn: "2026-10-30", amountCents: lempiras(500) },
      { id: "m5", installment: 99, incurredOn: "2026-10-15", amountCents: lempiras(500) },
    ];

    assert.deepEqual(moraAccount(CONTRACT, onTimeThroughCuota3(), [], "2026-10-20", manual).charges, []);
  });

  it("never charges a reservation or a cash sale", () => {
    const manual = [{ id: "m6", installment: 4, incurredOn: "2026-10-15", amountCents: lempiras(500) }];

    assert.deepEqual(
      moraAccount({ ...CONTRACT, kind: "reservation" }, onTimeThroughCuota3(), [], "2026-10-20", manual).charges,
      [],
    );
  });
});

describe("a contract's own rule", () => {
  const OWN: OwnMoraRules = {
    calculation: "fixed",
    percent: 0,
    fixedCents: lempiras(300),
    capCents: null,
    minUnpaidCents: null,
    frequency: "once",
  };
  const none = (effectiveFrom: string): ContractMoraVersion => ({ effectiveFrom, rule: { mode: "none" } });
  const general = (effectiveFrom: string): ContractMoraVersion => ({ effectiveFrom, rule: { mode: "general" } });
  const own = (effectiveFrom: string, rules: Partial<OwnMoraRules> = {}): ContractMoraVersion => ({
    effectiveFrom,
    rule: { mode: "own", rules: { ...OWN, ...rules } },
  });
  const account = (versions: ContractMoraVersion[], asOf: string, history = [since()]) =>
    moraAccount(CONTRACT, onTimeThroughCuota3(), contractHistory(history, versions), asOf);

  it("leaves every other contract on the general history, untouched", () => {
    const history = [since()];

    assert.equal(contractHistory(history, []), history);
  });

  it("charges nothing on a contract «Sin mora»", () => {
    assert.deepEqual(chargesOf(account([none("2026-10-01")], "2026-12-20")), []);
  });

  it("keeps the mora charged before «Sin mora» was set: never backwards", () => {
    // Cuota 4 was charged on the 11th; «Sin mora» counts from the 12th.
    assert.deepEqual(chargesOf(account([none("2026-10-12")], "2026-12-20")), [[4, "2026-10-11", 500]]);
  });

  it("charges its own amount, on the general grace days", () => {
    assert.deepEqual(chargesOf(account([own("2026-10-01")], "2026-10-20")), [[4, "2026-10-11", 300]]);
  });

  it("charges nothing while mora is switched off in Configuración, whatever its own rule", () => {
    const off = [since({ enabled: false })];

    assert.deepEqual(chargesOf(account([own("2026-10-01")], "2026-12-20", off)), []);
  });

  it("changes how much and how often from its day, after a charge under the general rule", () => {
    // 2 % once under the general rule on 11 October; from the 20th, 1 % every
    // month, so cuota 4 is charged again on 11 November, and cuota 5 too.
    const charges = chargesOf(
      account([own("2026-10-20", { calculation: "percent", percent: 1, frequency: "monthly" })], "2026-11-20"),
    );

    assert.deepEqual(charges, [
      [4, "2026-10-11", 500],
      [4, "2026-11-11", 250],
      [5, "2026-11-11", 250],
    ]);
  });

  it("back from «Sin mora», charges only the cuotas falling due from that day", () => {
    // Without mora through October; back on the general rule from 1 November.
    // Cuota 4 (due 5 October) stays without mora; cuota 5 (due 5 November) does not.
    assert.deepEqual(chargesOf(account([none("2026-10-01"), general("2026-11-01")], "2026-11-20")), [
      [5, "2026-11-11", 500],
    ]);
  });
});
