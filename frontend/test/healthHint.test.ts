import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { healthHint } from "../src/features/contracts/contractPresentation";

/*
 * The sentence under a contract's chip, and on the Panel's buckets. It used to
 * say «cinco días de gracia» whatever Configuración said.
 */
describe("the sentence that explains «Por vencer» and «Atrasado»", () => {
  it("names the grace days set on Configuración", () => {
    assert.equal(healthHint("due_soon", 5), "Tiene una cuota próxima o dentro de los 5 días de gracia.");
    assert.equal(healthHint("overdue", 5), "Pasaron los 5 días de gracia y la cuota no entró.");
    assert.equal(healthHint("overdue", 3), "Pasaron los 3 días de gracia y la cuota no entró.");
  });

  it("says one day in the singular", () => {
    assert.equal(healthHint("due_soon", 1), "Tiene una cuota próxima o dentro de su día de gracia.");
    assert.equal(healthHint("overdue", 1), "Pasó el día de gracia y la cuota no entró.");
  });

  it("does not mention a grace when there is none", () => {
    assert.equal(healthHint("due_soon", 0), "Tiene una cuota próxima o que vence hoy.");
    assert.equal(healthHint("overdue", 0), "Venció una cuota y no entró.");
  });

  it("keeps the other two as they were", () => {
    assert.equal(healthHint("current", 5), "No debe nada vencido.");
    assert.equal(healthHint("at_risk", 5), "Dos meses o más sin pagar.");
  });
});
