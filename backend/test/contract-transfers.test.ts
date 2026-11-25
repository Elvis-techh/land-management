import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

import { auditEvents, customers, lots } from "../src/db/schema.js";
import { OWNER_PASSWORD, STAFF_PASSWORD, buildTestApp, login } from "./helpers.js";

const lempiras = (amount: number) => Math.round(amount * 100);

interface ContractJson {
  id: string;
  code: string;
  status: string;
  saleGroupId: string | null;
  customer: { id: string; fullName: string };
  paidToDate: number;
  balance: number;
  transfers: Array<{
    from: { id: string; fullName: string };
    to: { id: string; fullName: string };
    effectiveOn: string;
    reason: string;
    recordedBy: string;
  }>;
}

interface ReceiptJson {
  id: string;
  customer: { id: string; fullName: string };
  totalPaid: number;
  previousBalance: number;
  newBalance: number;
  cumulativePaid: number;
  lines: Array<{
    contractId: string;
    amount: number;
    previousBalance: number;
    newBalance: number;
    appliedTo: unknown;
    holder: { id: string; fullName: string } | null;
  }>;
}

/**
 * «Traspasar»: a family hands a running contract to somebody else, who signs a
 * new promesa de venta. The case it was built for: a contract of L 330,000
 * with L 100,000 of prima and cuotas of L 19,167, half paid, passing from one
 * relative to another — the money staying with the lot, and the receipts
 * already issued keeping the name they were made out to.
 */
describe("«Traspasar» a contract to another customer", async () => {
  const { app, db, sqlite, ids } = await buildTestApp();
  after(async () => {
    await app.close();
    sqlite.close();
  });

  const ownerCookie = await login(app, "owner@test.hn", OWNER_PASSWORD);
  const staffCookie = await login(app, "staff@test.hn", STAFF_PASSWORD);

  const person = (fullName: string) => {
    const id = randomUUID();
    db.insert(customers).values({ id, fullName, customerSince: 2026 }).run();
    return id;
  };

  const previousHolder = person("Titular Anterior");
  const newHolder = person("Titular Nuevo");

  const post = (url: string, payload: unknown, cookie = ownerCookie) =>
    app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });

  const contractsNow = async (): Promise<ContractJson[]> =>
    (await app.inject({ method: "GET", url: "/api/contracts", headers: { cookie: ownerCookie } }))
      .json().contracts;
  const contract = async (id: string) => (await contractsNow()).find((row) => row.id === id)!;

  const receipt = async (id: string): Promise<ReceiptJson> =>
    (await app.inject({ method: "GET", url: `/api/receipts/${id}`, headers: { cookie: ownerCookie } }))
      .json().receipt;

  let lotNumber = 0;

  /** A financed contract on a lot of its own: L 330,000, L 100,000 prima, 12 × L 19,167. */
  const sale = async (customerId: string, joinGroupOfContractId?: string) => {
    lotNumber += 1;
    const lotId = randomUUID();
    db.insert(lots)
      .values({
        id: lotId,
        projectId: ids.projectId,
        code: `T-${lotNumber}`,
        areaM2: 300,
        basePriceCents: lempiras(330_000),
      })
      .run();

    const response = await post("/api/contracts", {
      customerId,
      lotId,
      kind: "contract",
      saleType: "financed",
      salePriceCents: lempiras(330_000),
      downPaymentCents: lempiras(100_000),
      termMonths: 12,
      monthlyPaymentCents: lempiras(19_167),
      dueDay: 27,
      signedOn: "2026-05-01",
      joinGroupOfContractId,
    });
    assert.equal(response.statusCode, 201, response.body);

    return response.json().contract.id as string;
  };

  /** One receipt, `amount` on each contract named. */
  const pay = async (
    customerId: string,
    paidOn: string,
    contractIds: string[],
    amount: number,
    type = "installment",
  ) => {
    const response = await post("/api/receipts", {
      customerId,
      paidOn,
      method: "transfer",
      lines: contractIds.map((contractId) => ({ contractId, amountCents: lempiras(amount), type })),
    });
    assert.equal(response.statusCode, 201, response.body);

    return response.json().receipt.id as string;
  };

  const transfer = (contractIds: string[], toCustomerId: string, extra: object = {}, cookie = ownerCookie) =>
    post(
      "/api/contracts/transfers",
      {
        contractIds,
        toCustomerId,
        effectiveOn: "2026-11-20",
        reason: "Nueva promesa de venta firmada por el nuevo titular.",
        ...extra,
      },
      cookie,
    );

  const handedOver = await sale(previousHolder);
  const issued = [
    await pay(previousHolder, "2026-06-30", [handedOver], 100_000, "down_payment"),
    await pay(previousHolder, "2026-07-27", [handedOver], 28_500),
    await pay(previousHolder, "2026-08-25", [handedOver], 19_166),
  ];
  const printedBefore = await Promise.all(issued.map(receipt));
  const before = await contract(handedOver);

  /** What a receipt says, without what may legitimately differ (who holds the lot now). */
  const face = (printed: ReceiptJson) => ({
    customer: printed.customer,
    totalPaid: printed.totalPaid,
    previousBalance: printed.previousBalance,
    newBalance: printed.newBalance,
    cumulativePaid: printed.cumulativePaid,
    lines: printed.lines.map((line) => ({
      contractId: line.contractId,
      amount: line.amount,
      previousBalance: line.previousBalance,
      newBalance: line.newBalance,
      appliedTo: line.appliedTo,
    })),
  });

  it("is not something an associate may do by default", async () => {
    const response = await transfer([handedOver], newHolder, {}, staffCookie);
    assert.equal(response.statusCode, 403);
  });

  it("demands a written motive", async () => {
    const response = await transfer([handedOver], newHolder, { reason: "cambio" });
    assert.equal(response.statusCode, 400);
  });

  it("refuses a date that has not happened yet", async () => {
    const response = await transfer([handedOver], newHolder, { effectiveOn: "2099-01-01" });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "future_date");
  });

  it("refuses a date before the contract was signed", async () => {
    const response = await transfer([handedOver], newHolder, { effectiveOn: "2026-04-30" });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "before_signing");
  });

  it("refuses handing a contract to the person who already holds it", async () => {
    const response = await transfer([handedOver], previousHolder);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "same_customer");
  });

  it("refuses somebody who is not a customer", async () => {
    const response = await transfer([handedOver], randomUUID());
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "unknown_customer");
  });

  it("refuses contracts of two different holders in one traspaso", async () => {
    const other = await sale(person("Otro Titular"));
    const response = await transfer([handedOver, other], newHolder);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "customer_mismatch");
  });

  it("refuses a contract that is already closed", async () => {
    // Somebody else's, so the previous holder is left with no contract at all
    // once theirs is handed over — the case the deletion test below is about.
    const closed = await sale(person("Titular con Venta Deshecha"));
    const cancelled = await post(`/api/contracts/${closed}/cancel`, {
      reason: "La venta se deshizo antes de pagar nada.",
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);

    const response = await transfer([closed], newHolder);
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "not_active");
  });

  it("hands the contract over with every payment, the balance and its number", async () => {
    const response = await transfer([handedOver], newHolder);
    assert.equal(response.statusCode, 201, response.body);

    const now = await contract(handedOver);

    assert.equal(now.customer.id, newHolder);
    assert.equal(now.code, before.code);
    assert.equal(now.status, "active");
    assert.equal(now.paidToDate, lempiras(147_666));
    assert.equal(now.paidToDate, before.paidToDate);
    assert.equal(now.balance, before.balance);
    assert.equal(now.transfers.length, 1);
    assert.equal(now.transfers[0]!.from.fullName, "Titular Anterior");
    assert.equal(now.transfers[0]!.to.fullName, "Titular Nuevo");
    assert.equal(now.transfers[0]!.effectiveOn, "2026-11-20");
    assert.equal(now.transfers[0]!.recordedBy, "Owner");
  });

  it("leaves every receipt already issued in its name, with the same figures", async () => {
    const printedAfter = await Promise.all(issued.map(receipt));

    assert.deepEqual(printedAfter.map(face), printedBefore.map(face));
    assert.equal(printedAfter[0]!.customer.fullName, "Titular Anterior");
    assert.equal(printedAfter[2]!.lines.length, 1);
    assert.equal(printedAfter[2]!.cumulativePaid, lempiras(147_666));
    // Beside the paper, never on it: who holds the lot now.
    assert.equal(printedAfter[2]!.lines[0]!.holder?.fullName, "Titular Nuevo");
  });

  it("makes the next receipt the new holder's, counting what was paid before", async () => {
    const refused = await post("/api/receipts", {
      customerId: previousHolder,
      paidOn: "2026-11-24",
      method: "cash",
      lines: [{ contractId: handedOver, amountCents: lempiras(19_167), type: "installment" }],
    });
    assert.equal(refused.statusCode, 400);

    const next = await receipt(await pay(newHolder, "2026-11-24", [handedOver], 19_167));

    assert.equal(next.customer.fullName, "Titular Nuevo");
    assert.equal(next.previousBalance, lempiras(330_000 - 147_666));
    assert.equal(next.cumulativePaid, lempiras(147_666 + 19_167));
  });

  it("lists the rows under the new holder, naming the receipts still in the old name", async () => {
    const rows = (
      await app.inject({ method: "GET", url: "/api/transactions", headers: { cookie: ownerCookie } })
    )
      .json()
      .transactions.filter((row: { contractId: string }) => row.contractId === handedOver) as Array<{
      customerName: string;
      receiptId: string;
      receiptCustomerName?: string;
    }>;

    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => row.customerName === "Titular Nuevo"));

    const before = rows.filter((row) => issued.includes(row.receiptId));
    assert.equal(before.length, 3);
    assert.ok(before.every((row) => row.receiptCustomerName === "Titular Anterior"));

    // The receipt issued after the traspaso is the new holder's own: nothing to say.
    const since = rows.find((row) => !issued.includes(row.receiptId))!;
    assert.equal("receiptCustomerName" in since, false);
  });

  it("files the traspaso in the Historial, with both names and the reason", async () => {
    const rows = db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, handedOver), eq(auditEvents.action, "transfer")))
      .all();

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.reason, "Nueva promesa de venta firmada por el nuevo titular.");
    assert.deepEqual(JSON.parse(rows[0]!.beforeJson!), { customerName: "Titular Anterior" });
    assert.deepEqual(JSON.parse(rows[0]!.afterJson!), {
      customerName: "Titular Nuevo",
      transferredOn: "2026-11-20",
    });
  });

  it("keeps the previous holder from being deleted while receipts carry their name", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/customers/${previousHolder}`,
      headers: { cookie: ownerCookie },
      payload: { reason: "Ya no tiene contratos con nosotros." },
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, "customer_has_history");
  });

  it("moves a whole purchase together, and it stays one purchase", async () => {
    const holder = person("Comprador de Dos Lotes");
    const first = await sale(holder);
    const second = await sale(holder, first);
    const shared = await pay(holder, "2026-06-01", [first, second], 10_000);
    const group = (await contract(first)).saleGroupId;
    assert.notEqual(group, null);

    const response = await transfer([first, second], newHolder);
    assert.equal(response.statusCode, 201, response.body);

    assert.equal((await contract(first)).saleGroupId, group);
    assert.equal((await contract(second)).saleGroupId, group);

    // The old receipt can still be divided differently between ITS lots,
    // which are now both the new holder's.
    const moved = await post(`/api/receipts/${shared}/redistribute`, {
      reason: "Se repartió mal entre los dos lotes.",
      lines: [
        { contractId: first, amountCents: lempiras(15_000) },
        { contractId: second, amountCents: lempiras(5_000) },
      ],
    });
    assert.equal(moved.statusCode, 200, moved.body);
  });

  it("makes one lot of a purchase a lot on its own when only it moves", async () => {
    const holder = person("Comprador que Cede Uno");
    const kept = await sale(holder);
    const given = await sale(holder, kept);
    const shared = await pay(holder, "2026-06-01", [kept, given], 10_000);
    const group = (await contract(kept)).saleGroupId;

    const response = await transfer([given], newHolder);
    assert.equal(response.statusCode, 201, response.body);

    assert.equal((await contract(kept)).saleGroupId, group);
    assert.equal((await contract(given)).saleGroupId, null);

    // The receipt that covered both still reads both of its lines.
    const printed = await receipt(shared);
    assert.equal(printed.lines.length, 2);
    assert.equal(printed.totalPaid, lempiras(20_000));
    assert.equal(printed.cumulativePaid, lempiras(20_000));

    // But it no longer moves money between them: that would move it from one
    // person's lot to another's.
    const refused = await post(`/api/receipts/${shared}/redistribute`, {
      reason: "Se repartió mal entre los dos lotes.",
      lines: [
        { contractId: kept, amountCents: lempiras(15_000) },
        { contractId: given, amountCents: lempiras(5_000) },
      ],
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal(refused.json().error, "different_holders");
  });

  it("voids a standing constancia, which keeps the name it was issued in", async () => {
    const holder = person("Titular que Pagó Todo");
    lotNumber += 1;
    const lotId = randomUUID();
    db.insert(lots)
      .values({ id: lotId, projectId: ids.projectId, code: `T-${lotNumber}`, areaM2: 300, basePriceCents: lempiras(50_000) })
      .run();
    const created = await post("/api/contracts", {
      customerId: holder,
      lotId,
      kind: "contract",
      saleType: "cash",
      salePriceCents: lempiras(50_000),
      downPaymentCents: 0,
      signedOn: "2026-03-01",
    });
    const paidOff = created.json().contract.id as string;
    await pay(holder, "2026-03-01", [paidOff], 50_000, "full_payment");

    const constancia = (await post("/api/constancias", { contractIds: [paidOff] })).json().constancia;
    assert.equal(constancia.customer.fullName, "Titular que Pagó Todo");

    const response = await transfer([paidOff], newHolder);
    assert.equal(response.statusCode, 201, response.body);

    const after = (
      await app.inject({
        method: "GET",
        url: `/api/constancias/${constancia.id}`,
        headers: { cookie: ownerCookie },
      })
    ).json().constancia;

    assert.notEqual(after.voidedAt, null);
    assert.match(after.voidReason, /traspasado a Titular Nuevo/);
    assert.equal(after.customer.fullName, "Titular que Pagó Todo");
  });
});
