import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MoraForm } from "../src/features/settings/moraSummary";
import { moraSummary } from "../src/features/settings/moraSummary";

/*
 * The sentence under the mora switch on Configuración. It is how the
 * supervisor checks the rules before saving them, so it has to say exactly
 * what the fields say.
 */
const form = (patch: Partial<MoraForm> = {}): MoraForm => ({
  enabled: true,
  startsOn: "2026-11-01",
  calculation: "percent",
  percent: "2",
  fixed: "",
  graceDays: "5",
  cap: "",
  frequency: "once",
  chargeDownPayment: false,
  paymentOrder: "mora",
  ...patch,
});

describe("the mora summary", () => {
  it("says the mora is off, whatever the other fields hold", () => {
    assert.equal(moraSummary(form({ enabled: false })), "Apagada. Ningún contrato lleva mora.");
  });

  it("reads a percentage rule back", () => {
    assert.equal(
      moraSummary(form()),
      "Se cobrará 2 % de lo que falta de la cuota, una vez por cuota atrasada, después de 5 días de gracia, desde el 01 nov 2026.",
    );
  });

  it("reads a fixed amount with a maximum, monthly, with the prima", () => {
    assert.equal(
      moraSummary(
        form({
          calculation: "fixed",
          fixed: "500.00",
          cap: "1,500.00",
          frequency: "monthly",
          chargeDownPayment: true,
          graceDays: "1",
        }),
      ),
      "Se cobrará L. 500.00 fijos (hasta L. 1,500.00 por cuota), cada mes que siga atrasada, después de 1 día de gracia, desde el 01 nov 2026. La prima también lleva mora.",
    );
  });

  it("does not invent a start date nobody picked", () => {
    assert.match(moraSummary(form({ startsOn: "" })), /desde la fecha que elijas\.$/);
  });
});
