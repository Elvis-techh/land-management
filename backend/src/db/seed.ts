import { randomUUID } from "node:crypto";

import { loadConfig } from "../config/env.js";
import { hashPassword } from "../lib/password.js";
import { createDb } from "./client.js";
import { contracts, customers, lots, payments, projects, users } from "./schema.js";

/**
 * Fills an empty database with the data the prototype showed, so the app has
 * something real to display before anyone types a record in.
 *
 * Refuses to run if users already exist, so it can never overwrite live data.
 */
const config = loadConfig();
const { db, sqlite } = createDb(config.databasePath);

const existing = db.select({ id: users.id }).from(users).all();

if (existing.length > 0) {
  console.log("Database already has users — seed skipped.");
  sqlite.close();
  process.exit(0);
}

const lempiras = (amount: number) => Math.round(amount * 100);

const ownerId = randomUUID();
const staffId = randomUUID();

/*
 * `areaUnit` is how each project's areas are WRITTEN, not how they are stored —
 * every area below is square metres, always. Monte Real is seeded in varas
 * cuadradas so the unit handling is visible from the first run.
 */
const projectRows = [
  { id: randomUUID(), name: "Proyecto Santiago Etapa 1", areaUnit: "m2" },
  { id: randomUUID(), name: "Proyecto Santiago Etapa 2", areaUnit: "m2" },
  { id: randomUUID(), name: "Valle Verde", areaUnit: "m2" },
  { id: randomUUID(), name: "Monte Real", areaUnit: "vara2" },
];

const projectId = (name: string) => {
  const found = projectRows.find((project) => project.name === name);
  if (!found) {
    throw new Error(`Unknown project: ${name}`);
  }
  return found.id;
};

/*
 * Phones are seeded in E.164, the shape they are stored in — see
 * src/lib/phone.ts. The interface still shows and accepts "9944-7781".
 */
const customerRows = [
  { id: randomUUID(), fullName: "José Rodríguez", identification: "0801-1985-04412", phone: "+50499447781", email: "jrodriguez@correo.hn", address: "Col. Las Colinas, Tegucigalpa", customerSince: 2024, notes: "Prefiere que le escriban por WhatsApp en las tardes." },
  { id: randomUUID(), fullName: "Roberto Cruz", identification: "0501-1979-00238", phone: "+50498713320", email: null, address: "Barrio El Centro, San Pedro Sula", customerSince: 2025, notes: null },
  { id: randomUUID(), fullName: "Carlos Mendoza", identification: "0801-1990-11207", phone: "+50499824471", email: "cmendoza@correo.hn", address: "Res. El Trapiche, Tegucigalpa", customerSince: 2024, notes: "Paga por transferencia los primeros días del mes." },
  { id: randomUUID(), fullName: "Ana Lucía Paz", identification: "0703-1988-00951", phone: "+50499152093", email: "alpaz@correo.hn", address: "Col. Satélite, La Ceiba", customerSince: 2023, notes: null },
  { id: randomUUID(), fullName: "Elena Castillo", identification: "0801-1975-08830", phone: "+50499036612", email: null, address: "Col. Kennedy, Tegucigalpa", customerSince: 2022, notes: "Contrato pagado por completo en 2025." },
  { id: randomUUID(), fullName: "María Fernández", identification: "0601-1992-02274", phone: "+50499581104", email: "mfernandez@correo.hn", address: "Col. Modelo, Comayagua", customerSince: 2025, notes: "Contactar al esposo, Luis, al 9958-1105 si no contesta." },
  // Nobody has put her on a contract yet: a real cartera is mostly people who
  // asked once. She is also the only seeded record the delete button will
  // actually let go of, and the only one the "Sin contrato activo" filter finds.
  { id: randomUUID(), fullName: "Sofía Núñez", identification: "0801-1996-03318", phone: "+50497720145", email: null, address: "Col. Miraflores, Tegucigalpa", customerSince: 2026, notes: "Preguntó por lotes de esquina en Valle Verde; no ha vuelto." },
];

const customerId = (fullName: string) => {
  const found = customerRows.find((customer) => customer.fullName === fullName);
  if (!found) {
    throw new Error(`Unknown customer: ${fullName}`);
  }
  return found.id;
};

/** [lot code, project, area, base price, holder or null, contract code, kind, paid so far] */
const lotSpecs: Array<[string, string, number, number, string | null, string, string, number]> = [
  ["A-07", "Proyecto Santiago Etapa 1", 320, 185_000, "José Rodríguez", "CT-2026-014", "reservation", 158_250],
  ["A-12", "Proyecto Santiago Etapa 1", 298, 172_000, null, "", "", 0],
  ["B-03", "Proyecto Santiago Etapa 2", 310, 178_500, "Roberto Cruz", "CT-2026-021", "reservation", 35_000],
  ["B-14", "Proyecto Santiago Etapa 2", 340, 196_000, "Carlos Mendoza", "CT-2025-088", "reservation", 154_000],
  ["C-02", "Valle Verde", 285, 164_000, "Ana Lucía Paz", "CT-2025-052", "reservation", 145_500],
  ["C-08", "Valle Verde", 305, 176_000, null, "", "", 0],
  ["D-04", "Monte Real", 330, 210_000, "Elena Castillo", "CT-2024-007", "contract", 210_000],
  ["D-11", "Monte Real", 312, 198_500, "María Fernández", "CT-2026-003", "reservation", 147_300],
];

const ownerPassword = await hashPassword("lindero123");
const staffPassword = await hashPassword("asociado123");

db.transaction((tx) => {
  tx.insert(users)
    .values([
      { id: ownerId, email: "gerencia@lindero.hn", name: "Gerencia", role: "owner", passwordHash: ownerPassword },
      { id: staffId, email: "asociado@lindero.hn", name: "Asociado", role: "staff", passwordHash: staffPassword },
    ])
    .run();

  tx.insert(projects).values(projectRows).run();
  tx.insert(customers).values(customerRows).run();

  for (const [code, project, areaM2, basePrice, holder, contractCode, kind, paid] of lotSpecs) {
    const lotId = randomUUID();

    tx.insert(lots)
      .values({
        id: lotId,
        projectId: projectId(project),
        code,
        areaM2,
        basePriceCents: lempiras(basePrice),
      })
      .run();

    if (!holder) {
      continue;
    }

    const contractId = randomUUID();

    tx.insert(contracts)
      .values({
        id: contractId,
        code: contractCode,
        lotId,
        customerId: customerId(holder),
        kind,
        status: "active",
        salePriceCents: lempiras(basePrice),
      })
      .run();

    // One payment standing in for the history so far. The real schedule and
    // individual installments arrive with the payments feature; what matters
    // now is that paid-to-date is SUMMED from this table, never stored.
    if (paid > 0) {
      tx.insert(payments)
        .values({
          id: randomUUID(),
          contractId,
          amountCents: lempiras(paid),
          originalAmountCents: lempiras(paid),
          originalCurrency: "HNL",
          exchangeRate: "1",
          paidOn: "2026-08-01",
          method: "transfer",
          type: "installment",
          recordedBy: ownerId,
        })
        .run();
    }
  }
});

sqlite.close();

console.log(`Seeded ${config.databasePath}`);
console.log("  Supervisor  gerencia@lindero.hn / lindero123");
console.log("  Asociado    asociado@lindero.hn / asociado123");
