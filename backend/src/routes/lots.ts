import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { contracts, customers, lots, payments, projects } from "../db/schema.js";
import { recordAudit } from "../lib/audit.js";
import { can } from "../lib/permissions.js";

/**
 * The lots list, shaped exactly as the table needs it.
 *
 * Two values here are DERIVED, never stored:
 *
 * - `holding` comes from the lot's active contract. The frontend turns it into
 *   Disponible / Reservado / Vendido, so a lot cannot claim to be available
 *   while a contract exists against it.
 * - `paidToDate` is the sum of the contract's non-reversed payments. Nobody
 *   types a balance in Lindero.
 */
const lotsListQuery = (db: import("../db/client.js").Db) =>
  db
    .select({
      id: lots.id,
      code: lots.code,
      projectName: projects.name,
      areaM2: lots.areaM2,
      basePriceCents: lots.basePriceCents,
      archivedAt: lots.archivedAt,
      contractId: contracts.id,
      contractCode: contracts.code,
      contractKind: contracts.kind,
      salePriceCents: contracts.salePriceCents,
      customerId: customers.id,
      customerName: customers.fullName,
      paidToDateCents: sql<number>`
        COALESCE((
          SELECT SUM(${payments.amountCents})
          FROM ${payments}
          WHERE ${payments.contractId} = ${contracts.id}
            AND ${payments.reversedAt} IS NULL
        ), 0)
      `,
    })
    .from(lots)
    .innerJoin(projects, eq(projects.id, lots.projectId))
    // A lot has at most one contract that is holding it. Cancelled and
    // defaulted contracts release the lot, so they are excluded here.
    .leftJoin(
      contracts,
      and(eq(contracts.lotId, lots.id), eq(contracts.status, "active")),
    )
    .leftJoin(customers, eq(customers.id, contracts.customerId));

/**
 * The clash a lot code would cause inside a project, worded for the person at
 * the screen — or `null` when the number is free.
 *
 * The unique index on (project_id, code) is what actually guarantees
 * uniqueness. This lookup exists so a refusal reads as a sentence naming the
 * lot that already holds the number, instead of surfacing SQLite's
 * "UNIQUE constraint failed: lots.project_id, lots.code", which tells the user
 * nothing they can act on.
 *
 * `ignoreLotId` is the lot being edited: a lot keeping its own number is not a
 * duplicate of itself.
 */
function lotCodeClash(
  db: import("../db/client.js").Db,
  project: { id: string; name: string },
  code: string,
  ignoreLotId?: string,
): string | null {
  const clash = db
    .select({ id: lots.id, archivedAt: lots.archivedAt })
    .from(lots)
    .where(and(eq(lots.projectId, project.id), eq(lots.code, code)))
    .get();

  if (!clash || clash.id === ignoreLotId) {
    return null;
  }

  // An archived clash is the confusing one: the number looks free because the
  // lot holding it is hidden from every screen, so the message has to say so.
  return clash.archivedAt === null
    ? `El lote ${code} ya existe en ${project.name}. Usa otro número.`
    : `El lote ${code} ya existe en ${project.name}, pero está archivado. ` +
        "Usa otro número o restaura ese lote.";
}

const updateLotBody = z.object({
  code: z.string().trim().min(1).max(40),
  projectName: z.string().trim().min(1).max(160),
  areaM2: z.number().positive().finite(),
  /** Whole centavos. The client converts from lempiras before sending. */
  basePriceCents: z.number().int().nonnegative(),
  /**
   * Required only when the price changes on a lot that is under contract.
   * Everyday corrections do not ask for one — being asked to justify every
   * edit trains people to type "x" and defeats the point.
   */
  reason: z.string().trim().min(10).max(500).optional(),
});

/**
 * A brand-new lot.
 *
 * Deliberately shorter than `updateLotBody`: a lot is born available, so there
 * is no client, no status and no reason to justify — those only ever arrive
 * through a contract.
 */
const createLotBody = z.object({
  code: z.string().trim().min(1).max(40),
  projectName: z.string().trim().min(1).max(160),
  areaM2: z.number().positive().finite(),
  /** Whole centavos. The client converts from lempiras before sending. */
  basePriceCents: z.number().int().nonnegative(),
});

const archiveLotBody = z.object({
  reason: z.string().trim().min(10).max(500),
});

export const lotRoutes: FastifyPluginAsync = async (app) => {
  app.get("/lots", { onRequest: app.requireUser }, async (request, reply) => {
    const rows = lotsListQuery(app.db).where(isNull(lots.archivedAt)).all();

    return reply.send({
      lots: rows.map((row) => ({
        id: row.id,
        code: row.code,
        projectName: row.projectName,
        areaM2: row.areaM2,
        basePrice: row.basePriceCents,
        archivedAt: row.archivedAt,
        holding:
          row.contractId && row.customerId
            ? {
                contractId: row.contractId,
                contractCode: row.contractCode,
                customerId: row.customerId,
                kind: row.contractKind,
                salePrice: row.salePriceCents,
                paidToDate: row.paidToDateCents,
              }
            : null,
      })),
      // Sent alongside so the table can render customer names without a second
      // request per row.
      customers: app.db
        .select({
          id: customers.id,
          fullName: customers.fullName,
          identification: customers.identification,
          phone: customers.phone,
          email: customers.email,
          address: customers.address,
          customerSince: customers.customerSince,
          notes: customers.notes,
        })
        .from(customers)
        .all(),
      // The projects a lot may be filed under: every ACTIVE one, including
      // those with no lots yet, since a new project starts empty. Archived
      // projects are left out — nothing new should be added to them.
      projects: app.db
        .select({ id: projects.id, name: projects.name, areaUnit: projects.areaUnit })
        .from(projects)
        .where(isNull(projects.archivedAt))
        .orderBy(projects.name)
        .all(),
    });
  });

  app.post("/lots", { onRequest: app.requireCapability("lot:create") }, async (request, reply) => {
    const parsed = createLotBody.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_body",
        message: "Revisa los datos del lote.",
        issues: parsed.error.issues.map((issue) => issue.message),
      });
    }

    const actor = request.user!;

    const project = app.db
      .select()
      .from(projects)
      .where(eq(projects.name, parsed.data.projectName))
      .get();

    if (!project || project.archivedAt !== null) {
      return reply.code(400).send({
        error: "unknown_project",
        message: "Ese proyecto no existe o está archivado.",
      });
    }

    const clash = lotCodeClash(app.db, project, parsed.data.code);

    if (clash) {
      return reply.code(409).send({ error: "duplicate_code", message: clash });
    }

    const now = new Date().toISOString();

    const created = app.db.transaction((tx) => {
      const next = tx
        .insert(lots)
        .values({
          id: randomUUID(),
          projectId: project.id,
          code: parsed.data.code,
          areaM2: parsed.data.areaM2,
          basePriceCents: parsed.data.basePriceCents,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      recordAudit(tx, {
        actorId: actor.id,
        entityType: "lot",
        entityId: next.id,
        action: "create",
        // Nothing existed before, so `before` stays absent rather than being a
        // row of nulls pretending to be a previous state.
        after: {
          code: next.code,
          projectId: next.projectId,
          areaM2: next.areaM2,
          basePriceCents: next.basePriceCents,
        },
      });

      return next;
    });

    return reply.code(201).send({ lot: { id: created.id, code: created.code } });
  });

  app.patch<{ Params: { id: string } }>(
    "/lots/:id",
    { onRequest: app.requireCapability("lot:edit") },
    async (request, reply) => {
      const parsed = updateLotBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Revisa los datos del lote.",
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const actor = request.user!;
      const existing = app.db.select().from(lots).where(eq(lots.id, request.params.id)).get();

      if (!existing || existing.archivedAt !== null) {
        return reply.code(404).send({ error: "not_found", message: "Lote no encontrado." });
      }

      const project = app.db
        .select()
        .from(projects)
        .where(eq(projects.name, parsed.data.projectName))
        .get();

      if (!project || project.archivedAt !== null) {
        return reply.code(400).send({
          error: "unknown_project",
          message: "Ese proyecto no existe o está archivado.",
        });
      }

      // Renaming a lot on to a number that is taken is the same mistake as
      // creating one there, and it has to be refused the same way. Without
      // this the write reached SQLite and the unique index answered in its own
      // words, which arrived in the dialog as raw constraint text.
      const clash = lotCodeClash(app.db, project, parsed.data.code, existing.id);

      if (clash) {
        return reply.code(409).send({ error: "duplicate_code", message: clash });
      }

      // A lot under contract can still be repriced — prices really do get
      // renegotiated, especially early on. But this is the one lot edit that
      // touches money, so it demands the `price:change` capability and a
      // written reason, and it is recorded as its own audit action.
      const activeContract = app.db
        .select({ id: contracts.id, code: contracts.code })
        .from(contracts)
        .where(and(eq(contracts.lotId, existing.id), eq(contracts.status, "active")))
        .get();

      const isRepricing = parsed.data.basePriceCents !== existing.basePriceCents;
      const needsJustification = isRepricing && activeContract !== undefined;

      if (needsJustification && !can(actor.role, "price:change")) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Tu usuario no puede cambiar el precio de un lote con contrato.",
        });
      }

      if (needsJustification && !parsed.data.reason) {
        return reply.code(400).send({
          error: "reason_required",
          message:
            `El lote tiene el contrato ${activeContract.code} vigente. ` +
            "Explica el motivo del cambio de precio (mínimo 10 caracteres).",
        });
      }

      const basePriceCents = parsed.data.basePriceCents;

      // The write and its audit row commit together or not at all.
      const updated = app.db.transaction((tx) => {
        const next = tx
          .update(lots)
          .set({
            code: parsed.data.code,
            projectId: project.id,
            areaM2: parsed.data.areaM2,
            basePriceCents,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(lots.id, existing.id))
          .returning()
          .get();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "lot",
          entityId: existing.id,
          // A reprice is filed under its own action so it can be found without
          // reading through every routine edit.
          action: isRepricing ? "reprice" : "update",
          reason: parsed.data.reason ?? null,
          before: {
            code: existing.code,
            projectId: existing.projectId,
            areaM2: existing.areaM2,
            basePriceCents: existing.basePriceCents,
          },
          after: {
            code: next.code,
            projectId: next.projectId,
            areaM2: next.areaM2,
            basePriceCents: next.basePriceCents,
          },
        });

        return next;
      });

      return reply.send({ lot: { id: updated.id, code: updated.code } });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/lots/:id/archive",
    { onRequest: app.requireCapability("lot:archive") },
    async (request, reply) => {
      const parsed = archiveLotBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Explica el motivo con al menos 10 caracteres.",
        });
      }

      const actor = request.user!;
      const existing = app.db.select().from(lots).where(eq(lots.id, request.params.id)).get();

      if (!existing || existing.archivedAt !== null) {
        return reply.code(404).send({ error: "not_found", message: "Lote no encontrado." });
      }

      // Archiving a lot that is under contract would orphan the contract.
      const activeContract = app.db
        .select({ code: contracts.code })
        .from(contracts)
        .where(and(eq(contracts.lotId, existing.id), eq(contracts.status, "active")))
        .get();

      if (activeContract) {
        return reply.code(409).send({
          error: "lot_has_contract",
          message: `No se puede archivar: el lote tiene el contrato ${activeContract.code} vigente.`,
        });
      }

      const archivedAt = new Date().toISOString();

      app.db.transaction((tx) => {
        tx.update(lots)
          .set({ archivedAt, archiveReason: parsed.data.reason, updatedAt: archivedAt })
          .where(eq(lots.id, existing.id))
          .run();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "lot",
          entityId: existing.id,
          action: "archive",
          reason: parsed.data.reason,
          before: { archivedAt: null },
          after: { archivedAt },
        });
      });

      return reply.send({ ok: true, archivedAt });
    },
  );
};
