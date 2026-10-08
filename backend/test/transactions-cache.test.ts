import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { attachments } from "../src/db/schema.js";
import { attachmentsForReceipts } from "../src/lib/storedFiles.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

/**
 * The transactions list is the biggest thing any tab re-reads, and it re-reads
 * it every time it comes back to the front. When nothing has been written in
 * between, the server answers "you already have it" without building it again.
 *
 * The danger in that is the opposite answer: a screen told its copy is current
 * when it is not. Most of these tests are about that direction.
 */
describe("re-reading the transactions list", async () => {
  const { app, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const owner = await login(app, "owner@test.hn", OWNER_PASSWORD);

  const read = (cookie: string, etag?: string) =>
    app.inject({
      method: "GET",
      url: "/api/transactions",
      headers: { cookie, ...(etag ? { "if-none-match": etag } : {}) },
    });

  it("answers 'unchanged', with no body, when nothing was written since", async () => {
    const first = await read(owner);
    const etag = first.headers.etag as string;

    assert.equal(first.statusCode, 200);
    assert.ok(etag, "the list carries a version");
    assert.equal(first.headers["cache-control"], "private, no-cache");

    const again = await read(owner, etag);

    assert.equal(again.statusCode, 304);
    assert.equal(again.body, "");
  });

  it("sends the list again, with the change in it, after any write", async () => {
    const before = await read(owner);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/customers/${ids.customerId}`,
      headers: { cookie: owner },
      payload: {
        fullName: "Cliente Renombrado",
        identification: "0801-1990-00001",
        phone: "+50499990000",
        customerSince: 2024,
      },
    });
    assert.equal(renamed.statusCode, 200);

    const after = await read(owner, before.headers.etag as string);

    assert.equal(after.statusCode, 200);
    assert.notEqual(after.headers.etag, before.headers.etag);
    assert.ok(
      (after.json().transactions as Array<{ customerName: string }>).every(
        (row) => row.customerName === "Cliente Renombrado",
      ),
    );
  });

  it("never confirms one person's copy to somebody else on the same computer", async () => {
    const ownersCopy = await read(owner);
    const staff = await login(app, "staff@test.hn", STAFF_PASSWORD);

    const staffRead = await read(staff, ownersCopy.headers.etag as string);

    assert.equal(staffRead.statusCode, 200);
  });

  it("still lists everything once there are more receipts than SQLite takes in one query", () => {
    // 32,766 is SQLite's limit on parameters in one statement. The list asks
    // about every receipt ever issued, so it must not depend on staying under.
    const receiptIds = Array.from({ length: 32_800 }, () => randomUUID());
    const last = receiptIds.at(-1)!;

    const fileId = randomUUID();
    sqlite.pragma("foreign_keys = OFF");
    app.db
      .insert(attachments)
      .values({
        id: fileId,
        receiptId: last,
        paymentId: null,
        storageKey: "stored/deposito.pdf",
        fileName: "deposito.pdf",
        contentType: "application/pdf",
        byteSize: 1024,
        uploadedBy: ids.ownerId,
      })
      .run();
    sqlite.pragma("foreign_keys = ON");

    const byReceipt = attachmentsForReceipts(app.db, receiptIds);

    assert.deepEqual(
      byReceipt.get(last)?.map((file) => file.id),
      [fileId],
    );
  });
});
