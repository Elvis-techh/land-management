import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { contracts } from "../src/db/schema.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

/** A second contract for the SAME customer, so a multi-lot receipt is possible. */
function addSecondContract(
  db: TestApp["db"],
  ids: { customerId: string; freeLotId: string },
): string {
  const contractId = randomUUID();

  db.insert(contracts)
    .values({
      id: contractId,
      code: "CT-DUP-002",
      lotId: ids.freeLotId,
      customerId: ids.customerId,
      kind: "contract",
      saleType: "financed",
      status: "active",
      salePriceCents: lempiras(80_000),
      downPaymentCents: lempiras(10_000),
      termMonths: 24,
      monthlyPaymentCents: lempiras(3_000),
      dueDay: 5,
      signedOn: "2026-01-10",
    })
    .run();

  return contractId;
}

async function issueReceipt(
  app: TestApp["app"],
  cookie: string,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await app.inject({
    method: "POST",
    url: "/api/receipts",
    headers: { cookie },
    payload: body,
  });

  assert.equal(response.statusCode, 201, response.body);

  return (response.json() as { receipt: Record<string, any> }).receipt;
}

async function checkDuplicates(
  app: TestApp["app"],
  cookie: string,
  query: Record<string, string | number>,
): Promise<Array<Record<string, any>>> {
  const search = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );

  const response = await app.inject({
    method: "GET",
    url: `/api/receipts/duplicates?${search.toString()}`,
    headers: { cookie },
  });

  assert.equal(response.statusCode, 200, response.body);

  return (response.json() as { matches: Array<Record<string, any>> }).matches;
}

describe("warning that a payment may already be recorded", () => {
  it("says nothing when asked about nothing", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    assert.deepEqual(await checkDuplicates(app, cookie, {}), []);
    // A customer alone is not a question — everybody pays more than once.
    assert.deepEqual(await checkDuplicates(app, cookie, { customerId: ids.customerId }), []);
  });

  it("finds the receipt that already carries this confirmation number", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const first = await issueReceipt(app, cookie, {
      customerId: ids.customerId,
      paidOn: "2026-08-29",
      method: "transfer",
      reference: "412401817",
      lines: [{ contractId: ids.contractId, amountCents: lempiras(7_000), type: "installment" }],
    });

    const matches = await checkDuplicates(app, cookie, { reference: "412401817" });

    assert.equal(matches.length, 1);
    assert.equal(matches[0].reason, "reference");
    assert.equal(matches[0].receiptCode, first.code);
    assert.equal(matches[0].amountCents, lempiras(7_000));
    assert.equal(matches[0].cancelled, false);
  });

  it("ignores case and stray spaces, which is how a number gets retyped", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    await issueReceipt(app, cookie, {
      customerId: ids.customerId,
      paidOn: "2026-08-29",
      method: "transfer",
      reference: "BAC-889231",
      lines: [{ contractId: ids.contractId, amountCents: lempiras(7_000), type: "installment" }],
    });

    const matches = await checkDuplicates(app, cookie, { reference: "  bac-889231 " });

    assert.equal(matches.length, 1);
  });

  it("does not invent a match for a number nobody has used", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    await issueReceipt(app, cookie, {
      customerId: ids.customerId,
      paidOn: "2026-08-29",
      method: "transfer",
      reference: "412401817",
      lines: [{ contractId: ids.contractId, amountCents: lempiras(7_000), type: "installment" }],
    });

    assert.deepEqual(await checkDuplicates(app, cookie, { reference: "999999999" }), []);
  });

  /*
   * THE ONE THAT MAKES THIS FEATURE USABLE.
   *
   * One receipt for L 30,000 across two lots becomes two payments of L 15,000,
   * same customer, same date, same reference. Compared payment by payment, that
   * receipt reports itself as a duplicate of itself — and since every multi-lot
   * receipt would do it, the warning would appear so often it would be ignored,
   * which is worse than not having it.
   */
  it("does not report a multi-lot receipt as a duplicate of itself", async () => {
    const { app, db, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const secondContract = addSecondContract(db, ids);

    await issueReceipt(app, cookie, {
      customerId: ids.customerId,
      paidOn: "2026-09-04",
      method: "transfer",
      reference: "58071669",
      lines: [
        { contractId: ids.contractId, amountCents: lempiras(15_000), type: "installment" },
        { contractId: secondContract, amountCents: lempiras(15_000), type: "installment" },
      ],
    });

    const matches = await checkDuplicates(app, cookie, { reference: "58071669" });

    // ONE finding, not two, and it reports the whole receipt.
    assert.equal(matches.length, 1);
    assert.equal(matches[0].amountCents, lempiras(30_000));
    assert.deepEqual(matches[0].lotCodes.slice().sort(), ["A-01", "A-02"]);
  });

  /*
   * The case that actually cost money: two L 7,000.00 payments to the same
   * account on 2026-08-29, hours apart. Neither the amount nor the day tells
   * them apart, and one of them carried no reference at all.
   */
  it("flags the same customer, date and total when there is no reference", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    await issueReceipt(app, cookie, {
      customerId: ids.customerId,
      paidOn: "2026-08-29",
      method: "cash",
      lines: [{ contractId: ids.contractId, amountCents: lempiras(7_000), type: "installment" }],
    });

    const matches = await checkDuplicates(app, cookie, {
      customerId: ids.customerId,
      paidOn: "2026-08-29",
      amountCents: lempiras(7_000),
    });

    assert.equal(matches.length, 1);
    assert.equal(matches[0].reason, "amount");
  });

  it("leaves a different amount, day or customer alone", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    await issueReceipt(app, cookie, {
      customerId: ids.customerId,
      paidOn: "2026-08-29",
      method: "cash",
      lines: [{ contractId: ids.contractId, amountCents: lempiras(7_000), type: "installment" }],
    });

    const base = { customerId: ids.customerId, paidOn: "2026-08-29", amountCents: lempiras(7_000) };

    assert.deepEqual(
      await checkDuplicates(app, cookie, { ...base, amountCents: lempiras(7_001) }),
      [],
    );
    assert.deepEqual(await checkDuplicates(app, cookie, { ...base, paidOn: "2026-08-30" }), []);
  });

  it("reports one finding, not two, when both questions match the same receipt", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    await issueReceipt(app, cookie, {
      customerId: ids.customerId,
      paidOn: "2026-08-29",
      method: "transfer",
      reference: "412401817",
      lines: [{ contractId: ids.contractId, amountCents: lempiras(7_000), type: "installment" }],
    });

    const matches = await checkDuplicates(app, cookie, {
      reference: "412401817",
      customerId: ids.customerId,
      paidOn: "2026-08-29",
      amountCents: lempiras(7_000),
    });

    assert.equal(matches.length, 1);
    // Under the stronger reason: the bank's own number, not a coincidence of
    // amount and day.
    assert.equal(matches[0].reason, "reference");
  });

  /*
   * A cancelled receipt is still reported, and marked. "You entered this and
   * then voided it" is precisely what somebody about to enter it again needs;
   * hiding it would make the second attempt look like new money.
   */
  it("still reports a voided receipt, marked as cancelled", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const receipt = await issueReceipt(app, cookie, {
      customerId: ids.customerId,
      paidOn: "2026-08-29",
      method: "transfer",
      reference: "412401817",
      lines: [{ contractId: ids.contractId, amountCents: lempiras(7_000), type: "installment" }],
    });

    const voided = await app.inject({
      method: "POST",
      url: `/api/receipts/${receipt.id}/void`,
      headers: { cookie },
      payload: { reason: "Depósito duplicado registrado por error." },
    });

    assert.equal(voided.statusCode, 200, voided.body);

    const matches = await checkDuplicates(app, cookie, { reference: "412401817" });

    assert.equal(matches.length, 1);
    assert.equal(matches[0].cancelled, true);
    // Reversed money is not counted, so the live total is zero.
    assert.equal(matches[0].amountCents, 0);
  });

  it("is closed to anyone not signed in", async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/receipts/duplicates?reference=412401817",
    });

    assert.equal(response.statusCode, 401);
  });
});
