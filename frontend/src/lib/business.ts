import type { BusinessSettings } from "../features/settings/api";

/**
 * Who the receipt is FROM.
 *
 * Lindero is the name of the software; Inversiones Manuel is the name of the
 * business that hands a customer a piece of paper. The receipt used to be
 * headed "Lindero", which named the wrong one of the two — the customer has
 * never heard of the app and is not paying it.
 *
 * The details themselves (name, signature, location, phone, email) are set on
 * the Configuración screen and read with `useSettings()`. They started as the
 * strings from the official receipt template (`server.js` in
 * inversion_pdf_service), which are still the defaults. This file only builds
 * the lines that are made from them, so the receipt and the constancia compose
 * them the same way.
 */

/** "Gracias por su pago y su confianza en Inversiones Manuel." */
export function thankYou(business: BusinessSettings): string {
  return `Gracias por su pago y su confianza en ${business.name}.`;
}

/** The same line on the receipt that pays everything off. */
export function thankYouFinal(business: BusinessSettings): string {
  return `Gracias por completar su compra con ${business.name}. ¡Felicidades por su terreno!`;
}

/**
 * The footer's one-line contact strip, composed rather than stored whole so it
 * cannot drift out of step with the fields it is made from.
 */
export function contactLine(business: BusinessSettings): string {
  return [business.name, business.location, `Tel: ${business.phone}`, `Correo: ${business.email}`].join(
    " | ",
  );
}
