import { eq } from "drizzle-orm";
import { z } from "zod";
import { appSettings } from "../db/schema.js";
import { DEFAULT_HEALTH_RULES } from "./contracts.js";
/**
 * The Configuración screen: what each setting is, what it may hold, and who
 * may change it.
 *
 * Three sections, each saved, permitted and filed in Historial on its own:
 *
 * - `mora`: the late-fee rules, plus the grace days. Grace lives here rather
 *   than under contracts because one number decides both when a mora starts and
 *   when a contract turns «Atrasado» (the owner wanted those to agree), and so
 *   changing it is a mora decision. Only the supervisor makes those
 *   (`mora:edit` is locked, see lib/permissions.ts).
 * - `contracts`: how long a reservation lasts by default, and how many missed
 *   payments make a contract «En riesgo».
 * - `business`: the name, signature and contacts printed on receipts and
 *   constancias.
 *
 * Every default below is the value that was hardcoded before this file
 * existed, so a database nobody has configured behaves exactly as it did.
 */
/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */
const isoDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "invalid date");
const text = (max) => z.string().trim().min(1).max(max);
const moraSchema = z.object({
    /** Off until the supervisor switches it on. */
    enabled: z.boolean(),
    /**
     * YYYY-MM-DD. Only cuotas falling due on or after this day ever carry mora.
     * Null while mora has never been switched on.
     */
    startsOn: isoDate.nullable(),
    /** A percentage of what is still unpaid of the cuota, or a fixed amount. */
    calculation: z.enum(["percent", "fixed"]),
    /** 2 means 2 %. Of what is STILL UNPAID of the cuota when the mora is charged. */
    percent: z.number().finite().min(0).max(100),
    fixedCents: z.number().int().min(0).max(100_000_000_00),
    /** Days after the due date before a cuota is late: for mora and for «Atrasado». */
    graceDays: z.number().int().min(0).max(31),
    /** The most mora one cuota can collect, however long it stays late. Null: no maximum. */
    capCents: z.number().int().min(1).max(100_000_000_00).nullable(),
    /** Charged once per late cuota, or again every month it stays late. */
    frequency: z.enum(["once", "monthly"]),
    /** Whether a late prima carries mora too. */
    chargeDownPayment: z.boolean(),
    /** What a payment covers first when both a mora and a cuota are owed. */
    paymentOrder: z.enum(["mora", "cuota"]),
});
const contractsSchema = z.object({
    /** How far out «Nuevo contrato» suggests a reservation's expiry, in months. */
    reservationMonths: z.number().int().min(1).max(12),
    /** Missed payments at which a contract is «En riesgo» rather than «Atrasado». */
    atRiskPayments: z.number().int().min(1).max(12),
});
const businessSchema = z.object({
    /** The trading name, printed under the logo. */
    name: text(80),
    /** Whose signature appears above "Firma Autorizada". */
    signatory: text(80),
    location: text(80),
    phone: text(40),
    email: z.string().trim().max(120).pipe(z.email()),
});
export const SETTINGS_SECTIONS = ["mora", "contracts", "business"];
const SCHEMAS = {
    mora: moraSchema,
    contracts: contractsSchema,
    business: businessSchema,
};
/**
 * What a whole save may carry: any of the sections, each one complete.
 *
 * Complete rather than a patch, like the permissions screen: the screen sends
 * what it shows, and what is stored is then exactly what somebody saw.
 */
export const settingsUpdateSchema = z.object({
    mora: moraSchema.optional(),
    contracts: contractsSchema.optional(),
    business: businessSchema.optional(),
});
/** Who may change each section. */
export const SECTION_CAPABILITY = {
    mora: "mora:edit",
    contracts: "settings:edit",
    business: "settings:edit",
};
/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */
export const DEFAULT_SETTINGS = {
    mora: {
        enabled: false,
        startsOn: null,
        calculation: "percent",
        // Zero rather than a guessed rate: how much a late customer pays is the
        // owner's number to type, and mora cannot be switched on while it is zero.
        percent: 0,
        fixedCents: 0,
        graceDays: DEFAULT_HEALTH_RULES.graceDays,
        capCents: null,
        frequency: "once",
        chargeDownPayment: false,
        paymentOrder: "mora",
    },
    contracts: {
        reservationMonths: 1,
        atRiskPayments: DEFAULT_HEALTH_RULES.atRiskPayments,
    },
    // The strings from the official receipt template, which lived in
    // frontend/src/lib/business.ts until they became editable.
    business: {
        name: "Inversiones Manuel",
        signatory: "Manuel Rivera",
        location: "Tela, Atlántida",
        phone: "+504 9315-4685",
        email: "edrosfamily@gmail.com",
    },
};
/* -------------------------------------------------------------------------- */
/* Reading and writing                                                         */
/* -------------------------------------------------------------------------- */
/**
 * One section as stored, laid over its defaults.
 *
 * Laid over rather than used as-is so a setting added to a section after it
 * was saved reads as its default instead of as missing. A stored value that no
 * longer passes the schema (only possible by editing the database by hand) is
 * dropped for the defaults rather than allowed to reach the arithmetic, or to
 * fail every screen that reads it.
 */
function readSection(key, stored) {
    const fallback = DEFAULT_SETTINGS[key];
    if (stored === undefined) {
        return fallback;
    }
    try {
        const parsed = SCHEMAS[key].safeParse({ ...fallback, ...JSON.parse(stored) });
        return parsed.success ? parsed.data : fallback;
    }
    catch {
        return fallback;
    }
}
/** Every section, as it stands now. One small read; there are three rows at most. */
export function readSettings(db) {
    const rows = db.select({ key: appSettings.key, value: appSettings.value }).from(appSettings).all();
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    return {
        mora: readSection("mora", stored.get("mora")),
        contracts: readSection("contracts", stored.get("contracts")),
        business: readSection("business", stored.get("business")),
    };
}
/** Store one section, replacing what was there. Call inside the audit's transaction. */
export function writeSection(db, key, value, actorId) {
    const encoded = JSON.stringify(value);
    const now = new Date().toISOString();
    db.insert(appSettings)
        .values({ key, value: encoded, updatedBy: actorId, updatedAt: now })
        .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: encoded, updatedBy: actorId, updatedAt: now },
    })
        .run();
}
/** Forget a section, so it follows the defaults again. Used by the tests. */
export function clearSection(db, key) {
    db.delete(appSettings).where(eq(appSettings.key, key)).run();
}
/** The two numbers `assessContract` needs, from wherever they are kept. */
export function healthRulesOf(settings) {
    return {
        graceDays: settings.mora.graceDays,
        atRiskPayments: settings.contracts.atRiskPayments,
    };
}
/* -------------------------------------------------------------------------- */
/* The rules a save must keep                                                  */
/* -------------------------------------------------------------------------- */
/**
 * Why this mora configuration cannot be saved, or null when it can.
 *
 * Beyond the shape the schema checks, two promises made to the owner:
 *
 * - Mora is never charged backwards. Switching it on, or moving its start date,
 *   needs a start date of today or later, so no cuota that fell due before
 *   anybody decided to charge mora ever carries one. A start date already in
 *   the past is fine to keep while other settings change: that only means mora
 *   has been running since then.
 * - Mora that is on charges something. A zero rate would look switched on and
 *   charge nothing, which is the same as off, only harder to notice.
 */
export function moraProblem(before, after, today) {
    if (!after.enabled) {
        return null;
    }
    if (after.startsOn === null) {
        return "Para cobrar mora, elige desde qué fecha se cobra.";
    }
    const startsAnew = !before.enabled || before.startsOn !== after.startsOn;
    if (startsAnew && after.startsOn < today) {
        return "La mora no se cobra hacia atrás: «Desde» tiene que ser hoy o una fecha futura.";
    }
    if (after.calculation === "percent" && after.percent <= 0) {
        return "Escribe el porcentaje de mora.";
    }
    if (after.calculation === "fixed" && after.fixedCents <= 0) {
        return "Escribe el monto fijo de mora.";
    }
    return null;
}
/** Is this section, as sent, any different from what is stored? */
export function sectionChanged(current, next) {
    // Field by field, so the order the keys happen to be in cannot make two equal
    // sections look different.
    const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
    const a = current;
    const b = next;
    return [...keys].some((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}
//# sourceMappingURL=settings.js.map