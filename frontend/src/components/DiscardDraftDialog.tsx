import { ConfirmDialog } from "./ConfirmDialog";

interface DiscardDraftDialogProps {
  /** The thing being abandoned, as it reads after "Descartar": "el contrato". */
  what: string;
  /** "Seguir escribiendo": back to the form, nothing lost. */
  onKeep: () => void;
  /** Erase the draft and close the form. */
  onDiscard: () => void;
}

/**
 * "¿Descartar lo escrito?", asked when «Cancelar» or the X closes a form that
 * has something typed in it.
 *
 * Cancelling used to close the form and keep its draft, so the next time the
 * form opened it offered «Quedó algo a medio escribir» — for work the user had
 * just chosen to throw away. Pressing Cancelar is a decision, and a decision
 * should be final; the draft is for what nobody decided: a reload, a phone
 * that slept, a crash. So this asks once, and «Descartar» erases the draft.
 *
 * Asking rather than discarding outright because the X sits a thumb's width
 * from the fields on a phone, and twenty fields copied off a paper contract
 * are not something one stray tap should erase.
 */
export function DiscardDraftDialog({ what, onKeep, onDiscard }: DiscardDraftDialogProps) {
  return (
    <ConfirmDialog
      eyebrow={`Descartar ${what}`}
      title="¿Descartar lo escrito?"
      confirmLabel="Descartar"
      busyLabel="Descartando…"
      cancelLabel="Seguir escribiendo"
      onCancel={onKeep}
      onConfirm={async () => onDiscard()}
    >
      Lo que escribiste se borra y no se guardó nada. La próxima vez el formulario empieza en
      blanco.
    </ConfirmDialog>
  );
}
