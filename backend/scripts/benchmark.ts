/**
 * How long the heavy list endpoints take as the data grows.
 *
 *   npm run bench -w backend               # 5 years of data
 *   npm run bench -w backend -- --years 15
 *
 * Builds a throwaway in-memory database (the same one the tests use), fills it
 * with `years` of contracts, monthly payments and one receipt per payment, and
 * times each endpoint. Nothing touches the real database or the network.
 *
 * Run it on two versions of the code to compare them. A speed fix that worked
 * makes the times drop while every fingerprint stays the same: the fingerprint
 * is a short code computed from the whole answer, so if even one figure on the
 * page changed, it changes too.
 */
import { createHash } from "node:crypto";

import { contracts, customers, lots, payments, receipts } from "../src/db/schema.js";
import { buildTestApp, login, OWNER_PASSWORD } from "../test/helpers.js";

const yearsArg = process.argv.indexOf("--years");
const years = yearsArg === -1 ? 5 : Number(process.argv[yearsArg + 1]);
/** About what the office signs in a year. */
const CONTRACTS_PER_YEAR = 60;
const RUNS = 5;

const { app, db, ids } = await buildTestApp();
const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

const today = new Date();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const monthsAgo = (months: number, day: number) =>
  iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - months, day)));

// Predictable ids, so two runs build identical data and fingerprints compare.
let nextId = 0;
const seqId = () => `bench-${String((nextId += 1)).padStart(8, "0")}`;

/** The answer with the parts that differ on every run (the fixture's own random
 * ids, and timestamps of when rows were inserted) blanked out. */
const fingerprint = (body: string) =>
  createHash("sha256")
    .update(
      body
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
        .replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?/g, "<time>"),
    )
    .digest("hex")
    .slice(0, 12);

// Fixed, so rows paid on the same day list in the same order on every run.
// Left to the database, they would get whenever the insert happened to run,
// and the order of same-day rows would shift between runs of identical code.
const createdAt = "2020-01-01 00:00:00";

let receiptNumber = 0;
let paymentCount = 0;
const totalContracts = years * CONTRACTS_PER_YEAR;

db.transaction((tx) => {
  for (let index = 0; index < totalContracts; index += 1) {
    const lotId = seqId();
    const customerId = seqId();
    const contractId = seqId();
    // Spread the signings evenly over the period, oldest first.
    const signedMonthsAgo = Math.floor(((totalContracts - index) / totalContracts) * years * 12);
    const signedOn = monthsAgo(signedMonthsAgo, 15);

    tx.insert(lots)
      .values({
        id: lotId,
        projectId: ids.projectId,
        code: `B-${index}`,
        areaM2: 300,
        basePriceCents: 18_500_000,
      })
      .run();

    tx.insert(customers)
      .values({
        id: customerId,
        fullName: `Cliente ${index}`,
        identification: `0801-2000-${String(index).padStart(5, "0")}`,
        phone: "+50499990000",
        email: null,
        address: null,
        customerSince: 2020,
      })
      .run();

    tx.insert(contracts)
      .values({
        id: contractId,
        code: `CT-BENCH-${index}`,
        lotId,
        customerId,
        kind: "contract",
        saleType: "financed",
        status: "active",
        salePriceCents: 18_500_000,
        downPaymentCents: 2_500_000,
        termMonths: 60,
        monthlyPaymentCents: 270_000,
        dueDay: 5,
        signedOn,
      })
      .run();

    // The prima at signing, then one installment a month until today.
    for (let month = signedMonthsAgo; month >= 0 && month >= signedMonthsAgo - 60; month -= 1) {
      const paidOn = month === signedMonthsAgo ? signedOn : monthsAgo(month, 5);
      const receiptId = seqId();
      receiptNumber += 1;

      tx.insert(receipts)
        .values({
          id: receiptId,
          number: receiptNumber,
          code: `BENCH${receiptNumber}`,
          lookupCode: `LK${receiptNumber}`,
          customerId,
          issuedOn: paidOn,
          issuedBy: ids.ownerId,
          createdAt,
        })
        .run();

      tx.insert(payments)
        .values({
          id: seqId(),
          contractId,
          receiptId,
          amountCents: month === signedMonthsAgo ? 2_500_000 : 270_000,
          originalAmountCents: month === signedMonthsAgo ? 2_500_000 : 270_000,
          originalCurrency: "HNL",
          exchangeRate: "1",
          paidOn,
          method: "cash",
          type: month === signedMonthsAgo ? "down_payment" : "installment",
          recordedBy: ids.ownerId,
          createdAt,
        })
        .run();
      paymentCount += 1;
    }
  }
});

console.log(
  `${years} years of data: ${totalContracts} contracts, ${paymentCount} payments, ${receiptNumber} receipts\n`,
);

for (const url of ["/api/dashboard", "/api/contracts", "/api/transactions", "/api/receipts"]) {
  const timings: number[] = [];
  let failed = 0;
  let body = "";

  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    const response = await app.inject({ method: "GET", url, headers: { cookie } });
    timings.push(performance.now() - started);
    failed = response.statusCode;
    body = response.body;

    if (response.statusCode !== 200) {
      break;
    }
  }

  if (failed !== 200) {
    console.log(`${url.padEnd(20)} FAILED with status ${failed}`);
    continue;
  }

  // The first run warms caches; the middle of the rest is the honest figure.
  const median = timings.slice(1).sort((a, b) => a - b)[Math.floor((RUNS - 1) / 2)]!;
  console.log(`${url.padEnd(20)} first ${timings[0]!.toFixed(0).padStart(5)} ms   typical ${median.toFixed(0).padStart(5)} ms   fingerprint ${fingerprint(body)}`);
}

await app.close();
