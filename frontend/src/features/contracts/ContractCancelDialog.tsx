import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { MoneyView } from "../../lib/money";
import { formatMoney } from "../../lib/money";
import type { Contract } from "../../types";
import type { CancelSettlement } from "./api";

const MINIMUM_REASON_LENGTH = 10;

/**
 * Cancelling and defaulting are the same dialog: the lot comes back, nothing is
 * deleted, and the same question is asked about money already paid. They differ
 * only in wording — a cancellation is a sale unwound by agreement, a default is
 * the business writing off what it is owed.
 */
type Mode = "cancel" | "default";

interface ContractCancelDialogProps {
  contract: Contract;
  money: MoneyView;
  mode?: Mode;
  /** May this user reverse payments? Gates the "refund" option. */
  canRefund: boolean;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: (reason: string, settlement?: CancelSettlement) => Promise<void>;
}

const COPY: Record<
  Mode,
  { eyebrow: string; submit: string; busy: string; placeholder: string; moneyHint: string }
> = {
  cancel: {
    eyebrow: "Cancelar contrato",
    submit: "Cancelar contrato",
    busy: "Cancelando…",
    placeholder: "Ej. El cliente desistió de la compra y se acordó devolver la prima.",
    moneyHint: "¿Qué pasa con ese dinero?",
  },
  default: {
    eyebrow: "Declarar incumplido",
    submit: "Marcar como incumplido",
    busy: "Guardando…",
    placeholder: "Ej. El cliente perdió el empleo y avisó que no podrá seguir pagando.",
    moneyHint: "¿Qué pasa con lo que ya pagó? Lo habitual es que quede como ingreso.",
  },
};

const SETTLEMENT_OPTIONS: Array<{
  value: CancelSettlement;
  title: string;
  detail: string;
  needsRefundRight?: boolean;
}> = [
  {
    value: "none",
    title: "Queda como ingreso",
    detail: "No se devuelve nada. Lo pagado se mantiene en las cuentas.",
  },
  {
    value: "held",
    title: "Retenido temporalmente",
    detail: "Sigue contando por ahora. Queda marcado para decidir después.",
  },
  {
    value: "refunded",
    title: "Reembolsado al cliente",
    detail:
      "Se revierten los pagos ahora mismo: dejan de contar y el recibo que cubrían se anula.",
    needsRefundRight: true,
  },
];

export function ContractCancelDialog({
  contract,
  money,
  mode = "cancel",
  canRefund,
  onCancel,
  onConfirm,
}: ContractCancelDialogProps) {
  const [reason, setReason] = useState("");
  const [settlement, setSettlement] = useState<CancelSettlement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);

  const copy = COPY[mode];
  const hasMoney = contract.paidToDate > 0;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Explica el motivo con al menos ${MINIMUM_REASON_LENGTH} caracteres.`);
      return;
    }

    if (hasMoney && settlement === null) {
      setError("Indica qué pasa con el dinero que el cliente ya pagó.");
      return;
    }

    setSubmitting(true);

    try {
      await onConfirm(reason.trim(), hasMoney ? (settlement ?? undefined) : undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo completar la acción.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog ariaLabel={`${copy.eyebrow} ${contract.code}`} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow danger-eyebrow">{copy.eyebrow}</p>
            <h2>{contract.code}</h2>
            <p className="modal-description">
              El lote {contract.lot.code} vuelve a quedar disponible. El contrato y sus pagos se
              conservan en el historial: nada se elimina.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          {hasMoney && (
            <fieldset className="form-field full-width settlement-choice">
              <legend>
                {contract.customer.fullName} ya pagó {formatMoney(contract.paidToDate, money)} en
                este contrato. {copy.moneyHint}
                <span className="required-mark" aria-hidden="true"> *</span>
              </legend>

              {SETTLEMENT_OPTIONS.map((option) => {
                const disabled = option.needsRefundRight === true && !canRefund;

                return (
                  <label
                    key={option.value}
                    className={disabled ? "settlement-option is-disabled" : "settlement-option"}
                  >
                    <input
                      type="radio"
                      name="settlement"
                      value={option.value}
                      checked={settlement === option.value}
                      disabled={disabled}
                      onChange={() => setSettlement(option.value)}
                    />
                    <span>
                      <span className="settlement-title">{option.title}</span>
                      <span className="settlement-detail">
                        {option.detail}
                        {disabled && " Tu usuario no puede revertir pagos."}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}

          <div className="form-field full-width">
            <label htmlFor="cancel-reason">
              Motivo<span className="required-mark" aria-hidden="true"> *</span>
            </label>
            <textarea
              id="cancel-reason"
              rows={3}
              value={reason}
              placeholder={copy.placeholder}
              onChange={(event) => setReason(event.target.value)}
            />
            <span className="field-hint">
              Queda guardado en el historial junto con tu nombre y la fecha.
            </span>
          </div>

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSubmitting}>
            Volver
          </button>
          <button type="submit" className="btn-danger" disabled={isSubmitting}>
            {isSubmitting ? copy.busy : copy.submit}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
