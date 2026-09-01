import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import { IconChevronDown, IconDrag, IconEye, IconEyeOff } from "../../components/Icons";
import { getInitials } from "../../lib/initials";
import type { Cents, MoneyView } from "../../lib/money";
import { formatMoney, formatMoneyParts } from "../../lib/money";
import { buildProjectAccents } from "../../lib/projectAccent";
import { HEALTH_PRESENTATION } from "../contracts/contractPresentation";
import type { Dashboard, Debtor } from "./api";
import { resetDashboardLayout, saveDashboardLayout } from "./api";
import { MonthlyBars } from "./MonthlyBars";
import type { DashboardLayout, SectionId } from "./dashboardSections";
import {
  SECTION_LABELS,
  dropSection,
  isDefaultLayout,
  moveSection,
  resolveLayout,
} from "./dashboardSections";
import {
  collectionRate,
  compareToPrevious,
  describeComparison,
  describeExpiry,
  formatDate,
  formatMonth,
  formatMonthName,
  pluralise,
} from "./dashboardPresentation";

interface DashboardPageProps {
  data: Dashboard;
  money: MoneyView;
  /** Reports a different month. `undefined` means "whatever month it is now". */
  onSelectMonth: (month: string | undefined) => void;
}

/**
 * The Panel General.
 *
 * Every other screen in Lindero answers a question about one ROW — this
 * contract, this customer, this lot. This one exists for the questions that
 * need every row at once, or the same row at two points in time, and it is
 * deliberately limited to those. A contract's progress is on the Contratos tab
 * and is not repeated here; what is here instead is what that tab cannot say:
 * whether September beat August, who stopped paying since last month, and what
 * falls due in February.
 *
 * Almost every figure is a link into the screen that can act on it. A number
 * nobody can follow anywhere is decoration.
 */
export function DashboardPage({ data, money, onSelectMonth }: DashboardPageProps) {
  const { income, collections, upcoming } = data;
  const rate = collectionRate(income.collectedCents, income.expectedCents);
  const collectedDelta = compareToPrevious(income.collectedCents, income.previousToDateCents);
  const payersDelta = compareToPrevious(income.payingCustomers, income.previousPayingCustomers);
  // Both deltas above compare the same span of both months, so this one
  // sentence describes either of them.
  const comparison = describeComparison(data.previousMonth, income.comparisonDays);

  // Projects keep the colour they have on Lotes, Clientes and Contratos.
  const accents = buildProjectAccents(data.projects.map((project) => project.projectName));

  /* ---------------------------------------------------------------------- */
  /* Arranging the screen                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * The arrangement being rendered, and — while the editor is open — the one
   * being worked on.
   *
   * Kept apart on purpose. The draft is what the reader is dragging around, so
   * Cancelar has something to throw away and a background refresh has something
   * it is not allowed to touch.
   */
  const [layout, setLayout] = useState<DashboardLayout>(() => resolveLayout(data.layout));
  const [draft, setDraft] = useState<DashboardLayout | null>(null);
  const [dragging, setDragging] = useState<SectionId | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Adopt an arrangement saved somewhere else — another tab, or this account
   * signing in on a second machine.
   *
   * Keyed on the CONTENT rather than on `data.layout` itself, which is a fresh
   * object out of JSON.parse on every poll: depending on its identity would
   * reset the arrangement every few seconds, and the state below would fight
   * the live-update refresh forever. The draft is deliberately not touched — a
   * refresh landing mid-edit must not throw away what somebody is doing.
   */
  const storedLayout = JSON.stringify(data.layout);

  useEffect(() => {
    setLayout(resolveLayout(JSON.parse(storedLayout) as DashboardLayout | null));
  }, [storedLayout]);

  const visible = draft ?? layout;
  const hiddenIds = useMemo(() => new Set(visible.hidden), [visible.hidden]);

  const save = async () => {
    if (!draft) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await saveDashboardLayout(draft);
      setLayout(draft);
      setDraft(null);
    } catch (caught) {
      // The arrangement stays on screen and the editor stays open, so nothing
      // somebody just spent a minute on is lost to a dropped connection.
      setError(caught instanceof Error ? caught.message : "No se pudo guardar el orden.");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError(null);

    try {
      await resetDashboardLayout();
      setLayout(resolveLayout(null));
      setDraft(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo restaurar el orden.");
    } finally {
      setSaving(false);
    }
  };

  /** The money cell used down the tables: tinted symbol, full-strength digits. */
  const moneyCell = (amount: Cents, className = "") => {
    const parts = formatMoneyParts(amount, money);

    return (
      <span className={`cell-money ${className}`}>
        <span className="currency-symbol">{parts.symbol}</span>
        {parts.value}
      </span>
    );
  };

  const sections: Record<SectionId, ReactNode> = {
    income: (
        <div className="dash-headline">
          <div className="card dash-hero">
            <p className="dash-hero-label">Cobrado en {formatMonthName(data.month)}</p>
            <p className="dash-hero-value">{formatMoney(income.collectedCents, money)}</p>

            <p className="dash-hero-meta">
              <span className={`dash-delta is-${collectedDelta.tone}`}>{collectedDelta.label}</span>
              <span>{comparison}</span>
            </p>

            {/*
              The figure that turns the number above into a judgement. A month
              that collected less than the last one may simply have had fewer
              cuotas falling due; only the rate can tell the two apart.
            */}
            {rate === null ? (
              <p className="dash-hero-rate is-quiet">
                No había cuotas programadas para {formatMonthName(data.month)}.
              </p>
            ) : (
              <div className="dash-hero-rate">
                <div className="dash-meter" role="presentation">
                  <span className={meterClass(rate)} style={{ width: `${Math.min(100, rate)}%` }} />
                </div>
                <p>
                  <strong>{rate} %</strong> de los {formatMoney(income.expectedCents, money)}{" "}
                  programados para el mes
                </p>
              </div>
            )}
          </div>

          <div className="dash-tiles">
            <StatTile
              label={data.isCurrentMonth ? "Por cobrar este mes" : "Quedó por cobrar"}
              value={formatMoney(income.stillDueCents, money)}
              detail={
                income.stillDueContracts === 0
                  ? "Todo al día"
                  : `${pluralise(
                      income.stillDueContracts,
                      "contrato",
                      "contratos",
                    )} con saldo del mes`
              }
              tone={income.stillDueCents > 0 ? "warn" : "good"}
            />

            <StatTile
              label="Clientes que pagaron"
              value={String(income.payingCustomers)}
              detail={`${payersDelta.label} ${comparison}`}
            />

            <StatTile
              label="Contratos nuevos"
              value={String(income.signedCount)}
              detail={
                income.signedCount === 0
                  ? "Ninguno firmado"
                  : `${formatMoney(income.signedValueCents, money)} en ventas`
              }
            />
          </div>
        </div>
    ),

    history: (
        <div className="card dash-card">
          <div className="card-head">
            <h3>Cobrado mes a mes</h3>
            <span className="tag">últimos 12 meses</span>
          </div>

          <div className="dash-card-body">
            <MonthlyBars
              columns={data.history.map((row) => ({
                month: row.month,
                valueCents: row.collectedCents,
                targetCents: row.expectedCents,
              }))}
              money={money}
              valueLabel="Cobrado"
              targetLabel="Programado"
              selectedMonth={data.month}
              onSelectMonth={onSelectMonth}
              tableCaption="Cobrado y programado por mes, últimos doce meses."
            />
            <p className="dash-note">
              Toca un mes para ver todo el panel de ese período. El mes de un pago es el día en que
              se recibió el dinero, no el día en que se registró.
            </p>
          </div>
        </div>
    ),

    composition: (
        <div className="card dash-card">
          <div className="card-head">
            <h3>De dónde vino el dinero</h3>
            <span className="tag">{formatMonthName(data.month)}</span>
          </div>

          <div className="dash-card-body dash-splits">
            {/*
              A month carried by one large prima is not a month that repeats, and
              the headline figure cannot say so. This is the split that separates
              income that comes back next month from income that does not.
            */}
            <Split
              title="Por concepto"
              money={money}
              total={income.collectedCents}
              rows={[
                { label: "Cuotas", amount: income.byType.installment },
                { label: "Primas", amount: income.byType.downPayment },
                { label: "Contados", amount: income.byType.fullPayment },
                { label: "Ajustes", amount: income.byType.adjustment },
              ]}
            />
            <Split
              title="Por forma de pago"
              money={money}
              total={income.collectedCents}
              rows={[
                { label: "Efectivo", amount: income.byMethod.cash },
                { label: "Transferencia", amount: income.byMethod.transfer },
                { label: "Tarjeta", amount: income.byMethod.card },
              ]}
            />
          </div>
        </div>
    ),

    collections: (
        <div className="card dash-card">
          <div className="card-head">
            <h3>Cobranza</h3>
            <span className="tag">
              al {formatDate(data.asOf)}
              {collections.settledContracts > 0 &&
                ` · ${pluralise(
                  collections.settledContracts,
                  "contrato pagado",
                  "contratos pagados",
                )}`}
            </span>
          </div>

          <div className="dash-card-body">
            <div className="dash-buckets">
              {collections.buckets.map((bucket) => {
                const presentation = HEALTH_PRESENTATION[bucket.status];

                return (
                  <div key={bucket.status} className="dash-bucket" title={presentation.hint}>
                    {/* The label is always present, so these four are never told
                        apart by their colour alone. */}
                    <span className={presentation.stampClass}>{presentation.label}</span>
                    <p className="dash-bucket-count">{bucket.contracts}</p>
                    <p className="dash-bucket-detail">
                      {pluralise(bucket.customers, "cliente", "clientes")}
                    </p>
                    <p className="dash-bucket-money">
                      {bucket.arrearsCents > 0
                        ? `${formatMoney(bucket.arrearsCents, money)} vencidos`
                        : `${formatMoney(bucket.balanceCents, money)} por cobrar`}
                    </p>
                  </div>
                );
              })}
            </div>

            <ChangeLists collections={collections} month={data.month} />
          </div>
        </div>
    ),

    worklist: (
        <div className="card dash-card">
          <div className="card-head">
            <h3>A quién llamar primero</h3>
            <span className="tag">por monto vencido</span>
          </div>

          {collections.worklist.length === 0 ? (
            <p className="state-message">Nadie está atrasado. Toda la cartera está al día.</p>
          ) : (
            <div className="table-wrap">
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Lote</th>
                    <th className="col-money">Vencido</th>
                    <th className="col-money">Saldo</th>
                    <th>Último pago</th>
                  </tr>
                </thead>
                <tbody>
                  {collections.worklist.map((debtor) => (
                    <tr key={debtor.contractId}>
                      <td>
                        <DebtorName debtor={debtor} />
                      </td>
                      <td>
                        <span className="contract-lot">
                          <span className="code-badge">{debtor.lotCode}</span>
                          <span
                            className={`cell-project cell-sub ${
                              accents.get(debtor.projectName) ?? ""
                            }`}
                          >
                            <span className="project-dot" />
                            {debtor.projectName}
                          </span>
                        </span>
                      </td>
                      <td className="col-money">
                        {moneyCell(debtor.arrearsCents, "is-balance")}
                        <span className="cell-sub">
                          {pluralise(debtor.monthsBehind, "mes", "meses")}
                        </span>
                      </td>
                      <td className="col-money">{moneyCell(debtor.balanceCents)}</td>
                      <td>
                        {/* The most useful column on a list of debtors: somebody
                            who paid last week forgot, somebody last seen in March
                            has stopped. */}
                        <span className="cell-sub">{formatDate(debtor.lastPaymentOn)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
    ),

    projects: (
        <div className="card dash-card">
          <div className="card-head">
            <h3>Por proyecto</h3>
            <span className="tag">{formatMonthName(data.month)}</span>
          </div>

          {data.projects.length === 0 ? (
            <p className="state-message">Todavía no hay contratos en ningún proyecto.</p>
          ) : (
            <div className="table-wrap">
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>Proyecto</th>
                    <th className="col-money">Cobrado</th>
                    <th className="col-money">Por cobrar</th>
                    <th>Cartera</th>
                    <th>Inventario</th>
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((project) => {
                    const delta = compareToPrevious(
                      project.collectedCents,
                      project.previousToDateCents,
                    );

                    return (
                      <tr key={project.projectId}>
                        <td>
                          <span className={`cell-project ${accents.get(project.projectName) ?? ""}`}>
                            <span className="project-dot" />
                            {project.projectName}
                          </span>
                        </td>
                        <td className="col-money">
                          {moneyCell(project.collectedCents)}
                          <span className={`cell-sub dash-delta is-${delta.tone}`}>
                            {delta.label}
                          </span>
                        </td>
                        <td className="col-money">
                          {moneyCell(project.outstandingCents, "is-balance")}
                          {project.arrearsCents > 0 && (
                            <span className="cell-sub warn">
                              {formatMoney(project.arrearsCents, money)} vencidos
                            </span>
                          )}
                        </td>
                        <td>
                          {pluralise(project.activeContracts, "contrato", "contratos")}
                          {project.behindContracts > 0 && (
                            <span className="cell-sub warn">
                              {project.behindContracts} atrasados
                            </span>
                          )}
                        </td>
                        <td>
                          {project.lotsAvailable} de {project.lotsTotal} libres
                          {/*
                            The one thing the Proyectos tab deliberately does not
                            show: not what is left, but how long it lasts at the
                            rate this project has actually been selling.
                          */}
                          <span className="cell-sub">
                            {project.monthsOfStock === null
                              ? project.lotsAvailable === 0
                                ? "sin lotes libres"
                                : "sin ventas recientes"
                              : `~${pluralise(project.monthsOfStock, "mes", "meses")} de inventario`}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
    ),

    projection: (
        <div className="card dash-card">
          <div className="card-head">
            <h3>Lo que viene</h3>
            <span className="tag">próximos 6 meses</span>
          </div>

          <div className="dash-card-body">
            <MonthlyBars
              columns={upcoming.projection.map((row) => ({
                month: row.month,
                valueCents: row.expectedCents,
              }))}
              money={money}
              valueLabel="Programado"
              tableCaption="Cuotas programadas por mes, próximos seis meses."
            />
            <p className="dash-note">
              Lo que las cuotas ya firmadas traerían si todo el mundo paga. Un escalón hacia abajo
              es un grupo de contratos que termina: ese mes entra menos dinero aunque nadie se
              atrase.
            </p>
          </div>
        </div>
    ),

    attention: (
        <div className="dash-attention">
          <AttentionCard
            title="Reservas por vencer"
            tag="próximos 30 días"
            empty="Ninguna reserva vence pronto."
            items={upcoming.expiringReservations.map((row) => ({
              key: row.contractId,
              code: row.contractCode,
              title: row.customerName,
              detail: `${row.lotCode} · ${row.projectName}`,
              note: describeExpiry(row.expiresOn, data.asOf),
              isUrgent: row.expiresOn <= data.asOf,
            }))}
          />

          <AttentionCard
            title="Contratos por terminar"
            tag="3 cuotas o menos"
            empty="Ningún contrato está por terminar."
            items={upcoming.finishingSoon.map((row) => ({
              key: row.contractId,
              code: row.contractCode,
              title: row.customerName,
              detail: `${row.lotCode} · ${row.projectName}`,
              note: `${pluralise(row.installmentsLeft, "cuota", "cuotas")} · ${formatMoney(
                row.balanceCents,
                money,
              )}`,
              isUrgent: false,
            }))}
          />

          <div className="card dash-card">
            <div className="card-head">
              <h3>Primas sin cobrar</h3>
              <span className="tag">contratos vigentes</span>
            </div>
            <div className="dash-card-body">
              {upcoming.unpaidPrimas.contracts === 0 ? (
                <p className="state-message">Todas las primas acordadas entraron completas.</p>
              ) : (
                <>
                  <p className="dash-figure">
                    {formatMoney(upcoming.unpaidPrimas.amountCents, money)}
                  </p>
                  <p className="dash-figure-label">
                    acordados y no recibidos en{" "}
                    {pluralise(upcoming.unpaidPrimas.contracts, "contrato", "contratos")}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
    ),

    control: data.control && (
          <div className="card dash-card dash-control">
            <div className="card-head">
              <h3>Control</h3>
              <span className="tag">{formatMonthName(data.month)}</span>
            </div>

            <div className="dash-card-body">
              {data.control.byUser.length === 0 ? (
                <p className="state-message">Nadie registró cobros este mes.</p>
              ) : (
                <div className="table-wrap">
                  <table className="dash-table">
                    <thead>
                      <tr>
                        <th>Quién cobró</th>
                        <th className="col-money">Total</th>
                        <th className="col-money">En efectivo</th>
                        <th>Transacciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.control.byUser.map((row) => (
                        <tr key={row.userId}>
                          <td>
                            <span className="holder-btn is-static">
                              <span className="holder-avatar">{getInitials(row.userName)}</span>
                              <span className="holder-name">{row.userName}</span>
                            </span>
                          </td>
                          <td className="col-money">{moneyCell(row.collectedCents)}</td>
                          <td className="col-money">
                            {/* Singled out because it is the only figure here that
                                passed through somebody's hands, not a bank's. */}
                            {moneyCell(row.cashCents, row.cashCents > 0 ? "is-balance" : "")}
                          </td>
                          <td className="mono">{row.payments}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="dash-flags">
                <div className="dash-flag">
                  <p className="dash-flag-label">Transferencias sin comprobante</p>
                  <p className="dash-flag-value">
                    {data.control.unprovenTransfers.count === 0
                      ? "Ninguna"
                      : `${data.control.unprovenTransfers.count} · ${formatMoney(
                          data.control.unprovenTransfers.amountCents,
                          money,
                        )}`}
                  </p>
                  <p className="dash-flag-note">
                    Sin número de confirmación ni foto del depósito: no hay con qué compararlas
                    contra el estado de cuenta.
                  </p>
                </div>

                <div className="dash-flag">
                  <p className="dash-flag-label">Recibos anulados</p>
                  <p className="dash-flag-value">
                    {data.control.voidedReceipts.length === 0
                      ? "Ninguno"
                      : String(data.control.voidedReceipts.length)}
                  </p>
                  {data.control.voidedReceipts.length > 0 && (
                    <ul className="dash-flag-list">
                      {data.control.voidedReceipts.map((receipt) => (
                        <li key={receipt.id}>
                          <span className="code-badge">{receipt.code}</span>
                          <span className="dash-flag-list-name">{receipt.customerName}</span>
                          <span className="cell-sub">
                            {receipt.wasSuperseded ? "corregido" : "anulado"}
                            {receipt.voidReason ? ` · ${receipt.voidReason}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </div>
    ),
  };

  /*
   * The first and last bands this account can actually see.
   *
   * Not `order[0]` and `order.at(-1)`: an associate has no Control band, so if
   * it happened to sit last, the band above it would show an enabled "move
   * down" that moved it past something invisible and appeared to do nothing.
   *
   * Below `sections` rather than beside the other state, and it has to stay
   * there: the callback runs immediately, so reading `sections` from above its
   * own declaration is a dead-zone error at runtime — one TypeScript cannot see
   * through a callback, and only the browser reports.
   */
  const movable = visible.order.filter((id) => sections[id] !== null);
  const firstMovable = movable[0];
  const lastMovable = movable.at(-1);

  return (
    <section className="panel active">
      <MonthPicker data={data} onSelectMonth={onSelectMonth} />

      <LayoutBar
        isEditing={draft !== null}
        isDefault={isDefaultLayout(visible)}
        isSaving={isSaving}
        error={error}
        onEdit={() => setDraft(visible)}
        onCancel={() => {
          setDraft(null);
          setError(null);
        }}
        onSave={() => void save()}
        onReset={() => void reset()}
      />

      {/*
        The bands, in this reader's order.

        Each one lays ITSELF out exactly as it always did — the running order is
        the only thing a preference decides, which is what makes every possible
        arrangement a valid page. See dashboardSections.ts.
      */}
      {visible.order.map((id) => {
        const content = sections[id];

        // A band this account cannot see — Control, for an associate — is
        // absent rather than empty, and is not offered in the editor either.
        if (!content) {
          return null;
        }

        if (draft === null) {
          return hiddenIds.has(id) ? null : <div key={id}>{content}</div>;
        }

        return (
          <SectionFrame
            key={id}
            id={id}
            isHidden={hiddenIds.has(id)}
            isFirst={id === firstMovable}
            isLast={id === lastMovable}
            isDragging={dragging === id}
            onMove={(direction) => setDraft({ ...draft, order: moveSection(draft.order, id, direction) })}
            onToggleHidden={() =>
              setDraft({
                ...draft,
                hidden: hiddenIds.has(id)
                  ? draft.hidden.filter((other) => other !== id)
                  : [...draft.hidden, id],
              })
            }
            onDragStart={() => setDragging(id)}
            onDragEnd={() => setDragging(null)}
            onDropBefore={() => {
              if (dragging) {
                setDraft({ ...draft, order: dropSection(draft.order, dragging, id) });
              }
              setDragging(null);
            }}
          >
            {content}
          </SectionFrame>
        );
      })}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Arranging the screen                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The bar that turns the editor on, and the controls it becomes.
 *
 * An explicit mode, rather than making the bands draggable all the time. A page
 * whose cards move when you brush past them is a page nobody trusts to read —
 * and it is a page you cannot select text on. While this is off, the screen is
 * exactly what it always was.
 */
function LayoutBar({
  isEditing,
  isDefault,
  isSaving,
  error,
  onEdit,
  onCancel,
  onSave,
  onReset,
}: {
  isEditing: boolean;
  isDefault: boolean;
  isSaving: boolean;
  error: string | null;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onReset: () => void;
}) {
  if (!isEditing) {
    return (
      <div className="dash-layout-bar">
        <button type="button" className="chip" onClick={onEdit}>
          Personalizar
        </button>
        {!isDefault && <span className="result-count">Orden personalizado</span>}
      </div>
    );
  }

  return (
    <div className="dash-layout-bar is-editing">
      <p className="dash-layout-hint">
        Arrastra una sección o usa las flechas para moverla. El ojo la oculta sin
        borrarla.
      </p>

      <div className="toolbar-spacer" />

      {error && <span className="dash-layout-error">{error}</span>}

      <button type="button" className="chip" onClick={onReset} disabled={isSaving || isDefault}>
        Restaurar el orden original
      </button>
      <button type="button" className="chip" onClick={onCancel} disabled={isSaving}>
        Cancelar
      </button>
      <button type="button" className="btn-primary" onClick={onSave} disabled={isSaving}>
        {isSaving ? "Guardando…" : "Guardar"}
      </button>
    </div>
  );
}

/**
 * One band while the screen is being arranged.
 *
 * The band's own content is rendered untouched inside it — the frame only adds
 * a header to grab and to press. That is the whole reason any arrangement is a
 * valid page: nothing in here can affect how a band lays itself out.
 *
 * Both ways of moving a band are real controls, and the buttons came first. A
 * drag handle is unusable with a keyboard, awkward with a screen reader, and
 * genuinely hard on a phone, where this app is often read; up and down arrows
 * work everywhere. Dragging is the shortcut for a mouse, not the mechanism.
 */
function SectionFrame({
  id,
  isHidden,
  isFirst,
  isLast,
  isDragging,
  onMove,
  onToggleHidden,
  onDragStart,
  onDragEnd,
  onDropBefore,
  children,
}: {
  id: SectionId;
  isHidden: boolean;
  isFirst: boolean;
  isLast: boolean;
  isDragging: boolean;
  onMove: (direction: -1 | 1) => void;
  onToggleHidden: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropBefore: () => void;
  children: ReactNode;
}) {
  const label = SECTION_LABELS[id];

  return (
    <section
      className={[
        "dash-section",
        isHidden ? "is-hidden" : "",
        isDragging ? "is-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
      // The whole band is the drop target, not a thin line between bands: a
      // 4px gap is a target nobody hits, and the result of missing it is a card
      // that springs back to where it started.
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDropBefore();
      }}
    >
      <header className="dash-section-bar" draggable onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <span className="dash-section-grip" aria-hidden="true">
          <IconDrag />
        </span>
        <span className="dash-section-name">{label}</span>

        <button
          type="button"
          className="row-action"
          onClick={onToggleHidden}
          title={isHidden ? `Mostrar ${label}` : `Ocultar ${label}`}
          aria-label={isHidden ? `Mostrar ${label}` : `Ocultar ${label}`}
          aria-pressed={isHidden}
        >
          {isHidden ? <IconEyeOff /> : <IconEye />}
        </button>

        <button
          type="button"
          className="row-action dash-section-up"
          onClick={() => onMove(-1)}
          disabled={isFirst}
          title={`Subir ${label}`}
          aria-label={`Subir ${label}`}
        >
          <IconChevronDown />
        </button>

        <button
          type="button"
          className="row-action"
          onClick={() => onMove(1)}
          disabled={isLast}
          title={`Bajar ${label}`}
          aria-label={`Bajar ${label}`}
        >
          <IconChevronDown />
        </button>
      </header>

      {/* Kept on screen while hidden, dimmed, so nothing can be folded away and
          then be impossible to find again. */}
      <div className="dash-section-body">{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Which month the whole screen is reporting.
 *
 * "Este mes" is a separate button from the arrows rather than a special case of
 * them: it returns the screen to asking the SERVER what month it is, which is
 * the only reading that stays right in a browser left open past midnight.
 */
function MonthPicker({
  data,
  onSelectMonth,
}: {
  data: Dashboard;
  onSelectMonth: (month: string | undefined) => void;
}) {
  const step = (delta: number) => {
    const year = Number(data.month.slice(0, 4));
    const index = Number(data.month.slice(5, 7)) - 1;

    return new Date(Date.UTC(year, index + delta, 1)).toISOString().slice(0, 7);
  };

  return (
    <div className="toolbar dash-toolbar">
      <div className="dash-month">
        <button
          type="button"
          className="chip dash-step"
          onClick={() => onSelectMonth(step(-1))}
          aria-label="Mes anterior"
        >
          <IconChevronDown />
        </button>

        <span className="dash-month-name">{formatMonth(data.month)}</span>

        <button
          type="button"
          className="chip dash-step is-next"
          onClick={() => onSelectMonth(step(1))}
          // There is nothing to report from a month that has not happened, and
          // the server refuses it — so the button is not offered either.
          disabled={data.isCurrentMonth}
          aria-label="Mes siguiente"
        >
          <IconChevronDown />
        </button>
      </div>

      {!data.isCurrentMonth && (
        <button type="button" className="chip" onClick={() => onSelectMonth(undefined)}>
          Volver a este mes
        </button>
      )}

      <div className="toolbar-spacer" />

      <span className="result-count">
        {data.isCurrentMonth
          ? `Al ${formatDate(data.asOf)}`
          : `Como estaba al cerrar ${formatMonthName(data.month)}`}
      </span>
    </div>
  );
}

/** Label, value, and one line saying what the value is measured against. */
function StatTile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "good" | "warn";
}) {
  return (
    <div className="card dash-tile">
      <p className="dash-tile-label">{label}</p>
      <p className={tone ? `dash-tile-value is-${tone}` : "dash-tile-value"}>{value}</p>
      <p className="dash-tile-detail">{detail}</p>
    </div>
  );
}

/** One breakdown of the month's money, as bars that sum to the whole. */
function Split({
  title,
  rows,
  total,
  money,
}: {
  title: string;
  rows: Array<{ label: string; amount: Cents }>;
  total: Cents;
  money: MoneyView;
}) {
  // Rows worth nothing are dropped rather than drawn as empty tracks: a list of
  // zeroes is noise, and "Tarjeta L. 0" says nothing a missing row does not.
  const shown = rows.filter((row) => row.amount > 0);

  return (
    <div className="dash-split">
      <p className="dash-split-title">{title}</p>

      {shown.length === 0 ? (
        <p className="state-message">Sin movimientos.</p>
      ) : (
        <ul className="dash-split-list">
          {shown.map((row) => (
            <li key={row.label}>
              <span className="dash-split-label">{row.label}</span>
              <span className="dash-split-track">
                <span
                  className="dash-split-fill"
                  style={{ width: `${total > 0 ? (row.amount / total) * 100 : 0}%` }}
                />
              </span>
              <span className="dash-split-value mono">{formatMoney(row.amount, money)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Who crossed the line this month, in both directions.
 *
 * The lists are short by construction — only somebody who changed state inside
 * one month can appear — so they are shown in full rather than capped. An empty
 * one is normal early in a month and says so, instead of leaving a blank box to
 * be read as something broken.
 */
function ChangeLists({
  collections,
  month,
}: {
  collections: Dashboard["collections"];
  month: string;
}) {
  return (
    <div className="dash-changes">
      <div className="dash-change">
        <p className="dash-change-title">
          <span className="stamp clay">Se atrasaron</span>
          en {formatMonthName(month)}
        </p>
        {collections.slipped.length === 0 ? (
          <p className="dash-change-empty">Nadie nuevo se atrasó.</p>
        ) : (
          <ul className="dash-change-list">
            {collections.slipped.map((debtor) => (
              <li key={debtor.contractId}>
                <DebtorName debtor={debtor} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="dash-change">
        <p className="dash-change-title">
          <span className="stamp success">Se pusieron al día</span>
          en {formatMonthName(month)}
        </p>
        {collections.recovered.length === 0 ? (
          <p className="dash-change-empty">Nadie salió del atraso.</p>
        ) : (
          <ul className="dash-change-list">
            {collections.recovered.map((debtor) => (
              <li key={debtor.contractId}>
                <DebtorName debtor={debtor} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A person with the lot they are behind on, and the number to call them at. */
function DebtorName({ debtor }: { debtor: Debtor }) {
  return (
    <span className="holder-btn is-static">
      <span className="holder-avatar">{getInitials(debtor.customerName)}</span>
      <span className="holder-text">
        <span className="holder-name">{debtor.customerName}</span>
        <span className="holder-contract">{debtor.contractCode}</span>
      </span>
    </span>
  );
}

/** A short list of things that need attention before they become a problem. */
function AttentionCard({
  title,
  tag,
  empty,
  items,
}: {
  title: string;
  tag: string;
  empty: string;
  items: Array<{
    key: string;
    code: string;
    title: string;
    detail: string;
    note: string;
    isUrgent: boolean;
  }>;
}) {
  return (
    <div className="card dash-card">
      <div className="card-head">
        <h3>{title}</h3>
        <span className="tag">{tag}</span>
      </div>

      {items.length === 0 ? (
        <p className="state-message">{empty}</p>
      ) : (
        <ul className="dash-list">
          {items.map((item) => (
            <li key={item.key}>
              <span className="code-badge">{item.code}</span>
              <span className="dash-list-text">
                <span className="dash-list-title">{item.title}</span>
                <span className="cell-sub">{item.detail}</span>
              </span>
              <span className={item.isUrgent ? "dash-list-note is-urgent" : "dash-list-note"}>
                {item.note}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * How the collection meter is coloured.
 *
 * Three steps rather than a continuous ramp, because the reader is making a
 * decision, not reading a value: is this month fine, worth watching, or a
 * problem. The exact percentage is written beside it either way.
 */
function meterClass(rate: number): string {
  if (rate >= 90) {
    return "dash-meter-fill is-good";
  }

  return rate >= 70 ? "dash-meter-fill is-warn" : "dash-meter-fill is-bad";
}
