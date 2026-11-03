import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { searchContracts } from "../src/features/contracts/contractFilters";
import { searchCustomers } from "../src/features/customers/customerFilters";
import { searchLots } from "../src/features/lots/lotFilters";
import { searchTransactions } from "../src/features/receipts/transactionFilters";
import { searchRows } from "../src/lib/textSearch";
import { cents } from "../src/lib/money";
import type { Contract, Customer, CustomerRecord, Lot, Transaction } from "../src/types";

/*
 * The owner searched «Etapa 9» in Lotes and got 39 of 49 lots: «Etapa» is in
 * every project name, and «9» only had to appear somewhere, in a contract number
 * or a phone. One rule now, on all four lists.
 */

const search = (typed: string, ...rows: { name: string; phone?: string; id?: string }[]) =>
  searchRows(rows, typed, (row) => ({ text: [row.name], phones: [row.phone], identities: [row.id] })).map(
    (row) => row.name,
  );

describe("a word that is only a number", () => {
  const rows = [
    { name: "Etapa 9" },
    { name: "Etapa 19" },
    { name: "CT-2026-009" },
    { name: "A-01" },
    { name: "A-1" },
    { name: "A-10" },
  ];

  it("has to be a whole number on the row, as written", () => {
    assert.deepEqual(search("9", ...rows), ["Etapa 9"]);
    assert.deepEqual(search("01", ...rows), ["A-01"]);
    assert.deepEqual(search("1", ...rows), ["A-1"]);
    assert.deepEqual(search("009", ...rows), ["CT-2026-009"]);
    assert.deepEqual(search("2", ...rows), []);
  });

  it("counts both words, so «etapa 9» is only the one", () => {
    assert.deepEqual(search("etapa 9", ...rows), ["Etapa 9"]);
    assert.deepEqual(search("etapa 1", ...rows), []);
  });

  it("can be part of a longer number from four digits up", () => {
    assert.deepEqual(search("2026", ...rows), ["CT-2026-009"]);
    assert.deepEqual(search("9051", { name: "IM-905112837461" }, { name: "IM-482739156034" }), ["IM-905112837461"]);
  });

  it("leaves a word with letters as it was: part of it is enough", () => {
    assert.deepEqual(search("a-1", ...rows), ["A-1", "A-10"]);
    assert.deepEqual(search("ct-2026", ...rows), ["CT-2026-009"]);
  });
});

describe("phones and identity numbers", () => {
  const karla = { name: "Karla", phone: "+50499447781", id: "0801-1990-12345" };
  const luis = { name: "Luis", phone: "+50433221100" };

  it("do not count for a short number, which is inside most of them", () => {
    assert.deepEqual(search("9", karla, luis), []);
    assert.deepEqual(search("99", karla, luis), []);
    assert.deepEqual(search("504", karla, luis), []);
    assert.deepEqual(search("801", karla, luis), []);
  });

  it("count from four digits, anywhere in the number", () => {
    assert.deepEqual(search("9944", karla, luis), ["Karla"]);
    assert.deepEqual(search("7781", karla, luis), ["Karla"]);
    assert.deepEqual(search("99447781", karla, luis), ["Karla"]);
    assert.deepEqual(search("0801", karla, luis), ["Karla"]);
    assert.deepEqual(search("080119901", karla, luis), ["Karla"]);
  });

  it("do not match the country code every Honduran number shares", () => {
    assert.deepEqual(search("5049", karla, luis), []);
    assert.deepEqual(search("5043", karla, luis), []);
  });

  it("are found the way people write them", () => {
    assert.deepEqual(search("9944-7781", karla, luis), ["Karla"]);
    assert.deepEqual(search("+504 9944-7781", karla, luis), ["Karla"]);
    assert.deepEqual(search("+50499447781", karla, luis), ["Karla"]);
    assert.deepEqual(search("0801-1990", karla, luis), ["Karla"]);
  });
});

describe("capitals and accents", () => {
  it("never matter, in what was typed or in what is stored", () => {
    const rows = [{ name: "José Peña" }, { name: "Ana" }];

    assert.deepEqual(search("jose", ...rows), ["José Peña"]);
    assert.deepEqual(search("JOSÉ", ...rows), ["José Peña"]);
    assert.deepEqual(search("pena", ...rows), ["José Peña"]);
    assert.deepEqual(search("peña", ...rows), ["José Peña"]);
  });
});

describe("the box", () => {
  it("shows every row when nothing is typed, and needs every word to match", () => {
    const rows = [{ name: "Elena Valle" }, { name: "Elena Monte" }];

    assert.deepEqual(search("   ", ...rows), ["Elena Valle", "Elena Monte"]);
    assert.deepEqual(search("elena valle", ...rows), ["Elena Valle"]);
    assert.deepEqual(search("valle monte", ...rows), []);
  });
});

/* The same rule on each list, with the fields each one really searches. */
describe("each list", () => {
  it("Lotes: «Etapa 9» is the lots of Etapa 9, as the owner expected", () => {
    const holder = { id: "cu1", fullName: "Karla Díaz", phone: "+50499447781" } as Customer;
    const lot = (code: string, projectName: string, contractCode?: string) =>
      ({
        id: code,
        code,
        projectName,
        areaM2: 300,
        basePrice: cents(100),
        archivedAt: null,
        holding: contractCode ? { contractCode, customerId: holder.id } : null,
      }) as Lot;
    const lots = [
      lot("A-01", "Santiago Etapa 9"),
      lot("A-01", "Santiago Etapa 1", "CT-2026-009"),
      lot("A-02", "Santiago Etapa 1", "CT-2026-023"),
    ];
    const found = (typed: string) =>
      searchLots(lots, typed, new Map([[holder.id, holder]])).map((row) => `${row.code} ${row.projectName}`);

    assert.deepEqual(found("Etapa 9"), ["A-01 Santiago Etapa 9"]);
    assert.deepEqual(found("etapa 1 a-01"), ["A-01 Santiago Etapa 1"]);
    assert.deepEqual(found("karla diaz"), ["A-01 Santiago Etapa 1", "A-02 Santiago Etapa 1"]);
    assert.deepEqual(found("7781"), ["A-01 Santiago Etapa 1", "A-02 Santiago Etapa 1"]);
  });

  it("Contratos: a short number is not the phone or the end of the contract number", () => {
    const contract = (code: string, projectName: string) =>
      ({
        code,
        notes: null,
        customer: { fullName: "Ana", phone: "+50499447781" },
        lot: { code: "A-07", projectName },
      }) as unknown as Contract;
    const contracts = [contract("CT-2026-009", "Etapa 1"), contract("CT-2026-010", "Etapa 9")];
    const found = (typed: string) => searchContracts(contracts, typed).map((row) => row.code);

    assert.deepEqual(found("9"), ["CT-2026-010"]);
    assert.deepEqual(found("009"), ["CT-2026-009"]);
    assert.deepEqual(found("ana etapa 9"), ["CT-2026-010"]);
  });

  it("Clientes: finds by contract and project, and by a phone from four digits", () => {
    const customer = (fullName: string, phone: string, projectName: string) =>
      ({
        fullName,
        phone,
        identification: "0801-1990-12345",
        email: null,
        address: null,
        notes: null,
        contracts: [{ contractCode: "CT-2026-009", lotCode: "A-01", projectName }],
      }) as unknown as CustomerRecord;
    const customers = [
      customer("José Pérez", "+50499447781", "Etapa 9"),
      customer("Ana Díaz", "+50433221100", "Etapa 1"),
    ];
    const found = (typed: string) => searchCustomers(customers, typed).map((row) => row.fullName);

    assert.deepEqual(found("jose"), ["José Pérez"]);
    assert.deepEqual(found("etapa 9"), ["José Pérez"]);
    assert.deepEqual(found("7781"), ["José Pérez"]);
    assert.deepEqual(found("9"), ["José Pérez"]);
    assert.deepEqual(found("99"), []);
  });

  it("Recibos: a short number is not the receipt code or the identity", () => {
    const transaction = (id: string, projectName: string, receiptCode: string) =>
      ({
        id,
        customerName: "Ana Díaz",
        customerIdentification: "0801-1990-12345",
        lotCode: "A-07",
        projectName,
        contractCode: "CT-2026-010",
        receiptCode,
        reference: null,
        notes: null,
        receiptNote: null,
      }) as unknown as Transaction;
    const transactions = [transaction("1", "Etapa 9", "IM-100"), transaction("2", "Etapa 1", "IM-109")];
    const found = (typed: string) => searchTransactions(transactions, typed).map((row) => row.id);

    assert.deepEqual(found("etapa 9"), ["1"]);
    assert.deepEqual(found("ana etapa 1"), ["2"]);
    assert.deepEqual(found("109"), ["2"]);
    assert.deepEqual(found("12345"), ["1", "2"]);
  });
});
