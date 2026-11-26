import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { Db } from "../db/client.js";
import type { PickDatabase } from "../db/pickDatabase.js";
import { userCan } from "../lib/capabilities.js";
import type { Capability } from "../lib/permissions.js";
import type { SessionUser } from "./session.js";
import { SESSION_COOKIE, getSessionUser } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The database of this request's company, chosen before anything else
     * runs. Every route reads and writes through this, never through a
     * database shared by the whole app: once there are several companies, a
     * shared one would be some other company's.
     */
    db: Db;
    /** The signed-in user, or `null` for an anonymous request. */
    user: SessionUser | null;
  }

  interface FastifyInstance {
    /** Route guard: 401 unless someone is signed in. */
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Route guard factory: 401 if anonymous, 403 without the capability. */
    requireCapability: (
      capability: Capability,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

interface AuthPluginOptions {
  pickDatabase: PickDatabase;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  // `null` only until the hook below runs, which is before any route handler.
  app.decorateRequest("db", null as unknown as Db);
  app.decorateRequest("user", null);

  // Pick the request's database, then resolve the session from it, on every
  // request and before any route handler runs. The user is read from the
  // database, never from the cookie's contents.
  app.addHook("onRequest", async (request) => {
    request.db = options.pickDatabase(request);

    const token = request.cookies[SESSION_COOKIE];
    request.user = token ? getSessionUser(request.db, token) : null;
  });

  app.decorate("requireUser", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      await reply.code(401).send({ error: "unauthenticated", message: "Inicia sesión." });
    }
  });

  app.decorate("requireCapability", (capability: Capability) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        await reply.code(401).send({ error: "unauthenticated", message: "Inicia sesión." });
        return;
      }

      // Asked of the database, not of a hard-coded table: the supervisor can
      // change what the associate role, or one associate, may do, and a revoked
      // capability has to stop working on that person's very next request.
      if (!userCan(request.db, request.user, capability)) {
        request.log.warn(
          { userId: request.user.id, role: request.user.role, capability },
          "Capability denied",
        );
        await reply.code(403).send({
          error: "forbidden",
          message: "Tu usuario no tiene permiso para esta acción.",
        });
      }
    };
  });
};

// `fastify-plugin` stops Fastify from scoping these decorations to a child
// context, so `request.db` and the guards are visible to every route.
export default fp(authPlugin, { name: "lindero-auth" });
