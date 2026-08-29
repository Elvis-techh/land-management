import { useCallback, useEffect, useState } from "react";

import type { MoneyView } from "../../lib/money";
import { cents, formatMoney } from "../../lib/money";
import { ROLE_LABELS } from "../../lib/permissions";
import type { AuditAction, AuditEvent, AuditPage as AuditPageData } from "./api";
import { fetchAudit } from "./api";

const PAGE_SIZE = 25;

const actionPresentation: Record<AuditAction, { label: string; stampClass: string }> = {
  create: { label: "Creado", stampClass: "stamp success" },
  update: { label: "Editado", stampClass: "stamp neutral" },
  reprice: { label: "Cambio de precio", stampClass: "stamp clay" },
  archive: { label: "Archivado", stampClass: "stamp danger" },
  delete: { label: "Eliminado", stampClass: "stamp danger" },
  cancel: { label: "Cancelado", stampClass: "stamp danger" },
  reverse: { label: "Reversado", stampClass: "stamp danger" },
  login: { label: "Inicio de sesión", stampClass: "stamp neutral" },
  logout: { label: "Cierre de sesión", stampClass: "stamp neutral" },
};

/** Field names as staff would say them, rather than as the database spells them. */
const fieldLabels: Record<string, string> = {
  code: "Lote",
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
};

/** Money fields are stored in centavos and must not be printed raw. */
const moneyFields = new Set(["basePriceCents", "salePriceCents", "amountCents"]);

function formatValue(field: string, value: unknown, money: MoneyView): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (moneyFields.has(field) && typeof value === "number") {
    return formatMoney(cents(value), money);
  }
  if (field === "areaM2") {
    return `${String(value)} m²`;
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

  return parsed.toLocaleString("es-HN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type State =
  | { status: "loading" }
  | { status: "ready"; data: AuditPageData }
  | { status: "error"; message: string };

interface AuditPageProps {
  money: MoneyView;
}

export function AuditPage({ money }: AuditPageProps) {
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async (nextOffset: number) => {
    setState({ status: "loading" });
    try {
      setState({
        status: "ready",
        data: await fetchAudit({ limit: PAGE_SIZE, offset: nextOffset }),
      });
    } catch (caught) {
      setState({
        status: "error",
        message: caught instanceof Error ? caught.message : "No se pudo cargar el historial.",
      });
    }
  }, []);

  useEffect(() => {
    void load(offset);
  }, [load, offset]);

  if (state.status === "loading") {
    return (
      <section className="panel active">
        <div className="card">
          <p className="state-message">Cargando historial…</p>
        </div>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="panel active">
        <div className="card">
          <p className="form-error">{state.message}</p>
        </div>
      </section>
    );
  }

  const { events, total } = state.data;
  const hasPrevious = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <section className="panel active">
      <div className="card">
        <div className="card-head">
          <h3>Historial de cambios</h3>
          <span className="tag">{total} registros</span>
        </div>

        {events.length === 0 ? (
          <p className="state-message">Todavía no hay movimientos registrados.</p>
        ) : (
          <div className="audit-list">
            {events.map((event) => {
              const action = actionPresentation[event.action];
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
