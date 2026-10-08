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
import { spawn } from "node:child_process";
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

/** Everything a tab re-reads after a change (see reloadEverything in App.tsx), plus the receipts list. */
const ENDPOINTS = [
  "/api/dashboard",
  "/api/contracts",
  "/api/transactions",
  "/api/receipts",
  "/api/lots?includeArchived=true",
  "/api/projects",
  "/api/customers",
  "/api/exchange-rate",
  "/api/users",
  // A tab coming back to the front when nothing has been written since its
  // last read: the browser asks "still the same?" with the version it has.
  "again:/api/transactions",
];

// With --tabs, only the memory test below runs, so nothing else muddies it.
for (const url of process.argv.includes("--tabs") ? [] : ENDPOINTS) {
  const timings: number[] = [];
  let failed = 0;
  let body = "";
  let sent = 0;

  const again = url.startsWith("again:");
  const path = url.replace(/^again:/, "");
  // What the browser holds after a first read, as it would hold it.
  const first = again ? await app.inject({ method: "GET", url: path, headers: { cookie } }) : null;
  const ifNoneMatch = first?.headers.etag ? { "if-none-match": String(first.headers.etag) } : {};

  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    const response = await app.inject({
      method: "GET",
      url: path,
      headers: { cookie, ...ifNoneMatch },
    });
    timings.push(performance.now() - started);
    failed = response.statusCode === 304 ? 200 : response.statusCode;
    // On a 304 the browser shows the copy it already has.
    body = response.statusCode === 304 ? first!.body : response.body;
    sent = Buffer.byteLength(response.body);

    if (failed !== 200) {
      break;
    }
  }

  if (failed !== 200) {
    console.log(`${url.split("?")[0]!.padEnd(24)} FAILED with status ${failed}`);
    continue;
  }

  // The first run warms caches; the middle of the rest is the honest figure.
  const median = timings.slice(1).sort((a, b) => a - b)[Math.floor((RUNS - 1) / 2)]!;
  console.log(`${url.split("?")[0]!.padEnd(24)} first ${timings[0]!.toFixed(0).padStart(5)} ms   typical ${median.toFixed(0).padStart(5)} ms   fingerprint ${fingerprint(body)}   sent ${(sent / 1024).toFixed(0).padStart(6)} KB`);
}

/*
 * --tabs N: what one change costs when N tabs are open. Each open tab re-reads
 * every list at once (reloadEverything in App.tsx); this does that for
 * `--changes` changes in a row and reports the most memory the process used.
 */
const tabsArg = process.argv.indexOf("--tabs");

if (tabsArg !== -1) {
  const tabs = Number(process.argv[tabsArg + 1]);
  const changesArg = process.argv.indexOf("--changes");
  const changes = changesArg === -1 ? 10 : Number(process.argv[changesArg + 1]);
  // No screen reads /api/receipts; the "again:" line is the timing table's.
  const reloaded = ENDPOINTS.filter((url) => url !== "/api/receipts" && !url.startsWith("again:"));
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

  // Over a real socket, read by separate curl processes the way nginx reads
  // from Lindero, so a response is freed once it has been handed over rather
  // than held in this process the way app.inject would hold it.
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const fetchAll = () =>
    new Promise<void>((resolve, reject) => {
      const urls = Array.from({ length: tabs }, () => reloaded).flat();
      const curl = spawn("curl", [
        "--silent",
        "--fail",
        "--parallel",
        "--parallel-max",
        String(urls.length),
        "--cookie",
        cookie,
        ...urls.flatMap((url) => [`${address}${url}`, "--output", "/dev/null"]),
      ]);
      curl.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`curl exited ${code}`))));
    });

  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 5);
  const before = process.memoryUsage().rss;

  for (let change = 0; change < changes; change += 1) {
    await fetchAll();
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }

  clearInterval(sampler);
  console.log(
    `\n${changes} changes with ${tabs} tabs open: memory ${mb(before)} before, peak ${mb(peakRss)}, ` +
      `${mb(process.memoryUsage().rss)} after`,
  );
}

await app.close();
