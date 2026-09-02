import type { FormEvent } from "react";
import { useMemo, useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { businessToday } from "../../lib/businessTime";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { Contract, CustomerRecord, HoldingKind, Lot, SaleType } from "../../types";
import type { AreaUnit } from "../../lib/area";
import type { ContractCreateDraft } from "./api";
import { CustomerPicker, LotPicker } from "./ContractPartyPickers";
import { KIND_LABELS, SALE_TYPE_LABELS, formatDate } from "./contractPresentation";
import {
  addMonthsOnDay,
  financedCents,
  firstDueDate,
  parseIntOrNull,
  suggestMonthlyPayment,
  summarizeSchedule,
} from "./contractSchedule";

/** Two questions, asked one at a time — see the note on the component. */
type Step = "parties" | "terms";

interface ContractCreateDialogProps {
  customers: CustomerRecord[];
  /** Every lot; the picker narrows it to what can actually be sold. */
  lots: Lot[];
  /** Existing contracts, used to offer joining an existing purchase. */
  contracts: Contract[];
  unitByProject: Map<string, AreaUnit>;
  money: MoneyView;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onCreate: (draft: ContractCreateDraft) => Promise<void>;
}

/**
 * The "Nuevo contrato" form.
 *
 * Two steps rather than one long scroll, and the split is not cosmetic. The
 * first step settles WHO and WHICH LOT; the second settles the money. The
 * second genuinely depends on the first — the lot's list price is where the
 * sale price starts, and whether this customer already has a live purchase is
 * what decides whether these lots are one deal or two — so asking them in one
 * pile would mean showing a price field before there is a lot to price.
 *
 * What is deliberately NOT here:
 *
 * - The contract number. The server assigns it, from a per-year sequence with a
 *   unique index behind it. Two people entering contracts at the same time
 *   cannot be trusted to pick different numbers, and neither can one person.
 * - The lot's status. A lot is available exactly while no active contract
 *   points at it. Creating this contract IS what makes it sold; there is
 *   nothing to tick.
 * - A motive. Correcting a signed contract demands one (see
 *   `ContractEditDialog`) because it changes what two people are recorded as
 *   having agreed. Writing one down for the first time changes nothing — the
 *   audit trail already records who created it and when.
 */
export function ContractCreateDialog({
  customers,
  lots,
  contracts,
  unitByProject,
  money,
  onCancel,
  onCreate,
}: ContractCreateDialogProps) {
  const [step, setStep] = useState<Step>("parties");

  const [customer, setCustomer] = useState<CustomerRecord | null>(null);
  const [lot, setLot] = useState<Lot | null>(null);
  /** The contract this purchase joins, or "" for a sale of its own. */
  const [joinContractId, setJoinContractId] = useState("");

  const [kind, setKind] = useState<HoldingKind>("contract");
  const [saleType, setSaleType] = useState<SaleType>("financed");

  // `null` in the three overrides below means "follow the suggestion". Once the
  // user types, their value is kept verbatim and the suggestion never
  // overwrites a decision they made — the same rule the Nuevo lote form uses
  // for the lot number.
  const [priceOverride, setPriceOverride] = useState<string | null>(null);
  const [monthlyOverride, setMonthlyOverride] = useState<string | null>(null);
  const [expiresOverride, setExpiresOverride] = useState<string | null>(null);
  const [signedOnOverride, setSignedOnOverride] = useState<string | null>(null);

  const [downPayment, setDownPayment] = useState("");
  const [termMonths, setTermMonths] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [firstDueOn, setFirstDueOn] = useState("");
  const [notes, setNotes] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const isFinanced = saleType === "financed";
  const isDonation = saleType === "donation";
  const isReservation = kind === "reservation";

  // The active contracts this customer already holds. Only these can be joined:
  // a sale group exists so that ONE payment can be split across the lots of ONE
  // purchase, so mixing two customers into a group would put one person's money
  // against another person's lot.
  const groupCandidates = useMemo(
    () =>
      customer === null
        ? []
        : contracts.filter(
            (candidate) => candidate.customer.id === customer.id && candidate.status === "active",
          ),
    [contracts, customer],
  );

  const joinContract = groupCandidates.find((candidate) => candidate.id === joinContractId) ?? null;

  // Joining an existing purchase inherits its signing date by default: these
  // are lots bought in the same deal, and two signing dates a week apart would
  // give one purchase two different payment calendars.
  const signedOn = signedOnOverride ?? joinContract?.terms.signedOn ?? businessToday();

  const salePrice = priceOverride ?? (lot === null ? "" : toMoneyInput(lot.basePrice));

  const priceNumber = isDonation ? 0 : parseMoneyInput(salePrice);
  const downNumber = isDonation || downPayment.trim() === "" ? 0 : parseMoneyInput(downPayment);
  const priceCents = Number.isFinite(priceNumber) ? Math.round(priceNumber * 100) : 0;
  const downCents = Number.isFinite(downNumber) ? Math.round(downNumber * 100) : 0;
  const financed = financedCents(priceCents, downCents);

  const months = parseIntOrNull(termMonths);
  const day = parseIntOrNull(dueDay);
  const hasTerm = months !== null && Number.isFinite(months) && months >= 1;
  const hasDueDay = day !== null && Number.isFinite(day) && day >= 1 && day <= 31;

  const suggestedMonthly = isFinanced && hasTerm ? suggestMonthlyPayment(financed, months) : null;
  const monthlyPayment =
    monthlyOverride ?? (suggestedMonthly === null ? "" : toMoneyInput(cents(suggestedMonthly)));

  const monthlyNumber = monthlyPayment.trim() === "" ? Number.NaN : parseMoneyInput(monthlyPayment);
  const monthlyCents = Number.isFinite(monthlyNumber) ? Math.round(monthlyNumber * 100) : 0;

  // What the schedule works out to, previewed live. The server builds the real
  // one from the same rules on every read; this exists so the person typing can
  // see that "24 meses de L 3,500" against this price is really 23 cuotas and a
  // short one at the end, before they promise it to somebody.
  const scheduledFirstDue = firstDueDate(
    signedOn,
    hasDueDay ? day : null,
    firstDueOn.trim() === "" ? null : firstDueOn,
  );
  const schedule =
    isFinanced && hasTerm && hasDueDay && scheduledFirstDue !== null
      ? summarizeSchedule(financed, months, monthlyCents, scheduledFirstDue, day)
      : null;

  // A hold with no end date keeps a lot off the market forever and nobody ever
  // notices, so the field is required — starting a month out, which is what
  // these are in practice.
  const expiresOn =
    expiresOverride ??
    (isReservation && signedOn !== ""
      ? addMonthsOnDay(signedOn, 1, Number(signedOn.slice(8, 10)))
      : "");

  const chooseCustomer = (next: CustomerRecord | null) => {
    setCustomer(next);
    // The group belongs to the person who was selected a moment ago, so it
    // cannot survive them being swapped out.
    setJoinContractId("");
    setError(null);
  };

  const chooseLot = (next: Lot | null) => {
    setLot(next);
    setError(null);
  };

  const goBack = () => {
    setStep("parties");
    setError(null);
  };

  const submitParties = () => {
    if (customer === null) {
      setError("Elige el cliente que firma este contrato.");
      return;
    }
    if (lot === null) {
      setError("Elige el lote que se está vendiendo.");
      return;
    }

    setError(null);
    setStep("terms");
  };

  const submitTerms = async () => {
    setError(null);

    if (customer === null || lot === null) {
      setStep("parties");
      return;
    }

    // The same relationships the server checks in `termsProblem`, mirrored here
    // so a mistake is caught before the round trip rather than after it.
    if (!isDonation) {
      if (!Number.isFinite(priceNumber) || priceNumber < 0) {
        setError("Escribe el precio de venta en lempiras.");
        return;
      }
      if (!Number.isFinite(downNumber) || downNumber < 0) {
        setError("Escribe la prima en lempiras.");
        return;
      }
      if (downCents > priceCents) {
        setError("La prima no puede ser mayor que el precio de venta.");
        return;
      }
    }

    if (isFinanced) {
      if (!hasTerm) {
        setError("Un contrato a crédito necesita el plazo en meses.");
        return;
      }
      if (monthlyCents <= 0) {
        setError("Un contrato a crédito necesita la cuota mensual.");
        return;
      }
      if (!hasDueDay) {
        setError("El día de pago debe estar entre 1 y 31.");
        return;
      }
      if (downCents === priceCents) {
        setError("Si la prima cubre todo el precio, la venta es de contado, no a crédito.");
        return;
      }
    }
    // No matching `else` complaining about a stray plazo or cuota, which is
    // what the server checks for. The three schedule fields only EXIST here
    // while the sale is financed, so a leftover in one of them after switching
    // to contado is invisible — and an error about a field that is not on
    // screen is an error nobody can clear. They are sent as null below instead.

    if (signedOn.trim() === "") {
      setError("Escribe la fecha en que se firmó el contrato.");
      return;
    }
    if (isReservation && expiresOn.trim() === "") {
      setError("Una reserva necesita una fecha de vencimiento.");
      return;
    }
    // Guarded on `isFinanced` for the same reason as the note above: the field
    // is only on screen for a credit sale, and a leftover date behind a hidden
    // field must not refuse a save. It is sent as null below either way.
    if (isFinanced && firstDueOn.trim() !== "" && firstDueOn < signedOn) {
      setError("La primera cuota no puede vencer antes de firmar el contrato.");
      return;
    }
    if (isReservation && expiresOn < signedOn) {
      setError("El vencimiento de la reserva no puede ser anterior a la firma.");
      return;
    }

    setSaving(true);

    try {
      await onCreate({
        customerId: customer.id,
        lotId: lot.id,
        kind,
        saleType,
        // A donation is recorded at zero rather than left out of the table: the
        // lot's history has to say what became of it, and "no aparece" is not
        // an answer.
        salePriceCents: isDonation ? 0 : priceCents,
        downPaymentCents: isDonation ? 0 : downCents,
        termMonths: isFinanced ? months : null,
        monthlyPaymentCents: isFinanced ? monthlyCents : null,
        dueDay: isFinanced ? day : null,
        signedOn,
        // Blank means "let it follow from the signing date", which is a
        // different instruction from any particular date.
        firstDueOn: isFinanced && firstDueOn.trim() !== "" ? firstDueOn : null,
        expiresOn: isReservation ? expiresOn : null,
        notes: notes.trim() === "" ? null : notes.trim(),
        joinGroupOfContractId: joinContractId === "" ? null : joinContractId,
      });
    } catch (caught) {
      // The server checks every one of these rules independently, and it is
      // also the only one that can see whether somebody else took this lot
      // thirty seconds ago — so that refusal surfaces here too.
      setError(caught instanceof Error ? caught.message : "No se pudo crear el contrato.");
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (step === "parties") {
      submitParties();
      return;
    }

    void submitTerms();
  };

  return (
    <Dialog ariaLabel="Nuevo contrato" onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">
              Nuevo contrato · Paso {step === "parties" ? 1 : 2} de 2
            </p>
            <h2>{step === "parties" ? "Cliente y lote" : "Términos de la venta"}</h2>
            <p className="modal-description">
              {step === "parties" ? (
                "Un contrato es una persona y un lote. El número se asigna solo al guardar."
              ) : customer && lot ? (
                <>
                  {customer.fullName} · Lote {lot.code} · {lot.projectName}
                </>
              ) : (
                ""
              )}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        {step === "parties" && (
          <div className="modal-form-grid">
            <div className="form-field full-width">
              {/* A <p> rather than a <label>: a label has to name one control,
                  and the picker below is a search box that disappears the
                  moment a choice is made. The controls inside carry their own
                  aria-label instead. */}
              <p className="picker-label">
                Cliente<span className="required-mark" aria-hidden="true"> *</span>
              </p>
              <CustomerPicker
                customers={customers}
                selected={customer}
                onSelect={chooseCustomer}
              />
            </div>

            <div className="form-field full-width">
              <p className="picker-label">
                Lote<span className="required-mark" aria-hidden="true"> *</span>
              </p>
              <LotPicker
                lots={lots}
                unitByProject={unitByProject}
                money={money}
                selected={lot}
                onSelect={chooseLot}
              />
              <span className="field-hint">
                Solo aparecen los lotes libres. Guardar este contrato es lo que saca el lote del
                inventario disponible; no hay un estado que marcar aparte.
              </span>
            </div>

            {/* Offered only when there is something to join. A customer with no
                live contract cannot be buying a second lot of the same deal. */}
            {groupCandidates.length > 0 && (
              <div className="form-field full-width">
                <label htmlFor="new-contract-group">¿Es parte de una compra que ya existe?</label>
                <select
                  id="new-contract-group"
                  value={joinContractId}
                  onChange={(event) => setJoinContractId(event.target.value)}
                >
                  <option value="">No, es una compra aparte</option>
                  {groupCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.code} · Lote {candidate.lot.code} · firmado{" "}
                      {formatDate(candidate.terms.signedOn)}
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  {joinContract
                    ? `Los dos lotes quedan como una sola compra, cada uno con su propio saldo. Un pago de ${customer?.fullName} podrá repartirse entre ellos desde la lista de contratos.`
                    : "Únelo solo si es la misma venta: dos lotes firmados el mismo día, con un solo recibo. Lotes comprados en años distintos comparten al cliente, no la compra."}
                </span>
              </div>
            )}

            {error && <p className="form-error full-width">{error}</p>}
          </div>
        )}

        {step === "terms" && lot && (
          <div className="modal-form-grid">
            <div className="form-field">
              <label htmlFor="new-contract-kind">Tipo</label>
              <select
                id="new-contract-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as HoldingKind)}
              >
                {(Object.keys(KIND_LABELS) as HoldingKind[]).map((value) => (
                  <option key={value} value={value}>
                    {KIND_LABELS[value]}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                Una reserva es un apartado con fecha de vencimiento; un contrato es la venta.
              </span>
            </div>

            <div className="form-field">
              <label htmlFor="new-contract-sale-type">Forma de pago</label>
              <select
                id="new-contract-sale-type"
                value={saleType}
                onChange={(event) => setSaleType(event.target.value as SaleType)}
              >
                {(Object.keys(SALE_TYPE_LABELS) as SaleType[]).map((value) => (
                  <option key={value} value={value}>
                    {SALE_TYPE_LABELS[value]}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                Solo el crédito lleva plazo, cuota y día de pago.
              </span>
            </div>

            {/* A donation has no price and no prima by definition, so the
                fields are gone rather than sitting there waiting to be zeroed
                and then refused. */}
            {isDonation ? (
              <p className="form-blocked full-width">
                Una donación se registra con precio y prima en cero. El lote sale del inventario
                igual que con una venta, y su historial dice a quién se entregó.
              </p>
            ) : (
              <>
                <div className="form-field">
                  <label htmlFor="new-contract-price">
                    Precio de venta<span className="required-mark" aria-hidden="true"> *</span>
                  </label>
                  <MoneyInput
                    id="new-contract-price"
                    value={salePrice}
                    onChange={setPriceOverride}
                    placeholder="0.00"
                  />
                  <span className="field-hint">
                    {priceCents === lot.basePrice ? (
                      <>Precio de lista del lote. Es negociable: escribe lo que se acordó.</>
                    ) : (
                      <>
                        El lote está en lista a {formatMoney(lot.basePrice, money)}.{" "}
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => setPriceOverride(null)}
                        >
                          Volver al precio de lista
                        </button>
                      </>
                    )}
                  </span>
                </div>

                <div className="form-field">
                  <label htmlFor="new-contract-down">Prima acordada</label>
                  <MoneyInput
                    id="new-contract-down"
                    value={downPayment}
                    onChange={setDownPayment}
                    placeholder="0.00"
                  />
                  <span className="field-hint">
                    Lo acordado, no lo cobrado. La prima que entra se registra después como un
                    pago, y hasta entonces la lista lo dirá.
                  </span>
                </div>
              </>
            )}

            {isFinanced && (
              <>
                <div className="form-field">
                  <label htmlFor="new-contract-term">
                    Plazo en meses<span className="required-mark" aria-hidden="true"> *</span>
                  </label>
                  <input
                    id="new-contract-term"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="600"
                    value={termMonths}
                    placeholder="24"
                    onChange={(event) => setTermMonths(event.target.value)}
                  />
                  <span className="field-hint">
                    {financed > 0
                      ? `Se financian ${formatMoney(cents(financed), money)} después de la prima.`
                      : "Lo que queda después de la prima es lo que se financia."}
                  </span>
                </div>

                <div className="form-field">
                  <label htmlFor="new-contract-monthly">
                    Cuota mensual<span className="required-mark" aria-hidden="true"> *</span>
                  </label>
                  <MoneyInput
                    id="new-contract-monthly"
                    value={monthlyPayment}
                    onChange={setMonthlyOverride}
                    placeholder="0.00"
                  />
                  <span className="field-hint">
                    {suggestedMonthly !== null && monthlyOverride === null
                      ? "Sugerida a partir del plazo. La cuota se negocia: escribe otra si se acordó otra."
                      : suggestedMonthly !== null
                        ? (
                            <>
                              Repartido en partes iguales daría{" "}
                              {formatMoney(cents(suggestedMonthly), money)}.{" "}
                              <button
                                type="button"
                                className="link-btn"
                                onClick={() => setMonthlyOverride(null)}
                              >
                                Usar esa cuota
                              </button>
                            </>
                          )
                        : "Escribe primero el plazo para ver la cuota sugerida."}
                  </span>
                </div>

                <div className="form-field">
                  <label htmlFor="new-contract-due-day">
                    Día de pago<span className="required-mark" aria-hidden="true"> *</span>
                  </label>
                  <input
                    id="new-contract-due-day"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="31"
                    value={dueDay}
                    placeholder="5"
                    onChange={(event) => setDueDay(event.target.value)}
                  />
                  <span className="field-hint">
                    Los meses cortos se ajustan solos: el 31 vence el 28 en febrero.
                  </span>
                </div>
              </>
            )}

            <div className="form-field">
              <label htmlFor="new-contract-signed">
                Fecha de firma<span className="required-mark" aria-hidden="true"> *</span>
              </label>
              <input
                id="new-contract-signed"
                type="date"
                value={signedOn}
                onChange={(event) => setSignedOnOverride(event.target.value)}
              />
              <span className="field-hint">
                {joinContract && signedOnOverride === null
                  ? `Tomada de ${joinContract.code}, la otra mitad de esta compra.`
                  : "Desde aquí cuenta el calendario de pagos."}
              </span>
            </div>

            {isFinanced && (
              <div className="form-field">
                <label htmlFor="new-contract-first-due">Primera cuota</label>
                <input
                  id="new-contract-first-due"
                  type="date"
                  value={firstDueOn}
                  onChange={(event) => setFirstDueOn(event.target.value)}
                />
                <span className="field-hint">
                  {firstDueOn.trim() === "" && scheduledFirstDue !== null
                    ? `Opcional. Sin fecha vence el ${formatDate(scheduledFirstDue)}, un mes después de firmar.`
                    : "Solo si se negoció aparte. Déjalo vacío para contar un mes desde la firma."}
                </span>
              </div>
            )}

            {isReservation && (
              <div className="form-field">
                <label htmlFor="new-contract-expires">
                  Vence la reserva<span className="required-mark" aria-hidden="true"> *</span>
                </label>
                <input
                  id="new-contract-expires"
                  type="date"
                  value={expiresOn}
                  onChange={(event) => setExpiresOverride(event.target.value)}
                />
                <span className="field-hint">
                  Un apartado sin fecha deja el lote fuera del mercado para siempre.
                </span>
              </div>
            )}

            <div className="form-field full-width">
              <label htmlFor="new-contract-notes">Notas</label>
              <textarea
                id="new-contract-notes"
                rows={2}
                value={notes}
                placeholder="Ej. Paga por transferencia los primeros días del mes."
                onChange={(event) => setNotes(event.target.value)}
              />
              <span className="field-hint">
                Se ve en la lista de contratos, debajo del nombre del cliente.
              </span>
            </div>

            {/* The schedule as it really comes out, not as the two numbers
                above suggest. The last cuota absorbs the rounding, so an agreed
                figure over an agreed term routinely produces a final payment
                that is nothing like the others — and that is worth seeing
                before it is promised to somebody rather than a year later. */}
            {schedule !== null && (
              <p className="form-note full-width">
                <strong>
                  {schedule.count} cuota{schedule.count === 1 ? "" : "s"}
                </strong>{" "}
                de {formatMoney(cents(monthlyCents), money)}, de{" "}
                {formatDate(scheduledFirstDue)} a {formatDate(schedule.lastDueOn)}.
                {schedule.lastAmountCents !== monthlyCents && (
                  <>
                    {" "}
                    La última es de {formatMoney(cents(schedule.lastAmountCents), money)}: absorbe
                    la diferencia del redondeo.
                  </>
                )}
                {schedule.count < (months ?? 0) && (
                  <>
                    {" "}
                    Con esa cuota el saldo se termina en {schedule.count} meses, antes de los{" "}
                    {months} del plazo.
                  </>
                )}
              </p>
            )}

            {error && <p className="form-error full-width">{error}</p>}
          </div>
        )}

        <div className="modal-actions">
          {step === "terms" ? (
            <button type="button" className="btn-secondary" onClick={goBack} disabled={isSaving}>
              Atrás
            </button>
          ) : (
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancelar
            </button>
          )}

          <button
            type="submit"
            className="btn-primary modal-submit"
            disabled={isSaving || (step === "parties" && (customer === null || lot === null))}
          >
            <span>
              {step === "parties"
                ? "Continuar"
                : isSaving
                  ? "Creando…"
                  : isReservation
                    ? "Crear reserva"
                    : "Crear contrato"}
            </span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
