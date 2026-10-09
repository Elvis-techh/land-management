import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { uploadContractDocument } from "../src/features/contracts/api";
import { ApiError } from "../src/lib/api";

/*
 * Two different things can refuse a scan: Lindero, which explains itself in
 * JSON, and Nginx in front of it, which answers with an HTML page before
 * Lindero sees a byte. The person filing the contract should be told the file
 * was too big either way, not that the upload failed for no stated reason.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function serverAnswers(response: Response): void {
  globalThis.fetch = async () => response;
}

const scan = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "contrato.pdf", {
  type: "application/pdf",
});

const refusedWith = (status: number, message: string) => (error: unknown) =>
  error instanceof ApiError && error.status === status && error.message === message;

describe("uploadContractDocument", () => {
  it("says the file was too big when Nginx refuses it", async () => {
    serverAnswers(
      new Response("<html><body><h1>413 Request Entity Too Large</h1></body></html>", {
        status: 413,
        headers: { "Content-Type": "text/html" },
      }),
    );

    await assert.rejects(
      uploadContractDocument("contract-1", scan),
      refusedWith(413, "El archivo es demasiado grande para el servidor."),
    );
  });

  it("passes Lindero's own refusal through as written", async () => {
    serverAnswers(
      Response.json(
        { error: "file_too_large", message: "El archivo supera el máximo de 30 MB." },
        { status: 413 },
      ),
    );

    await assert.rejects(
      uploadContractDocument("contract-1", scan),
      refusedWith(413, "El archivo supera el máximo de 30 MB."),
    );
  });

  it("keeps the general message for any other failure that explains nothing", async () => {
    serverAnswers(new Response("<html>502 Bad Gateway</html>", { status: 502 }));

    await assert.rejects(
      uploadContractDocument("contract-1", scan),
      refusedWith(502, "No se pudo subir el documento."),
    );
  });
});
