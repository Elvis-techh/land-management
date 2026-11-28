import fp from "fastify-plugin";
import { userCan } from "../lib/capabilities.js";
import { SESSION_COOKIE, getSessionUser } from "./session.js";
const authPlugin = async (app, options) => {
    // `null` only until the hook below runs, which is before any route handler.
    app.decorateRequest("company", null);
    app.decorateRequest("db", null);
    app.decorateRequest("user", null);
    // Pick the request's company, then resolve the session from its database,
    // on every request and before any route handler runs. The user is read from
    // the database, never from the cookie's contents.
    app.addHook("onRequest", async (request) => {
        request.company = options.companies.forRequest(request);
        request.db = request.company.db;
        const token = request.cookies[SESSION_COOKIE];
        request.user = token ? getSessionUser(request.db, token) : null;
    });
    app.decorate("requireUser", async (request, reply) => {
        if (!request.user) {
            await reply.code(401).send({ error: "unauthenticated", message: "Inicia sesión." });
        }
    });
    app.decorate("requireCapability", (capability) => {
        return async (request, reply) => {
            if (!request.user) {
                await reply.code(401).send({ error: "unauthenticated", message: "Inicia sesión." });
                return;
            }
            // Asked of the database, not of a hard-coded table: the supervisor can
            // change what the associate role, or one associate, may do, and a revoked
            // capability has to stop working on that person's very next request.
            if (!userCan(request.db, request.user, capability)) {
                request.log.warn({ userId: request.user.id, role: request.user.role, capability }, "Capability denied");
                await reply.code(403).send({
                    error: "forbidden",
                    message: "Tu usuario no tiene permiso para esta acción.",
                });
            }
        };
    });
};
// `fastify-plugin` stops Fastify from scoping these decorations to a child
// context, so `request.company`, `request.db` and the guards are visible to
// every route.
export default fp(authPlugin, { name: "lindero-auth" });
//# sourceMappingURL=plugin.js.map