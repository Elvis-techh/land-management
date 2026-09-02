import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrations.js";
import { contracts, customers, lots, payments, projects, users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

export const OWNER_PASSWORD = "owner-password";
export const STAFF_PASSWORD = "staff-password";

const testConfig: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  frontendOrigins: ["http://localhost:5173"],
  databasePath: ":memory:",
  // Each test app gets its own directory, so uploads from one test can
  // never be read by another and nothing lands in the real data folder.
  uploadsPath: mkdtempSync(join(tmpdir(), "lindero-test-uploads-")),
  cookieSecret: "test-cookie-secret-that-is-long-enough-x",
  sessionDays: 7,
  // Effectively off for most tests; the rate-limit test lowers it on purpose.
  loginAttemptsPerMinute: 10_000,
  // No test may reach the network. The exchange-rate tests drive the routes
  // directly and stub the provider where they need to.
  exchangeRateRefreshHours: 0,
};

/**
 * A fresh, fully migrated, seeded database for one test.
 *
 * It lives in memory, so every test starts from an identical known state and
 * nothing a test does can leak into the next one or touch the real database.
 */
export async function buildTestApp(configOverrides: Partial<AppConfig> = {}) {
  const { db, sqlite } = createDb(":memory:");
  runMigrations(db);

  const ownerId = randomUUID();
  const staffId = randomUUID();
  const projectId = randomUUID();
  const customerId = randomUUID();
  const heldLotId = randomUUID();
  const freeLotId = randomUUID();
  const contractId = randomUUID();

  db.insert(users)
    .values([
      {
        id: ownerId,
        email: "owner@test.hn",
        name: "Owner",
        role: "owner",
        passwordHash: await hashPassword(OWNER_PASSWORD),
      },
      {
        id: staffId,
        email: "staff@test.hn",
        name: "Staff",
        role: "staff",
        passwordHash: await hashPassword(STAFF_PASSWORD),
      },
    ])
    .run();

  db.insert(projects).values({ id: projectId, name: "Proyecto Prueba" }).run();

  db.insert(lots)
    .values([
      { id: heldLotId, projectId, code: "A-01", areaM2: 300, basePriceCents: 18_500_000 },
      { id: freeLotId, projectId, code: "A-02", areaM2: 280, basePriceCents: 16_000_000 },
    ])
    .run();

  db.insert(customers)
    .values({
      id: customerId,
      fullName: "Cliente Prueba",
      identification: "0801-1990-00001",
      phone: "+50499990000",
      email: null,
      address: null,
      customerSince: 2024,
    })
    .run();

  db.insert(contracts)
    .values({
      id: contractId,
      code: "CT-TEST-001",
      lotId: heldLotId,
      customerId,
      kind: "reservation",
      status: "active",
      salePriceCents: 18_500_000,
    })
    .run();

  // Two payments, so the tests prove paid-to-date is SUMMED rather than stored.
  db.insert(payments)
    .values([
      {
        id: randomUUID(),
        contractId,
        amountCents: 1_000_000,
        originalAmountCents: 1_000_000,
        originalCurrency: "HNL",
        exchangeRate: "1",
        paidOn: "2026-01-15",
        method: "cash",
        type: "down_payment",
        recordedBy: ownerId,
      },
      {
        id: randomUUID(),
        contractId,
        amountCents: 500_000,
        originalAmountCents: 500_000,
        originalCurrency: "HNL",
        exchangeRate: "1",
        paidOn: "2026-02-15",
        method: "transfer",
        type: "installment",
        recordedBy: ownerId,
      },
    ])
    .run();

  const app = await buildApp({ ...testConfig, ...configOverrides }, db);
  await app.ready();

  return {
    app,
    db,
    sqlite,
    ids: { ownerId, staffId, projectId, customerId, heldLotId, freeLotId, contractId },
  };
}

export type TestApp = Awaited<ReturnType<typeof buildTestApp>>["app"];

/** Log in and return the session cookie for use on later requests. */
export async function login(app: TestApp, email: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });

  const cookie = response.cookies.find((entry) => entry.name === "lindero_session");

  if (!cookie) {
    throw new Error(`Login failed for ${email}: ${response.statusCode} ${response.body}`);
  }

  return `lindero_session=${cookie.value}`;
}
