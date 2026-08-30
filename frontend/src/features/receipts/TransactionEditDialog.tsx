import { useEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { ApiError } from "../../lib/api";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { Transaction } from "../../types";
import type { TransactionEdit } from "./api";
import { updateTransaction } from "./api";

interface TransactionEditDialogProps {
  transaction: Transaction;
  /** Every transaction of the SAME customer, so the edit is seen in context. */
  customerTransactions: Transaction[];
  money: MoneyView;
  onClose: () => void;
  onSaved: () => void;
}

type Method = "cash" | "transfer" | "card";
type PaymentType = "down_payment" | "installment" | "full_payment" | "adjustment";

const METHODS: Array<{ value: Method; label: string }> = [
  { value: "cash", label: "Efectivo" },
  { value: "transfer", label: "Transferencia" },
  { value: "card", label: "Tarjeta" },
];

const TYPES: Array<{ value: PaymentType; label: string }> = [
  { value: "down_payment", label: "Prima" },
  { value: "installment", label: "Cuota" },
  { value: "full_payment", label: "Pago total" },
  { value: "adjustment", label: "Ajuste" },
];

const MINIMUM_REASON = 10;

/** "15 mar 2026" — compact, for a list rather than a document. */
function shortDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);

  return new Intl.DateTimeFormat("es-HN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year!, month! - 1, day!)));
}

/**
 * Correct a posted transaction.
 *
 * This is the one place in Lindero where a financial fact is rewritten rather
 * than reversed, so the screen is built to make that visible rather than easy:
 * the customer's whole history sits beside the form, the row being changed is
 * marked in it, and a reason is required before the button will do anything.
 *
 * The history is there because an amount has no meaning on its own. "L 5,000 →
 * L 10,000" is a number changing; the same edit seen against the eleven
 * payments around it is a story that either makes sense or obviously does not,
 * and that is the check no validation rule can perform.
 *
 * Every balance after this transaction re-derives on its own once it is saved.
 * Nothing has to be unlocked, and nothing downstream has to be corrected by
 * hand — see backend/src/lib/ledger.ts.
 */
export function TransactionEditDialog({
  transaction,
  customerTransactions,
  money,
  onClose,
  onSaved,
}: TransactionEditDialogProps) {
  const [amountText, setAmountText] = useState(() => toMoneyInput(transaction.amount));
  const [paidOn, setPaidOn] = useState(transaction.paidOn);
  const [method, setMethod] = useState<Method>(transaction.method as Method);
  const [type, setType] = useState<PaymentType>(transaction.type as PaymentType);
  const [reference, setReference] = useState(transaction.reference ?? "");
  const [notes, setNotes] = useState(transaction.notes ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [overpaymentPrompt, setOverpaymentPrompt] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const typedAmount = parseMoneyInput(amountText);
  const amountCents = Number.isNaN(typedAmount) ? 0 : Math.round(typedAmount * 100);
  const trimmedReason = reason.trim();

  const targetRef = useRef<HTMLLIElement>(null);

  /*
   * Scroll the row being corrected into view.
   *
   * A customer with three lots and two years of payments has upwards of sixty
   * rows here, and the one being changed is very often the most recent — i.e.
   * off the bottom. A history you have to hunt through is not context.
   */
  useEffect(() => {
    targetRef.current?.scrollIntoView({ block: "center" });
  }, []);

  /** Ordered oldest-first here, because this is a history rather than a feed. */
  const history = useMemo(
    () =>
      [...customerTransactions].sort(
        (a, b) => a.paidOn.localeCompare(b.paidOn) || a.id.localeCompare(b.id),
      ),
    [customerTransactions],
  );

  const hasChanges =
    amountCents !== transaction.amount ||
    paidOn !== transaction.paidOn ||
    method !== transaction.method ||
    type !== transaction.type ||
    (reference.trim() || null) !== (transaction.reference ?? null) ||
    (notes.trim() || null) !== (transaction.notes ?? null);

  const canSubmit =
    amountCents > 0 && trimmedReason.length >= MINIMUM_REASON && hasChanges && !isSaving;

  const submit = async (allowOverpayment: boolean) => {
    setError(null);
    setSaving(true);

    const edit: TransactionEdit = {
      amountCents,
      paidOn,
      method,
      type,
      reference: reference.trim() === "" ? null : reference.trim(),
      notes: notes.trim() === "" ? null : notes.trim(),
      reason: trimmedReason,
      allowOverpayment,
    };

    try {
      await updateTransaction(transaction.id, edit);
      onSaved();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "overpayment") {
        setOverpaymentPrompt(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : "No se pudo guardar el cambio.");
      }
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Corregir la transacción de ${transaction.customerName}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">Corregir transacción</p>
          <h2>{transaction.customerName}</h2>
          <p className="modal-description">
            {transaction.lotCode} · {transaction.projectName} · registrada por{" "}
            {transaction.recordedByName}
          </p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          <IconClose />
        </button>
      </div>

      <div className="edit-with-history">
        <div className="edit-form">
          <div className="modal-form-grid">
            <div className="form-field">
              <label htmlFor="edit-amount">
                Monto <span className="required-mark">*</span>
              </label>
              <MoneyInput id="edit-amount" value={amountText} onChange={setAmountText} />
              {amountCents !== transaction.amount && amountCents > 0 && (
                <span className="field-hint">
                  Antes {formatMoney(transaction.amount, money)} → ahora{" "}
                  {formatMoney(cents(amountCents), money)}
                </span>
              )}
            </div>

            <div className="form-field">
              <label htmlFor="edit-date">
                Fecha del pago <span className="required-mark">*</span>
              </label>
              <input
                id="edit-date"
                type="date"
                value={paidOn}
                onChange={(event) => setPaidOn(event.target.value)}
              />
              {paidOn !== transaction.paidOn && (
                <span className="field-hint">
                  Cambiar la fecha la mueve de lugar en el historial y recalcula los saldos que
                  vienen después.
                </span>
              )}
            </div>

            <div className="form-field">
              <label htmlFor="edit-method">Forma de pago</label>
              <select
                id="edit-method"
                value={method}
                onChange={(event) => setMethod(event.target.value as Method)}
              >
                {METHODS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <label htmlFor="edit-type">Tipo</label>
              <select
                id="edit-type"
                value={type}
                onChange={(event) => setType(event.target.value as PaymentType)}
              >
                {TYPES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-field full-width">
              <label htmlFor="edit-reference">Número de confirmación</label>
              <input
                id="edit-reference"
                type="text"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="Ej. BAC-889231"
              />
            </div>

            <div className="form-field full-width">
              <label htmlFor="edit-notes">Nota</label>
              <input
                id="edit-notes"
                type="text"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>

            <div className="form-field full-width">
              <label htmlFor="edit-reason">
                Motivo del cambio <span className="required-mark">*</span>
              </label>
              <textarea
                id="edit-reason"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Ej. El cliente entregó L 10,000, no L 5,000. Corregido con el recibo físico a la vista."
              />
              <span className="field-hint">
                Queda en el historial junto al monto anterior. Es el único lugar donde sobrevive la
                cifra que estás cambiando.
              </span>
              {trimmedReason.length > 0 && trimmedReason.length < MINIMUM_REASON && (
                <span className="field-error">
                  Escribe al menos {MINIMUM_REASON} caracteres.
                </span>
              )}
            </div>

            {transaction.receiptId && (
              <p className="form-warning full-width">
                Esta transacción está impresa en el recibo {transaction.receiptCode}. Al guardar,
                los montos de ese recibo cambian — si el cliente ya tiene una copia en papel,
                conviene volver a imprimírselo.
              </p>
            )}

            {error && <p className="form-error full-width">{error}</p>}

            {overpaymentPrompt && (
              <div className="form-warning full-width">
                <p>{overpaymentPrompt}</p>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setOverpaymentPrompt(null);
                    void submit(true);
                  }}
                >
                  Sí, el cliente entregó de más — guardarlo así
                </button>
              </div>
            )}
          </div>
        </div>

        {/* The customer's whole history, so the change is judged in context
            rather than as a number on its own. */}
        <aside className="edit-history">
          <p className="cp-section-title">Historial de {transaction.customerName}</p>
          <p className="field-hint">
            {history.length} transacci{history.length === 1 ? "ón" : "ones"} en total.
          </p>

          <ul className="edit-history-list">
            {history.map((entry) => {
              const isTarget = entry.id === transaction.id;

              return (
                <li
                  key={entry.id}
                  ref={isTarget ? targetRef : undefined}
                  className={`edit-history-row${isTarget ? " is-target" : ""}${
                    entry.reversedAt ? " is-void" : ""
                  }`}
                >
                  <span className="edit-history-date">{shortDate(entry.paidOn)}</span>
                  <span className="edit-history-lot">{entry.lotCode}</span>
                  <span className="edit-history-amount">
                    {isTarget && amountCents > 0 && amountCents !== entry.amount
                      ? formatMoney(cents(amountCents), money)
                      : formatMoney(entry.amount, money)}
                  </span>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn-primary modal-submit"
          disabled={!canSubmit}
          onClick={() => void submit(false)}
        >
          {isSaving ? "Guardando…" : "Guardar corrección"}
        </button>
      </div>
    </Dialog>
  );
}
