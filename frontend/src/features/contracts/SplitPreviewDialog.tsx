import { useEffect, useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, parseMoneyInput } from "../../lib/money";
import type { Contract } from "../../types";
import type { SplitLine } from "./api";
import { fetchSplit } from "./api";

interface SplitPreviewDialogProps {
  /** The contracts of one purchase. All share a sale group. */
  contracts: Contract[];
  money: MoneyView;
  onClose: () => void;
}

/**
 * What one receipt would do to each lot of a purchase — before anything is
 * posted.
 *
 * The customer hands over a single amount for three lots and expects a single
 * receipt, but the money has to land on three contracts. The division is worked
 * out by the SERVER, so this screen and the payment that eventually gets
 * recorded cannot disagree about the arithmetic: equal shares rounded down to
 * whole hundreds, with the odd remainder going to the lot that owes the most.
 *
 * Nothing here writes anything. Recording the payment arrives with the
 * transactions screen; this is the preview that makes the rule visible first.
 */
export function SplitPreviewDialog({ contracts, money, onClose }: SplitPreviewDialogProps) {
  const saleGroupId = contracts[0]?.saleGroupId ?? null;
  const customerName = contracts[0]?.customer.fullName ?? "";

  const [amountText, setAmountText] = useState("");
  const [lines, setLines] = useState<SplitLine[]>([]);
  const [unallocated, setUnallocated] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(false);

  const amount = parseMoneyInput(amountText);
  const amountCents = Number.isNaN(amount) ? 0 : Math.round(amount * 100);

  useEffect(() => {
    if (saleGroupId === null || amountCents <= 0) {
      setLines([]);
      setUnallocated(0);
      setError(null);
      return;
    }

    // A typed amount changes on every keystroke, so a stale answer can arrive
    // after a newer one. `cancelled` makes the outdated response drop itself
    // instead of overwriting the current split.
    let cancelled = false;
    setLoading(true);

    fetchSplit(saleGroupId, amountCents)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setLines(result.lines);
        setUnallocated(result.unallocatedCents);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        setError(caught instanceof Error ? caught.message : "No se pudo calcular el reparto.");
        setLines([]);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [saleGroupId, amountCents]);

  const totalBalance = contracts.reduce((sum, contract) => sum + contract.balance, 0);

  return (
    <Dialog ariaLabel={`Repartir un pago de ${customerName}`} onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">Repartir un pago</p>
          <h2>{customerName}</h2>
          <p className="modal-description">
            {contracts.length} lotes en una sola compra · saldo total{" "}
            {formatMoney(cents(totalBalance), money)}
          </p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          <IconClose />
        </button>
      </div>

      <div className="modal-form-grid">
        <div className="form-field full-width">
          <label htmlFor="split-amount">Monto del recibo</label>
          <MoneyInput
            id="split-amount"
            value={amountText}
            onChange={setAmountText}
            placeholder="Ej. 25,000"
          />
          <span className="field-hint">
            Se divide en partes iguales redondeadas a cien lempiras. El sobrante va al lote que
            más debe, así que el mes siguiente le toca a otro y con el tiempo se emparejan solos.
          </span>
        </div>

        {error && <p className="form-error full-width">{error}</p>}
      </div>

      {lines.length > 0 && (
        <div className="split-preview">
          <table className="split-table">
            <thead>
              <tr>
                <th>Lote</th>
                <th className="col-money">Le toca</th>
                <th className="col-money">Saldo después</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.contractId}>
                  <td>
                    <span className="code-badge">{line.lotCode}</span>
                    <span className="cell-sub">{line.contractCode}</span>
                  </td>
                  <td className="col-money">
                    <span className="cell-money">
                      {formatMoney(cents(line.amountCents), money)}
                    </span>
                  </td>
                  <td className="col-money">
                    <span className="cell-money is-balance">
                      {formatMoney(cents(line.balanceAfter), money)}
                    </span>
                    <span className="cell-sub">
                      antes {formatMoney(cents(line.balanceBefore), money)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {unallocated > 0 && (
            // Handed back rather than absorbed: pushing the extra onto a lot
            // that is already paid off is how a customer ends up with a credit
            // nobody can explain.
            <p className="form-blocked">
              Sobran {formatMoney(cents(unallocated), money)}: la compra ya no debe tanto. Hay que
              decidir a dónde va ese dinero antes de registrar el pago.
            </p>
          )}
        </div>
      )}

      {isLoading && lines.length === 0 && <p className="state-message">Calculando…</p>}

      <div className="modal-actions">
        {/* Registering the payment belongs to the transactions screen. Showing
            a disabled button here would promise something this screen cannot
            do yet, so it says so instead — and it sits first, so the button
            stays where a button belongs. */}
        <span className="field-hint modal-foot-note">
          Registrar el pago llega con la pantalla de transacciones.
        </span>
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </Dialog>
  );
}
