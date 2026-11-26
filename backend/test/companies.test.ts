import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import { buildApp } from "../src/app.js";
import { SESSION_COOKIE, createSession, sessionCookieValue } from "../src/auth/session.js";
import { companyFiles, openCompany } from "../src/db/companies.js";
import type { Companies, Company } from "../src/db/companies.js";
import { projects, sessions, users } from "../src/db/schema.js";
import { readCurrentRate, recordRate, refreshEveryCompany } from "../src/lib/exchangeRate.js";
import { buildTestDb, testConfig } from "./helpers.js";

/**
 * Every request works on its own company, and on no other.
 *
 * The step before one database file per company (docs/later-versions.md,
 * section 1). Here the choice is a test header, so one app serves two
 * companies side by side; in the real app it will be the signed-in account.
 * A route still reaching for a database, uploads folder or stream shared by
 * the whole app would show up here as the other company's data, or as an
 * error once that one is closed.
 */
async function twoCompanies() {
  const a = await buildTestDb();
  const b = await buildTestDb();

  const companyA: Company = { id: "1", db: a.db, sqlite: a.sqlite, uploadsPath: uploadsFolder() };
  const companyB: Company = { id: "2", db: b.db, sqlite: b.sqlite, uploadsPath: uploadsFolder() };

  const companies: Companies = {
    forRequest: (request) => (request.headers["x-test-company"] === "b" ? companyB : companyA),
    open: () => [companyA, companyB],
    // Signing in is tested with the real registry, further down.
    forEmail: () => null,
    emailUsedElsewhere: () => false,
    usersChanged: () => undefined,
  };

  const app = await buildApp(testConfig, companies);
  await app.ready();

  // A session in each, for the same owner email: only the header says which
  // company is meant.
  const cookieA = sessionCookie(companyA, a.ids.ownerId);
  const cookieB = sessionCookie(companyB, b.ids.ownerId);

  return { app, a, b, companyA, companyB, cookieA, cookieB };
}

function uploadsFolder() {
  return mkdtempSync(join(tmpdir(), "lindero-test-company-uploads-"));
}

function sessionCookie(company: Company, userId: string) {
  const token = createSession(company.db, userId, 7);
  return `${SESSION_COOKIE}=${sessionCookieValue(company.id, token)}`;
}

/** Every GET route the app has, with its parameters as written («/api/receipts/:id»). */
function getRoutes(app: Awaited<ReturnType<typeof buildApp>>) {
  const found: string[] = [];
  const parents: string[] = [];

  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const match = /^([│ ]*)[├└]── (\S+)(?: \(([^)]*)\))?/.exec(line);
    if (!match) {
      continue;
    }

    const depth = match[1]!.length / 4;
    const path = (parents[depth - 1] ?? "") + match[2]!;
    parents.length = depth;
    parents.push(path);

    if (match[3]?.split(", ").includes("GET")) {
      found.push(path);
    }
  }

  return found;
}

describe("each request's own company", () => {
  it("reads from the database picked for the request", async () => {
    const { app, a, b, cookieA, cookieB } = await twoCompanies();
    b.db.update(projects).set({ name: "Proyecto de B" }).where(eq(projects.id, b.ids.projectId)).run();

    const fromA = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: cookieA, "x-test-company": "a" },
    });
    const fromB = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: cookieB, "x-test-company": "b" },
    });

    assert.deepEqual(
      fromA.json().projects.map((project: { id: string; name: string }) => [project.id, project.name]),
      [[a.ids.projectId, "Proyecto Prueba"]],
    );
    assert.deepEqual(
      fromB.json().projects.map((project: { id: string; name: string }) => [project.id, project.name]),
      [[b.ids.projectId, "Proyecto de B"]],
    );

    await app.close();
  });

  it("writes only to the database picked for the request", async () => {
    const { app, a, b, cookieB } = await twoCompanies();

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: cookieB, "x-test-company": "b" },
      payload: { name: "Solo de B", areaUnit: "m2" },
    });
    assert.equal(created.statusCode, 201, created.body);

    const named = (db: typeof a.db) =>
      db.select().from(projects).where(eq(projects.name, "Solo de B")).all().length;
    assert.equal(named(b.db), 1);
    assert.equal(named(a.db), 0);

    await app.close();
  });

  it("finds a session only in the database it was opened in", async () => {
    const { app, cookieA, cookieB } = await twoCompanies();

    const me = (cookie: string, company: "a" | "b") =>
      app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie, "x-test-company": company } });

    assert.equal((await me(cookieA, "a")).statusCode, 200);
    assert.equal((await me(cookieB, "b")).statusCode, 200);
    assert.equal((await me(cookieB, "a")).statusCode, 401);
    assert.equal((await me(cookieA, "b")).statusCode, 401);

    await app.close();
  });

  it("answers every screen's read with the other database closed", async () => {
    const { app, a, b, cookieB } = await twoCompanies();

    // Anything that still reached for A would now fail with a 500.
    a.sqlite.close();

    // Real records where a route names one, so those reads find something.
    const known: Record<string, string> = {
      contracts: b.ids.contractId,
      customers: b.ids.customerId,
      users: b.ids.staffId,
    };

    // The live stream never ends, so it cannot be asked like the rest; it
    // does not read the database.
    const routes = getRoutes(app).filter((route) => route !== "/api/events");
    assert.ok(routes.length >= 25, `only ${routes.length} GET routes found: ${routes.join(", ")}`);

    for (const route of routes) {
      const url = route.replace(/([^/]+)\/:\w+/g, (_whole, before: string) => {
        return `${before}/${known[before] ?? randomUUID()}`;
      });

      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: cookieB, "x-test-company": "b" },
      });

      assert.ok(response.statusCode < 500, `${url}: ${response.statusCode} ${response.body}`);
    }

    await app.close();
    b.sqlite.close();
  });
});

/** A real, minimal PNG — one transparent pixel. */
const PNG_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function pngUpload() {
  const boundary = "----LinderoCompaniesBoundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slip.png"\r\n` +
      "Content-Type: image/png\r\n\r\n",
  );
  return {
    payload: Buffer.concat([head, PNG_PIXEL, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

describe("each company's own uploads folder", () => {
  it("writes a company's file to its folder, and serves it only to that company", async () => {
    const { app, b, companyA, companyB, cookieA, cookieB } = await twoCompanies();
    const asB = { cookie: cookieB, "x-test-company": "b" };

    const issued = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: asB,
      payload: {
        customerId: b.ids.customerId,
        paidOn: "2026-03-15",
        method: "transfer",
        lines: [{ contractId: b.ids.contractId, amountCents: 670_000, type: "installment" }],
      },
    });
    assert.equal(issued.statusCode, 201, issued.body);

    const { payload, headers } = pngUpload();
    const upload = await app.inject({
      method: "POST",
      url: `/api/receipts/${issued.json().receipt.id}/attachments`,
      headers: { ...asB, ...headers },
      payload,
    });
    assert.equal(upload.statusCode, 201, upload.body);
    const attachmentId = upload.json().attachment.id;

    assert.equal(readdirSync(companyB.uploadsPath).length, 1);
    assert.deepEqual(readdirSync(companyA.uploadsPath), []);

    const fromB = await app.inject({
      method: "GET",
      url: `/api/attachments/${attachmentId}/file`,
      headers: asB,
    });
    assert.equal(fromB.statusCode, 200);
    assert.deepEqual(fromB.rawPayload, PNG_PIXEL);

    const fromA = await app.inject({
      method: "GET",
      url: `/api/attachments/${attachmentId}/file`,
      headers: { cookie: cookieA, "x-test-company": "a" },
    });
    assert.equal(fromA.statusCode, 404);

    await app.close();
  });
});

/** A real live stream, as a browser tab holds one; `heard` collects what arrives. */
async function openStream(port: number, cookie: string, company: "a" | "b") {
  let heard = "";
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/api/events", headers: { cookie, "x-test-company": company } },
      (response) => {
        assert.equal(response.statusCode, 200);
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          heard += chunk;
          resolve();
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
  return () => heard;
}

describe("each company's own live updates and list versions", () => {
  it("tells only the writing company's open tabs to re-read", async (t) => {
    const { app, cookieA, cookieB } = await twoCompanies();
    await app.listen({ host: "127.0.0.1", port: 0 });
    // Closed even when an assertion fails, or the open streams keep the test
    // process running.
    t.after(() => app.close());
    const { port } = app.server.address() as AddressInfo;

    const streamA = await openStream(port, cookieA, "a");
    const streamB = await openStream(port, cookieB, "b");

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: cookieB, "x-test-company": "b" },
      payload: { name: "Solo de B", areaUnit: "m2" },
    });
    assert.equal(created.statusCode, 201, created.body);

    // The news is written to B's stream synchronously after the response; a
    // short wait lets it cross the socket.
    for (let tries = 0; tries < 50 && !streamB().includes("event: change"); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.match(streamB(), /event: change\ndata: \{"resource":"projects"/);
    assert.doesNotMatch(streamA(), /event: change/);
  });

  it("keeps a company's list version when another company writes", async () => {
    const { app, cookieA, cookieB } = await twoCompanies();
    const asA = { cookie: cookieA, "x-test-company": "a" };

    const read = (etag: string) =>
      app.inject({ method: "GET", url: "/api/transactions", headers: { ...asA, "if-none-match": etag } });

    const first = await app.inject({ method: "GET", url: "/api/transactions", headers: asA });
    const etag = first.headers.etag as string;
    assert.ok(etag, "the list carries a version");

    const elsewhere = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: cookieB, "x-test-company": "b" },
      payload: { name: "Solo de B", areaUnit: "m2" },
    });
    assert.equal(elsewhere.statusCode, 201, elsewhere.body);

    assert.equal((await read(etag)).statusCode, 304, "B's write left A's copy current");

    const here = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: asA,
      payload: { name: "Solo de A", areaUnit: "m2" },
    });
    assert.equal(here.statusCode, 201, here.body);

    assert.equal((await read(etag)).statusCode, 200, "A's own write outdates A's copy");

    await app.close();
  });
});

describe("opening a company's files", () => {
  const config = {
    ...testConfig,
    databasePath: "/srv/lindero/data/lindero.db",
    uploadsPath: "/srv/lindero/data/uploads",
    companiesPath: "/srv/lindero/data/companies",
  };

  it("keeps company 1 where Lindero's files have always been, and gives the others a folder each", () => {
    assert.deepEqual(companyFiles(config, "1"), {
      databasePath: "/srv/lindero/data/lindero.db",
      uploadsPath: "/srv/lindero/data/uploads",
    });
    assert.deepEqual(companyFiles(config, "12"), {
      databasePath: "/srv/lindero/data/companies/12/lindero.db",
      uploadsPath: "/srv/lindero/data/companies/12/uploads",
    });
  });

  it("refuses an id that is not a plain number, so no id can point outside its folder", () => {
    for (const id of ["", "0", "01", "../1", "1/2", "a", "1 ", "12345678901"]) {
      assert.throws(() => companyFiles(config, id), /Not a company id/, JSON.stringify(id));
    }
  });

  it("brings a new company's database up to date, and sweeps expired sessions when it opens", () => {
    const folder = mkdtempSync(join(tmpdir(), "lindero-test-companies-"));
    const files = companyFiles({ ...config, companiesPath: folder }, "2");

    const first = openCompany("2", files);
    assert.ok(existsSync(join(folder, "2", "lindero.db")));
    assert.equal(first.company.uploadsPath, join(folder, "2", "uploads"));
    // A fresh file has every table: the schema came with the opening.
    assert.deepEqual(first.company.db.select().from(projects).all(), []);
    const applied = first.company.db.get<{ count: number }>(
      sql`SELECT count(*) AS count FROM __drizzle_migrations`,
    );
    assert.ok(applied.count > 25, `only ${applied.count} migrations applied`);

    const userId = randomUUID();
    first.company.db
      .insert(users)
      .values({ id: userId, email: "owner@nueva.hn", name: "Owner", role: "owner", passwordHash: "x" })
      .run();
    first.company.db
      .insert(sessions)
      .values({ id: "old-token", userId, expiresAt: "2020-01-01T00:00:00.000Z" })
      .run();
    first.company.sqlite.close();

    const again = openCompany("2", files);
    assert.equal(again.expiredSessions, 1);
    assert.deepEqual(again.company.db.select().from(sessions).all(), []);
    again.company.sqlite.close();
  });
});

describe("the exchange rate for every company", () => {
  const quietLog = () => {
    const warnings: unknown[] = [];
    const log = {
      info: () => undefined,
      warn: (details: unknown) => warnings.push(details),
      error: (details: unknown) => warnings.push(details),
      child: () => log,
    } as unknown as FastifyBaseLogger;
    return { log, warnings };
  };

  it("asks the provider once, and leaves a company's hand-set rate alone", async () => {
    const a = await buildTestDb();
    const b = await buildTestDb();
    const c = await buildTestDb();
    recordRate(b.db, { rate: 25.5, adjustmentPercent: 0, source: "manual", actorId: b.ids.ownerId });

    let asked = 0;
    const { log } = quietLog();
    const companies = [
      { id: "1", db: a.db },
      { id: "2", db: b.db },
      { id: "3", db: c.db },
    ];
    await refreshEveryCompany(companies, log, async () => {
      asked += 1;
      return 26.1;
    });

    assert.equal(asked, 1);
    for (const automatic of [a, c]) {
      assert.equal(readCurrentRate(automatic.db).rate, 26.1);
      assert.equal(readCurrentRate(automatic.db).source, "auto");
    }
    assert.equal(readCurrentRate(b.db).rate, 25.5);
    assert.equal(readCurrentRate(b.db).source, "manual");
  });

  it("still updates the others when one company's file fails", async () => {
    const a = await buildTestDb();
    const b = await buildTestDb();
    a.sqlite.close();

    const { log, warnings } = quietLog();
    await refreshEveryCompany([{ id: "1", db: a.db }, { id: "2", db: b.db }], log, async () => 26.1);

    assert.equal(readCurrentRate(b.db).rate, 26.1);
    assert.equal(warnings.length, 1);
  });
});
