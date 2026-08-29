import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { recordAudit } from "../lib/audit.js";
import {
  PROVIDER_NAME,
  fetchMarketRate,
  isPlausibleRate,
  isStale,
  readCurrentRate,
  recordRate,
} from "../lib/exchangeRate.js";

const manualRateBody = z.object({
  rate: z.number().positive().finite(),
});

/** The shape every route here answers with, so the client has one thing to read. */
const currentRatePayload = (db: import("../db/client.js").Db) => {
  const reading = readCurrentRate(db);

  return {
    rate: reading.rate,
    source: reading.source,
    provider: reading.provider,
    capturedAt: reading.capturedAt,
    isStale: isStale(reading),
    providerName: PROVIDER_NAME,
  };
};

export const exchangeRateRoutes: FastifyPluginAsync = async (app) => {
  // Everyone signed in can READ the rate — it is on every screen that shows
  // money. Only `rate:edit` may change it.
  app.get("/exchange-rate", { onRequest: app.requireUser }, async (request, reply) =>
    reply.send(currentRatePayload(app.db)),
  );

  app.post(
    "/exchange-rate",
    { onRequest: app.requireCapability("rate:edit") },
    async (request, reply) => {
      const parsed = manualRateBody.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_body",
          message: "Escribe la tasa en lempiras por dólar.",
        });
      }

      if (!isPlausibleRate(parsed.data.rate)) {
        return reply.code(400).send({
          error: "implausible_rate",
          message: "Esa tasa no parece correcta. Escribe cuántos lempiras cuesta un dólar.",
        });
      }

      const actor = request.user!;
      const previous = readCurrentRate(app.db);

      app.db.transaction((tx) => {
        recordRate(tx, {
          rate: parsed.data.rate,
          source: "manual",
          actorId: actor.id,
        });

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "exchange_rate",
          entityId: "current",
          action: "update",
          before: { rate: previous.rate, source: previous.source },
          after: { rate: parsed.data.rate, source: "manual" },
        });
      });

      return reply.send(currentRatePayload(app.db));
    },
  );

  /**
   * Hand control back to the market feed, and take a reading right away.
   *
   * Needed because a manual rate deliberately stops the scheduler from touching
   * the value — so there has to be an explicit way to say "follow the market
   * again", or an override would be permanent by accident.
   */
  app.post(
    "/exchange-rate/auto",
    { onRequest: app.requireCapability("rate:edit") },
    async (request, reply) => {
      const actor = request.user!;
      const previous = readCurrentRate(app.db);

      let rate: number;

      try {
        rate = await fetchMarketRate();
      } catch (caught) {
        // The previous rate stays in force. Nothing is written, because a
        // failed fetch is not a reading.
        return reply.code(502).send({
          error: "provider_unavailable",
          message:
            caught instanceof Error
              ? `No se pudo consultar la tasa del mercado: ${caught.message}`
              : "No se pudo consultar la tasa del mercado.",
        });
      }

      app.db.transaction((tx) => {
        recordRate(tx, {
          rate,
          source: "auto",
          actorId: null,
        });

        recordAudit(tx, {
          actorId: actor.id,
          entityType: "exchange_rate",
          entityId: "current",
          action: "update",
          before: { rate: previous.rate, source: previous.source },
          after: { rate, source: "auto" },
        });
      });

      return reply.send(currentRatePayload(app.db));
    },
  );
};
