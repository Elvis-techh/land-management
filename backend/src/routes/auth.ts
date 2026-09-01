import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { users } from "../db/schema.js";
import { resolveCapabilities } from "../lib/capabilities.js";
import { recordAudit } from "../lib/audit.js";
import { verifyPassword } from "../lib/password.js";
import type { Role } from "../lib/permissions.js";
import { SESSION_COOKIE, createSession, destroySession } from "../auth/session.js";

const loginBody = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(200),
});

interface AuthRoutesOptions {
  sessionDays: number;
  isProduction: boolean;
  /** Attempts allowed per minute, per IP — this route only. See app.ts. */
  loginAttemptsPerMinute: number;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
  app.post(
    "/auth/login",
    {
      // The one route worth attacking with a script, so it gets its own tight
      // limit instead of the generous app-wide default every other route
      // here uses (see routes/health etc. registration in app.ts).
      config: {
        rateLimit: {
          max: options.loginAttemptsPerMinute,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const parsed = loginBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", message: "Datos incompletos." });
      }

      const email = parsed.data.email.toLowerCase();
      const user = app.db.select().from(users).where(eq(users.email, email)).get();

      // Always run a hash comparison, even when the email is unknown. Returning
      // early would make "no such user" measurably faster than "wrong password",
      // which lets an attacker discover which emails exist.
      const storedHash = user?.passwordHash ?? "scrypt$00$00";
      const passwordMatches = await verifyPassword(parsed.data.password, storedHash);

      if (!user || !passwordMatches) {
        request.log.warn({ email }, "Failed login");
        return reply
          .code(401)
          .send({ error: "invalid_credentials", message: "Correo o contraseña incorrectos." });
      }

      const sessionId = createSession(app.db, user.id, options.sessionDays);
      recordAudit(app.db, {
        actorId: user.id,
        entityType: "user",
        entityId: user.id,
        action: "login",
      });

      reply.setCookie(SESSION_COOKIE, sessionId, {
        path: "/",
        // The browser will not expose this cookie to JavaScript, so a script
        // injected into the page cannot steal the session.
        httpOnly: true,
        // Not sent on cross-site requests, which blocks CSRF.
        sameSite: "lax",
        // HTTPS only in production. Left off in development so localhost works.
        secure: options.isProduction,
        maxAge: options.sessionDays * 24 * 60 * 60,
      });

      return reply.send({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          // Sent so the interface can hide what this user cannot do. It is a
          // convenience only — every write re-checks server-side.
          capabilities: [...resolveCapabilities(app.db, user.role as Role)],
        },
      });
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];

    if (sessionId) {
      destroySession(app.db, sessionId);
    }

    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.send({ ok: true });
  });

  /** Who am I? The frontend calls this on load to restore an existing session. */
  app.get("/auth/me", async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: "unauthenticated", message: "Inicia sesión." });
    }

    return reply.send({
      user: {
        ...request.user,
        capabilities: [...resolveCapabilities(app.db, request.user.role)],
      },
    });
  });
};
