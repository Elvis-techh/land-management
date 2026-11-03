import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrations.js";
import { seedMoraCases } from "../src/db/moraCases.js";
import { contracts, payments, users } from "../src/db/schema.js";
import { loadMoraAccounts } from "../src/lib/moraAccounts.js";
import { businessToday } from "../src/lib/time.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

/*
 * The test site's «Caso» contracts (src/db/moraCases.ts).
 *
 * A person walks through these with the notes on each contract, so the notes
 * have to be true: every amount they promise is checked here, on the day of the
 * seed, whichever day that is. And then, through the real routes, what they say
 * should happen when something is tried.
 */

const TIME_ZONE = "America/Tegucigalpa";

/** In centavos, by contract code: what the notes promise right after a seed. */
const EXPECTED: Record<
  string,
  { charged: number; paid: number; forgiven: number; pending: number; byInstallment: Record<number, number> }
> = {
  "CM-01": { charged: 20_000, paid: 0, forgiven: 0, pending: 20_000, byInstallment: { 1: 20_000 } },
  "CM-02": { charged: 50_000, paid: 0, forgiven: 0, pending: 50_000, byInstallment: { 1: 50_000 } },
  "CM-03": {
    charged: 110_000,
    paid: 0,
    forgiven: 0,
    pending: 110_000,
    byInstallment: { 1: 50_000, 2: 40_000, 3: 20_000 },
  },
  "CM-04": { charged: 50_000, paid: 0, forgiven: 0, pending: 50_000, byInstallment: { 0: 50_000 } },
  "CM-05": { charged: 50_000, paid: 30_000, forgiven: 0, pending: 20_000, byInstallment: { 1: 20_000 } },
  "CM-06": { charged: 50_000, paid: 50_000, forgiven: 0, pending: 0, byInstallment: {} },
  "CM-07": { charged: 30_000, paid: 0, forgiven: 0, pending: 30_000, byInstallment: { 1: 30_000 } },
  "CM-08": { charged: 50_000, paid: 0, forgiven: 0, pending: 50_000, byInstallment: { 2: 50_000 } },
  "CM-09": { charged: 50_000, paid: 0, forgiven: 0, pending: 50_000, byInstallment: { 1: 50_000 } },
  "CM-10": { charged: 40_000, paid: 0, forgiven: 20_000, pending: 20_000, byInstallment: { 1: 20_000 } },
  "CM-11": { charged: 50_000, paid: 0, forgiven: 50_000, pending: 0, byInstallment: {} },
  "CM-12": { charged: 20_000, paid: 0, forgiven: 0, pending: 20_000, byInstallment: { 1: 20_000 } },
  "CM-13": { charged: 60_000, paid: 0, forgiven: 0, pending: 60_000, byInstallment: { 1: 60_000 } },
  "CM-14": { charged: 20_000, paid: 0, forgiven: 20_000, pending: 0, byInstallment: {} },
  "CM-15": { charged: 50_000, paid: 10_000, forgiven: 20_000, pending: 20_000, byInstallment: { 1: 20_000 } },
  "CM-16": { charged: 50_000, paid: 40_000, forgiven: 10_000, pending: 0, byInstallment: {} },
  "CM-17": { charged: 50_000, paid: 20_000, forgiven: 30_000, pending: 0, byInstallment: {} },
  "CM-18": { charged: 50_000, paid: 0, forgiven: 0, pending: 50_000, byInstallment: { 1: 50_000 } },
  "CM-19": { charged: 50_000, paid: 0, forgiven: 20_000, pending: 30_000, byInstallment: { 1: 30_000 } },
  "CM-20A": { charged: 20_000, paid: 0, forgiven: 0, pending: 20_000, byInstallment: { 1: 20_000 } },
  "CM-20B": { charged: 20_000, paid: 0, forgiven: 0, pending: 20_000, byInstallment: { 1: 20_000 } },
};

describe("the mora cases come out the same on any day", () => {
  // Months of 28, 29, 30 and 31 days, and the days the due day has to clamp.
  const days = [
    "2026-01-31",
    "2026-02-28",
    "2026-03-01",
    "2026-03-31",
    "2026-04-30",
    "2026-07-31",
    "2026-11-03",
    "2026-12-31",
    "2028-02-29",
    "2028-03-30",
  ];

  for (const today of days) {
    it(`seeded on ${today}`, () => {
      const { db, sqlite } = createDb(":memory:");
      runMigrations(db, sqlite);

      const actorId = randomUUID();
      db.insert(users)
        .values({ id: actorId, email: "owner@test.hn", name: "Owner", role: "owner", passwordHash: "x" })
        .run();

      seedMoraCases(db, { actorId, today, timeZone: TIME_ZONE });

      const accounts = loadMoraAccounts(db, { asOf: today, timeZone: TIME_ZONE });
      const rows = db.select({ id: contracts.id, code: contracts.code }).from(contracts).all();

      assert.equal(rows.length, Object.keys(EXPECTED).length);

      for (const { id, code } of rows) {
        const account = accounts.get(id);
        const expected = EXPECTED[code]!;

        assert.ok(account, code);
        assert.deepEqual(
          {
            charged: account.chargedCents,
            paid: account.paidCents,
            forgiven: account.forgivenCents,
            pending: account.pendingCents,
            byInstallment: account.pendingByInstallment,
          },
          expected,
          code,
        );
      }

      sqlite.close();
    });
  }
});

describe("the mora cases, through the routes", async () => {
  const { app, sqlite, db, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  seedMoraCases(db, { actorId: ids.ownerId, today: businessToday(TIME_ZONE), timeZone: TIME_ZONE });

  const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const list = async () =>
    (await app.inject({ method: "GET", url: "/api/contracts", headers: { cookie } })).json().contracts as Array<{
      id: string;
      code: string;
      status: string;
      balance: number;
      notes: string | null;
      mora: { charged: number; paid: number; forgiven: number; pending: number };
      health?: { status: string; arrears: number };
    }>;

  const contract = async (code: string) => (await list()).find((row) => row.code === code)!;

  const moraOf = async (code: string) =>
    (
      await app.inject({
        method: "GET",
        url: `/api/contracts/${(await contract(code)).id}/mora`,
        headers: { cookie },
      })
    ).json();

  const forgive = async (code: string, installment: number, amountCents: number, who = cookie) =>
    app.inject({
      method: "POST",
      url: `/api/contracts/${(await contract(code)).id}/mora/forgive`,
      headers: { cookie: who },
      payload: { installment, amountCents, reason: "Se acordó perdonar esta mora en la prueba." },
    });

  const unforgive = async (code: string) => {
    const row = await contract(code);
    const entry = (await moraOf(code)).forgiven[0];

    return app.inject({
      method: "POST",
      url: `/api/contracts/${row.id}/mora/forgiven/${entry.id}/remove`,
      headers: { cookie },
      payload: { reason: "Se perdonó por error en esta prueba." },
    });
  };

  /** The case's receipt, leaving the prima's out. */
  const receiptOf = async (code: string) => {
    const row = await contract(code);
    const payment = db
      .select({ receiptId: payments.receiptId })
      .from(payments)
      .where(and(eq(payments.contractId, row.id), eq(payments.type, "installment")))
      .get();

    return payment!.receiptId!;
  };

  it("gives every contract the notes that say what to try", async () => {
    const rows = (await list()).filter((row) => row.code.startsWith("CM-"));

    assert.equal(rows.length, Object.keys(EXPECTED).length);
    for (const row of rows) {
      assert.match(row.notes ?? "", /^Caso \d\d/, row.code);
    }
  });

  it("shows the same figures through the routes as the notes promise", async () => {
    for (const row of await list()) {
      const expected = EXPECTED[row.code];

      if (!expected) {
        continue;
      }

      const { byInstallment, ...totals } = expected;
      assert.deepEqual(row.mora, totals, row.code);
      assert.deepEqual((await moraOf(row.code)).pendingByInstallment, byInstallment, row.code);
    }
  });

  it("does not let an associate forgive", async () => {
    assert.equal((await forgive("CM-01", 1, 20_000, staffCookie)).statusCode, 403);
  });

  it("case 01: forgiving all of it takes it off the saldo", async () => {
    const before = await contract("CM-01");
    assert.equal((await forgive("CM-01", 1, 20_000)).statusCode, 201);

    const row = await contract("CM-01");
    assert.equal(row.mora.pending, 0);
    assert.equal(row.balance, before.balance - 20_000);
  });

  it("case 02: refuses too much, then forgives in two parts", async () => {
    assert.equal((await forgive("CM-02", 1, 60_000)).statusCode, 400);
    assert.equal((await forgive("CM-02", 1, 30_000)).statusCode, 201);
    assert.equal((await forgive("CM-02", 1, 10_000)).statusCode, 201);

    const mora = await moraOf("CM-02");
    assert.equal(mora.forgiven.length, 2);
    assert.deepEqual(mora.pendingByInstallment, { 1: 10_000 });
  });

  it("case 03: one cuota leaves the others alone", async () => {
    assert.equal((await forgive("CM-03", 2, 40_000)).statusCode, 201);
    assert.deepEqual((await moraOf("CM-03")).pendingByInstallment, { 1: 50_000, 3: 20_000 });
    assert.equal((await contract("CM-03")).mora.pending, 70_000);
  });

  it("case 04: the prima's mora can be forgiven", async () => {
    assert.equal((await forgive("CM-04", 0, 50_000)).statusCode, 201);
    assert.equal((await contract("CM-04")).mora.pending, 0);
  });

  it("case 05: offers only what is unpaid", async () => {
    assert.equal((await forgive("CM-05", 1, 30_000)).statusCode, 400);
    assert.equal((await forgive("CM-05", 1, 20_000)).statusCode, 201);
    assert.equal((await contract("CM-05")).mora.paid, 30_000);
  });

  it("case 06: nothing to forgive until the receipt is voided", async () => {
    assert.equal((await forgive("CM-06", 1, 1)).statusCode, 400);

    const voided = await app.inject({
      method: "POST",
      url: `/api/receipts/${await receiptOf("CM-06")}/void`,
      headers: { cookie },
      payload: { reason: "Se anuló para probar el perdón." },
    });
    assert.equal(voided.statusCode, 200, voided.body);
    assert.deepEqual((await moraOf("CM-06")).pendingByInstallment, { 1: 50_000 });
    assert.equal((await forgive("CM-06", 1, 50_000)).statusCode, 201);
  });

  it("case 07: mora alone does not make a contract late", async () => {
    assert.equal((await contract("CM-07")).health?.arrears, 0);
    assert.equal((await forgive("CM-07", 1, 30_000)).statusCode, 201);
    assert.equal((await contract("CM-07")).health?.arrears, 0);
  });

  it("case 08: forgiving the last of it settles the contract, and «Quitar» reopens it", async () => {
    assert.equal((await contract("CM-08")).status, "active");
    assert.equal((await contract("CM-08")).balance, 50_000);

    assert.equal((await forgive("CM-08", 2, 50_000)).statusCode, 201);
    assert.equal((await contract("CM-08")).status, "paid_off");

    assert.equal((await unforgive("CM-08")).statusCode, 200);
    assert.equal((await contract("CM-08")).status, "active");
    assert.equal((await contract("CM-08")).balance, 50_000);
  });

  it("case 09: clears the oldest charge first, the automatic one", async () => {
    assert.equal((await forgive("CM-09", 1, 20_000)).statusCode, 201);
    assert.equal((await moraOf("CM-09")).manual[0].pendingCents, 30_000);

    assert.equal((await forgive("CM-09", 1, 10_000)).statusCode, 201);
    assert.equal((await moraOf("CM-09")).manual[0].pendingCents, 20_000);
  });

  it("case 11: at the maximum, and «Quitar» makes it owed again", async () => {
    assert.equal((await forgive("CM-11", 1, 1)).statusCode, 400);
    assert.equal((await unforgive("CM-11")).statusCode, 200);
    assert.equal((await contract("CM-11")).mora.pending, 50_000);
  });

  it("case 12: the mora from before «Sin mora» can be forgiven", async () => {
    assert.equal((await moraOf("CM-12")).rules[0].rule.mode, "none");
    assert.equal((await forgive("CM-12", 1, 20_000)).statusCode, 201);
    assert.equal((await contract("CM-12")).mora.pending, 0);
  });

  it("cases 13 and 14: their own rule", async () => {
    assert.equal((await moraOf("CM-13")).rules[0].rule.mode, "own");
    assert.equal((await forgive("CM-13", 1, 60_000)).statusCode, 201);
    assert.equal((await forgive("CM-14", 1, 1)).statusCode, 400);
  });

  it("case 15: the receipt from before stays as it was", async () => {
    const read = async () =>
      (await app.inject({ method: "GET", url: `/api/receipts/${await receiptOf("CM-15")}`, headers: { cookie } })).json().receipt;
    const figures = async () => {
      const receipt = await read();
      return {
        previousBalance: receipt.previousBalance,
        newBalance: receipt.newBalance,
        moraCharged: receipt.moraCharged,
        moraPaid: receipt.lines[0].moraPaid,
      };
    };
    const before = await figures();

    assert.equal((await forgive("CM-15", 1, 20_000)).statusCode, 201);
    assert.deepEqual(await figures(), before);
  });

  it("case 16: says the payment had already covered the rest", async () => {
    const [entry] = (await moraOf("CM-16")).forgiven;

    assert.equal(entry.amountCents, 50_000);
    assert.equal(entry.clearedCents, 10_000);
  });

  it("case 17: «Quitar» puts it back on the saldo", async () => {
    const before = await contract("CM-17");

    assert.equal((await unforgive("CM-17")).statusCode, 200);

    const row = await contract("CM-17");
    assert.equal(row.mora.pending, 30_000);
    assert.equal(row.balance, before.balance + 30_000);
  });

  it("cases 18 and 19: a closed contract cannot be forgiven", async () => {
    assert.equal((await forgive("CM-18", 1, 50_000)).statusCode, 409);
    assert.equal((await moraOf("CM-18")).chargeable, false);
    assert.equal((await forgive("CM-19", 1, 30_000)).statusCode, 409);
    assert.equal((await moraOf("CM-19")).forgiven.length, 1);
  });

  it("case 20: the customer's other lot does not move", async () => {
    assert.equal((await forgive("CM-20A", 1, 20_000)).statusCode, 201);
    assert.equal((await contract("CM-20A")).mora.pending, 0);
    assert.equal((await contract("CM-20B")).mora.pending, 20_000);
  });

  it("files what was seeded in the Historial", async () => {
    const events = (await app.inject({ method: "GET", url: "/api/audit?entityTypes=contract", headers: { cookie } }))
      .json()
      .events as Array<{ action: string }>;
    const actions = new Set(events.map((event) => event.action));

    for (const action of ["mora_forgive", "mora_charge", "mora_rule", "cancel"]) {
      assert.ok(actions.has(action), action);
    }
  });
});
