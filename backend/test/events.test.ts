import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { OWNER_PASSWORD, buildTestApp, login } from "./helpers.js";

/**
 * The live stream must not hold a deploy up.
 *
 * A hijacked event stream never ends on its own, and `app.close()` waits for
 * every open connection. Without the route ending its streams at shutdown, one
 * open tab kept the process alive until systemd gave up and sent SIGKILL — the
 * 90-second restarts seen during deploys.
 */
describe("the live stream at shutdown", () => {
  it("is ended so app.close() finishes while a tab is connected", async () => {
    const { app, sqlite } = await buildTestApp();
    const cookie = await login(app, "owner@test.hn", OWNER_PASSWORD);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;

    // Open a real stream and wait for its first bytes, so it is in flight.
    const ended = new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/api/events", headers: { cookie } },
        (response) => {
          assert.equal(response.statusCode, 200);
          response.once("data", () => resolveOpen());
          response.on("end", resolve);
          response.on("error", resolve);
        },
      );
      req.on("error", reject);
      req.end();
    });

    let resolveOpen!: () => void;
    await new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });

    const closed = app.close().then(() => "closed" as const);
    const timedOut = new Promise<"timed out">((resolve) => {
      setTimeout(() => resolve("timed out"), 2_000).unref();
    });

    const outcome = await Promise.race([closed, timedOut]);

    // On a regression, drop the stream by force so the suite fails rather
    // than hanging on the same open connection it is testing for.
    if (outcome === "timed out") {
      app.server.closeAllConnections();
      await closed;
    }
    sqlite.close();

    assert.equal(outcome, "closed", "app.close() is still waiting on the open stream");
    // The browser sees a clean end and reconnects to the new process.
    await ended;
  });
});
