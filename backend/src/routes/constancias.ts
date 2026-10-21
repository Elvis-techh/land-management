import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";

import type { Db } from "../db/client.js";
import {
  constancias,
  contracts,
  customers,
  lots,
  payments,
  projects,
  receipts,
  users,
} from "../db/schema.js";
import { allocateConstanciaCode } from "../lib/constancias.js";
import { generateLookupCode, nextReceiptNumber, toStoredLookupCode } from "../lib/receipts.js";
import { businessToday } from "../lib/time.js";

/*
 * «Constancia de Cancelación Total» — the document that says a paid-off
 * contract owes nothing. See `constancias` in src/db/schema.ts.
 *
 *   POST /contracts/:id/constancia   issue one (or hand back the standing one)
 *   GET  /contracts/:id/constancia   the standing one, or null
 *   GET  /constancias/:id            one, as a document
 *   GET  /constancias/lookup/:code   verify one from its code, staff only
 *
 * Verification is deliberately inside Lindero, behind the login, like the
 * receipt lookup: a notary or a bank calls the office, and the office reads
 * the code back. A public page would show the customer's name, lot and price
 * to anybody who got hold of the code.
 */

export interface ConstanciaRoutesOptions {
  /** IANA name — see `timeZone` in src/config/env.ts. Dates the document. */
  timeZone: string;
}

/** A constancia as the document needs it. Figures are read from the payments. */
function presentConstancia(db: Db, id: string) {
  const row = db
    .select({
      id: constancias.id,
      code: constancias.code,
      lookupCode: constancias.lookupCode,
      issuedOn: constancias.issuedOn,
      voidedAt: constancias.voidedAt,
      voidReason: constancias.voidReason,
      issuedByName: users.name,
      contractId: contracts.id,
      contractCode: contracts.code,
      salePriceCents: contracts.salePriceCents,
      signedOn: contracts.signedOn,
      lotCode: lots.code,
      projectName: projects.name,
      customerName: customers.fullName,
      customerIdentification: customers.identification,
    })
    .from(constancias)
    .innerJoin(users, eq(users.id, constancias.issuedBy))
    .innerJoin(contracts, eq(contracts.id, constancias.contractId))
    .innerJoin(lots, eq(lots.id, contracts.lotId))
    .innerJoin(projects, eq(projects.id, lots.projectId))
    .innerJoin(customers, eq(customers.id, contracts.customerId))
    .where(eq(constancias.id, id))
    .get();

  if (!row) {
    return null;
  }

  // Every payment that still counts, in the order they were made. A reversed
  // one is left out: it is not money the contract was paid with.
  const history = db
    .select({
      paidOn: payments.paidOn,
      type: payments.type,
      amountCents: payments.amountCents,
      receiptCode: receipts.code,
    })
    .from(payments)
    .leftJoin(receipts, eq(receipts.id, payments.receiptId))
    .where(and(eq(payments.contractId, row.contractId), isNull(payments.reversedAt)))
    .orderBy(asc(payments.paidOn), asc(payments.createdAt))
    .all();

  const totalPaidCents = history.reduce((total, payment) => total + payment.amountCents, 0);

  return {
    id: row.id,
    code: row.code,
    lookupCode: row.lookupCode,
    issuedOn: row.issuedOn,
    issuedBy: { name: row.issuedByName },
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    contract: {
      id: row.contractId,
      code: row.contractCode,
      salePriceCents: row.salePriceCents,
      signedOn: row.signedOn,
    },
    lot: { code: row.lotCode, projectName: row.projectName },
    customer: { fullName: row.customerName, identification: row.customerIdentification },
    payments: history,
    totalPaidCents,
    lastPaidOn: history.length > 0 ? history[history.length - 1]!.paidOn : null,
  };
}

/** The contract's standing (not voided) constancia, if it has one. */
function standingConstanciaId(db: Pick<Db, "select">, contractId: string): string | null {
  return (
    db
      .select({ id: constancias.id })
      .from(constancias)
      .where(and(eq(constancias.contractId, contractId), isNull(constancias.voidedAt)))
      .get()?.id ?? null
  );
}

export const constanciaRoutes: FastifyPluginAsync<ConstanciaRoutesOptions> = async (
  app,
  options,
) => {
  app.get<{ Params: { id: string } }>(
    "/contracts/:id/constancia",
    { onRequest: app.requireUser },
    async (request) => {
      const id = standingConstanciaId(app.db, request.params.id);

      return { constancia: id === null ? null : presentConstancia(app.db, id) };
    },
  );

  /**
   * Issue the constancia for a paid-off contract.
   *
   * One at a time: a contract that already has a standing constancia gets that
   * one back rather than a second, so printing it again never mints a new
   * number. Only once it has been voided — the contract reopened and was paid
   * off again — is a new one issued.
   */
  app.post<{ Params: { id: string } }>(
    "/contracts/:id/constancia",
    { onRequest: app.requireCapability("contract:certify") },
    async (request, reply) => {
      const actor = request.user!;

      const contract = app.db
        .select({
          id: contracts.id,
          status: contracts.status,
          kind: contracts.kind,
          saleType: contracts.saleType,
        })
        .from(contracts)
        .where(eq(contracts.id, request.params.id))
        .get();

      if (!contract) {
        return reply.code(404).send({ error: "not_found", message: "Ese contrato no existe." });
      }

      if (contract.kind !== "contract" || contract.status !== "paid_off") {
        return reply.code(409).send({
          error: "not_paid_off",
          message: "Solo se emite constancia de un contrato en estado Pagado.",
        });
      }

      // A donation is "paid off" at a price of zero: no money was ever owed,
      // so there is nothing for a constancia of payment to certify.
      if (contract.saleType === "donation") {
        return reply.code(409).send({
          error: "donation",
          message: "Una donación no tiene pagos que hacer constar.",
        });
      }

      const id = app.db.transaction((tx) => {
        const standing = standingConstanciaId(tx, contract.id);

        if (standing !== null) {
          return standing;
        }

        // Allocated inside the transaction, under the write lock, exactly as
        // a receipt number is.
        const highest = tx
          .select({ value: sql<number | null>`MAX(${constancias.number})` })
          .from(constancias)
          .get();

        const code = allocateConstanciaCode(
          (candidate) =>
            tx
              .select({ id: constancias.id })
              .from(constancias)
              .where(eq(constancias.code, candidate))
              .get() !== undefined,
        );

        const newId = randomUUID();

        tx.insert(constancias)
          .values({
            id: newId,
            number: nextReceiptNumber(highest?.value),
            code,
            lookupCode: generateLookupCode(),
            contractId: contract.id,
            issuedOn: businessToday(options.timeZone),
            issuedBy: actor.id,
          })
          .run();

        return newId;
      });

      return { constancia: presentConstancia(app.db, id) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/constancias/:id",
    { onRequest: app.requireUser },
    async (request, reply) => {
      const constancia = presentConstancia(app.db, request.params.id);

      if (!constancia) {
        return reply.code(404).send({ error: "not_found", message: "Esa constancia no existe." });
      }

      return { constancia };
    },
  );

  /** Verify a constancia from the code printed on it. */
  app.get<{ Params: { code: string } }>(
    "/constancias/lookup/:code",
    { onRequest: app.requireUser },
    async (request, reply) => {
      const stored = toStoredLookupCode(request.params.code);

      if (stored === null) {
        return reply.code(400).send({
          error: "invalid_lookup_code",
          message: "Ese código no tiene la forma de un código de verificación.",
        });
      }

      const row = app.db
        .select({ id: constancias.id })
        .from(constancias)
        .where(eq(constancias.lookupCode, stored))
        .get();

      if (!row) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "No existe una constancia con ese código." });
      }

      return { constancia: presentConstancia(app.db, row.id) };
    },
  );
};
