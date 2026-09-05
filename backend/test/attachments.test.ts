import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_ATTACHMENTS_PER_RECEIPT,
  asciiFileName,
  isAllowedContentType,
  isValidStorageKey,
  safeDisplayName,
  storageKeyFor,
} from "../src/lib/storedFiles.js";
import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

/** A real, minimal PNG — one transparent pixel. */
const PNG_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Build a multipart body by hand, so the test exercises the real parser.
 *
 * `fields` are written BEFORE the file, which is not a stylistic choice: the
 * handler reads them off the part it stops at, so anything sent after the file
 * has not been parsed when it looks. Sending them in this order is what the
 * browser is asked to do too — see features/receipts/api.ts.
 */
function multipartBody(
  fileName: string,
  contentType: string,
  content: Buffer,
  fields: Record<string, string> = {},
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----LinderoTestBoundary7f3a";

  const head = Buffer.from(
    Object.entries(fields)
      .map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      )
      .join("") +
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

  it("keeps the Content-Disposition fallback name inside plain ASCII", () => {
    // The quote would close the quoted-string the name sits inside, and the
    // backslash would escape whatever came next — a filename must not be able
    // to rewrite the header carrying it.
    assert.equal(asciiFileName('depósito "agosto".png'), "dep_sito _agosto_.png");
    assert.equal(asciiFileName("back\\slash.pdf"), "back_slash.pdf");
    // Two underscores per emoji: the regex works on UTF-16 code units, and an
    // emoji is a surrogate pair. Lossy is fine here — the real name travels in
    // the `filename*` parameter beside this one.
    assert.equal(asciiFileName("💸💸💸"), "______");
    assert.equal(asciiFileName("   "), "comprobante");
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

  it("serves the bytes back for viewing, sandboxed rather than downloaded", async () => {
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

    /*
     * Inline, so looking at a comprobante does not drop a copy of somebody's
     * bank slip into the Downloads folder of a shared office machine — the
     * files live on the server so they stop living on devices.
     *
     * The risk that used to justify `attachment` — a stored PDF running script
     * in this app's origin — is answered by the sandbox CSP instead, which is
     * strictly stronger: it holds while the file is being VIEWED, where
     * `attachment` only relocated the problem to a folder.
     */
    assert.match(file.headers["content-disposition"] as string, /^inline;/);
    assert.match(file.headers["content-security-policy"] as string, /(^|;)\s*sandbox\s*(;|$)/);
    assert.equal(file.headers["x-content-type-options"], "nosniff");

    // The accented name survives in the RFC 5987 parameter; the plain one
    // beside it is ASCII so the header itself is never malformed.
    const accented = multipartBody("depósito agosto.png", "image/png", PNG_PIXEL);
    const second = await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/attachments`,
      headers: { cookie, ...accented.headers },
      payload: accented.payload,
    });

    const named = await app.inject({
      method: "GET",
      url: `/api/attachments/${second.json().attachment.id}/file`,
      headers: { cookie },
    });

    const disposition = named.headers["content-disposition"] as string;
    assert.match(disposition, /filename="dep_sito agosto\.png"/);
    assert.match(disposition, /filename\*=UTF-8''dep%C3%B3sito%20agosto\.png/);

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

  it("ties a comprobante to one lot, and refuses a lot from another receipt", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const receiptId = await issueReceipt(app, cookie, ids);

    const receipt = (
      await app.inject({ method: "GET", url: `/api/receipts/${receiptId}`, headers: { cookie } })
    ).json().receipt;
    const paymentId = receipt.lines[0].paymentId as string;

    const tagged = multipartBody("lote-a14.png", "image/png", PNG_PIXEL, { paymentId });
    const upload = await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/attachments`,
      headers: { cookie, ...tagged.headers },
      payload: tagged.payload,
    });

    assert.equal(upload.statusCode, 201);
    assert.equal(upload.json().attachment.paymentId, paymentId);

    // A payment id that is not a line on THIS receipt would file one customer's
    // bank slip under another's lot.
    const foreign = multipartBody("ajeno.png", "image/png", PNG_PIXEL, {
      paymentId: "00000000-0000-0000-0000-000000000000",
    });
    const refused = await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/attachments`,
      headers: { cookie, ...foreign.headers },
      payload: foreign.payload,
    });

    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error, "unknown_payment");

    await app.close();
  });

  it("shows every transaction row the proof behind it", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const receiptId = await issueReceipt(app, cookie, ids);

    const { payload, headers } = multipartBody("slip.png", "image/png", PNG_PIXEL);
    await app.inject({
      method: "POST",
      url: `/api/receipts/${receiptId}/attachments`,
      headers: { cookie, ...headers },
      payload,
    });

    const transactions = (
      await app.inject({ method: "GET", url: "/api/transactions", headers: { cookie } })
    ).json().transactions;

    const row = transactions.find((entry: any) => entry.receiptId === receiptId);

    // Metadata only — enough to draw a thumbnail and open the viewer. The bytes
    // are fetched per file, lazily, so a long list is not a hundred photographs
    // on the wire.
    assert.equal(row.attachments.length, 1);
    assert.equal(row.attachments[0].fileName, "slip.png");
    assert.equal(row.attachments[0].paymentId, null);
    assert.ok(!("storageKey" in row.attachments[0]));

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
