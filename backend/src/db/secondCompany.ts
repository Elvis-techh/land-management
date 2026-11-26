import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config/env.js";
import { hashPassword } from "../lib/password.js";
import { writeSection } from "../lib/settings.js";
import { companyForEmail, createCompany, openAccounts, syncCompanyEmails } from "./accounts.js";
import { companyFiles, openCompany } from "./companies.js";
import { contracts, customers, lots, payments, projects, users } from "./schema.js";

/** The second demo company's sign-in emails. The passwords are company 1's. */
export const SECOND_COMPANY_EMAILS = {
  owner: "gerencia@empresados.hn",
  staff: "asociado@empresados.hn",
};

/**
 * A second, small demo company beside the first, for the test site and a
 * laptop: signing in with its emails must show its records and none of the
 * first company's (docs/later-versions.md, section 1).
 *
 * Its own name on the receipts, one project, three lots and one customer
 * paying a contract, so nobody can mistake it for the first company. Skipped
 * when its emails already sign in somewhere.
 */
export async function seedSecondCompany(
  config: Pick<AppConfig, "databasePath" | "uploadsPath" | "companiesPath" | "accountsPath">,
  passwords: { owner: string; staff: string },
): Promise<string | null> {
  const accounts = openAccounts(config.accountsPath);

  try {
    if (companyForEmail(accounts.db, SECOND_COMPANY_EMAILS.owner) !== null) {
      return null;
    }

    const id = createCompany(accounts.db);
    const { company } = openCompany(id, companyFiles(config, id));

    try {
      const ownerId = randomUUID();
      const staffId = randomUUID();
      const projectId = randomUUID();
      const customerId = randomUUID();
      const lotIds = [randomUUID(), randomUUID(), randomUUID()];
      const contractId = randomUUID();
      const ownerHash = await hashPassword(passwords.owner);
      const staffHash = await hashPassword(passwords.staff);

      company.db.transaction((tx) => {
        tx.insert(users)
          .values([
            { id: ownerId, email: SECOND_COMPANY_EMAILS.owner, name: "Gerencia Empresa Dos", role: "owner", passwordHash: ownerHash },
            { id: staffId, email: SECOND_COMPANY_EMAILS.staff, name: "Asociado Empresa Dos", role: "staff", passwordHash: staffHash },
          ])
          .run();

        writeSection(
          tx,
          "business",
          {
            name: "Empresa de Prueba Dos",
            signatory: "Gerencia Empresa Dos",
            location: "Comayagua",
            phone: "+504 9000-0002",
            email: "contacto@empresados.hn",
          },
          ownerId,
        );

        tx.insert(projects).values({ id: projectId, name: "Lomas de la Empresa Dos", areaUnit: "m2" }).run();

        tx.insert(lots)
          .values(
            lotIds.map((lotId, index) => ({
              id: lotId,
              projectId,
              code: `D-0${index + 1}`,
              areaM2: 250,
              basePriceCents: 12_000_000,
            })),
          )
          .run();

        tx.insert(customers)
          .values({
            id: customerId,
            fullName: "Cliente de la Empresa Dos",
            identification: "0301-1990-00002",
            phone: "+50490000022",
            email: null,
            address: "Barrio Abajo, Comayagua",
            customerSince: 2026,
          })
          .run();

        tx.insert(contracts)
          .values({
            id: contractId,
            code: "CT-2026-001",
            lotId: lotIds[0]!,
            customerId,
            kind: "contract",
            saleType: "financed",
            status: "active",
            salePriceCents: 12_000_000,
            downPaymentCents: 1_200_000,
            termMonths: 36,
            monthlyPaymentCents: 300_000,
            dueDay: 15,
            signedOn: "2026-09-15",
          })
          .run();

        tx.insert(payments)
          .values(
            [
              ["2026-09-15", 1_200_000, "down_payment"],
              ["2026-10-15", 300_000, "installment"],
            ].map(([paidOn, amountCents, type]) => ({
              id: randomUUID(),
              contractId,
              amountCents: amountCents as number,
              originalAmountCents: amountCents as number,
              originalCurrency: "HNL",
              exchangeRate: "1",
              paidOn: paidOn as string,
              method: type === "down_payment" ? "cash" : "transfer",
              type: type as "down_payment" | "installment",
              recordedBy: ownerId,
            })),
          )
          .run();
      });

      syncCompanyEmails(accounts.db, id, Object.values(SECOND_COMPANY_EMAILS));
    } finally {
      company.sqlite.close();
    }

    return id;
  } finally {
    accounts.sqlite.close();
  }
}
