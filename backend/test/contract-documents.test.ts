import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_DOCUMENTS_PER_CONTRACT } from "../src/lib/storedFiles.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

/** A real, minimal PDF — enough bytes for a parser to accept as a document. */
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "latin1",
);

/** Build a multipart body by hand, so the test exercises the real parser. */
function multipartBody(
  fileName: string,
  contentType: string,
  content: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----LinderoContractBoundary91c4";

  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );

  return {
    payload: Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

const upload = (
  app: any,
  cookie: string,
  contractId: string,
  fileName = "contrato-firmado.pdf",
  contentType = "application/pdf",
  content: Buffer = PDF,
) => {
  const { payload, headers } = multipartBody(fileName, contentType, content);

  return app.inject({
    method: "POST",
    url: `/api/contracts/${contractId}/documents`,
    headers: { cookie, ...headers },
    payload,
  });
};

describe("the signed contract on file", () => {
  it("stores the document and lists it against the contract", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const created = await upload(app, cookie, ids.contractId);

    assert.equal(created.statusCode, 201);
    assert.equal(created.json().document.fileName, "contrato-firmado.pdf");
    assert.equal(created.json().document.byteSize, PDF.byteLength);

    const listed = await app.inject({
      method: "GET",
      url: `/api/contracts/${ids.contractId}/documents`,
      headers: { cookie },
    });

    assert.equal(listed.json().documents.length, 1);
    assert.equal(listed.json().documents[0].contentType, "application/pdf");
    // Who filed it, which is the question asked of a legal document later.
    assert.ok(typeof listed.json().documents[0].uploadedBy === "string");
    // The name on disk is ours alone and never leaves the server.
    assert.ok(!("storageKey" in listed.json().documents[0]));

    await app.close();
  });

  it("marks the contracts that have their paperwork, and counts nothing else", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const before = (
      await app.inject({ method: "GET", url: "/api/contracts", headers: { cookie } })
    ).json().contracts;

    // Every contract starts at zero, which is why the screen marks the ones
    // that HAVE a document rather than flagging the ones that do not.
    assert.ok(before.length > 0);
    assert.ok(before.every((contract: any) => contract.documentCount === 0));

    await upload(app, cookie, ids.contractId);

    const after = (
      await app.inject({ method: "GET", url: "/api/contracts", headers: { cookie } })
    ).json().contracts;

    for (const contract of after) {
      assert.equal(contract.documentCount, contract.id === ids.contractId ? 1 : 0);
    }

    await app.close();
  });

  it("serves the contract for viewing, sandboxed rather than downloaded", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const documentId = (await upload(app, cookie, ids.contractId)).json().document.id;

    const file = await app.inject({
      method: "GET",
      url: `/api/contract-documents/${documentId}/file`,
      headers: { cookie },
    });

    assert.equal(file.statusCode, 200);
    assert.deepEqual(file.rawPayload, PDF);

    /*
     * Inline, so reading the contract does not leave a copy of it on whatever
     * machine asked — which for a legal document matters more than it did for
     * a deposit slip. `allow-scripts` because the browser's PDF viewer is
     * itself script; `allow-same-origin` is deliberately absent, since the two
     * together would undo the sandbox.
     */
    assert.match(file.headers["content-disposition"] as string, /^inline;/);
    assert.equal(file.headers["content-security-policy"], "sandbox allow-scripts");
    assert.equal(file.headers["x-content-type-options"], "nosniff");

    await app.close();
  });

  it("keeps a signed contract behind the session", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const documentId = (await upload(app, cookie, ids.contractId)).json().document.id;

    // Both parties' names, their identidades and what was agreed.
    const anonymous = await app.inject({
      method: "GET",
      url: `/api/contract-documents/${documentId}/file`,
    });

    assert.equal(anonymous.statusCode, 401);

    await app.close();
  });

  it("refuses a file that is not a PDF or a scan", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const refused = await upload(
      app,
      cookie,
      ids.contractId,
      "contrato.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      Buffer.from("PK"),
    );

    assert.equal(refused.statusCode, 415);
    assert.equal(refused.json().error, "unsupported_type");

    await app.close();
  });

  it("refuses an empty file, and one document past the ceiling", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const empty = await upload(
      app,
      cookie,
      ids.contractId,
      "vacio.pdf",
      "application/pdf",
      Buffer.alloc(0),
    );

    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().error, "empty_file");

    for (let index = 0; index < MAX_DOCUMENTS_PER_CONTRACT; index += 1) {
      const filled = await upload(app, cookie, ids.contractId, `doc-${index}.pdf`);
      assert.equal(filled.statusCode, 201);
    }

    const overflowed = await upload(app, cookie, ids.contractId, "uno-mas.pdf");

    assert.equal(overflowed.statusCode, 409);
    assert.equal(overflowed.json().error, "too_many_documents");

    await app.close();
  });

  it("refuses a document for a contract that does not exist", async () => {
    const { app } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    const refused = await upload(app, cookie, "00000000-0000-0000-0000-000000000000");

    assert.equal(refused.statusCode, 404);

    await app.close();
  });

  it("lets an associate file the signed copy but not destroy it", async () => {
    const { app, ids } = await buildTestApp();
    const staff = await login(app, "staff@test.hn", STAFF_PASSWORD);

    /*
     * Filing the signed copy is the last step of writing a contract, which is
     * why it rides on `contract:create` — an associate's job. Destroying it is
     * a different act: it is the legal instrument for a lot, and unlike a
     * mis-attached photograph of a deposit slip there is no second copy of it
     * in a chat somewhere.
     */
    const created = await upload(app, staff, ids.contractId);
    assert.equal(created.statusCode, 201);

    const refused = await app.inject({
      method: "DELETE",
      url: `/api/contract-documents/${created.json().document.id}`,
      headers: { cookie: staff },
    });

    assert.equal(refused.statusCode, 403);

    await app.close();
  });

  it("removes the document and files the removal in the history", async () => {
    const { app, ids } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
    const documentId = (await upload(app, cookie, ids.contractId)).json().document.id;

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/contract-documents/${documentId}`,
      headers: { cookie },
    });

    assert.equal(removed.statusCode, 200);

    const gone = await app.inject({
      method: "GET",
      url: `/api/contract-documents/${documentId}/file`,
      headers: { cookie },
    });

    assert.equal(gone.statusCode, 404);

    // The audit entry naming the file is what remains of it.
    const events = (
      await app.inject({ method: "GET", url: "/api/audit", headers: { cookie } })
    ).json().events.filter((event: any) => event.entityId === ids.contractId);

    assert.ok(events.some((event: any) => event.after?.attachedDocument === "contrato-firmado.pdf"));
    assert.ok(events.some((event: any) => event.before?.removedDocument === "contrato-firmado.pdf"));

    await app.close();
  });
});
