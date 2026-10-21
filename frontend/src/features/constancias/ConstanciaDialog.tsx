import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { Constancia } from "./api";
import { fetchContractConstancia, issueConstancia } from "./api";
import { ConstanciaPaper } from "./ConstanciaPaper";

interface ConstanciaDialogProps {
  contract: { id: string; code: string };
  /** May this user issue one? Viewing a standing one needs no capability. */
  canIssue: boolean;
  onClose: () => void;
}

type State =
  | { status: "loading" }
  | { status: "ready"; constancia: Constancia | null }
  | { status: "error"; message: string };

/**
 * Show the contract's constancia, issue it if there is none, and print it.
 *
 * Issuing is a deliberate click rather than something opening the dialog does:
 * a constancia is a legal statement, and the supervisor should be the one who
 * decides the contract is ready for it, not a side effect of looking.
 */
export function ConstanciaDialog({ contract, canIssue, onClose }: ConstanciaDialogProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [isIssuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  // On by default: the notary usually wants the detail, and leaving it out is
  // the decision somebody makes on purpose.
  const [withAnnex, setWithAnnex] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetchContractConstancia(contract.id)
      .then((constancia) => !cancelled && setState({ status: "ready", constancia }))
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

  const issue = async () => {
    setIssuing(true);
    setIssueError(null);

    try {
      setState({ status: "ready", constancia: await issueConstancia(contract.id) });
    } catch (caught) {
      setIssueError(caught instanceof Error ? caught.message : "No se pudo emitir la constancia.");
    } finally {
      setIssuing(false);
    }
  };

  const constancia = state.status === "ready" ? state.constancia : null;

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
        {state.status === "ready" && constancia === null && (
          <p className="modal-description">
            {canIssue
              ? "Este contrato está pagado y todavía no tiene constancia. Al emitirla recibe su número y su código de verificación; si el contrato vuelve a tener saldo, queda ANULADA."
              : "Este contrato todavía no tiene constancia. Pide a un supervisor que la emita."}
          </p>
        )}
        {constancia && constancia.payments.length > 0 && (
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
            {isIssuing ? "Emitiendo…" : "Emitir constancia"}
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
