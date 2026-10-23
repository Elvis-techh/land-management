import { api } from "../../lib/api";

/**
 * The Configuración screen's settings, as the server keeps them. The meaning of
 * each one, and the limits on it, are in backend/src/lib/settings.ts; this is
 * the same shape.
 */
export interface MoraSettings {
  enabled: boolean;
  /** YYYY-MM-DD. Only cuotas due on or after it carry mora. */
  startsOn: string | null;
  calculation: "percent" | "fixed";
  /** 2 means 2 % of what is still unpaid of the cuota. */
  percent: number;
  fixedCents: number;
  /** Days after the due date before a cuota is late: for mora and «Atrasado». */
  graceDays: number;
  /** The most mora one cuota can collect. Null: no maximum. */
  capCents: number | null;
  frequency: "once" | "monthly";
  chargeDownPayment: boolean;
  paymentOrder: "mora" | "cuota";
}

export interface ContractSettings {
  reservationMonths: number;
  atRiskPayments: number;
}

export interface BusinessSettings {
  name: string;
  signatory: string;
  location: string;
  phone: string;
  email: string;
}

export interface AppSettings {
  mora: MoraSettings;
  contracts: ContractSettings;
  business: BusinessSettings;
}

/**
 * What is in force until the server has answered, which is also what the
 * server answers when nobody has saved anything: the values that were
 * hardcoded before the Configuración screen existed.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  mora: {
    enabled: false,
    startsOn: null,
    calculation: "percent",
    percent: 0,
    fixedCents: 0,
    graceDays: 5,
    capCents: null,
    frequency: "once",
    chargeDownPayment: false,
    paymentOrder: "mora",
  },
  contracts: {
    reservationMonths: 1,
    atRiskPayments: 2,
  },
  business: {
    name: "Inversiones Manuel",
    signatory: "Manuel Rivera",
    location: "Tela, Atlántida",
    phone: "+504 9315-4685",
    email: "edrosfamily@gmail.com",
  },
};

export function fetchSettings() {
  return api.get<AppSettings>("/api/settings");
}

/**
 * Save the screen. Every section is sent complete; the server only checks
 * permission for, and only files in Historial, the ones that changed.
 */
export function saveSettings(settings: AppSettings) {
  return api.put<AppSettings>("/api/settings", settings);
}
