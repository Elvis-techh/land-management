import { useEffect, useRef, useState } from "react";
import { useRememberedState } from "../../lib/viewMemory";

import { businessTimeZone } from "../../lib/businessTime";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney } from "../../lib/money";
import { ROLE_LABELS } from "../../lib/permissions";
import type { ContractStatus } from "../../types";
import { KIND_LABELS, STATUS_PRESENTATION } from "../contracts/contractPresentation";
import { paymentTypeLabel } from "../receipts/paymentType";
import { METHOD_LABELS } from "../receipts/transactionFilters";
import type { AuditAction, AuditEvent, AuditFilters, AuditPage as AuditPageData } from "./api";
import { NO_AUDIT_FILTERS, fetchAudit } from "./api";
import type { AuditOrder } from "./AuditToolbar";
import { AuditToolbar, countActiveAuditFilters } from "./AuditToolbar";
import { formatAuditList } from "./auditLines";

const PAGE_SIZE = 25;

const actionPresentation: Record<AuditAction, { label: string; stampClass: string }> = {
  create: { label: "Creado", stampClass: "stamp success" },
  update: { label: "Editado", stampClass: "stamp neutral" },
  reprice: { label: "Cambio de precio", stampClass: "stamp clay" },
  archive: { label: "Archivado", stampClass: "stamp danger" },
  restore: { label: "Restaurado", stampClass: "stamp success" },
  delete: { label: "Eliminado", stampClass: "stamp danger" },
  cancel: { label: "Cancelado", stampClass: "stamp danger" },
  reassign_lot: { label: "Lote corregido", stampClass: "stamp clay" },
  replace: { label: "Reemplazado por adenda", stampClass: "stamp clay" },
  reverse: { label: "Reversado", stampClass: "stamp danger" },
  mora_charge: { label: "Mora cargada", stampClass: "stamp clay" },
  mora_remove: { label: "Mora quitada", stampClass: "stamp danger" },
  mora_rule: { label: "Regla de mora", stampClass: "stamp clay" },
  mora_forgive: { label: "Mora perdonada", stampClass: "stamp success" },
  mora_unforgive: { label: "Perdón de mora quitado", stampClass: "stamp danger" },
  // No longer written — sign-ins are kept on the account, not here — but the
  // rows recorded before that are still on file and still have to read.
  login: { label: "Inicio de sesión", stampClass: "stamp neutral" },
  logout: { label: "Cierre de sesión", stampClass: "stamp neutral" },
};

/** Field names as staff would say them, rather than as the database spells them. */
const fieldLabels: Record<string, string> = {
  code: "Lote",
  // A contract's lot, corrected — see POST /contracts/:id/reassign-lot.
  lotCode: "Lote",
  lotId: "Id del lote",
  fullName: "Cliente",
  identification: "Identidad",
  phone: "Teléfono",
  email: "Correo",
  address: "Dirección",
  customerSince: "Cliente desde",
  notes: "Notas",
  projectId: "Proyecto",
  areaM2: "Área",
  basePriceCents: "Precio base",
  archivedAt: "Archivado",
  // Account changes, from the Usuarios screen.
  name: "Nombre",
  role: "Rol",
  deactivatedAt: "Cuenta desactivada",
  passwordResetAt: "Contraseña cambiada",
  // A contract's terms — edits, reprices, and the two sides of an adenda.
  status: "Situación",
  kind: "Reserva o contrato",
  saleType: "Forma de pago",
  salePriceCents: "Precio de venta",
  downPaymentCents: "Prima",
  termMonths: "Plazo (meses)",
  monthlyPaymentCents: "Cuota",
  dueDay: "Día de pago",
  signedOn: "Firma",
  firstDueOn: "Primera cuota",
  expiresOn: "Vence la reserva",
  paidToDateCents: "Pagado",
  settlement: "Lo ya pagado",
  replacedBy: "Reemplazado por",
  replaces: "Reemplaza a",
  // A payment corrected, and a receipt voided — which restates the whole
  // receipt, since issuing one leaves no row of its own.
  amountCents: "Monto",
  paidOn: "Fecha del pago",
  method: "Método",
  type: "Tipo",
  reference: "Referencia",
  receiptNumber: "Número de recibo",
  customerName: "Cliente",
  // Mora put on a contract by hand, «Cargar mora» — see routes/mora.ts.
  moraInstallment: "Cuota",
  moraIncurredOn: "Fecha de la mora",
  moraForgivenOn: "Mora perdonada el",
  // A contract's own mora rule — see POST /contracts/:id/mora/rule.
  moraRule: "Regla de mora",
  moraRuleFrom: "Regla desde",
  // Who a receipt says paid — see PATCH /receipts/:id/paid-by.
  paidBy: "Pagado por",
  issuedBy: "Emitido por",
  totalCents: "Total",
  lines: "Lotes",
  // A file taken off a contract or a receipt. Putting one there is not filed.
  removedDocument: "Documento quitado",
  removedFile: "Comprobante quitado",
  // The Configuración screen: the mora, the contract defaults, the business.
  enabled: "Cobrar mora",
  startsOn: "Mora desde",
  calculation: "Cómo se calcula la mora",
  percent: "Porcentaje de mora",
  fixedCents: "Mora fija",
  graceDays: "Días de gracia",
  capCents: "Máximo de mora por cuota",
  minUnpaidCents: "Sin mora si falta menos de",
  frequency: "Cuándo se cobra la mora",
  chargeDownPayment: "La prima lleva mora",
  paymentOrder: "Un pago cubre primero",
  reservationMonths: "Una reserva dura (meses)",
  atRiskPayments: "«En riesgo» desde (pagos atrasados)",
  signatory: "Firma",
  location: "Ubicación",
};

/** The Configuración screen's choices, as the screen words them. */
const settingChoiceLabels: Record<string, Record<string, string>> = {
  calculation: { percent: "% de lo que falta de la cuota", fixed: "Monto fijo" },
  frequency: { once: "Una vez por cuota atrasada", monthly: "Cada mes que siga atrasada" },
  paymentOrder: { mora: "La mora", cuota: "La cuota" },
  moraRule: { general: "La general", none: "Sin mora", own: "Regla propia" },
};

/** Money fields are stored in centavos and must not be printed raw. */
const moneyFields = new Set([
  "basePriceCents",
  "salePriceCents",
  "amountCents",
  "downPaymentCents",
  "monthlyPaymentCents",
  "paidToDateCents",
  "totalCents",
  "fixedCents",
  "capCents",
  "minUnpaidCents",
]);

function formatValue(field: string, value: unknown, money: MoneyView): string {
  if (field === "capCents" && value === null) {
    return "Sin máximo";
  }
  if (field === "minUnpaidCents" && value === null) {
    return "Sin mínimo";
  }
  if (field === "paidBy" && value === null) {
    return "El cliente";
  }
  if (field === "moraInstallment" && typeof value === "number") {
    return value === 0 ? "Prima" : `Cuota ${value}`;
  }
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "boolean") {
    return value ? "Sí" : "No";
  }
  if (field === "percent" && typeof value === "number") {
    return `${value} %`;
  }
  if (typeof value === "string" && settingChoiceLabels[field]?.[value]) {
    return settingChoiceLabels[field][value];
  }
  if (moneyFields.has(field) && typeof value === "number") {
    return formatMoney(cents(value), money);
  }
  if (field === "areaM2") {
    return `${String(value)} m²`;
  }
  // The lines of a receipt are a list of objects, which `String()` would turn
  // into "[object Object]".
  if (Array.isArray(value)) {
    return formatAuditList(value, money);
  }
  if (field === "method" && typeof value === "string") {
    return METHOD_LABELS.find((option) => option.value === value)?.label ?? value;
  }
  if (field === "type" && typeof value === "string") {
    return paymentTypeLabel(value);
  }
  if (field === "kind" && typeof value === "string" && value in KIND_LABELS) {
    return KIND_LABELS[value as keyof typeof KIND_LABELS];
  }
  // "replaced" is how the database spells it; "Reemplazado" is how it is said.
  if (field === "status" && typeof value === "string" && value in STATUS_PRESENTATION) {
    return STATUS_PRESENTATION[value as ContractStatus].label;
  }
  return String(value);
}

/** Only the fields that actually differ, so the reader is not made to hunt. */
function changedFields(event: AuditEvent): string[] {
  const keys = new Set([...Object.keys(event.before ?? {}), ...Object.keys(event.after ?? {})]);

  return [...keys].filter(
    (key) => JSON.stringify(event.before?.[key]) !== JSON.stringify(event.after?.[key]),
  );
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  // In the OFFICE's clock, not the reader's. This is a log of when things were
  // done at the counter, so a laptop set to another zone must not restate the
  // history three hours out — see lib/businessTime.ts.
  return parsed.toLocaleString("es-HN", {
    timeZone: businessTimeZone(),
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** How long typing has to pause before the server is asked, so each key is not a request. */
const SEARCH_DELAY_MS = 300;

interface AuditPageProps {
  money: MoneyView;
}

export function AuditPage({ money }: AuditPageProps) {
  const [offset, setOffset] = useRememberedState("audit.offset", 0);
  // #6: search, filters and sort, remembered while moving between tabs like
  // every other list. They are sent to the server: see routes/audit.ts.
  const [search, setSearch] = useRememberedState("audit.search", "");
  const [filters, setFilters] = useRememberedState<AuditFilters>("audit.filters", NO_AUDIT_FILTERS);
  const [order, setOrder] = useRememberedState<AuditOrder>("audit.order", "desc");
  const [askedSearch, setAskedSearch] = useState(search);

  const [data, setData] = useState<AuditPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may fill the screen: an answer to an older search
  // that arrives late must not replace the one being typed now.
  const latest = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setAskedSearch(search), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const request = ++latest.current;
    setLoading(true);

    fetchAudit({ limit: PAGE_SIZE, offset, search: askedSearch, filters, order })
      .then((page) => {
        if (request === latest.current) {
          setData(page);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (request === latest.current) {
          setError(caught instanceof Error ? caught.message : "No se pudo cargar el historial.");
        }
      })
      .finally(() => {
        if (request === latest.current) {
          setLoading(false);
        }
      });
  }, [offset, askedSearch, filters, order]);

  // A new question starts again on its first page.
  const changeSearch = (next: string) => {
    setSearch(next);
    setOffset(0);
  };
  const changeFilters = (next: AuditFilters) => {
    setFilters(next);
    setOffset(0);
  };
  const changeOrder = (next: AuditOrder) => {
    setOrder(next);
    setOffset(0);
  };
  const clearSearchAndFilters = () => {
    changeSearch("");
    setAskedSearch("");
    changeFilters(NO_AUDIT_FILTERS);
  };

  const narrowed = search.trim() !== "" || countActiveAuditFilters(filters) > 0;

  const toolbar = (
    <AuditToolbar
      filters={filters}
      onFiltersChange={changeFilters}
      order={order}
      onOrderChange={changeOrder}
      search={search}
      onSearchChange={changeSearch}
      total={data?.total ?? null}
    />
  );

  if (data === null) {
    return (
      <section className="panel active">
        {toolbar}
        <div className="card">
          {error === null ? (
            <p className="state-message">Cargando historial…</p>
          ) : (
            <p className="form-error">{error}</p>
          )}
        </div>
      </section>
    );
  }

  const { events, total } = data;
  const hasPrevious = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <section className="panel active">
      {toolbar}
      {error !== null && <p className="form-error">{error}</p>}
      <div className={loading ? "card audit-loading" : "card"} aria-busy={loading}>
        <div className="card-head">
          <h3>Historial de cambios</h3>
          <span className="tag">{total} registros</span>
        </div>

        {events.length === 0 ? (
          narrowed ? (
            <div className="state-message">
              <p>
                {search.trim() !== ""
                  ? `Ningún cambio coincide con «${search.trim()}».`
                  : "Ningún cambio coincide con los filtros."}
              </p>
              <button type="button" className="link-btn" onClick={clearSearchAndFilters}>
                Ver todo el historial
              </button>
            </div>
          ) : (
            <p className="state-message">Todavía no hay movimientos registrados.</p>
          )
        ) : (
          <div className="audit-list">
            {events.map((event) => {
              /*
               * Falls back rather than trusting the map to be complete.
               *
               * The server can record an action this screen has never heard of
               * — it did, for a while, with `restore` — and reading a missing
               * key off the table would throw while rendering, taking the WHOLE
               * history down over one unrecognised row. The history is the last
               * thing that should break, so an unknown action is shown as
               * itself instead.
               */
              const action = actionPresentation[event.action] ?? {
                label: event.action,
                stampClass: "stamp neutral",
              };
              const fields = changedFields(event);

              return (
                <article key={event.id} className="audit-item">
                  <div className="audit-head">
                    <span className={action.stampClass}>{action.label}</span>
                    {event.entityLabel && <span className="code-badge">{event.entityLabel}</span>}
                    <span className="audit-actor">
                      {event.actorName}
                      <span className="audit-role">{ROLE_LABELS[event.actorRole]}</span>
                    </span>
                    <time className="audit-time">{formatTimestamp(event.createdAt)}</time>
                  </div>

                  {fields.length > 0 && (
                    <div className="audit-diff">
                      {fields.map((field) => (
                        <div key={field} className="audit-diff-row">
                          <span className="audit-field">{fieldLabels[field] ?? field}</span>
                          <span className="audit-before">
                            {formatValue(field, event.before?.[field], money)}
                          </span>
                          <span className="audit-arrow" aria-hidden="true">
                            →
                          </span>
                          <span className="audit-after">
                            {formatValue(field, event.after?.[field], money)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {event.reason && <p className="audit-reason">“{event.reason}”</p>}
                </article>
              );
            })}
          </div>
        )}

        {(hasPrevious || hasNext) && (
          <div className="audit-pager">
            <button
              type="button"
              className="btn-secondary"
              disabled={!hasPrevious}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Anteriores
            </button>
            <span className="audit-range">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} de {total}
            </span>
            <button
              type="button"
              className="btn-secondary"
              disabled={!hasNext}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Siguientes
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
