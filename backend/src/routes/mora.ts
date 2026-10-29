import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { Db } from "../db/client.js";
import { contracts, moraContractRules, moraForgiveness, moraManualCharges, users } from "../db/schema.js";
import { recordAudit } from "../lib/audit.js";
import { syncContractLifecycle } from "../lib/contractLifecycle.js";
import type { ContractTerms, SaleType } from "../lib/contracts.js";
import { buildSchedule, shiftDays } from "../lib/contracts.js";
import type { ContractMoraRule } from "../lib/mora.js";
import { contractRuleOf, loadMoraAccount } from "../lib/moraAccounts.js";
import { amountProblem, ownMoraSchema, readSettings } from "../lib/settings.js";
import { businessToday } from "../lib/time.js";

interface MoraRouteOptions {
  timeZone: string;
}

/**
 * «Cargar mora»: mora put on one contract by hand. See `moraManualCharges` in
 * src/db/schema.ts for what it is for, and lib/mora.ts for how it counts.
 *
 * Also a contract's own rule («Regla de mora»): see `moraContractRules`, and
 * «Perdonar», mora forgiven: see `moraForgiveness`.
 *
 * Every write is on `mora:charge` (supervisors by default, changeable in
 * Permisos), take a written reason and are filed in the Historial. The money
 * received never changes: only how the payments on that contract divide
 * between mora and cuotas.
 */

const chargeBody = z.object({
  /** 0 for the prima, otherwise the cuota's number. */
  installment: z.number().int().min(0),
  incurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa una fecha AAAA-MM-DD."),
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(10).max(500),
});

const forgiveBody = z.object({
  /** 0 for the prima, otherwise the cuota's number. */
  installment: z.number().int().min(0),
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(10).max(500),
});

const removeBody = z.object({
  reason: z.string().trim().min(10).max(500),
});

/**
 * A contract's own rule: back to «General», «Sin mora», or «Regla propia»
 * with its numbers. Always with a reason, like every other mora decision.
 */
const ruleBody = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("general"), reason: z.string().trim().min(10).max(500) }),
  z.object({ mode: z.literal("none"), reason: z.string().trim().min(10).max(500) }),
  z.object({ mode: z.literal("own"), rules: ownMoraSchema, reason: z.string().trim().min(10).max(500) }),
]);

/** Statuses that can still be charged: an open contract, or one paid off that a charge may reopen. */
const CHARGEABLE = new Set(["active", "paid_off"]);

type ContractRow = typeof contracts.$inferSelect;

function termsOf(row: ContractRow): ContractTerms {
  return {
    saleType: row.saleType as SaleType,
    salePriceCents: row.salePriceCents,
    downPaymentCents: row.downPaymentCents,
    termMonths: row.termMonths,
    monthlyPaymentCents: row.monthlyPaymentCents,
    dueDay: row.dueDay,
    signedOn: row.signedOn ?? row.createdAt.slice(0, 10),
    firstDueOn: row.firstDueOn,
  };
}

/** The prima (when there is one) and the cuotas, with the day each falls due. */
function itemsOf(row: ContractRow): Array<{ installment: number; dueOn: string }> {
  const terms = termsOf(row);
  const items = terms.downPaymentCents > 0 ? [{ installment: 0, dueOn: terms.signedOn }] : [];

  return [
    ...items,
    ...buildSchedule(terms).map((entry) => ({ installment: entry.number, dueOn: entry.dueOn })),
  ];
}

/** Why this contract can take no mora at all, or null when it can. */
function contractProblem(row: ContractRow): string | null {
  if (row.kind !== "contract" || row.saleType !== "financed") {
    return "Solo un contrato firmado a crédito lleva mora.";
  }

  if (!CHARGEABLE.has(row.status)) {
    return "Este contrato está cerrado; ya no se le carga mora.";
  }

  return null;
}

function snapshot(entry: { installment: number; incurredOn: string; amountCents: number }) {
  return {
    moraInstallment: entry.installment,
    moraIncurredOn: entry.incurredOn,
    amountCents: entry.amountCents,
  };
}

function forgivenSnapshot(entry: { installment: number; forgivenOn: string; amountCents: number }) {
  return {
    moraInstallment: entry.installment,
    moraForgivenOn: entry.forgivenOn,
    amountCents: entry.amountCents,
  };
}

/** Two rules that charge the same, whatever order their keys came in. */
function sameRule(a: ContractMoraRule, b: ContractMoraRule): boolean {
  if (a.mode !== b.mode) {
    return false;
  }

  if (a.mode !== "own" || b.mode !== "own") {
    return true;
  }

  const keys = Object.keys(ownMoraSchema.shape) as Array<keyof typeof a.rules>;
  return keys.every((key) => a.rules[key] === b.rules[key]);
}

/** A rule as the Historial lists it: one field per setting, so it shows what changed. */
function flatRule(rule: ContractMoraRule) {
  return rule.mode === "own" ? { moraRule: rule.mode, ...rule.rules } : { moraRule: rule.mode };
}

/** One contract's rule versions, oldest first, with who set each and why. */
function readRuleVersions(db: Pick<Db, "select">, contractId: string) {
  return db
    .select({
      id: moraContractRules.id,
      effectiveFrom: moraContractRules.effectiveFrom,
      mode: moraContractRules.mode,
      value: moraContractRules.value,
      reason: moraContractRules.reason,
      recordedAt: moraContractRules.recordedAt,
      recordedBy: users.name,
    })
    .from(moraContractRules)
    .innerJoin(users, eq(users.id, moraContractRules.recordedBy))
    .where(eq(moraContractRules.contractId, contractId))
    .orderBy(asc(moraContractRules.effectiveFrom))
    .all()
    .map(({ mode, value, ...version }) => ({ ...version, rule: contractRuleOf(mode, value) }));
}

/** The rule in force on `date`, from versions oldest first. */
function ruleOn(versions: ReadonlyArray<{ effectiveFrom: string; rule: ContractMoraRule }>, date: string) {
  let found: ContractMoraRule = { mode: "general" };

  for (const version of versions) {
    if (version.effectiveFrom > date) {
      break;
    }

    found = version.rule;
  }

  return found;
}

function readContract(db: Pick<Db, "select">, id: string): ContractRow | undefined {
  return db.select().from(contracts).where(eq(contracts.id, id)).get();
}

export const moraRoutes: FastifyPluginAsync<MoraRouteOptions> = async (app, options) => {
  const today = () => businessToday(options.timeZone);
  const at = () => ({ asOf: today(), timeZone: options.timeZone });

  /**
   * One contract's mora, for its panel: the mora put on by hand (with what is
   * still unpaid of each), the automatic mora on each cuota (so the form can
   * warn before the same cuota is charged twice), and the cuotas already due,
   * which are the ones «Cargar mora» offers.
   */
  app.get<{ Params: { id: string } }>(
    "/contracts/:id/mora",
    { onRequest: app.requireUser },
    async (request, reply) => {
      const row = readContract(app.db, request.params.id);

      if (!row) {
        return reply.code(404).send({ error: "not_found", message: "Ese contrato no existe." });
      }

      const account = loadMoraAccount(app.db, row.id, at());
      const automaticByInstallment: Record<number, number> = {};

      for (const charge of account?.charges ?? []) {
        if (charge.manualId === undefined) {
          automaticByInstallment[charge.installment] =
            (automaticByInstallment[charge.installment] ?? 0) + charge.amountCents;
        }
      }

      const manual = app.db
        .select({
          id: moraManualCharges.id,
          installment: moraManualCharges.installment,
          incurredOn: moraManualCharges.incurredOn,
          amountCents: moraManualCharges.amountCents,
          reason: moraManualCharges.reason,
          recordedAt: moraManualCharges.recordedAt,
          recordedBy: users.name,
        })
        .from(moraManualCharges)
        .innerJoin(users, eq(users.id, moraManualCharges.recordedBy))
        .where(and(eq(moraManualCharges.contractId, row.id), isNull(moraManualCharges.removedAt)))
        .orderBy(asc(moraManualCharges.incurredOn), asc(moraManualCharges.recordedAt))
        .all()
        .map((entry) => ({
          ...entry,
          pendingCents: account?.pendingByCharge[`mora:manual:${entry.id}`] ?? 0,
        }));

      const clearedById = new Map((account?.forgiven ?? []).map((entry) => [entry.forgivenessId, entry.amountCents]));
      const forgiven = app.db
        .select({
          id: moraForgiveness.id,
          installment: moraForgiveness.installment,
          forgivenOn: moraForgiveness.forgivenOn,
          amountCents: moraForgiveness.amountCents,
          reason: moraForgiveness.reason,
          recordedAt: moraForgiveness.recordedAt,
          recordedBy: users.name,
        })
        .from(moraForgiveness)
        .innerJoin(users, eq(users.id, moraForgiveness.recordedBy))
        .where(and(eq(moraForgiveness.contractId, row.id), isNull(moraForgiveness.removedAt)))
        .orderBy(asc(moraForgiveness.forgivenOn), asc(moraForgiveness.recordedAt))
        .all()
        .map((entry) => ({
          ...entry,
          // Less than typed only when a payment entered later, with an earlier
          // date, left less unpaid on that cuota by then.
          clearedCents: clearedById.get(entry.id) ?? 0,
        }));

      const asOf = today();

      return {
        chargeable: contractProblem(row) === null,
        manual,
        forgiven,
        // What «Perdonar» can clear on each cuota today.
        pendingByInstallment: account?.pendingByInstallment ?? {},
        automaticByInstallment,
        due: itemsOf(row).filter((item) => item.dueOn < asOf),
        // Its own rule, every version (the last one may start tomorrow), and
        // the general rule it is laid over, so the panel can say both.
        rules: readRuleVersions(app.db, row.id),
        general: readSettings(app.db).mora,
      };
    },
  );

  /**
   * Give one contract its own rule, or put it back on the general one. In
   * force from tomorrow, like a change in Configuración: today's mora was
   * charged this morning and stays. A second change on the same day replaces
   * the first, which never got to decide anything.
   */
  app.post<{ Params: { id: string } }>(
    "/contracts/:id/mora/rule",
    { onRequest: app.requireCapability("mora:charge") },
    async (request, reply) => {
      const parsed = ruleBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Elige la regla y escribe un motivo de al menos 10 caracteres.",
        });
      }

      const body = parsed.data;
      const row = readContract(app.db, request.params.id);

      if (!row) {
        return reply.code(404).send({ error: "not_found", message: "Ese contrato no existe." });
      }

      const problem = contractProblem(row);

      if (problem) {
        return reply.code(409).send({ error: "not_chargeable", message: problem });
      }

      const rule: ContractMoraRule = body.mode === "own" ? { mode: "own", rules: body.rules } : { mode: body.mode };

      if (rule.mode === "own") {
        const amount = amountProblem(rule.rules);

        if (amount) {
          return reply.code(400).send({ error: "invalid_rule", message: amount });
        }
      }

      const today = businessToday(options.timeZone);
      const tomorrow = shiftDays(today, 1);
      const versions = readRuleVersions(app.db, row.id);
      const before = ruleOn(versions, tomorrow);

      if (sameRule(before, rule)) {
        return reply.code(400).send({ error: "unchanged", message: "Este contrato ya tiene esa regla." });
      }

      const actor = request.user!;

      app.db.transaction((tx) => {
        if (sameRule(ruleOn(versions, today), rule)) {
          // Back to what is in force today: tomorrow's change is simply undone.
          tx.delete(moraContractRules)
            .where(and(eq(moraContractRules.contractId, row.id), eq(moraContractRules.effectiveFrom, tomorrow)))
            .run();
        } else {
          const value = rule.mode === "own" ? JSON.stringify(rule.rules) : null;
          const recordedAt = new Date().toISOString();

          tx.insert(moraContractRules)
            .values({
              id: randomUUID(),
              contractId: row.id,
              effectiveFrom: tomorrow,
              mode: rule.mode,
              value,
              reason: body.reason,
              recordedBy: actor.id,
              recordedAt,
            })
            .onConflictDoUpdate({
              target: [moraContractRules.contractId, moraContractRules.effectiveFrom],
              set: { mode: rule.mode, value, reason: body.reason, recordedBy: actor.id, recordedAt },
            })
            .run();
        }

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: row.id,
          action: "mora_rule",
          reason: body.reason,
          before: flatRule(before),
          after: { ...flatRule(rule), moraRuleFrom: tomorrow },
        });
      });

      return reply.code(201).send({ effectiveFrom: tomorrow });
    },
  );

  /** Put mora on one cuota of one contract. */
  app.post<{ Params: { id: string } }>(
    "/contracts/:id/mora",
    { onRequest: app.requireCapability("mora:charge") },
    async (request, reply) => {
      const parsed = chargeBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Elige la cuota, la fecha y un monto, y escribe un motivo de al menos 10 caracteres.",
        });
      }

      const body = parsed.data;
      const row = readContract(app.db, request.params.id);

      if (!row) {
        return reply.code(404).send({ error: "not_found", message: "Ese contrato no existe." });
      }

      const problem = contractProblem(row);

      if (problem) {
        return reply.code(409).send({ error: "not_chargeable", message: problem });
      }

      const item = itemsOf(row).find((entry) => entry.installment === body.installment);

      if (!item) {
        return reply.code(400).send({
          error: "invalid_installment",
          message: "Ese contrato no tiene esa cuota.",
        });
      }

      // Mora is for being late, so it can only start after the cuota fell due.
      if (body.incurredOn <= item.dueOn) {
        return reply.code(400).send({
          error: "too_early",
          message: `La fecha tiene que ser después del ${item.dueOn}, cuando venció esa cuota.`,
        });
      }

      if (body.incurredOn > today()) {
        return reply.code(400).send({
          error: "in_the_future",
          message: "La fecha no puede ser futura.",
        });
      }

      const actor = request.user!;
      const id = randomUUID();

      app.db.transaction((tx) => {
        tx.insert(moraManualCharges)
          .values({
            id,
            contractId: row.id,
            installment: body.installment,
            incurredOn: body.incurredOn,
            amountCents: body.amountCents,
            reason: body.reason,
            recordedBy: actor.id,
            recordedAt: new Date().toISOString(),
          })
          .run();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: row.id,
          action: "mora_charge",
          reason: body.reason,
          after: snapshot(body),
        });

        // A mora covered by a payment already made takes that money off the
        // price, which can reopen a contract that was paid off.
        syncContractLifecycle(tx, row.id, at());
      });

      return reply.code(201).send({ id });
    },
  );

  /**
   * «Perdonar»: forgive all or part of the mora charged on one cuota and not
   * paid. From now on, never backwards: the payments already entered keep
   * their receipts. Only what has been charged; a cuota still late is charged
   * again when its rule says so (that is what «Sin mora» is for).
   */
  app.post<{ Params: { id: string } }>(
    "/contracts/:id/mora/forgive",
    { onRequest: app.requireCapability("mora:charge") },
    async (request, reply) => {
      const parsed = forgiveBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Elige la cuota y un monto, y escribe un motivo de al menos 10 caracteres.",
        });
      }

      const body = parsed.data;
      const row = readContract(app.db, request.params.id);

      if (!row) {
        return reply.code(404).send({ error: "not_found", message: "Ese contrato no existe." });
      }

      const problem = contractProblem(row);

      if (problem) {
        return reply.code(409).send({ error: "not_chargeable", message: problem });
      }

      const unpaid = loadMoraAccount(app.db, row.id, at())?.pendingByInstallment[body.installment] ?? 0;

      if (unpaid === 0) {
        return reply.code(400).send({
          error: "nothing_to_forgive",
          message: "Esa cuota no tiene mora sin pagar. La mora ya pagada se devuelve con «Anular recibo».",
        });
      }

      if (body.amountCents > unpaid) {
        return reply.code(400).send({
          error: "too_much",
          message: `De esa cuota solo faltan L. ${(unpaid / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} de mora por pagar; no se puede perdonar más.`,
        });
      }

      const actor = request.user!;
      const id = randomUUID();
      const forgivenOn = today();

      app.db.transaction((tx) => {
        tx.insert(moraForgiveness)
          .values({
            id,
            contractId: row.id,
            installment: body.installment,
            forgivenOn,
            amountCents: body.amountCents,
            reason: body.reason,
            recordedBy: actor.id,
            // An instant, not SQLite's default: it places this among the
            // payments of the day.
            recordedAt: new Date().toISOString(),
          })
          .run();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: row.id,
          action: "mora_forgive",
          reason: body.reason,
          after: forgivenSnapshot({ ...body, forgivenOn }),
        });

        // Forgiving the last of what was owed can settle the contract.
        syncContractLifecycle(tx, row.id, at());
      });

      return reply.code(201).send({ id });
    },
  );

  /** Take back a «Perdonar» entered by mistake. Its row stays, marked removed. */
  app.post<{ Params: { id: string; forgivenessId: string } }>(
    "/contracts/:id/mora/forgiven/:forgivenessId/remove",
    { onRequest: app.requireCapability("mora:charge") },
    async (request, reply) => {
      const parsed = removeBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Escribe un motivo de al menos 10 caracteres.",
        });
      }

      const existing = app.db
        .select()
        .from(moraForgiveness)
        .where(
          and(
            eq(moraForgiveness.id, request.params.forgivenessId),
            eq(moraForgiveness.contractId, request.params.id),
          ),
        )
        .get();

      if (!existing || existing.removedAt !== null) {
        return reply.code(404).send({ error: "not_found", message: "Ese perdón no existe o ya se quitó." });
      }

      const actor = request.user!;

      app.db.transaction((tx) => {
        tx.update(moraForgiveness)
          .set({
            removedAt: new Date().toISOString(),
            removedBy: actor.id,
            removalReason: parsed.data.reason,
          })
          .where(eq(moraForgiveness.id, existing.id))
          .run();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: existing.contractId,
          action: "mora_unforgive",
          reason: parsed.data.reason,
          before: forgivenSnapshot(existing),
        });

        // The mora is owed again, which can reopen a contract that was paid off.
        syncContractLifecycle(tx, existing.contractId, at());
      });

      return reply.send({ ok: true });
    },
  );

  /** Take back a mora put on by mistake. Its row stays, marked removed. */
  app.post<{ Params: { id: string; chargeId: string } }>(
    "/contracts/:id/mora/:chargeId/remove",
    { onRequest: app.requireCapability("mora:charge") },
    async (request, reply) => {
      const parsed = removeBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Escribe un motivo de al menos 10 caracteres.",
        });
      }

      const existing = app.db
        .select()
        .from(moraManualCharges)
        .where(
          and(
            eq(moraManualCharges.id, request.params.chargeId),
            eq(moraManualCharges.contractId, request.params.id),
          ),
        )
        .get();

      if (!existing || existing.removedAt !== null) {
        return reply.code(404).send({ error: "not_found", message: "Esa mora no existe o ya se quitó." });
      }

      const actor = request.user!;

      app.db.transaction((tx) => {
        tx.update(moraManualCharges)
          .set({
            removedAt: new Date().toISOString(),
            removedBy: actor.id,
            removalReason: parsed.data.reason,
          })
          .where(eq(moraManualCharges.id, existing.id))
          .run();

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "contract",
          entityId: existing.contractId,
          action: "mora_remove",
          reason: parsed.data.reason,
          before: snapshot(existing),
        });

        // Paid mora goes back to the cuotas, which can settle the contract.
        syncContractLifecycle(tx, existing.contractId, at());
      });

      return reply.send({ ok: true });
    },
  );
};
