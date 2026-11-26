import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The accounts database: which companies exist, and which company each email
 * signs in to.
 *
 * Small on purpose, and separate from every company's own file (see
 * docs/later-versions.md, section 1). A company's records never come here;
 * this only says where to find them. Signup, the free month and payment add
 * their columns here later.
 */

/** Every company. Its id names its folder (see `companyFiles` in companies.ts). */
export const companies = sqliteTable("companies", {
  id: integer("id").primaryKey(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

/**
 * Which company an email signs in to: one email, one company.
 *
 * A copy of the emails in each company's own `users` table, kept in step by
 * the Usuarios routes and checked again whenever a company's file is opened
 * (`syncCompanyEmails` in accounts.ts). The company's own table stays the one
 * that holds the password and whether the account is active.
 */
export const accountEmails = sqliteTable(
  "account_emails",
  {
    email: text("email").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
  },
  (table) => [index("account_emails_company_idx").on(table.companyId)],
);
