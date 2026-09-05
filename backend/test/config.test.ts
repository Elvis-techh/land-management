import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config/env.js";

/** The minimum a production config needs before TRUST_PROXY is even reached. */
const production = {
  NODE_ENV: "production",
  COOKIE_SECRET: "a".repeat(48),
  FRONTEND_ORIGIN: "https://lindero.example.com",
};

describe("TRUST_PROXY", () => {
  it("trusts nothing when unset", () => {
    assert.equal(loadConfig({ ...production }).trustProxy, false);
  });

  it("trusts nothing when empty, rather than guessing", () => {
    assert.equal(loadConfig({ ...production, TRUST_PROXY: "" }).trustProxy, false);
  });

  it("takes the proxy's address", () => {
    assert.equal(
      loadConfig({ ...production, TRUST_PROXY: "127.0.0.1" }).trustProxy,
      "127.0.0.1",
    );
  });

  it("takes a CIDR list", () => {
    assert.equal(
      loadConfig({ ...production, TRUST_PROXY: "127.0.0.1,10.0.0.0/8" }).trustProxy,
      "127.0.0.1,10.0.0.0/8",
    );
  });

  /*
   * The one that matters. A hop count is spoofable the moment this port is
   * reachable without passing the proxy: the caller's own X-Forwarded-For is
   * counted as the trusted hop and request.ip becomes whatever they wrote —
   * which is the address the login rate limit counts and the audit trail
   * records. Refusing at boot is deliberate; quietly substituting a safe value
   * would leave the operator believing something untrue about their server.
   */
  it("refuses a hop count, and says what to use instead", () => {
    assert.throws(
      () => loadConfig({ ...production, TRUST_PROXY: "1" }),
      /TRUST_PROXY=1 counts proxy hops[\s\S]*TRUST_PROXY=127\.0\.0\.1/,
    );
  });

  it("refuses any hop count, not just 1", () => {
    assert.throws(() => loadConfig({ ...production, TRUST_PROXY: "2" }), /counts proxy hops/);
  });

  it("still accepts the explicit booleans", () => {
    assert.equal(loadConfig({ ...production, TRUST_PROXY: "true" }).trustProxy, true);
    assert.equal(loadConfig({ ...production, TRUST_PROXY: "false" }).trustProxy, false);
  });
});
