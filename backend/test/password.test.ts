import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hashPassword, verifyPassword } from "../src/lib/password.js";

describe("password hashing", () => {
  it("accepts the correct password", async () => {
    const hash = await hashPassword("correcto-caballo-bateria");
    assert.equal(await verifyPassword("correcto-caballo-bateria", hash), true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correcto-caballo-bateria");
    assert.equal(await verifyPassword("caballo-correcto-bateria", hash), false);
  });

  it("never stores the plain password", async () => {
    const hash = await hashPassword("secreto123");
    assert.ok(!hash.includes("secreto123"));
  });

  it("gives two identical passwords different hashes", async () => {
    // Different salts. One cracked password must not reveal another.
    const first = await hashPassword("misma-clave");
    const second = await hashPassword("misma-clave");
    assert.notEqual(first, second);
  });

  it("rejects a malformed stored hash instead of throwing", async () => {
    assert.equal(await verifyPassword("cualquiera", "not-a-real-hash"), false);
    assert.equal(await verifyPassword("cualquiera", ""), false);
  });
});
