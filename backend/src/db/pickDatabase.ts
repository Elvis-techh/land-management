import type { FastifyRequest } from "fastify";

import type { Db } from "./client.js";

/**
 * Chooses the database a request reads and writes.
 *
 * Lindero is moving to one database file per company (docs/later-versions.md,
 * section 1). Every route already works on `request.db`, set from this, so the
 * step that adds companies only has to change how the choice is made: from the
 * signed-in account instead of always the same file.
 */
export type PickDatabase = (request: FastifyRequest) => Db;

/** Today's Lindero: one company, so every request gets the same database. */
export function singleCompany(db: Db): PickDatabase {
  return () => db;
}
