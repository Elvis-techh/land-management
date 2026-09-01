import { useEffect, useMemo, useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { ApiError } from "../../lib/api";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { Contract, CustomerRecord, Receipt } from "../../types";
import type { PendingProof } from "./ProofDropzone";
import { ProofDropzone } from "./ProofDropzone";
import type { ReceiptDraft, ReceiptDraftLine } from "./api";
import { createReceipt, fetchCustomerSplit, uploadAttachment } from "./api";

interface NewReceiptDialogProps {
  customers: CustomerRecord[];
  contracts: Contract[];
  money: MoneyView;
  onClose: () => void;
  onIssued: (receipt: Receipt) => void;
}

type Method = "cash" | "transfer" | "card";

const METHODS: Array<{ value: Method; label: string }> = [
  { value: "cash", label: "Efectivo" },
  { value: "transfer", label: "Transferencia" },
  { value: "card", label: "Tarjeta" },
];

/** Matches MAX_ATTACHMENTS_PER_RECEIPT on the server. */
const MAX_PROOFS = 8;

/** Today as a calendar date, in the user's own timezone rather than UTC. */
function todayLocal(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

/**
 * A key unique to one open form.
 *
 * `crypto.randomUUID` only exists in a SECURE context — https, or localhost.
 * Field staff reaching this app over plain http on a LAN address ("192.168.1.x")
 * would find it undefined, and the form would throw before it ever rendered.
 * That is the exact situation the idempotency key exists to protect, so it
 * cannot be the thing that breaks there.
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const random = new Uint8Array(16);

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(random);
  } else {
    for (let index = 0; index < random.length; index += 1) {
      random[index] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Record a payment and issue its receipt.
 *
 * The shape of this form follows the shape of the money: ONE customer, ONE date
 * and ONE method at the top, then a line per lot underneath. That is not a
 * layout preference — it is what a receipt is. A customer holding three lots
 * hands over a single amount at a single window and expects a single piece of
 * paper, and the split across their contracts happens below the fold.
 *
 * Nothing here computes a balance. Every figure the customer will read is
 * derived by the server when the receipt is fetched back, so this form cannot
 * disagree with the document it produces — and the split, likewise, is proposed
 * by the server rather than worked out twice.
 */
export function NewReceiptDialog({
  customers,
  contracts,
  money,
  onClose,
  onIssued,
}: NewReceiptDialogProps) {
  const [customerId, setCustomerId] = useState("");
  const [paidOn, setPaidOn] = useState(todayLocal);
  const [method, setMethod] = useState<Method>("cash");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [totalText, setTotalText] = useState("");
  const [amountByContract, setAmountByContract] = useState<Record<string, string>>({});
  const [proofs, setProofs] = useState<PendingProof[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [overpaymentPrompt, setOverpaymentPrompt] = useState<string | null>(null);
  const [splitNote, setSplitNote] = useState<string | null>(null);
  const [isSplitting, setSplitting] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const [savingStep, setSavingStep] = useState<string | null>(null);

  /**
   * Minted once, for the life of this open form.
   *
   * It has to survive a failed attempt: if the first submission actually
   * reached the server and only the response was lost, the retry must carry the
   * SAME key or the money is taken twice — which is the exact failure the key
   * exists to prevent.
   */
  const [idempotencyKey] = useState(newIdempotencyKey);

  // Only what this person is actually paying on. A cancelled or defaulted
  // contract does not take money, and a paid-off one has nothing left to take.
  const payable = useMemo(
    () => contracts.filter((contract) => contract.customer.id === customerId && contract.status === "active"),
    [contracts, customerId],
  );

  const isMultiLot = payable.length > 1;

  // Object URLs live until revoked. Leaving the form with images still attached
  // would otherwise hold every one of them in memory for the life of the page.
  useEffect(() => {
    return () => {
      for (const proof of proofs) {
        if (proof.previewUrl) {
          URL.revokeObjectURL(proof.previewUrl);
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lines: ReceiptDraftLine[] = useMemo(() => {
    const drafts: ReceiptDraftLine[] = [];

    for (const contract of payable) {
      const typed = parseMoneyInput(amountByContract[contract.id] ?? "");

      if (Number.isNaN(typed) || typed <= 0) {
        continue;
      }

      drafts.push({
        contractId: contract.id,
        amountCents: Math.round(typed * 100),
        // The prima is its own kind of money: it is the term of the contract
        // the customer is settling, not one of the cuotas that follow it.
        type: contract.downPaymentPaid < contract.terms.downPayment ? "down_payment" : "installment",
      });
    }

    return drafts;
  }, [payable, amountByContract]);

  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);

  /**
   * Divide the typed total across everything this customer is paying on.
   *
   * Asked of the SERVER rather than computed here, so this screen and the
   * payment that gets recorded cannot disagree: equal shares rounded down to
   * whole hundreds, capped at what each lot still owes, with the remainder
   * going to the lot that owes the most — which is what makes the lots even out
   * over a term instead of one always taking the odd money.
   *
   * The result lands in the per-lot fields as ordinary typed values, so every
   * line stays editable afterwards. It is a proposal, never a decision.
   */
  const distribute = async () => {
    const typed = parseMoneyInput(totalText);

    if (Number.isNaN(typed) || typed <= 0) {
      setError("Escribe el total que entregó el cliente.");
      return;
    }

    setError(null);
    setSplitNote(null);
    setSplitting(true);

    try {
      const result = await fetchCustomerSplit(customerId, Math.round(typed * 100));
      const next: Record<string, string> = {};

      for (const line of result.lines) {
        next[line.contractId] = line.amountCents > 0 ? toMoneyInput(cents(line.amountCents)) : "";
      }

      setAmountByContract(next);

      if (result.unallocatedCents > 0) {
        // Handed back rather than absorbed: pushing the extra onto a lot that
        // is already paid off is how a customer ends up with a credit nobody
        // can explain.
        setSplitNote(
          `Sobran ${formatMoney(cents(result.unallocatedCents), money)}: el cliente ya no debe tanto. ` +
            "Decide a dónde va ese dinero antes de guardar.",
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo repartir el monto.");
    } finally {
      setSplitting(false);
    }
  };

  const submit = async (allowOverpayment: boolean) => {
    setError(null);
    setSaving(true);
    setSavingStep("Registrando el pago…");

    const draft: ReceiptDraft = {
      customerId,
      paidOn,
      method,
      reference: reference.trim() === "" ? null : reference.trim(),
      note: note.trim() === "" ? null : note.trim(),
      idempotencyKey,
      allowOverpayment,
      lines,
    };

    try {
      const { receipt } = await createReceipt(draft);

      // The receipt has to exist before a file can belong to it, so the uploads
      // follow rather than travel with it.
      if (proofs.length > 0) {
        const failures: string[] = [];

        for (const [index, proof] of proofs.entries()) {
          setSavingStep(`Subiendo comprobante ${index + 1} de ${proofs.length}…`);

          try {
            await uploadAttachment(receipt.id, proof.file);
          } catch {
            failures.push(proof.file.name);
          }
        }

        // The money is already recorded, so a failed upload must NOT read as a
        // failed payment. The receipt stands; the file can be added again from
        // the receipt itself.
        if (failures.length > 0) {
          setError(
            `El pago quedó registrado como ${receipt.code}, pero no se pudo subir ` +
              `${failures.join(", ")}. Puedes adjuntarlo de nuevo desde el recibo.`,
          );
          setSaving(false);
          setSavingStep(null);
          return;
        }
      }

      onIssued(receipt);
    } catch (caught) {
      // The server refuses an overpayment by default and names the balance.
      // Surfaced as a question rather than an error: paying more than is owed
      // is a real thing customers do, it just must not happen by accident.
      if (caught instanceof ApiError && caught.code === "overpayment") {
        setOverpaymentPrompt(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : "No se pudo registrar el recibo.");
      }
      setSaving(false);
      setSavingStep(null);
    }
  };

  const canSubmit = customerId !== "" && lines.length > 0 && !isSaving;

  return (
    <Dialog ariaLabel="Registrar una transacción" onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">Nueva transacción</p>
          <h2>Registrar un pago</h2>
          <p className="modal-description">
            Un recibo por cliente. Si tiene varios lotes, se reparte abajo y cada uno conserva su
            propio saldo.
          </p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          <IconClose />
        </button>
      </div>

      <div className="modal-form-grid">
        <div className="form-field full-width">
          <label htmlFor="receipt-customer">
            Cliente <span className="required-mark">*</span>
          </label>
          <select
            id="receipt-customer"
            value={customerId}
            onChange={(event) => {
              setCustomerId(event.target.value);
              // Amounts belong to the previous person's lots; keeping them
              // would file one customer's money against another's contract.
              setAmountByContract({});
              setTotalText("");
              setSplitNote(null);
              setOverpaymentPrompt(null);
            }}
          >
            <option value="">Selecciona un cliente…</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.fullName} · {customer.identification}
              </option>
            ))}
          </select>
        </div>

        <div className="form-field">
          <label htmlFor="receipt-date">
            Fecha del pago <span className="required-mark">*</span>
          </label>
          <input
            id="receipt-date"
            type="date"
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
          />
          <span className="field-hint">
            El día que entró el dinero, no el día que lo registras. Una fecha anterior se acomoda
            sola en su lugar del historial.
          </span>
        </div>

        <div className="form-field">
          <label htmlFor="receipt-method">Forma de pago</label>
          <select
            id="receipt-method"
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

        {method === "transfer" && (
          <div className="form-field full-width">
            <label htmlFor="receipt-reference">Número de confirmación</label>
            <input
              id="receipt-reference"
              type="text"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Ej. BAC-889231"
            />
            <span className="field-hint">
              Lo que permite cuadrar este pago contra el estado de cuenta del banco meses después.
            </span>
          </div>
        )}
      </div>

      {customerId !== "" && payable.length === 0 && (
        <p className="form-blocked">Este cliente no tiene contratos que admitan pagos.</p>
      )}

      {payable.length > 0 && (
        <div className="split-preview">
          <p className="cp-section-title">
            {isMultiLot ? `Repartir entre sus ${payable.length} lotes` : "Monto"}
          </p>

          {isMultiLot && (
            // The fast path: the customer hands over one figure for three lots
            // and nobody wants to do the division at the window.
            <div className="split-total-row">
              <div className="form-field">
                <label htmlFor="receipt-total">Total entregado</label>
                <MoneyInput
                  id="receipt-total"
                  value={totalText}
                  onChange={setTotalText}
                  placeholder="Ej. 25,000"
                />
              </div>

              <button
                type="button"
                className="btn-secondary"
                disabled={isSplitting || totalText.trim() === ""}
                onClick={() => void distribute()}
              >
                {isSplitting ? "Repartiendo…" : "Repartir entre los lotes"}
              </button>
            </div>
          )}

          {isMultiLot && (
            <p className="field-hint">
              Partes iguales redondeadas a cien lempiras, sin pasarse de lo que debe cada lote. El
              sobrante va al que más debe, así el mes siguiente le toca a otro y con el tiempo se
              emparejan solos. Puedes ajustar cualquier línea después.
            </p>
          )}

          <table className="split-table">
            <thead>
              <tr>
                <th>Lote</th>
                <th className="col-money">Saldo actual</th>
                <th className="col-money">Recibe</th>
              </tr>
            </thead>
            <tbody>
              {payable.map((contract) => (
                <tr key={contract.id}>
                  <td>
                    <span className="code-badge">{contract.lot.code}</span>
                    <span className="cell-sub">{contract.lot.projectName}</span>
                  </td>
                  <td className="col-money">
                    <span className="cell-money is-balance">
                      {formatMoney(contract.balance, money)}
                    </span>
                    {contract.health.nextDueOn && (
                      <span className="cell-sub">
                        próxima {formatMoney(contract.health.nextDueAmount, money)}
                      </span>
                    )}
                  </td>
                  <td className="col-money">
                    <MoneyInput
                      id={`receipt-amount-${contract.id}`}
                      value={amountByContract[contract.id] ?? ""}
                      onChange={(formatted) =>
                        setAmountByContract((current) => ({
                          ...current,
                          [contract.id]: formatted,
                        }))
                      }
                      placeholder="0"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {splitNote && <p className="form-blocked">{splitNote}</p>}

          {total > 0 && (
            <p className="receipt-running-total">
              Total del recibo <strong>{formatMoney(cents(total), money)}</strong>
            </p>
          )}
        </div>
      )}

      <div className="modal-form-grid">
        <div className="form-field full-width">
          <label>Comprobante</label>
          <ProofDropzone
            files={proofs}
            onFilesChange={setProofs}
            onReject={setError}
            maxFiles={MAX_PROOFS}
            disabled={isSaving}
          />
        </div>

        <div className="form-field full-width">
          <label htmlFor="receipt-note">Nota (opcional)</label>
          <input
            id="receipt-note"
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Lo que quede impreso en el recibo"
          />
        </div>

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
              Sí, el cliente entregó de más — registrarlo
            </button>
          </div>
        )}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={isSaving}>
          Cancelar
        </button>
        <button
          type="button"
          className="btn-primary modal-submit"
          disabled={!canSubmit}
          onClick={() => void submit(false)}
        >
          {savingStep ?? "Registrar y emitir recibo"}
        </button>
      </div>
    </Dialog>
  );
}
