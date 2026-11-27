import type { FormEvent, KeyboardEvent } from "react";
import { useState } from "react";

import type { MoneyView } from "../../lib/money";
import type { Receipt } from "../../types";
import { remainingNotes } from "./appliedLabel";

/** The server's limit, repeated so the box stops taking text instead of refusing it. */
const MAX_NOTE_LENGTH = 500;

interface ReceiptNoteProps {
  receipt: Receipt;
  /** How the figures in the automatic lines are shown, the same as the rest of the screen. */
  money: MoneyView;
  /**
   * Whether this user may write or change the note.
   *
   * Reading is for everybody who can see the receipt — that is the point of it.
   * Writing rides on the same permission as recording a payment: the clerk who
   * took the money is the one who leaves the message.
   */
  canWrite: boolean;
  /** Rejects with the message to show when the server refuses. */
  onSave: (note: string | null) => Promise<void>;
}

/**
 * The message left on a receipt for whoever reads it next.
 *
 * It sits beside the document in the Recibos panel and never on it. It used to
 * be printed at the foot of the receipt, which is also the picture sent to the
 * customer over WhatsApp — so a note meant for the office reached the person it
 * was about, and nobody not holding the paper ever saw it.
 *
 * It also carries, above what a person wrote, what the payment left owing on
 * each lot it only part-paid ("B-04: faltan L. 47,223.00 de la cuota 1 de 3").
 * The receipt used to print that figure; the customer's copy only needs to say
 * the money was received, so it moved here (owner, 27 Nov 2026). Those lines are
 * worked out from the receipt every time it is opened, never stored: they are
 * not part of the text the note's «Editar» changes, they cannot run into its
 * 500 characters, they cannot go stale when an earlier payment is corrected,
 * and the receipts issued before this change have them too.
 *
 * Mount it with `key={receipt.id}`: an edit in progress belongs to one receipt,
 * and picking another row must not carry half a sentence over to it.
 */
export function ReceiptNote({ receipt, money, canWrite, onSave }: ReceiptNoteProps) {
  const [isEditing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  // A voided receipt moved no money, so it left nothing owing.
  const owing = receipt.voidedAt ? [] : remainingNotes(receipt.lines, money);

  // Nothing written, nothing automatic and nothing the user could write: no
  // empty box to look at.
  if (receipt.note === null && owing.length === 0 && !canWrite) {
    return null;
  }

  const startEditing = () => {
    setDraft(receipt.note ?? "");
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();

    const next = draft.trim() === "" ? null : draft.trim();

    // Unchanged is not a save: no request, and nothing for the Historial.
    if (next === receipt.note) {
      cancel();
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await onSave(next);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo guardar la nota.");
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && !isSaving) {
      event.stopPropagation();
      cancel();
    }
  };

  return (
    <section
      className={`receipt-memo${receipt.note === null && owing.length === 0 && !isEditing ? " is-empty" : ""}`}
      aria-label="Nota del recibo"
    >
      <div className="receipt-memo-head">
        <p className="receipt-memo-label">Nota del equipo</p>

        {canWrite && !isEditing && (
          <button type="button" className="btn-secondary is-small" onClick={startEditing}>
            {receipt.note === null ? "Agregar nota" : "Editar"}
          </button>
        )}
      </div>

      {owing.length > 0 && (
        <ul className="receipt-memo-auto" aria-label="Lo que falta por lote">
          {owing.map((text) => (
            // "L." stays with its figure when the line wraps on a phone.
            <li key={text}>{text.replace(/(L\.) /g, "$1 ")}</li>
          ))}
        </ul>
      )}

      {isEditing ? (
        <form onSubmit={(event) => void save(event)}>
          <textarea
            rows={3}
            maxLength={MAX_NOTE_LENGTH}
            value={draft}
            autoFocus
            aria-label="Nota del recibo"
            placeholder="Ej. Pagará el resto el viernes. Falta el comprobante."
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
          />

          <p className="receipt-memo-hint">
            La ven todos los usuarios. No se imprime en el recibo ni se envía al cliente.
          </p>

          {error && <p className="form-error">{error}</p>}

          <div className="receipt-memo-actions">
            <button
              type="button"
              className="btn-secondary is-small"
              onClick={cancel}
              disabled={isSaving}
            >
              Cancelar
            </button>
            <button type="submit" className="btn-primary is-small" disabled={isSaving}>
              {isSaving ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </form>
      ) : (
        receipt.note !== null && <p className="receipt-memo-text">{receipt.note}</p>
      )}
    </section>
  );
}
