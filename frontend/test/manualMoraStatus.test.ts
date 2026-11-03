import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { manualMoraStatus } from "../src/features/contracts/manualMoraStatus";
import type { MoneyView } from "../src/lib/money";

/*
 * The word beside a mora put on by hand. A forgiven one used to say «Pagada»,
 * because the screen only knew nothing was left unpaid.
 */

const HNL: MoneyView = { currency: "HNL", usdRate: 25 };

const status = (amountCents: number, pendingCents: number, forgivenCents: number) =>
  manualMoraStatus({ amountCents, pendingCents, forgivenCents }, HNL).replace(/ /g, " ");

describe("manualMoraStatus", () => {
  it("says «Pendiente» while nothing has touched it", () => {
    assert.equal(status(50_000, 50_000, 0), "Pendiente");
  });

  it("says what is left when part is covered, paid or forgiven", () => {
    assert.equal(status(50_000, 20_000, 0), "Faltan L. 200");
    assert.equal(status(50_000, 20_000, 30_000), "Faltan L. 200");
  });

  it("says «Pagada» only when payments covered all of it", () => {
    assert.equal(status(50_000, 0, 0), "Pagada");
  });

  it("says «Perdonada» when nobody paid it", () => {
    assert.equal(status(50_000, 0, 50_000), "Perdonada");
  });

  it("says both when it ended part paid and part forgiven", () => {
    assert.equal(status(50_000, 0, 20_000), "Pagada en parte, perdonada en parte");
  });
});
