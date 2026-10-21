import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { Constancia } from "./api";
import { lookupConstancia } from "./api";
import { ConstanciaPaper } from "./ConstanciaPaper";
import { lotsPhrase } from "./constanciaLayout";

/**
 * «Verificar constancia»: what the office does when a notary or a bank calls
 * and reads out the code printed on one.
 *
 * Inside Lindero, behind the login, on purpose: the answer shows the
 * customer's name, lot and price, and that is not something to hand to
 * whoever has a code. The answer is the first line — VÁLIDA or ANULADA — and
 * the document itself is underneath, so the details can be read back.
 */
export function ConstanciaVerifyDialog({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState("");
  const [result, setResult] = useState<Constancia | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setChecking] = useState(false);

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setChecking(true);
    setError(null);
    setResult(null);

    try {
      setResult(await lookupConstancia(code));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo verificar.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <Dialog ariaLabel="Verificar constancia" size="wide" onClose={onClose}>
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">Constancia de cancelación total</p>
          <h2>Verificar constancia</h2>
          <p className="modal-description">
            Escribe el código de verificación que aparece al pie de la constancia.
          </p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          <IconClose />
        </button>
      </div>

      <form className="constancia-verify-form" onSubmit={(event) => void verify(event)}>
        <label className="form-field">
          <span>Código de verificación</span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="K7M2-9XQR"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </label>
        <button type="submit" className="btn-primary" disabled={isChecking || code.trim() === ""}>
          {isChecking ? "Verificando…" : "Verificar"}
        </button>
      </form>

      <div className="constancia-dialog-body">
        {error && <p className="form-error">{error}</p>}
        {result && (
          <>
            <p className={`constancia-verdict${result.voidedAt ? " is-void" : ""}`}>
              {result.voidedAt
                ? `ANULADA — ${result.voidReason ?? ""}`
                : `VÁLIDA — ${result.customer.fullName}, ${lotsPhrase(result.parts)}`}
            </p>
            <ConstanciaPaper constancia={result} withAnnex />
          </>
        )}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </Dialog>
  );
}
