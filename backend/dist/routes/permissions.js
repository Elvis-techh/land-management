import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { roleCapabilities, userCapabilities, users } from "../db/schema.js";
import { recordAudit } from "../lib/audit.js";
import { ownCapabilities, resolveCapabilities } from "../lib/capabilities.js";
import { EDITABLE_CAPABILITIES, LOCKED_CAPABILITIES, isCapability, } from "../lib/permissions.js";
/**
 * Only the associate role is configurable.
 *
 * The owner's capabilities are fixed in code. A supervisor who could revoke
 * their own `permission:manage` would lock the business out of the only account
 * that can grant it back, and no confirmation dialog makes that a good idea.
 */
const EDITABLE_ROLE = "staff";
const updateBody = z.object({
    /** The complete set of granted capabilities — not a delta. */
    capabilities: z.array(z.string()).max(64),
});
/**
 * One associate's permissions: back to the general list, or a complete list of
 * their own. Never a delta, for the same reason as the role's list.
 */
const userUpdateBody = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("general") }),
    z.object({ mode: z.literal("own"), capabilities: z.array(z.string()).max(64) }),
]);
/**
 * Refuses a requested list that names something unknown or locked, and says
 * so. Returns `true` once the reply has been sent.
 */
function refuseInvalid(requested, reply) {
    const unknown = requested.filter((capability) => !isCapability(capability));
    if (unknown.length > 0) {
        void reply.code(400).send({
            error: "unknown_capability",
            message: `Permiso desconocido: ${unknown.join(", ")}.`,
        });
        return true;
    }
    // Refused loudly rather than filtered out silently. A request to grant
    // account control is either a bug or an attempt, and both deserve an
    // answer that says so.
    const locked = requested.filter((capability) => isCapability(capability) && LOCKED_CAPABILITIES.has(capability));
    if (locked.length > 0) {
        void reply.code(400).send({
            error: "locked_capability",
            message: "Gestionar usuarios, editar permisos, declarar un contrato incumplido y cambiar " +
                "la mora son exclusivos del supervisor y no se pueden ceder.",
        });
        return true;
    }
    return false;
}
export const permissionRoutes = async (app) => {
    /**
     * The associate an id names, or a refusal already sent.
     *
     * Only an active associate can have permissions of their own: a supervisor
     * can do everything whatever a list says, and a deactivated account cannot
     * sign in at all, so a list for either would be a setting that does nothing.
     */
    const findAssociate = (id, reply) => {
        const target = app.db
            .select({ id: users.id, name: users.name, role: users.role, deactivatedAt: users.deactivatedAt })
            .from(users)
            .where(eq(users.id, id))
            .get();
        if (!target) {
            void reply.code(404).send({ error: "not_found", message: "Cuenta no encontrada." });
            return null;
        }
        if (target.role !== EDITABLE_ROLE) {
            void reply.code(400).send({
                error: "not_an_associate",
                message: "Un supervisor puede hacerlo todo: los permisos propios son solo para asociados.",
            });
            return null;
        }
        if (target.deactivatedAt !== null) {
            void reply.code(400).send({
                error: "deactivated",
                message: "Esta cuenta está desactivada. Reactívala en Usuarios antes de darle permisos.",
            });
            return null;
        }
        return { id: target.id, name: target.name };
    };
    app.get("/permissions", { onRequest: app.requireCapability("permission:manage") }, async (request, reply) => {
        const granted = resolveCapabilities(app.db, EDITABLE_ROLE);
        const associates = app.db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(and(eq(users.role, EDITABLE_ROLE), isNull(users.deactivatedAt)))
            .orderBy(asc(users.name))
            .all();
        const withOwn = new Set(app.db
            .selectDistinct({ userId: userCapabilities.userId })
            .from(userCapabilities)
            .all()
            .map((row) => row.userId));
        return reply.send({
            role: EDITABLE_ROLE,
            capabilities: EDITABLE_CAPABILITIES.map((capability) => ({
                capability,
                enabled: granted.has(capability),
            })),
            // Sent so the screen can show what is deliberately not on offer,
            // rather than leaving the supervisor wondering where it went.
            locked: [...LOCKED_CAPABILITIES],
            // Who the general list governs, and who has a list of their own
            // instead: the screen names the exceptions, so a change here is not
            // mistaken for one that reaches everybody.
            associates: associates.map((associate) => ({
                ...associate,
                ownPermissions: withOwn.has(associate.id),
            })),
        });
    });
    app.put("/permissions", { onRequest: app.requireCapability("permission:manage") }, async (request, reply) => {
        const parsed = updateBody.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "invalid_body",
                message: "No se pudo leer la lista de permisos.",
            });
        }
        const requested = parsed.data.capabilities;
        if (refuseInvalid(requested, reply)) {
            return reply;
        }
        const actor = request.user;
        const before = [...resolveCapabilities(app.db, EDITABLE_ROLE)].sort();
        const granted = new Set(requested);
        const after = [...granted].sort();
        app.db.transaction((tx) => {
            // The request is the complete set, so the stored rows are replaced
            // wholesale. Toggling one switch off is then a normal write rather than
            // a delete that has to be worked out from a diff.
            tx.delete(roleCapabilities).where(eq(roleCapabilities.role, EDITABLE_ROLE)).run();
            // Every editable switch is written, including the ones turned OFF, so
            // "the supervisor revoked everything" is stored as a decision rather
            // than as an absence that would read back as "never configured".
            tx.insert(roleCapabilities)
                .values(EDITABLE_CAPABILITIES.map((capability) => ({
                role: EDITABLE_ROLE,
                capability,
                enabled: granted.has(capability),
                grantedBy: actor.id,
                grantedAt: new Date().toISOString(),
            })))
                .run();
            // Without this row the history becomes unreadable: an action the
            // associate took last month can look impossible today, simply because
            // the permission was revoked since.
            recordAudit(tx, {
                actorId: actor.id,
                entityType: "role",
                entityId: EDITABLE_ROLE,
                action: "update",
                before: { capabilities: before },
                after: { capabilities: after },
            });
        });
        return reply.send({ role: EDITABLE_ROLE, capabilities: after });
    });
    /** One associate's permissions, next to the general ones they would follow. */
    app.get("/permissions/users/:id", { onRequest: app.requireCapability("permission:manage") }, async (request, reply) => {
        const target = findAssociate(request.params.id, reply);
        if (!target) {
            return reply;
        }
        const general = resolveCapabilities(app.db, EDITABLE_ROLE);
        const own = ownCapabilities(app.db, target.id);
        const effective = own ?? general;
        return reply.send({
            user: target,
            mode: (own ? "own" : "general"),
            capabilities: EDITABLE_CAPABILITIES.map((capability) => ({
                capability,
                enabled: effective.has(capability),
                // So the screen can mark what this person may do differently from
                // everybody else, without a second request.
                general: general.has(capability),
            })),
            locked: [...LOCKED_CAPABILITIES],
        });
    });
    /**
     * Give one associate a list of their own, or put them back on the general
     * one. Recorded in the Historial against that person.
     */
    app.put("/permissions/users/:id", { onRequest: app.requireCapability("permission:manage") }, async (request, reply) => {
        const parsed = userUpdateBody.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "invalid_body",
                message: "No se pudo leer la lista de permisos.",
            });
        }
        const target = findAssociate(request.params.id, reply);
        if (!target) {
            return reply;
        }
        const body = parsed.data;
        if (body.mode === "own" && refuseInvalid(body.capabilities, reply)) {
            return reply;
        }
        const actor = request.user;
        const general = resolveCapabilities(app.db, EDITABLE_ROLE);
        const ownBefore = ownCapabilities(app.db, target.id);
        const granted = body.mode === "own" ? new Set(body.capabilities) : new Set(general);
        // What the person could do before and after, not just the switches that
        // were touched: the question the Historial answers later is "could this
        // associate do that on that day?", and a mode alone doesn't say.
        const before = {
            permissionMode: (ownBefore ? "own" : "general"),
            capabilities: [...(ownBefore ?? general)].sort(),
        };
        const after = {
            permissionMode: body.mode,
            capabilities: [...granted].sort(),
        };
        const result = { user: target, mode: body.mode, capabilities: after.capabilities };
        // Saving what is already there writes nothing, so pressing Guardar twice
        // doesn't leave two identical rows in the Historial.
        if (JSON.stringify(before) === JSON.stringify(after)) {
            return reply.send(result);
        }
        app.db.transaction((tx) => {
            tx.delete(userCapabilities).where(eq(userCapabilities.userId, target.id)).run();
            if (body.mode === "own") {
                // Every editable switch, the OFF ones included, as for the role.
                tx.insert(userCapabilities)
                    .values(EDITABLE_CAPABILITIES.map((capability) => ({
                    userId: target.id,
                    capability,
                    enabled: granted.has(capability),
                    grantedBy: actor.id,
                    grantedAt: new Date().toISOString(),
                })))
                    .run();
            }
            // Filed as a permissions change, like the general list's, but against
            // the person: the Historial names them, and its «Permisos» filter
            // finds both.
            recordAudit(tx, {
                actorId: actor.id,
                entityType: "role",
                entityId: target.id,
                action: "update",
                before,
                after,
            });
        });
        return reply.send(result);
    });
};
//# sourceMappingURL=permissions.js.map