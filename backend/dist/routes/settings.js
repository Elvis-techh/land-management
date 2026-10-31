import { recordAudit } from "../lib/audit.js";
import { roleCan } from "../lib/capabilities.js";
import { SECTION_CAPABILITY, SETTINGS_SECTIONS, moraProblem, readMoraHistory, readSettings, sectionChanged, settingsUpdateSchema, writeMoraVersion, writeSection, } from "../lib/settings.js";
import { businessToday } from "../lib/time.js";
/** What a refused section is called in the message, so the refusal says which. */
const SECTION_NAMES = {
    mora: "la mora",
    contracts: "la configuración de contratos",
    business: "los datos del negocio",
};
export const settingsRoutes = async (app, options) => {
    // Everyone signed in reads them: the business details are on every receipt,
    // the reservation length pre-fills «Nuevo contrato», and an associate should
    // be able to see the mora rules they cannot change.
    app.get("/settings", { onRequest: app.requireUser }, async (_request, reply) => reply.send(readSettings(app.db)));
    /**
     * Save any of the sections, each sent complete.
     *
     * A section sent unchanged is not a change: it needs no permission and files
     * nothing in Historial. That lets the screen send everything it shows, while
     * an associate who may edit the business details is not refused for the mora
     * section they only looked at.
     */
    app.put("/settings", { onRequest: app.requireUser }, async (request, reply) => {
        const parsed = settingsUpdateSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "invalid_body",
                message: "Revisa los valores: alguno está vacío o fuera de rango.",
            });
        }
        const actor = request.user;
        const current = readSettings(app.db);
        const changed = SETTINGS_SECTIONS.filter((section) => {
            const next = parsed.data[section];
            return next !== undefined && sectionChanged(current[section], next);
        });
        // Asked per section, of the database, like every other guard: `mora:edit`
        // can never be granted to the associate role, `settings:edit` can.
        const refused = changed.filter((section) => !roleCan(app.db, actor.role, SECTION_CAPABILITY[section]));
        if (refused.length > 0) {
            request.log.warn({ userId: actor.id, role: actor.role, refused }, "Settings change denied");
            return reply.code(403).send({
                error: "forbidden",
                message: `Tu usuario no puede cambiar ${refused.map((section) => SECTION_NAMES[section]).join(" ni ")}.`,
            });
        }
        const next = {
            mora: parsed.data.mora ?? current.mora,
            contracts: parsed.data.contracts ?? current.contracts,
            business: parsed.data.business ?? current.business,
        };
        const today = businessToday(options.timeZone);
        if (changed.includes("mora")) {
            const problem = moraProblem(current.mora, next.mora, today, readMoraHistory(app.db));
            if (problem) {
                return reply.code(400).send({ error: "invalid_mora", message: problem });
            }
        }
        app.db.transaction((tx) => {
            for (const section of changed) {
                writeSection(tx, section, next[section], actor.id);
                // The rules also go into their history, in force from tomorrow, so a
                // mora already charged keeps the rules it was charged under.
                if (section === "mora") {
                    writeMoraVersion(tx, next.mora, today, actor.id);
                }
                // One row per section, so Historial says "the mora changed" apart from
                // "the phone number changed", and a filter can find either.
                recordAudit(tx, {
                    actorId: actor.id,
                    entityType: "settings",
                    entityId: section,
                    action: "update",
                    before: current[section],
                    after: next[section],
                });
            }
        });
        return reply.send(next);
    });
};
//# sourceMappingURL=settings.js.map