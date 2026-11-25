import type { Capability } from "../../lib/permissions";

/**
 * How each capability reads to a person, grouped the way somebody thinks about
 * the work rather than the way the code is organised.
 *
 * Every entry says what the associate would be able to DO, in the words used
 * elsewhere in the interface — "Archivar lotes", not "lot:archive".
 */
export const CAPABILITY_GROUPS: ReadonlyArray<{
  title: string;
  description: string;
  items: Array<{ capability: Capability; label: string; hint?: string }>;
}> = [
  {
    title: "Lotes",
    description: "El inventario de terrenos.",
    items: [
      { capability: "lot:create", label: "Crear lotes" },
      { capability: "lot:edit", label: "Editar lotes" },
      {
        capability: "lot:archive",
        label: "Archivar lotes",
        hint: "Los saca del inventario activo; nada se elimina.",
      },
    ],
  },
  {
    title: "Proyectos",
    description: "Los desarrollos que agrupan los lotes.",
    items: [
      { capability: "project:create", label: "Crear proyectos" },
      { capability: "project:edit", label: "Editar proyectos y su unidad de área" },
      { capability: "project:archive", label: "Archivar proyectos" },
    ],
  },
  {
    title: "Clientes y contratos",
    description: "El trabajo del día a día.",
    items: [
      { capability: "customer:create", label: "Registrar clientes" },
      { capability: "customer:edit", label: "Editar clientes" },
      {
        capability: "customer:delete",
        label: "Eliminar clientes",
        hint: "Solo a quien nunca ha tenido un contrato. Exige escribir un motivo.",
      },
      { capability: "contract:create", label: "Crear contratos y reservas" },
      {
        capability: "contract:edit",
        label: "Editar los términos de un contrato",
        hint:
          "Plazo, cuota, día de pago, fechas y notas. Siempre exige escribir un motivo, " +
          "porque cambia lo que se firmó. El precio de venta va aparte.",
      },
      {
        capability: "contract:reprice",
        label: "Cambiar el precio de venta de un contrato",
        hint:
          "Cambia lo que el cliente debe. Se puede ceder «Editar los términos» sin ceder " +
          "esto: mover un día de cobro y mover un saldo no son la misma confianza.",
      },
      {
        capability: "contract:reassign_lot",
        label: "Corregir el lote de un contrato",
        hint:
          "Solo para un lote mal capturado por error: el contrato pasa a otro lote y conserva " +
          "sus pagos. No es para vender otro lote — eso es un contrato nuevo. Exige escribir " +
          "un motivo.",
      },
      {
        capability: "contract:amend",
        label: "Registrar adendas",
        hint:
          "Un nuevo acuerdo sobre contratos vigentes: los cierra como «Reemplazado», con sus " +
          "pagos y recibos intactos, y abre contratos nuevos con el nuevo precio y plazo. " +
          "Exige escribir un motivo.",
      },
      {
        capability: "contract:transfer",
        label: "Traspasar contratos a otra persona",
        hint:
          "Cambia quién es el titular: los pagos, el saldo y las cuotas pasan con el lote al " +
          "nuevo titular. Los recibos ya emitidos se quedan con su nombre. Exige escribir un " +
          "motivo.",
      },
      {
        capability: "contract:cancel",
        label: "Cancelar contratos",
        hint: "Libera el lote y deja el contrato en el historial.",
      },
      {
        capability: "contract:certify",
        label: "Emitir constancias de cancelación total",
        hint:
          "El documento que dice que un contrato pagado ya no debe nada, el que se lleva " +
          "al notario. Solo para contratos en estado Pagado.",
      },
    ],
  },
  {
    title: "Dinero",
    description: "Lo que toca los saldos. Piénsalo dos veces antes de ceder estos.",
    items: [
      { capability: "payment:record", label: "Registrar pagos" },
      {
        capability: "payment:reverse",
        label: "Reversar pagos y anular recibos",
        hint:
          "Escribe una reversa: el pago original queda a la vista y deja de contar. " +
          "No permite cambiarle el monto — eso va aparte.",
      },
      {
        capability: "payment:edit",
        label: "Corregir una transacción ya registrada",
        hint:
          "Reescribe el monto o la fecha de un pago en su lugar, en vez de reversarlo. " +
          "La cifra anterior sobrevive solo en el historial, así que es más confianza " +
          "que reversar. Exige escribir un motivo.",
      },
      {
        capability: "mora:charge",
        label: "Cargar, perdonar o quitar mora en un contrato",
        hint:
          "Pone mora a mano en una cuota, con fecha y motivo: la que el cliente ya pagó o " +
          "acordó antes de que la mora estuviera activada. También perdona mora ya cobrada. " +
          "Cambia lo que el cliente debe y queda en el historial.",
      },
      {
        capability: "price:change",
        label: "Cambiar el precio de un lote con contrato",
        hint: "Exige escribir un motivo, que queda en el historial.",
      },
      {
        capability: "rate:edit",
        label: "Cambiar la tasa de cambio",
        hint: "Solo afecta lo que se muestra en pantalla, nunca un saldo.",
      },
    ],
  },
  {
    title: "Configuración",
    description: "Los ajustes del negocio. La mora no está aquí: es siempre del supervisor.",
    items: [
      {
        capability: "settings:edit",
        label: "Cambiar la configuración de contratos y los datos del negocio",
        hint:
          "Cuánto dura una reserva, desde cuántos pagos atrasados un contrato está «En riesgo», " +
          "y el nombre, la firma y los contactos que salen en recibos y constancias.",
      },
    ],
  },
  {
    title: "Control",
    description: "Ver lo que ha pasado en el sistema.",
    items: [
      {
        capability: "audit:view",
        label: "Ver el historial",
        hint: "Quién cambió qué, cuándo y por qué.",
      },
    ],
  },
];

const LABELS = new Map<Capability, string>(
  CAPABILITY_GROUPS.flatMap((group) => group.items.map((item) => [item.capability, item.label] as const)),
);

/**
 * The words for a capability, «Archivar lotes» rather than `lot:archive`. One
 * the list above has never heard of is shown as it is, so it can't go missing.
 */
export function capabilityLabel(capability: string): string {
  return LABELS.get(capability as Capability) ?? capability;
}
