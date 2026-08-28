import { desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { auditEvents, lots, users } from "../db/schema.js";

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /** Optional filter, e.g. only lot changes. */
  entityType: z.enum(["lot", "customer", "contract", "payment", "user"]).optional(),
});

/**
 * The change history.
 *
 * Read-only by design: there is no endpoint to edit or delete an audit row.
 * A history someone can rewrite is not a history.
 */
export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get("/audit", { onRequest: app.requireCapability("audit:view") }, async (request, reply) => {
    const parsed = auditQuery.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", message: "Parámetros inválidos." });
    }

    const { limit, offset, entityType } = parsed.data;

    // Resolve a human-readable label for whatever the row points at, so the
    // screen shows "A-07" rather than a UUID.
    const actor = users;
    const baseQuery = app.db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        reason: auditEvents.reason,
        beforeJson: auditEvents.beforeJson,
        afterJson: auditEvents.afterJson,
        createdAt: auditEvents.createdAt,
        actorName: actor.name,
        actorRole: actor.role,
        lotCode: lots.code,
      })
      .from(auditEvents)
      .innerJoin(actor, eq(actor.id, auditEvents.actorId))
      .leftJoin(lots, eq(lots.id, auditEvents.entityId));

    const rows = (entityType
      ? baseQuery.where(eq(auditEvents.entityType, entityType))
      : baseQuery
    )
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(limit)
      .offset(offset)
      .all();

    const total = app.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(auditEvents)
      .get();

    return reply.send({
      events: rows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        entityLabel: row.lotCode ?? null,
        actorName: row.actorName,
        actorRole: row.actorRole,
        reason: row.reason,
        before: row.beforeJson ? (JSON.parse(row.beforeJson) as Record<string, unknown>) : null,
        after: row.afterJson ? (JSON.parse(row.afterJson) as Record<string, unknown>) : null,
        createdAt: row.createdAt,
      })),
      total: total?.count ?? 0,
      limit,
      offset,
    });
  });
};
