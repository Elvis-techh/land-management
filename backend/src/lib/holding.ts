import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { contracts } from "../db/schema.js";

/**
 * SQL predicate: this contract is holding its lot right now.
 *
 * `status = 'active'` is not the whole answer. A reservation past its
 * `expiresOn` has lapsed — the lot it was holding is available again, exactly
 * as the Panel General implies when it counts down reservations "por vencer".
 * That release is derived here on every read rather than written by a job, the
 * same way payment health and lot availability already are. A signed contract
 * never expires this way.
 *
 * Returns a `SQL` fragment usable directly in `.where(...)`, composed with
 * `and(...)`, or interpolated into a larger `sql` template — so every place
 * that asks "is this lot taken" asks it the same way.
 *
 * `asOf` is a YYYY-MM-DD calendar date and `expires_on` is stored the same way,
 * so `<` compares them correctly.
 */
export function activeHold(asOf: string): SQL {
  return sql`(
    ${contracts.status} = 'active'
    AND NOT (
      ${contracts.kind} = 'reservation'
      AND ${contracts.expiresOn} IS NOT NULL
      AND ${contracts.expiresOn} < ${asOf}
    )
  )`;
}
