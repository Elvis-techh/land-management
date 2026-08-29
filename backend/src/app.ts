import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

import authPlugin from "./auth/plugin.js";
import type { AppConfig } from "./config/env.js";
import type { Db } from "./db/client.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { customerRoutes } from "./routes/customers.js";
import { healthRoutes } from "./routes/health.js";
import { exchangeRateRoutes } from "./routes/exchangeRate.js";
import { lotRoutes } from "./routes/lots.js";
import { permissionRoutes } from "./routes/permissions.js";
import { projectRoutes } from "./routes/projects.js";

export async function buildApp(config: AppConfig, db: Db) {
  const app = Fastify({
    logger: config.nodeEnv !== "test",
  });

  await app.register(cors, {
    origin: config.frontendOrigins,
    // Required for the session cookie to travel with fetch() requests.
    credentials: true,
  });

  await app.register(cookie, { secret: config.cookieSecret });

  // A generous ceiling for normal use; the login route is far stricter below.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
  });

  await app.register(authPlugin, { db });

  /*
   * The last line between a database error and the user's screen.
   *
   * Routes refuse bad input themselves, in Spanish, naming the record at fault.
   * When something slips past one of those checks the failure still has to
   * arrive as a sentence: SQLite answers a violated index with text like
   * "UNIQUE constraint failed: lots.project_id, lots.code", and Fastify's
   * default handler would forward that verbatim into the dialog. It is not a
   * message, it is a schema dump — useless to the person at the screen and a
   * small gift to anyone probing the API.
   *
   * Deliberate refusals (4xx) keep their own wording; only unplanned failures
   * are replaced, and those are logged in full so nothing is actually lost.
   */
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = error.statusCode ?? 500;

    if (status < 500) {
      return reply.code(status).send({
        error: error.code ?? "request_error",
        message: error.message,
      });
    }

    request.log.error({ err: error }, "Unhandled error");

    return reply.code(500).send({
      error: "server_error",
      message: "No se pudo completar la operación. Vuelve a intentarlo o avisa a soporte.",
    });
  });

  await app.register(
    async (api) => {
      await api.register(healthRoutes);

      // Login is the one route worth attacking with a script, so it gets its
      // own tight limit — by default ten attempts per minute from one address.
      await api.register(async (scoped) => {
        await scoped.register(rateLimit, {
          max: config.loginAttemptsPerMinute,
          timeWindow: "1 minute",
        });
        await scoped.register(authRoutes, {
          sessionDays: config.sessionDays,
          isProduction: config.nodeEnv === "production",
        });
      });

      await api.register(lotRoutes);
      await api.register(projectRoutes);
      await api.register(customerRoutes);
      await api.register(permissionRoutes);
      await api.register(exchangeRateRoutes);
      await api.register(auditRoutes);
    },
    { prefix: "/api" },
  );

  return app;
}
