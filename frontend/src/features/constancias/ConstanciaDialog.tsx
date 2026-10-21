import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { CertifiableContract, Constancia } from "./api";
import { coversExactly, fetchContractConstancias, issueConstancia } from "./api";
import { ConstanciaPaper } from "./ConstanciaPaper";

interface ConstanciaDialogProps {
  contract: { id: string; code: string };
  /** May this user issue one? Viewing a standing one needs no capability. */
  canIssue: boolean;
  onClose: () => void;
}

type State =
  | { status: "loading" }
  | { status: "ready"; eligible: CertifiableContract[]; standing: Constancia[] }
  | { status: "error"; message: string };

/**
 * Show a constancia for this contract, issue one, and print it.
 *
 * When the customer has other paid-off lots, they are offered as checkboxes:
 * ticked together, they make one combined constancia for all of them. The
 * dialog shows whichever constancia stands for exactly the lots ticked — this
 * contract's own, or a combined one — and offers to issue one when none does.
 *
 * Issuing is a deliberate click rather than something opening the dialog does:
 * a constancia is a legal statement, and the supervisor should be the one who
 * decides the contracts are ready for it, not a side effect of looking.
 */
export function ConstanciaDialog({ contract, canIssue, onClose }: ConstanciaDialogProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set([contract.id]));
  const [isIssuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  // On by default: the notary usually wants the detail, and leaving it out is
  // the decision somebody makes on purpose.
  const [withAnnex, setWithAnnex] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetchContractConstancias(contract.id)
      .then(({ eligible, standing }) => !cancelled && setState({ status: "ready", eligible, standing }))
      .catch(
        (caught: unknown) =>
          !cancelled &&
          setState({
            status: "error",
            message: caught instanceof Error ? caught.message : "No se pudo cargar la constancia.",
          }),
      );

    return () => {
      cancelled = true;
    };
  }, [contract.id]);

  /*
   * What prints is the copy in `.constancia-print-root`, a direct child of
   * <body>, and nothing else — the class on <body> tells the print stylesheet
   * to hide every other child, the dialog included. Printing the dialog itself
   * would print its scroll position and its buttons.
   */
  useEffect(() => {
    document.body.classList.add("has-constancia");

    return () => document.body.classList.remove("has-constancia");
  }, []);

  const constancia = useMemo(
    () =>
      state.status === "ready"
        ? (state.standing.find((candidate) => coversExactly(candidate, selected)) ?? null)
        : null,
    [state, selected],
  );

  const toggle = (contractId: string) => {
    setIssueError(null);
    setSelected((current) => {
      const next = new Set(current);

      if (next.has(contractId)) {
        next.delete(contractId);
      } else {
        next.add(contractId);
      }

      return next;
    });
  };

  const issue = async () => {
    setIssuing(true);
    setIssueError(null);

    try {
      const issued = await issueConstancia([...selected]);

      setState((current) =>
        current.status === "ready"
          ? { ...current, standing: [...current.standing.filter((c) => c.id !== issued.id), issued] }
          : current,
      );
    } catch (caught) {
      setIssueError(caught instanceof Error ? caught.message : "No se pudo emitir la constancia.");
    } finally {
      setIssuing(false);
    }
  };

  const others = state.status === "ready" ? state.eligible.filter((c) => c.contractId !== contract.id) : [];
  const isCombined = selected.size > 1;

  return (
    <Dialog ariaLabel={`Constancia del contrato ${contract.code}`} size="wide" onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">Constancia de cancelación total</p>
          <h2>{contract.code}</h2>
          {constancia && (
            <p className="modal-description">
              {constancia.code} · emitida por {constancia.issuedBy.name}
            </p>
          )}
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          <IconClose />
        </button>
      </div>

      <div className="constancia-dialog-body">
        {state.status === "loading" && <p className="modal-description">Cargando…</p>}
        {state.status === "error" && <p className="form-error">{state.message}</p>}

        {state.status === "ready" && others.length > 0 && (
          <fieldset className="constancia-lots">
            <legend>
              Este cliente tiene otros lotes pagados. Marca los que van en la misma constancia.
            </legend>
            {state.eligible.map((candidate) => (
              <label key={candidate.contractId} className="constancia-lot-choice">
                <input
                  type="checkbox"
                  checked={selected.has(candidate.contractId)}
                  // This contract is the one the dialog was opened from, so it
                  // is always on the constancia.
                  disabled={candidate.contractId === contract.id}
                  onChange={() => toggle(candidate.contractId)}
                />
                <span>
                  Lote {candidate.lotCode} · {candidate.projectName} · {candidate.contractCode}
                </span>
              </label>
            ))}
          </fieldset>
        )}

        {state.status === "ready" && constancia === null && (
          <p className="modal-description">
            {canIssue
              ? isCombined
                ? `Estos ${selected.size} lotes todavía no tienen una constancia en conjunto. La constancia de cada lote por separado sigue valiendo; si alguno vuelve a tener saldo, la conjunta queda ANULADA.`
                : "Este contrato está pagado y todavía no tiene constancia. Al emitirla recibe su número y su código de verificación; si el contrato vuelve a tener saldo, queda ANULADA."
              : "Todavía no hay constancia para estos lotes. Pide a un supervisor que la emita."}
          </p>
        )}

        {constancia && (
          <label className="constancia-annex-toggle">
            <input
              type="checkbox"
              checked={withAnnex}
              onChange={(event) => setWithAnnex(event.target.checked)}
            />
            <span>Incluir el historial completo de pagos (anexo)</span>
          </label>
        )}
        {constancia && <ConstanciaPaper constancia={constancia} withAnnex={withAnnex} />}
        {issueError && <p className="form-error">{issueError}</p>}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cerrar
        </button>
        {state.status === "ready" && constancia === null && canIssue && (
          <button type="button" className="btn-primary" onClick={() => void issue()} disabled={isIssuing}>
            {isIssuing ? "Emitiendo…" : isCombined ? `Emitir constancia de ${selected.size} lotes` : "Emitir constancia"}
          </button>
        )}
        {constancia && (
          <button type="button" className="btn-primary" onClick={() => window.print()}>
            Imprimir
          </button>
        )}
      </div>

      {constancia &&
        createPortal(
          <div className="constancia-print-root" aria-hidden="true">
            <ConstanciaPaper constancia={constancia} withAnnex={withAnnex} />
          </div>,
          document.body,
        )}
    </Dialog>
  );
}
