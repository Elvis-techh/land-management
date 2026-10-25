import { formatDate } from "../contracts/contractPresentation";
import type { MoraSettings } from "./api";

/**
 * The mora section as the Configuración form holds it: numbers still the way
 * they were typed, so a half-typed "2." is not turned into something else.
 */
export interface MoraForm {
  enabled: boolean;
  startsOn: string;
  calculation: MoraSettings["calculation"];
  percent: string;
  fixed: string;
  graceDays: string;
  cap: string;
  minimum: string;
  frequency: MoraSettings["frequency"];
  chargeDownPayment: boolean;
  paymentOrder: MoraSettings["paymentOrder"];
}

/**
 * The mora rules read back as one sentence, under the switch, so whoever set
 * them sees what they add up to before pressing Guardar.
 *
 * It reads the form, not what is stored: the sentence follows every tap.
 */
export function moraSummary(mora: MoraForm): string {
  if (!mora.enabled) {
    return "Apagada. Ningún contrato lleva mora.";
  }

  const amount =
    mora.calculation === "percent"
      ? `${mora.percent.trim() || "0"} % de lo que falta de la cuota`
      : `L. ${mora.fixed.trim() || "0.00"} fijos`;
  const cap = mora.cap.trim() === "" ? "" : ` (hasta L. ${mora.cap.trim()} por cuota)`;
  const when =
    mora.frequency === "once" ? "una vez por cuota atrasada" : "cada mes que siga atrasada";
  const days = mora.graceDays.trim() || "0";
  const grace = days === "1" ? "1 día" : `${days} días`;
  const from = mora.startsOn === "" ? "desde la fecha que elijas" : `desde el ${formatDate(mora.startsOn)}`;
  const prima = mora.chargeDownPayment ? " La prima también lleva mora." : "";
  const minimum =
    mora.minimum.trim() === ""
      ? ""
      : ` No se cobra si de la cuota falta menos de L. ${mora.minimum.trim()}.`;

  return `Se cobrará ${amount}${cap}, ${when}, después de ${grace} de gracia, ${from}.${prima}${minimum}`;
}
