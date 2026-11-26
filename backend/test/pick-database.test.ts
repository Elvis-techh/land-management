import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { projects } from "../src/db/schema.js";
import { OWNER_PASSWORD, buildTestDb, login, testConfig } from "./helpers.js";

/**
 * Every request works on the database picked for it, and on no other.
 *
 * The step before one database file per company (docs/later-versions.md,
 * section 1). Here the choice is a test header, so one app serves two
 * databases side by side; in the real app it will be the signed-in account.
 * A route still reaching for a database shared by the whole app would show up
 * here as the other company's data, or as an error once that one is closed.
 */
async function twoCompanies() {
  const a = await buildTestDb();
  const b = await buildTestDb();

  const app = await buildApp(testConfig, (request) =>
    request.headers["x-test-company"] === "b" ? b.db : a.db,
  );
  await app.ready();

  // Same email and password in both: only the header says which is meant.
  const cookieA = await loginTo(app, "a");
  const cookieB = await loginTo(app, "b");

  return { app, a, b, cookieA, cookieB };
}

async function loginTo(app: Awaited<ReturnType<typeof buildApp>>, company: "a" | "b") {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-test-company": company },
    payload: { email: "owner@test.hn", password: OWNER_PASSWORD },
  });
  const cookie = response.cookies.find((entry) => entry.name === "lindero_session");
  assert.ok(cookie, `login to ${company}: ${response.statusCode} ${response.body}`);
  return `lindero_session=${cookie.value}`;
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

describe("each request's own database", () => {
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
