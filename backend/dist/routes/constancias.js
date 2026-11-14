import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { constanciaContracts, constancias, contracts, customers, lots, payments, projects, receipts, users, } from "../db/schema.js";
import { allocateConstanciaCode } from "../lib/constancias.js";
import { generateLookupCode, nextReceiptNumber, toStoredLookupCode } from "../lib/receipts.js";
import { businessToday } from "../lib/time.js";
/** The most lots one constancia may cover — far past any real purchase. */
const MAX_CONTRACTS = 20;
const issueBody = z.object({
    contractIds: z.array(z.string().min(1)).min(1).max(MAX_CONTRACTS),
});
/** One contract's part of a constancia: what it was worth, and every payment that counts. */
function presentPart(db, contractId) {
    const row = db
        .select({
        id: contracts.id,
        code: contracts.code,
        salePriceCents: contracts.salePriceCents,
        signedOn: contracts.signedOn,
        lotCode: lots.code,
        projectName: projects.name,
    })
        .from(contracts)
        .innerJoin(lots, eq(lots.id, contracts.lotId))
        .innerJoin(projects, eq(projects.id, lots.projectId))
        .where(eq(contracts.id, contractId))
        .get();
    // In the order they were made. A reversed one is left out: it is not money
    // the contract was paid with.
    const history = db
        .select({
        paidOn: payments.paidOn,
        type: payments.type,
        amountCents: payments.amountCents,
        receiptCode: receipts.code,
    })
        .from(payments)
        .leftJoin(receipts, eq(receipts.id, payments.receiptId))
        .where(and(eq(payments.contractId, contractId), isNull(payments.reversedAt)))
        .orderBy(asc(payments.paidOn), asc(payments.createdAt))
        .all();
    return {
        contract: {
            id: row.id,
            code: row.code,
            salePriceCents: row.salePriceCents,
            signedOn: row.signedOn,
        },
        lot: { code: row.lotCode, projectName: row.projectName },
        payments: history,
        totalPaidCents: history.reduce((total, payment) => total + payment.amountCents, 0),
        lastPaidOn: history.length > 0 ? history[history.length - 1].paidOn : null,
    };
}
/** A constancia as the document needs it. Figures are read from the payments. */
function presentConstancia(db, id) {
    const row = db
        .select({
        id: constancias.id,
        code: constancias.code,
        lookupCode: constancias.lookupCode,
        issuedOn: constancias.issuedOn,
        voidedAt: constancias.voidedAt,
        voidReason: constancias.voidReason,
        issuedByName: users.name,
        customerName: customers.fullName,
        customerIdentification: customers.identification,
        customerPhone: customers.phone,
    })
        .from(constancias)
        .innerJoin(users, eq(users.id, constancias.issuedBy))
        .innerJoin(contracts, eq(contracts.id, constancias.contractId))
        .innerJoin(customers, eq(customers.id, contracts.customerId))
        .where(eq(constancias.id, id))
        .get();
    if (!row) {
        return null;
    }
    const parts = contractIdsOf(db, id)
        .map((contractId) => presentPart(db, contractId))
        // By lot code, so «B-12 y B-13» reads in the order a person would say it.
        .sort((a, b) => a.lot.code.localeCompare(b.lot.code, "es", { numeric: true }));
    const lastPaidOn = parts
        .map((part) => part.lastPaidOn)
        .filter((date) => date !== null)
        .sort()
        .at(-1);
    return {
        id: row.id,
        code: row.code,
        lookupCode: row.lookupCode,
        issuedOn: row.issuedOn,
        issuedBy: { name: row.issuedByName },
        voidedAt: row.voidedAt,
        voidReason: row.voidReason,
        // The phone is not printed: it is where «Enviar por WhatsApp» sends it.
        customer: {
            fullName: row.customerName,
            identification: row.customerIdentification,
            phone: row.customerPhone,
        },
        parts,
        salePriceCents: parts.reduce((total, part) => total + part.contract.salePriceCents, 0),
        totalPaidCents: parts.reduce((total, part) => total + part.totalPaidCents, 0),
        lastPaidOn: lastPaidOn ?? null,
    };
}
function contractIdsOf(db, constanciaId) {
    return db
        .select({ contractId: constanciaContracts.contractId })
        .from(constanciaContracts)
        .where(eq(constanciaContracts.constanciaId, constanciaId))
        .all()
        .map((row) => row.contractId);
}
/** Every standing (not voided) constancia that speaks for this contract. */
function standingConstanciaIds(db, contractId) {
    return db
        .select({ id: constancias.id })
        .from(constanciaContracts)
        .innerJoin(constancias, eq(constancias.id, constanciaContracts.constanciaId))
        .where(and(eq(constanciaContracts.contractId, contractId), isNull(constancias.voidedAt)))
        .all()
        .map((row) => row.id);
}
/** May a constancia speak for this contract? A paid-off sale with money behind it. */
function isCertifiable(contract) {
    return contract.kind === "contract" && contract.status === "paid_off" && contract.saleType !== "donation";
}
export const constanciaRoutes = async (app, options) => {
    /**
     * What the Constancia dialog needs for one contract: the customer's
     * paid-off contracts that could go on a constancia with it (this one
     * included), and every standing constancia that already covers it.
     */
    app.get("/contracts/:id/constancias", { onRequest: app.requireUser }, async (request, reply) => {
        const contract = app.db
            .select({ customerId: contracts.customerId })
            .from(contracts)
            .where(eq(contracts.id, request.params.id))
            .get();
        if (!contract) {
            return reply.code(404).send({ error: "not_found", message: "Ese contrato no existe." });
        }
        const eligible = app.db
            .select({
            contractId: contracts.id,
            contractCode: contracts.code,
            kind: contracts.kind,
            status: contracts.status,
            saleType: contracts.saleType,
            lotCode: lots.code,
            projectName: projects.name,
        })
            .from(contracts)
            .innerJoin(lots, eq(lots.id, contracts.lotId))
            .innerJoin(projects, eq(projects.id, lots.projectId))
            .where(eq(contracts.customerId, contract.customerId))
            .all()
            .filter(isCertifiable)
            .map(({ contractId, contractCode, lotCode, projectName }) => ({
            contractId,
            contractCode,
            lotCode,
            projectName,
        }))
            .sort((a, b) => a.lotCode.localeCompare(b.lotCode, "es", { numeric: true }));
        return {
            eligible,
            standing: standingConstanciaIds(app.db, request.params.id).map((id) => presentConstancia(app.db, id)),
        };
    });
    /**
     * Issue a constancia for one paid-off contract or several of the same
     * customer's.
     *
     * One at a time per set: if a standing constancia already covers exactly
     * these contracts, that one comes back rather than a second, so printing it
     * again never mints a new number. Only once it has been voided — a contract
     * reopened and was paid off again — is a new one issued.
     */
    app.post("/constancias", { onRequest: app.requireCapability("contract:certify") }, async (request, reply) => {
        const actor = request.user;
        const parsed = issueBody.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "invalid_body",
                message: "Indica para qué contratos es la constancia.",
            });
        }
        const contractIds = [...new Set(parsed.data.contractIds)];
        const rows = app.db
            .select({
            id: contracts.id,
            customerId: contracts.customerId,
            status: contracts.status,
            kind: contracts.kind,
            saleType: contracts.saleType,
        })
            .from(contracts)
            .where(inArray(contracts.id, contractIds))
            .all();
        if (rows.length !== contractIds.length) {
            return reply.code(404).send({ error: "not_found", message: "Uno de esos contratos no existe." });
        }
        if (new Set(rows.map((row) => row.customerId)).size > 1) {
            return reply.code(409).send({
                error: "different_customers",
                message: "Una constancia es de un solo cliente: esos contratos son de clientes distintos.",
            });
        }
        // A donation is "paid off" at a price of zero: no money was ever owed,
        // so there is nothing for a constancia of payment to certify.
        if (rows.some((row) => row.saleType === "donation")) {
            return reply.code(409).send({
                error: "donation",
                message: "Una donación no tiene pagos que hacer constar.",
            });
        }
        if (!rows.every(isCertifiable)) {
            return reply.code(409).send({
                error: "not_paid_off",
                message: "Solo se emite constancia de contratos en estado Pagado.",
            });
        }
        const wanted = [...contractIds].sort().join(",");
        const id = app.db.transaction((tx) => {
            const standing = standingConstanciaIds(tx, contractIds[0]).find((candidate) => contractIdsOf(tx, candidate).sort().join(",") === wanted);
            if (standing !== undefined) {
                return standing;
            }
            // Allocated inside the transaction, under the write lock, exactly as
            // a receipt number is.
            const highest = tx
                .select({ value: sql `MAX(${constancias.number})` })
                .from(constancias)
                .get();
            const code = allocateConstanciaCode((candidate) => tx
                .select({ id: constancias.id })
                .from(constancias)
                .where(eq(constancias.code, candidate))
                .get() !== undefined);
            const newId = randomUUID();
            tx.insert(constancias)
                .values({
                id: newId,
                number: nextReceiptNumber(highest?.value),
                code,
                lookupCode: generateLookupCode(),
                contractId: contractIds[0],
                issuedOn: businessToday(options.timeZone),
                issuedBy: actor.id,
            })
                .run();
            for (const contractId of contractIds) {
                tx.insert(constanciaContracts).values({ constanciaId: newId, contractId }).run();
            }
            return newId;
        });
        return { constancia: presentConstancia(app.db, id) };
    });
    app.get("/constancias/:id", { onRequest: app.requireUser }, async (request, reply) => {
        const constancia = presentConstancia(app.db, request.params.id);
        if (!constancia) {
            return reply.code(404).send({ error: "not_found", message: "Esa constancia no existe." });
        }
        return { constancia };
    });
    /** Verify a constancia from the code printed on it. */
    app.get("/constancias/lookup/:code", { onRequest: app.requireUser }, async (request, reply) => {
        const stored = toStoredLookupCode(request.params.code);
        if (stored === null) {
            return reply.code(400).send({
                error: "invalid_lookup_code",
                message: "Ese código no tiene la forma de un código de verificación.",
            });
        }
        const row = app.db
            .select({ id: constancias.id })
            .from(constancias)
            .where(eq(constancias.lookupCode, stored))
            .get();
        if (!row) {
            return reply
                .code(404)
                .send({ error: "not_found", message: "No existe una constancia con ese código." });
        }
        return { constancia: presentConstancia(app.db, row.id) };
    });
};
//# sourceMappingURL=constancias.js.map