import cors from "@fastify/cors";
import Fastify from "fastify";

import type { AppConfig } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: config.nodeEnv !== "test",
  });

  await app.register(cors, {
    origin: config.frontendOrigins,
    credentials: true,
  });

  await app.register(healthRoutes, { prefix: "/api" });

  return app;
}

