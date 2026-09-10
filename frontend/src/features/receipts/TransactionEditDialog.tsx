import { useEffect, useMemo, useRef, useState } from "react";

import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog } from "../../components/Dialog";
import { DocumentThumb, DocumentViewer } from "../../components/DocumentViewer";
import type { ViewerFile } from "../../components/DocumentViewer";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { ApiError } from "../../lib/api";
import { readableSize } from "../../lib/documentFiles";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { ReceiptAttachment, Transaction } from "../../types";
import type { TransactionEdit } from "./api";
import { deleteAttachment, storedProof, updateTransaction, uploadAttachment } from "./api";
import { useFileDrop } from "../../lib/useFileDrop";
import type { PaymentType } from "./paymentType";
import { PAYMENT_TYPE_OPTIONS } from "./paymentType";
import { MAX_PROOFS, PROOF_ACCEPT, acceptProofFiles } from "./ProofDropzone";
import { compareLedgerOrder } from "./transactionSort";

interface TransactionEditDialogProps {
  transaction: Transaction;
  /** Every transaction of the SAME customer, so the edit is seen in context. */
  customerTransactions: Transaction[];
  money: MoneyView;
  onClose: () => void;
  onSaved: () => void;
  /**
   * Whether this user may attach and remove comprobantes.
   *
   * `payment:record` rather than `payment:edit`, deliberately, and they are not
   * the same permission: filing the slip the customer sent is part of recording
   * the money, while editing is rewriting a figure that was already posted.
   * Somebody allowed to correct an amount is not thereby allowed to add
   * evidence, and somebody who records payments all day is not thereby allowed
   * to correct them.
   */
  canAttachProof: boolean;
  /** The comprobantes changed on the server; the list behind has to re-read. */
  onProofsChanged: () => void;
}

type Method = "cash" | "transfer" | "card";

const METHODS: Array<{ value: Method; label: string }> = [
  { value: "cash", label: "Efectivo" },
  { value: "transfer", label: "Transferencia" },
  { value: "card", label: "Tarjeta" },
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
  canAttachProof,
  onProofsChanged,
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

  /*
   * The comprobantes on this row, held here rather than read off the prop.
   *
   * `transaction` is a snapshot App took when the pencil was pressed and it
   * does not change while the dialog is open, so a file uploaded here would not
   * appear until the dialog was closed and reopened — i.e. it would look like
   * the upload had failed. The list behind is refreshed too, through
   * `onProofsChanged`; this is what the dialog itself shows meanwhile.
   */
  const [attachments, setAttachments] = useState<ReceiptAttachment[]>(transaction.attachments);
  /*
   * Whether a comprobante was filed or removed while this dialog was open.
   *
   * Not part of the correction — those writes already went to the server — but
   * it changes what the two buttons at the bottom should SAY. Somebody who
   * opened the pencil only to attach the slip the customer sent has finished
   * their work, and telling them so is the difference between a screen that
   * saved their file and a screen that appears to have swallowed it.
   */
  const [proofsFiled, setProofsFiled] = useState(false);
  const [proofBusy, setProofBusy] = useState<string | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const [viewingProof, setViewingProof] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<ViewerFile | null>(null);
  const proofInputRef = useRef<HTMLInputElement>(null);

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

  /**
   * Ordered oldest-first here, because this is a history rather than a feed.
   *
   * `compareLedgerOrder` rather than a sort spelled out again: this is the
   * order `backend/src/lib/ledger.ts` replays a contract in, so the sequence
   * read here is the sequence the balances either side of this edit were
   * derived from — and it is the same function the Recibos list sorts by, which
   * is what makes that list's "más recientes primero" the exact reverse of this
   * panel. Written out twice, the two drifted: rows tied on both the date and
   * the entry time came out in the same order in a list that claimed to be
   * newest-first, so the last row of a customer's payments opened here as their
   * third rather than their first.
   */
  const history = useMemo(
    () => [...customerTransactions].sort(compareLedgerOrder),
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

  /**
   * The comprobante was the whole errand.
   *
   * Nothing on the form changed and a file was filed, so there is no correction
   * to save and the work is already on the server. The primary button becomes
   * "Listo" and simply closes — pressing the main button and having the screen
   * go away is what "done" looks like, and leaving a permanently dead "Guardar
   * corrección" there instead is what made attaching a slip feel like it had
   * failed.
   */
  const proofWasTheWork = !hasChanges && proofsFiled;

  /**
   * Why the button will not move, in the words of whoever is pressing it.
   *
   * A disabled primary button is now visibly disabled (see `.btn-primary` in
   * styles.css), but "greyed out" only says that it is refusing — not what it
   * is waiting for. Both of the things it waits for are invisible: a motive
   * that is long enough, and a figure that actually differs from the one
   * already posted. Neither is guessable from a grey rectangle.
   *
   * Silent on a form nobody has touched yet, though. A dialog that opens
   * already complaining is telling somebody off for not having done anything
   * in the half-second it has been on screen; the note is for the moment they
   * have started and something is missing, not for the moment they arrive.
   */
  const blockedReason = (() => {
    if (isSaving || canSubmit || proofWasTheWork) {
      return null;
    }

    if (amountCents <= 0) {
      return "Escribe el monto corregido.";
    }

    if (!hasChanges) {
      // Reached only with a motive typed against an untouched form — i.e.
      // somebody clearly intending to save. With a comprobante filed instead,
      // `proofWasTheWork` answered above and the button already says "Listo".
      return trimmedReason.length === 0
        ? null
        : "Ninguna cifra cambió todavía, así que no hay corrección que guardar.";
    }

    return `Escribe el motivo del cambio: al menos ${MINIMUM_REASON} caracteres.`;
  })();

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

  /** This row's evidence, as the viewer and the thumbnails want it. */
  const proofs: ViewerFile[] = attachments.map((file) =>
    storedProof(file, file.paymentId === null ? null : transaction.lotCode),
  );

  /**
   * Attach a comprobante to the payment on screen.
   *
   * Uploaded the moment it is chosen, NOT when "Guardar corrección" is pressed,
   * and the two are deliberately unrelated. Saving requires a real change plus
   * a typed motive, because it rewrites a posted figure. Filing the slip the
   * customer sent changes no figure at all — it adds the evidence for the one
   * already there — so making it wait behind a motive would mean inventing a
   * fake correction in order to attach a file.
   *
   * Tagged with `transaction.id`, so on a receipt covering three lots the slip
   * lands on THIS lot rather than on the paper as a whole.
   */
  const addProofs = async (incoming: FileList | null) => {
    if (transaction.receiptId === null || incoming === null || incoming.length === 0) {
      return;
    }

    setProofError(null);

    /*
     * Counted against this ROW's files, which is a floor and not the server's
     * actual limit: the cap is eight per RECEIPT, and a receipt covering three
     * lots can already hold files this row never shows. So this refuses the
     * obviously-too-many early and the server stays the authority on the rest —
     * its 409 arrives below as the message it wrote.
     */
    const { accepted, rejections } = acceptProofFiles(
      Array.from(incoming),
      attachments.length,
      MAX_PROOFS,
    );

    if (rejections.length > 0) {
      setProofError(rejections[0]!);
    }

    const stored: ReceiptAttachment[] = [];

    for (const proof of accepted) {
      setProofBusy(`Subiendo ${proof.file.name}…`);

      try {
        stored.push(await uploadAttachment(transaction.receiptId, proof.file, transaction.id));
      } catch (caught) {
        setProofError(
          caught instanceof Error ? caught.message : "No se pudo subir el comprobante.",
        );
      }

      // Held only to validate the file and to name it; nothing here previews
      // it, so the object URL would otherwise leak one image per upload.
      URL.revokeObjectURL(proof.previewUrl);
    }

    setProofBusy(null);

    if (stored.length > 0) {
      setAttachments((held) => [...held, ...stored]);
      setProofsFiled(true);
      onProofsChanged();
    }
  };

  /*
   * Dropping is the same act as choosing, so it goes through the same function
   * — the size, type and count rules, the sequential upload, and the error
   * that leaves the payment untouched are all in `addProofs` already.
   */
  const { isDraggingOver, dropHandlers } = useFileDrop(
    (files) => void addProofs(files),
    proofBusy !== null,
  );

  /**
   * Remove one. Only ever reached from the confirmation.
   *
   * Throws rather than swallowing, so `ConfirmDialog` can stay open and say
   * what went wrong — a prompt that closes on a failed delete looks exactly
   * like one that closed on a successful delete.
   */
  const removeProof = async (attachmentId: string) => {
    setProofError(null);
    setProofBusy("Quitando el comprobante…");

    try {
      await deleteAttachment(attachmentId);
      setAttachments((held) => held.filter((file) => file.id !== attachmentId));
      setProofsFiled(true);
      onProofsChanged();
    } finally {
      setProofBusy(null);
    }
  };

  return (
    /* `wide` because the history beside the form is a table, not prose — see
       the note on `size` in components/Dialog.tsx. It stacks under the form
       below 900px, where the room to put it beside them stops existing. */
    <Dialog
      ariaLabel={`Corregir la transacción de ${transaction.customerName}`}
      size="wide"
      onClose={onClose}
    >
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
                {PAYMENT_TYPE_OPTIONS.map((entry) => (
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

            {/*
              The customer's bank slip, attachable from here.

              It is reachable from the receipt panel too, but that is not where
              anybody looks for it: the comprobante arrives hours or days after
              the payment was recorded — the customer sends it that evening —
              and the gesture for "this payment needs something added" is the
              pencil on its row. Somebody who pressed it found a form about
              amounts and dates with no way to file the slip in their hand, and
              concluded the app could not hold one.

              Nothing here is part of the correction. The files upload as they
              are chosen and the button below never becomes the thing that
              saves them — attaching evidence is not rewriting a figure. What
              it does change is what that button SAYS: with no figure edited
              there is no correction left to save, so it reads "Listo" and
              closes, instead of sitting there refusing to be pressed.
            */}
            <div className="receipt-proofs full-width">
              <div className="receipt-proofs-head">
                <p className="receipt-preview-label">Comprobante del cliente</p>
              </div>

              {transaction.receiptId === null ? (
                /* Not a permission problem and not a bug, so it says which:
                   a comprobante is filed against a receipt, and this money was
                   recorded before there were any. Saying "no se puede" without
                   the reason is what sends somebody hunting for a setting. */
                <p className="state-message">
                  Este pago no está en ningún recibo, y un comprobante se archiva junto al
                  recibo — así que este no puede recibir uno. Los pagos registrados desde
                  Recibos sí.
                </p>
              ) : (
                <>
                  {/*
                    The same gesture the receipt form takes: drag the screenshot
                    straight out of the WhatsApp window.

                    It belongs here more than it belongs there. The comprobante
                    almost never arrives with the money — the customer sends it
                    that evening — so the payment is already recorded by the
                    time there is a file to file, and the pencil on its row is
                    where somebody goes to attach it. Until now this screen
                    offered a file picker and nothing else, which meant the one
                    place the drag was actually wanted was the one place it did
                    not work.
                  */}
                  {canAttachProof && attachments.length < MAX_PROOFS && (
                    <div
                      className={`proof-dropzone is-compact${isDraggingOver ? " is-over" : ""}${
                        proofBusy ? " is-disabled" : ""
                      }`}
                      {...dropHandlers}
                    >
                      <p className="proof-dropzone-title">Arrastra el comprobante aquí</p>
                      <p className="proof-dropzone-hint">
                        Se sube al soltarlo, sin esperar a «Guardar corrección» — adjuntar la
                        prueba no cambia ninguna cifra.
                      </p>

                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={proofBusy !== null}
                        onClick={() => proofInputRef.current?.click()}
                      >
                        Elegir archivo
                      </button>
                    </div>
                  )}

                  {/* Only where there is no dropzone above saying the same
                      thing by being empty. */}
                  {proofs.length === 0 && !canAttachProof && (
                    <p className="state-message">Sin comprobante.</p>
                  )}

                  {/* The zone is gone and the reason is not obvious: without
                      this, being at the limit looks exactly like having lost
                      the permission to attach. */}
                  {canAttachProof && attachments.length >= MAX_PROOFS && (
                    <p className="state-message">
                      Este recibo ya tiene los {MAX_PROOFS} comprobantes que caben. Quita uno
                      para poder agregar otro.
                    </p>
                  )}

                  {proofs.length > 0 && (
                    <div className="proof-grid">
                      {proofs.map((file) => (
                        <button
                          key={file.id}
                          type="button"
                          className="proof-tile"
                          onClick={() => setViewingProof(file.id)}
                          title={`Ver ${file.name}`}
                        >
                          <DocumentThumb file={file} />
                          <span className="proof-tile-name">{file.name}</span>
                          {file.caption && (
                            <span className="proof-tile-lot">{file.caption}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {proofBusy && <p className="state-message">{proofBusy}</p>}
              {proofError && <p className="field-error">{proofError}</p>}

              {/* Off-screen, opened by "Elegir archivo". The dropzone's own
                  accept list, imported rather than written out again; the
                  server's is the one that counts. */}
              <input
                ref={proofInputRef}
                type="file"
                multiple
                className="proof-input"
                accept={PROOF_ACCEPT}
                onChange={(event) => {
                  void addProofs(event.target.files);
                  // Cleared so choosing the SAME file twice in a row still
                  // fires a change event.
                  event.target.value = "";
                }}
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
        {blockedReason && <p className="modal-actions-hint">{blockedReason}</p>}

        {/* "Cancelar" stops being true the moment a comprobante is filed: that
            file is on the server and this button will not take it back. */}
        <button type="button" className="btn-secondary" onClick={onClose}>
          {proofsFiled ? "Cerrar" : "Cancelar"}
        </button>

        {proofWasTheWork ? (
          <button type="button" className="btn-primary modal-submit" onClick={onClose}>
            Listo
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary modal-submit"
            disabled={!canSubmit}
            onClick={() => void submit(false)}
          >
            {isSaving ? "Guardando…" : "Guardar corrección"}
          </button>
        )}
      </div>

      {/*
        Stacked over the edit dialog — `Dialog` portals to <body> and keeps its
        own stack, so the viewer paints above this one and Escape closes only
        the top. It reads `proofs` on every render, so removing several in a row
        is one gesture repeated rather than open-delete-close-reopen.

        Deliberately NOT also guarded on `proofs.length`: the viewer closes
        itself when the list empties, and that is what clears `viewingProof`.
        Guarding here would unmount it first, leaving the id of a deleted file
        in state — so the next comprobante attached would pop the viewer open on
        its own.
      */}
      {viewingProof !== null && (
        <DocumentViewer
          files={proofs}
          startId={viewingProof}
          onClose={() => setViewingProof(null)}
          onRemove={canAttachProof ? setPendingRemoval : undefined}
        />
      )}

      {pendingRemoval && (
        <ConfirmDialog
          eyebrow="Quitar comprobante"
          title={pendingRemoval.name}
          description={
            pendingRemoval.sizeBytes === undefined
              ? undefined
              : readableSize(pendingRemoval.sizeBytes)
          }
          confirmLabel="Quitar comprobante"
          busyLabel="Quitando…"
          onCancel={() => setPendingRemoval(null)}
          onConfirm={async () => {
            await removeProof(pendingRemoval.id);
            setPendingRemoval(null);
          }}
        >
          Esto borra el archivo del servidor para siempre. El pago y el recibo no cambian —
          solo se pierde la prueba que envió el cliente, y si ya no está en el chat no hay
          otra copia.
        </ConfirmDialog>
      )}
    </Dialog>
  );
}
