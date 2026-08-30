import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_ATTACHMENTS_PER_RECEIPT,
  isAllowedContentType,
  isValidStorageKey,
  safeDisplayName,
  storageKeyFor,
} from "../src/lib/attachments.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

/** A real, minimal PNG — one transparent pixel. */
const PNG_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Build a multipart body by hand, so the test exercises the real parser. */
function multipartBody(
  fileName: string,
  contentType: string,
  content: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----LinderoTestBoundary7f3a";

  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function issueReceipt(app: any, cookie: string, ids: { customerId: string; contractId: string }) {
  const response = await app.inject({
    method: "POST",
    url: "/api/receipts",
    headers: { cookie },
    payload: {
      customerId: ids.customerId,
      paidOn: "2026-03-15",
      method: "transfer",
      lines: [{ contractId: ids.contractId, amountCents: lempiras(6_700), type: "installment" }],
    },
  });

  return response.json().receipt.id as string;
}

describe("attachment safety helpers", () => {
  it("never lets an uploaded name reach the filesystem", () => {
    // The name is display text. The path comes from `storageKeyFor` alone.
    assert.equal(safeDisplayName("../../etc/passwd"), "..-..-etc-passwd");
    assert.equal(safeDisplayName("a\u0000b.jpg"), "ab.jpg");
    assert.equal(safeDisplayName("ok\nFAKE LINE.jpg"), "okFAKE LINE.jpg");
    assert.equal(safeDisplayName("   "), "comprobante");
  });

  it("names files on disk from the content type, not the upload", () => {
    assert.match(storageKeyFor("image/jpeg"), /^[0-9a-f-]{36}\.jpg$/);
    assert.match(storageKeyFor("application/pdf"), /^[0-9a-f-]{36}\.pdf$/);
  });

  it("accepts only what a proof of payment could be", () => {
    assert.equal(isAllowedContentType("image/png"), true);
    assert.equal(isAllowedContentType("image/heic"), true);
    assert.equal(isAllowedContentType("application/pdf"), true);
    assert.equal(isAllowedContentType("text/html"), false);
    assert.equal(isAllowedContentType("image/svg+xml"), false);
    assert.equal(isAllowedContentType("application/x-msdownload"), false);
  });

  it("refuses to treat anything but a generated key as a path", () => {
    assert.equal(isValidStorageKey(storageKeyFor("image/png")), true);
    assert.equal(isValidStorageKey("../../etc/passwd"), false);
    assert.equal(isValidStorageKey("../secrets.png"), false);
    assert.equal(isValidStorageKey(""), false);
  });
});

describe("attaching proof of payment", () => {
  it("stores the file and lists it on the receipt", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const receiptId = await issueReceipt(app, cookie, ids);

    const { payload, headers } = multipartBody("comprobante-bac.png", "image/png", PNG_PIXEL);

    const upload = await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/attachments`,
      headers: { cookie, ...headers },
      payload,
    });

    assert.equal(upload.statusCode, 201);
    assert.equal(upload.json().attachment.fileName, "comprobante-bac.png");
    assert.equal(upload.json().attachment.byteSize, PNG_PIXEL.byteLength);

    const receipt = await app.inject({
      method: "GET",
      url: `/api/receipts/${receiptId}`,
      headers: { cookie },
    });

    assert.equal(receipt.json().receipt.attachments.length, 1);
    assert.equal(receipt.json().receipt.attachments[0].contentType, "image/png");

    await app.close();
  });

  it("serves the bytes back exactly, and never inline", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const receiptId = await issueReceipt(app, cookie, ids);

    const { payload, headers } = multipartBody("slip.png", "image/png", PNG_PIXEL);
    const upload = await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/attachments`,
      headers: { cookie, ...headers },
      payload,
    });

    const file = await app.inject({
      method: "GET",
      url: `/api/attachments/${upload.json().attachment.id}/file`,
      headers: { cookie },
    });

    assert.equal(file.statusCode, 200);
    assert.deepEqual(file.rawPayload, PNG_PIXEL);

    // A stored PDF or SVG rendered inline would run in this app's origin.
    assert.match(file.headers["content-disposition"] as string, /^attachment;/);
    assert.equal(file.headers["x-content-type-options"], "nosniff");

    await app.close();
  });

  it("refuses a file that is not an image or a PDF", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const receiptId = await issueReceipt(app, cookie, ids);

    const { payload, headers } = multipartBody(
      "payload.html",
      "text/html",
      Buffer.from("<script>alert(1)</script>"),
    );

    const upload = await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/attachments`,
      headers: { cookie, ...headers },
      payload,
    });

    assert.equal(upload.statusCode, 415);
    assert.equal(upload.json().error, "unsupported_type");

    await app.close();
  });

  it("refuses an empty file", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const receiptId = await issueReceipt(app, cookie, ids);

    const { payload, headers } = multipartBody("empty.png", "image/png", Buffer.alloc(0));

    const upload = await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/attachments`,
      headers: { cookie, ...headers },
      payload,
    });

    assert.equal(upload.statusCode, 400);
    assert.equal(upload.json().error, "empty_file");

    await app.close();
  });

  it("refuses to attach to a receipt that does not exist", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const { payload, headers } = multipartBody("slip.png", "image/png", PNG_PIXEL);

    const upload = await app.inject({
      method: "POST",
      url: "/api/receipts/00000000-0000-0000-0000-000000000000/attachments",
      headers: { cookie, ...headers },
      payload,
    });

    assert.equal(upload.statusCode, 404);

    await app.close();
  });

  it("caps how many files one receipt may carry", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const receiptId = await issueReceipt(app, cookie, ids);

    for (let index = 0; index < MAX_ATTACHMENTS_PER_RECEIPT; index += 1) {
      const { payload, headers } = multipartBody(`slip-${index}.png`, "image/png", PNG_PIXEL);
      const response = await app.inject({
        method: "POST",
        url: `/api/receipts/${receiptId}/attachments`,
        headers: { cookie, ...headers },
        payload,
      });

      assert.equal(response.statusCode, 201);
    }

    const { payload, headers } = multipartBody("one-too-many.png", "image/png", PNG_PIXEL);
    const refused = await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/attachments`,
      headers: { cookie, ...headers },
      payload,
    });

    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, "too_many_attachments");

    await app.close();
  });

  it("removes an attachment on request", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const receiptId = await issueReceipt(app, cookie, ids);

    const { payload, headers } = multipartBody("wrong-customer.png", "image/png", PNG_PIXEL);
    const upload = await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/attachments`,
      headers: { cookie, ...headers },
      payload,
    });

    const attachmentId = upload.json().attachment.id;

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/attachments/${attachmentId}`,
      headers: { cookie },
    });

    assert.equal(removed.statusCode, 200);

    const gone = await app.inject({
      method: "GET",
      url: `/api/attachments/${attachmentId}/file`,
      headers: { cookie },
    });

    assert.equal(gone.statusCode, 404);

    const receipt = await app.inject({
      method: "GET",
      url: `/api/receipts/${receiptId}`,
      headers: { cookie },
    });

    assert.equal(receipt.json().receipt.attachments.length, 0);

    await app.close();
  });

  it("keeps a proof of payment behind the session", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const receiptId = await issueReceipt(app, cookie, ids);

    const { payload, headers } = multipartBody("slip.png", "image/png", PNG_PIXEL);
    const upload = await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/attachments`,
      headers: { cookie, ...headers },
      payload,
    });

    // A customer's bank details are nobody else's business.
    const anonymous = await app.inject({
      method: "GET",
      url: `/api/attachments/${upload.json().attachment.id}/file`,
    });

    assert.equal(anonymous.statusCode, 401);

    await app.close();
  });

  it("files the attachment in the history", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const receiptId = await issueReceipt(app, cookie, ids);

    const { payload, headers } = multipartBody("comprobante.png", "image/png", PNG_PIXEL);
    await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/attachments`,
      headers: { cookie, ...headers },
      payload,
    });

    const events = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { cookie } })
    ).json().events.filter((event: any) => event.entityId === receiptId);

    assert.ok(events.some((event: any) => event.after?.attachedFile === "comprobante.png"));

    await app.close();
  });
});
