import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { amountInWords } from "../src/lib/amountInWords";
import { cents } from "../src/lib/money";

const lempiras = (amount: number) => cents(Math.round(amount * 100));

describe("amountInWords", () => {
  it("writes the receipts the office issues every day", () => {
    assert.equal(amountInWords(lempiras(25_000)), "VEINTICINCO MIL LEMPIRAS EXACTOS");
    assert.equal(amountInWords(lempiras(15_000)), "QUINCE MIL LEMPIRAS EXACTOS");
    assert.equal(amountInWords(lempiras(55_000)), "CINCUENTA Y CINCO MIL LEMPIRAS EXACTOS");
    assert.equal(
      amountInWords(lempiras(225_000)),
      "DOSCIENTOS VEINTICINCO MIL LEMPIRAS EXACTOS",
    );
    assert.equal(
      amountInWords(lempiras(345_800)),
      "TRESCIENTOS CUARENTA Y CINCO MIL OCHOCIENTOS LEMPIRAS EXACTOS",
    );
  });

  it("states centavos as a fraction", () => {
    assert.equal(amountInWords(lempiras(500.5)), "QUINIENTOS LEMPIRAS CON 50/100");
    assert.equal(
      amountInWords(lempiras(55_358.08)),
      "CINCUENTA Y CINCO MIL TRESCIENTOS CINCUENTA Y OCHO LEMPIRAS CON 08/100",
    );
    assert.equal(amountInWords(cents(7)), "CERO LEMPIRAS CON 07/100");
  });

  it("shortens «uno» in front of a noun", () => {
    assert.equal(amountInWords(lempiras(1)), "UN LEMPIRA EXACTO");
    assert.equal(amountInWords(lempiras(21)), "VEINTIÚN LEMPIRAS EXACTOS");
    assert.equal(amountInWords(lempiras(31)), "TREINTA Y UN LEMPIRAS EXACTOS");
    assert.equal(amountInWords(lempiras(21_000)), "VEINTIÚN MIL LEMPIRAS EXACTOS");
    assert.equal(amountInWords(lempiras(101_000)), "CIENTO UN MIL LEMPIRAS EXACTOS");
    assert.equal(amountInWords(lempiras(11)), "ONCE LEMPIRAS EXACTOS");
  });

  it("says «cien» alone and «ciento» before more", () => {
    assert.equal(amountInWords(lempiras(100)), "CIEN LEMPIRAS EXACTOS");
    assert.equal(amountInWords(lempiras(100_000)), "CIEN MIL LEMPIRAS EXACTOS");
    assert.equal(amountInWords(lempiras(150)), "CIENTO CINCUENTA LEMPIRAS EXACTOS");
  });

  it("says «mil», not «un mil»", () => {
    assert.equal(amountInWords(lempiras(1_000)), "MIL LEMPIRAS EXACTOS");
    assert.equal(amountInWords(lempiras(1_500)), "MIL QUINIENTOS LEMPIRAS EXACTOS");
  });

  it("writes millions, with «de» only before the noun", () => {
    assert.equal(amountInWords(lempiras(1_000_000)), "UN MILLÓN DE LEMPIRAS EXACTOS");
    assert.equal(amountInWords(lempiras(3_000_000)), "TRES MILLONES DE LEMPIRAS EXACTOS");
    assert.equal(
      amountInWords(lempiras(1_750_000)),
      "UN MILLÓN SETECIENTOS CINCUENTA MIL LEMPIRAS EXACTOS",
    );
    assert.equal(
      amountInWords(lempiras(21_001_001)),
      "VEINTIÚN MILLONES MIL UN LEMPIRAS EXACTOS",
    );
  });
});
