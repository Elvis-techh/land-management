import { randomUUID } from "node:crypto";

import { asc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { contracts, customers, lots, payments, projects } from "../db/schema.js";
import { recordAudit } from "../lib/audit.js";
import { normalizePhone } from "../lib/phone.js";

/**
 * Every customer's ACTIVE contracts, in one query.
 *
 * The Clientes table shows what each person currently holds, and that has to be
 * read from the contracts rather than kept as a column on the customer: a
 * "2 contratos" written on the customer row is wrong the moment a contract is
 * cancelled, and nobody would ever find out.
 *
 * Cancelled, defaulted and paid-off contracts are left out on purpose — they
 * belong to the customer's history, which the contract screen will show, not to
 * "what is this person holding right now".
 */
const activeContractsQuery = (db: import("../db/client.js").Db) =>
  db
    .select({
      customerId: contracts.customerId,
      contractId: contracts.id,
      contractCode: contracts.code,
      kind: contracts.kind,
      salePriceCents: contracts.salePriceCents,
      lotCode: lots.code,
      projectName: projects.name,
      // Summed from the payments table, exactly as the lots list does it. There
      // is no stored balance anywhere in Lindero.
      paidToDateCents: sql<number>`
        COALESCE((
          SELECT SUM(${payments.amountCents})
          FROM ${payments}
          WHERE ${payments.contractId} = ${contracts.id}
            AND ${payments.reversedAt} IS NULL
        ), 0)
      `,
    })
    .from(contracts)
    .innerJoin(lots, eq(lots.id, contracts.lotId))
    .innerJoin(projects, eq(projects.id, lots.projectId))
    .where(eq(contracts.status, "active"))
    .orderBy(asc(contracts.code));

const customerBody = z.object({
  fullName: z.string().trim().min(1).max(160),
  /** Número de identidad. Unique — one person, one record. */
  identification: z.string().trim().min(1).max(40),
  /**
   * As typed. Normalised to E.164 below rather than by the schema, so the
   * refusal can explain what a usable number looks like instead of failing as
   * an anonymous validation issue.
   */
  phone: z.string().trim().min(1).max(40),
  /** Optional throughout: plenty of customers here have no email address. */
  email: z.string().trim().max(160).email().nullish(),
  address: z.string().trim().max(300).nullish(),
  customerSince: z.number().int().min(1900).max(2200),
  notes: z.string().trim().max(2000).nullish(),
});

/**
 * Deleting a customer asks for a motive, like archiving a lot does.
 *
 * The row itself is about to stop existing, so the audit entry is the ONLY
 * thing that will still be able to say this person was ever on file. A line
 * saying who removed them and why is the whole record.
 */
const deleteBody = z.object({
  reason: z.string().trim().min(10).max(500),
});

/**
 * The clash an identity number would cause, worded for the user, or `null` when
 * it is free.
 *
 * Same reasoning as `lotCodeClash` in routes/lots.ts: the unique index is what
 * guarantees this, and the lookup is what turns the guarantee into a sentence
 * naming the person already on file. It matters more here than anywhere — a
 * customer entered twice splits their contracts across two records, and the
 * balance on each one is then quietly wrong.
 */
function identificationClash(
  db: import("../db/client.js").Db,
  identification: string,
  ignoreCustomerId?: string,
): string | null {
  const clash = db
    .select({ id: customers.id, fullName: customers.fullName })
    .from(customers)
    .where(eq(customers.identification, identification))
    .get();

  if (!clash || clash.id === ignoreCustomerId) {
    return null;
  }

  return `La identidad ${identification} ya está registrada a nombre de ${clash.fullName}.`;
}

export const customerRoutes: FastifyPluginAsync = async (app) => {
  app.get("/customers", { onRequest: app.requireUser }, async (request, reply) => {
    const rows = app.db.select().from(customers).orderBy(asc(customers.fullName)).all();

    // One query for the contracts, grouped in memory, rather than one query per
    // customer. The list is small, but the shape of the mistake is not.
    const byCustomer = new Map<string, Array<Record<string, unknown>>>();

    for (const row of activeContractsQuery(app.db).all()) {
      const list = byCustomer.get(row.customerId) ?? [];

      list.push({
        contractId: row.contractId,
        contractCode: row.contractCode,
        kind: row.kind,
        lotCode: row.lotCode,
        projectName: row.projectName,
        salePrice: row.salePriceCents,
        paidToDate: row.paidToDateCents,
      });

      byCustomer.set(row.customerId, list);
    }

    return reply.send({
      customers: rows.map((row) => ({
        id: row.id,
        fullName: row.fullName,
        identification: row.identification,
        phone: row.phone,
        email: row.email,
        address: row.address,
        customerSince: row.customerSince,
        notes: row.notes,
        contracts: byCustomer.get(row.id) ?? [],
      })),
    });
  });

  app.post(
    "/customers",
    { onRequest: app.requireCapability("customer:create") },
    async (request, reply) => {
      const parsed = customerBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Revisa los datos del cliente.",
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const phone = normalizePhone(parsed.data.phone);

      if (!phone) {
        return reply.code(400).send({
          error: "invalid_phone",
          message:
            "El teléfono no parece un número válido. Escribe los 8 dígitos hondureños " +
            "(9982-4471) o el número completo con su código de país (+1 305 555 0123).",
        });
      }

      const clash = identificationClash(app.db, parsed.data.identification);

      if (clash) {
        return reply.code(409).send({ error: "duplicate_identification", message: clash });
      }

      const actor = request.user!;
      const now = new Date().toISOString();

      const created = app.db.transaction((tx) => {
        const next = tx
          .insert(customers)
          .values({
            id: randomUUID(),
            fullName: parsed.data.fullName,
            identification: parsed.data.identification,
            phone,
            email: parsed.data.email ?? null,
            address: parsed.data.address ?? null,
            customerSince: parsed.data.customerSince,
            notes: parsed.data.notes ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "customer",
          entityId: next.id,
          action: "create",
          after: {
            fullName: next.fullName,
            identification: next.identification,
            phone: next.phone,
          },
        });

        return next;
      });

      return reply.code(201).send({
        customer: { id: created.id, fullName: created.fullName, phone: created.phone },
      });
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/customers/:id",
    { onRequest: app.requireCapability("customer:edit") },
    async (request, reply) => {
      const parsed = customerBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Revisa los datos del cliente.",
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const existing = app.db
        .select()
        .from(customers)
        .where(eq(customers.id, request.params.id))
        .get();

      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: "Cliente no encontrado." });
      }

      const phone = normalizePhone(parsed.data.phone);

      if (!phone) {
        return reply.code(400).send({
          error: "invalid_phone",
          message:
            "El teléfono no parece un número válido. Escribe los 8 dígitos hondureños " +
            "(9982-4471) o el número completo con su código de país (+1 305 555 0123).",
        });
      }

      const clash = identificationClash(app.db, parsed.data.identification, existing.id);

      if (clash) {
        return reply.code(409).send({ error: "duplicate_identification", message: clash });
      }

      const actor = request.user!;

      const updated = app.db.transaction((tx) => {
        const next = tx
          .update(customers)
          .set({
            fullName: parsed.data.fullName,
            identification: parsed.data.identification,
            phone,
            email: parsed.data.email ?? null,
            address: parsed.data.address ?? null,
            customerSince: parsed.data.customerSince,
            notes: parsed.data.notes ?? null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(customers.id, existing.id))
          .returning()
          .get();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "customer",
          entityId: existing.id,
          action: "update",
          before: {
            fullName: existing.fullName,
            identification: existing.identification,
            phone: existing.phone,
            email: existing.email,
            address: existing.address,
            notes: existing.notes,
          },
          after: {
            fullName: next.fullName,
            identification: next.identification,
            phone: next.phone,
            email: next.email,
            address: next.address,
            notes: next.notes,
          },
        });

        return next;
      });

      return reply.send({
        customer: { id: updated.id, fullName: updated.fullName, phone: updated.phone },
      });
    },
  );

  /**
   * Delete a customer outright.
   *
   * This is the one place in Lindero where a row really is removed instead of
   * archived, and it is only safe because of the guard below: a customer who has
   * never appeared on a contract has no history to tear. Nothing points at them,
   * so nothing breaks when they go.
   *
   * The moment a contract exists the answer is no, and the two cases are kept
   * apart on purpose:
   *
   * - An ACTIVE contract means this person is holding a lot right now. Deleting
   *   them would leave that lot held by nobody, and the Lotes screen would show
   *   a contract with an empty name.
   * - A finished contract — cancelled, paid off, defaulted — is history. The
   *   payments under it are real money that was really received, and a receipt
   *   nobody can trace back to a person is not a record of anything.
   *
   * Neither is a case for a delete button. When a customer with history has to
   * go away, what is actually wanted is a contract cancellation, which is its
   * own deliberate action with its own trail.
   */
  app.delete<{ Params: { id: string } }>(
    "/customers/:id",
    { onRequest: app.requireCapability("customer:delete") },
    async (request, reply) => {
      const parsed = deleteBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Explica el motivo con al menos 10 caracteres.",
        });
      }

      const existing = app.db
        .select()
        .from(customers)
        .where(eq(customers.id, request.params.id))
        .get();

      if (!existing) {
        return reply.code(404).send({ error: "not_found", message: "Cliente no encontrado." });
      }

      // Every contract this person has ever been on, not just the live ones.
      // The active count decides the wording; the total decides the answer.
      const held = app.db
        .select({ code: contracts.code, status: contracts.status })
        .from(contracts)
        .where(eq(contracts.customerId, existing.id))
        .orderBy(asc(contracts.code))
        .all();

      const active = held.filter((contract) => contract.status === "active");

      if (active.length > 0) {
        return reply.code(409).send({
          error: "customer_has_active_contracts",
          message:
            `No se puede eliminar a ${existing.fullName}: todavía tiene ` +
            `${active.length} contrato${active.length === 1 ? "" : "s"} vigente` +
            `${active.length === 1 ? "" : "s"} (${active.map((contract) => contract.code).join(", ")}). ` +
            "Cancela el contrato primero.",
          contractCodes: active.map((contract) => contract.code),
        });
      }

      if (held.length > 0) {
        return reply.code(409).send({
          error: "customer_has_history",
          message:
            `No se puede eliminar a ${existing.fullName}: tiene ` +
            `${held.length} contrato${held.length === 1 ? "" : "s"} en su historial ` +
            `(${held.map((contract) => contract.code).join(", ")}). ` +
            "Borrar al cliente dejaría esos pagos sin dueño.",
          contractCodes: held.map((contract) => contract.code),
        });
      }

      const actor = request.user!;

      app.db.transaction((tx) => {
        tx.delete(customers).where(eq(customers.id, existing.id)).run();

        // Written with the full record in `before`, because after this
        // transaction there is nowhere else left to read it from. The audit
        // screen falls back to this name for exactly that reason — see the
        // label resolution in routes/audit.ts.
        recordAudit(tx, {
          actorId: actor.id,
          entityType: "customer",
          entityId: existing.id,
          action: "delete",
          reason: parsed.data.reason,
          before: {
            fullName: existing.fullName,
            identification: existing.identification,
            phone: existing.phone,
            email: existing.email,
            address: existing.address,
            customerSince: existing.customerSince,
            notes: existing.notes,
          },
        });
      });

      return reply.send({ ok: true, deleted: { id: existing.id, fullName: existing.fullName } });
    },
  );
};
