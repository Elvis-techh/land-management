import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { subscribeToChanges } from "../src/lib/changes.js";
import type { ChangeEvent } from "../src/lib/changes.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

/**
 * What makes the app live, tested at the seam where it can silently stop
 * working.
 *
 * The stream itself is a long-lived response and is exercised for real against
 * a browser rather than here. What IS worth pinning down is the rule that feeds
 * it: which requests announce a change and which stay quiet. Get that wrong in
 * the loud direction and every screen in the office re-reads itself on every
 * failed form submission; get it wrong in the quiet direction and somebody's
 * payment never reaches anybody else's screen, which is the bug this whole
 * mechanism exists to remove.
 */
describe("announcing a write to the other screens", async () => {
  const { app, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

  /** Everything published while `run` was executing. */
  async function announcementsDuring(run: () => Promise<unknown>): Promise<ChangeEvent[]> {
    const heard: ChangeEvent[] = [];
    const unsubscribe = subscribeToChanges((event) => heard.push(event));

    try {
      await run();
    } finally {
      unsubscribe();
    }

    return heard;
  }

  it("announces a successful write, naming the resource and the tab", async () => {
    const heard = await announcementsDuring(() =>
      app.inject({
        method: "PATCH",
        url: `/api/customers/${ids.customerId}`,
        headers: { cookie, "x-client-id": "the-phone" },
        payload: {
          fullName: "Cliente Prueba",
          identification: "0801-1990-00001",
          phone: "+50499990000",
          customerSince: 2024,
        },
      }),
    );

    assert.equal(heard.length, 1);
    assert.equal(heard[0]!.resource, "customers");
    // Carried so the tab that made the write can skip its own echo.
    assert.equal(heard[0]!.origin, "the-phone");
    assert.ok(!Number.isNaN(Date.parse(heard[0]!.at)));
  });

  it("says nothing about a read", async () => {
    const heard = await announcementsDuring(() =>
      Promise.all([
        app.inject({ method: "GET", url: "/api/lots", headers: { cookie } }),
        app.inject({ method: "GET", url: "/api/transactions", headers: { cookie } }),
        app.inject({ method: "GET", url: "/api/customers", headers: { cookie } }),
      ]),
    );

    assert.deepEqual(heard, []);
  });

  it("says nothing about a write that was refused", async () => {
    // Rejected by the schema: a customer needs a name. Nothing changed, so no
    // screen has anything to re-read.
    const heard = await announcementsDuring(async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/customers",
        headers: { cookie },
        payload: { fullName: "" },
      });

      assert.ok(response.statusCode >= 400, `expected a refusal, got ${response.statusCode}`);
    });

    assert.deepEqual(heard, []);
  });

  it("says nothing about a write somebody was not allowed to make", async () => {
    const heard = await announcementsDuring(async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/customers",
        payload: { fullName: "Sin sesión", phone: "+50499990001", customerSince: 2026 },
      });

      assert.equal(response.statusCode, 401);
    });

    assert.deepEqual(heard, []);
  });

  it("says nothing about signing in or out", async () => {
    // A session is one person's. Nobody else's screen went stale because
    // somebody logged in, and a login storm must not become a reload storm.
    const heard = await announcementsDuring(async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "owner@test.hn", password: OWNER_PASSWORD },
      });

      assert.equal(response.statusCode, 200);
    });

    assert.deepEqual(heard, []);
  });

  it("names the resource from the route, never from the record's id", async () => {
    // The registered pattern is "/api/receipts/:id/void", so what reaches every
    // other browser is "receipts" — not the id of the receipt, and not the id
    // of the customer it belongs to. The stream is a nudge, not a data feed.
    const created = await app.inject({
      method: "POST",
      url: "/api/receipts",
      headers: { cookie },
      payload: {
        customerId: ids.customerId,
        paidOn: "2026-03-01",
        method: "cash",
        idempotencyKey: "changes-test-1",
        lines: [{ contractId: ids.contractId, amountCents: 100_000, type: "installment" }],
      },
    });

    assert.equal(created.statusCode, 201, created.body);
    const receiptId = created.json().receipt.id as string;

    const heard = await announcementsDuring(() =>
      app.inject({
        method: "POST",
        url: `/api/receipts/${receiptId}/void`,
        headers: { cookie },
        payload: { reason: "Anulado durante la prueba" },
      }),
    );

    assert.equal(heard.length, 1);
    assert.equal(heard[0]!.resource, "receipts");
    assert.ok(
      !JSON.stringify(heard[0]).includes(receiptId),
      "an announcement must not carry the id of the record it is about",
    );
  });

  it("leaves the origin null when the client did not identify itself", async () => {
    // An unrecognised tab is not an error: everybody hears the event, including
    // whoever made the write. Chattier, still correct.
    const heard = await announcementsDuring(() =>
      app.inject({
        method: "POST",
        url: "/api/customers",
        headers: { cookie },
        payload: {
          fullName: "Sin identificador",
          phone: "+50499990002",
          customerSince: 2026,
        },
      }),
    );

    assert.equal(heard.length, 1);
    assert.equal(heard[0]!.origin, null);
  });

  it("keeps announcing after a subscriber throws", async () => {
    // A socket can die between the check and the write. One broken listener
    // must not swallow the news for everybody else, and must never turn a
    // completed payment into a failed request.
    const heard: string[] = [];
    const stopBroken = subscribeToChanges(() => {
      throw new Error("this socket is gone");
    });
    const stopGood = subscribeToChanges((event) => heard.push(event.resource));

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/customers",
        headers: { cookie },
        payload: { fullName: "Después del fallo", phone: "+50499990003", customerSince: 2026 },
      });

      assert.equal(response.statusCode, 201, response.body);
    } finally {
      stopBroken();
      stopGood();
    }

    assert.deepEqual(heard, ["customers"]);
  });

  it("stops delivering once a stream unsubscribes", async () => {
    // The rule an SSE connection depends on: a closed tab is one entry removed
    // from the set, not a listener writing to a dead socket forever.
    const heard: ChangeEvent[] = [];
    subscribeToChanges((event) => heard.push(event))();

    await app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { cookie },
      payload: { fullName: "Nadie escucha", phone: "+50499990004", customerSince: 2026 },
    });

    assert.deepEqual(heard, []);
  });
});
