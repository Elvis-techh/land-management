import { useEffect, useMemo, useRef, useState } from "react";

import { IconChevronDown, IconEdit, IconWhatsApp } from "../../components/Icons";
import { readableSize } from "../../lib/documentFiles";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney } from "../../lib/money";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import { useIsMobile } from "../../lib/viewport";
import type { Receipt, Transaction } from "../../types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DocumentViewer, DocumentThumb } from "../../components/DocumentViewer";
import type { ViewerFile } from "../../components/DocumentViewer";
import { ReceiptPaper } from "./ReceiptPaper";
import { acceptProofFiles } from "./ProofDropzone";
import { TransactionToolbar } from "./TransactionToolbar";
import type { TransactionView } from "./TransactionToolbar";
import { deleteAttachment, fetchReceipt, storedProof, uploadAttachment } from "./api";
import { receiptToPng } from "./receiptImage";
import { copyGesture, pasteInstruction, receiptCaption, sendReceiptOnWhatsApp } from "./whatsapp";
import type { TransactionFilters } from "./transactionFilters";
import {
  NO_TRANSACTION_FILTERS,
  filterTransactions,
  searchTransactions,
} from "./transactionFilters";
import { DEFAULT_SORT, groupByCustomer, sortTransactions } from "./transactionSort";
import type { TransactionSort } from "./transactionSort";

interface ReceiptsPageProps {
  transactions: Transaction[];
  money: MoneyView;
  user: User;
  onVoidReceipt: (receipt: Receipt) => void;
  onEditTransaction: (transaction: Transaction) => void;
  /**
   * Re-read the list after a comprobante is attached or removed.
   *
   * The thumbnails live on the transaction rows, which are the parent's data —
   * so attaching a file from the receipt panel has to reach back up, or the row
   * that prompted the upload keeps showing nothing.
   */
  onProofsChanged: () => void;
}

/** Matches MAX_ATTACHMENTS_PER_RECEIPT on the server, and `NewReceiptDialog`. */
const MAX_PROOFS = 8;

const METHOD_LABELS: Record<string, string> = {
  cash: "Efectivo",
  transfer: "Transferencia",
  card: "Tarjeta",
};

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

interface RowProps {
  transaction: Transaction;
  money: MoneyView;
  isSelected: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onEdit: () => void;
  /** Show this row's comprobantes, without selecting the row. */
  onOpenProof: (files: ViewerFile[], startId: string) => void;
  /** Hidden inside a customer group, where the name is already the heading. */
  showCustomer: boolean;
}

/**
 * One transaction.
 *
 * The row is a button so the whole thing is one keyboard-reachable target, with
 * the edit control beside it rather than inside it — a button inside a button
 * is invalid HTML and behaves unpredictably when clicked. The thumbnail is
 * outside it for the same reason.
 */
function TransactionRow({
  transaction,
  money,
  isSelected,
  canEdit,
  onSelect,
  onEdit,
  onOpenProof,
  showCustomer,
}: RowProps) {
  const isReversed = transaction.reversedAt !== null;

  /*
   * This row's evidence, ready for the viewer.
   *
   * `storedProof` addresses each file by id on the server, so the thumbnail is
   * the actual comprobante rather than a placeholder — and the browser fetches
   * it lazily, only for rows scrolled into view.
   */
  const proofs = transaction.attachments.map((file) =>
    storedProof(file, file.paymentId === null ? null : transaction.lotCode),
  );

  return (
    <div
      className={`txn-row${isSelected ? " is-selected" : ""}${isReversed ? " is-void" : ""}`}
    >
      {/*
        The comprobante, at a glance and one click from being read.

        Outside `txn-main` because it does something different from the row:
        the row opens the RECEIPT — the document the office issued — and this
        opens the SLIP the customer sent. Both are "look at this payment", and
        confusing them is how somebody confirms a transfer against a document
        the office wrote itself.
      */}
      {proofs.length > 0 && (
        <button
          type="button"
          className="txn-proof"
          onClick={() => onOpenProof(proofs, proofs[0]!.id)}
          title={
            proofs.length === 1
              ? `Ver el comprobante: ${proofs[0]!.name}`
              : `Ver ${proofs.length} comprobantes`
          }
          aria-label={`Ver el comprobante de ${transaction.customerName}`}
        >
          <DocumentThumb file={proofs[0]!} />
          {proofs.length > 1 && <span className="txn-proof-count">{proofs.length}</span>}
        </button>
      )}

      <button type="button" className="txn-main" onClick={onSelect}>
        <span className="txn-date">{shortDate(transaction.paidOn)}</span>

        <span className="txn-who">
          {showCustomer && <span className="txn-name">{transaction.customerName}</span>}
          <span className="txn-detail">
            {transaction.lotCode} · {transaction.projectName}
          </span>
        </span>

        <span className="txn-tags">
          {transaction.receiptCode ? (
            <span className="txn-receipt">{transaction.receiptCode}</span>
          ) : (
            <span className="txn-receipt is-missing" title="Este pago nunca se imprimió">
              sin recibo
            </span>
          )}
          <span className="txn-method">
            {METHOD_LABELS[transaction.method] ?? transaction.method}
          </span>
          {isReversed && <span className="txn-method is-void">anulada</span>}
        </span>

        <span className="txn-amount">{formatMoney(transaction.amount, money)}</span>
      </button>

      {canEdit && !isReversed && (
        <button
          type="button"
          className="icon-btn txn-edit"
          onClick={onEdit}
          aria-label={`Corregir la transacción de ${transaction.customerName} del ${transaction.paidOn}`}
          title="Corregir esta transacción"
        >
          <IconEdit />
        </button>
      )}
    </div>
  );
}

/**
 * The Recibos screen: the transactions on the left, the receipt on the right.
 *
 * Two arrangements of the same list, because the tab is opened for two
 * different questions. "¿Cuánto entró esta semana?" wants everything in date
 * order. "¿Qué ha pagado Ana?" wants one row per person that opens into their
 * history — which is also the only way to find a specific old payment without
 * scrolling through everybody else's.
 *
 * Both are built from ONE array of transactions, so they cannot disagree about
 * what exists. The receipt preview is fetched separately, on demand, because a
 * receipt's figures are derived from the whole ledger and the freshest answer
 * is always the one the server just computed.
 */
export function ReceiptsPage({
  transactions,
  money,
  user,
  onVoidReceipt,
  onEditTransaction,
  onProofsChanged,
}: ReceiptsPageProps) {
  const [view, setView] = useState<TransactionView>("date");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<TransactionSort>(DEFAULT_SORT);
  const [filters, setFilters] = useState<TransactionFilters>(NO_TRANSACTION_FILTERS);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Receipt | null>(null);
  const [isLoadingDetail, setLoadingDetail] = useState(false);

  /*
   * Whatever is being looked at, and where it came from.
   *
   * ONE viewer for every document this screen can show — a row's comprobante,
   * the panel's comprobantes, and the receipt image itself. They are the same
   * act (look at this, full size, without saving it anywhere), so only one can
   * be open at a time.
   *
   * What is stored is the SOURCE, not the list. The panel's files are derived
   * again on every render, so a receipt re-read underneath an open viewer —
   * which a teammate's write makes routine, and which removing a file does on
   * purpose — updates what is on screen instead of leaving it pointed at a
   * file that is no longer there. A row's files are carried, because they may
   * belong to a receipt that is not the one open in the panel.
   */
  const [viewing, setViewing] = useState<
    | { source: "proofs"; startId: string }
    | { source: "receipt" }
    | { source: "row"; files: ViewerFile[]; startId: string }
    | null
  >(null);
  /*
   * The comprobante somebody has asked to remove, waiting on a second press.
   *
   * The same guard the contract documents have, and for the same reason: the
   * remove control lives in a viewer that is opened to LOOK at things, so the
   * press that destroys a file must never be the press that was aimed at
   * dismissing one.
   */
  const [pendingRemoval, setPendingRemoval] = useState<ViewerFile | null>(null);
  const [proofBusy, setProofBusy] = useState<string | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const proofInputRef = useRef<HTMLInputElement>(null);

  /*
   * The receipt as a PNG, prepared as soon as one is opened.
   *
   * Rendered ahead of the button rather than on the press of it, and that is a
   * correctness thing rather than a speed one. `navigator.share` only works
   * while the browser still believes it is inside a user gesture, and Safari
   * stops believing it across an await that takes a few hundred milliseconds —
   * which rasterising an A4 document does. Rendering first means the click has
   * a file in hand and shares immediately.
   *
   * The pleasant side effect is that Enviar is instant, which is the whole
   * point of the feature: the customer is standing at the window.
   */
  const [shareImage, setShareImage] = useState<File | null>(null);
  const [isSharing, setSharing] = useState(false);
  /*
   * What to tell the user after pressing Enviar.
   *
   * Not just errors. On a phone the share sheet appears and needs no words, but
   * on a desktop what happens is that the image lands on the clipboard and a
   * chat opens — and nobody guesses that unless it is said. `chatUrl` is set
   * only when this screen could not open the chat itself, so the message can
   * offer it as a link instead of opening a second tab a blocker would eat.
   */
  const [shareNote, setShareNote] = useState<
    { tone: "info" | "error"; text: string; chatUrl?: string } | null
  >(null);
  const shareStageRef = useRef<HTMLDivElement>(null);

  /*
   * On a phone the receipt is a SCREEN, not a column.
   *
   * Side by side, the list and the document are two panes and picking a row
   * fills the one next to it. Stacked, the same arrangement puts the receipt —
   * and Imprimir and Anular with it — underneath every transaction in the list,
   * so printing the receipt somebody just tapped means scrolling past a hundred
   * rows to reach the button. The document is what the tab is FOR; it cannot be
   * the part you have to go looking for.
   *
   * So on a phone, tapping a transaction opens the receipt over the list
   * instead of below it. The list is covered rather than unmounted, which is
   * what keeps its scroll position: going back puts the user on the row they
   * tapped rather than at the top of the list.
   *
   * `useIsMobile` rather than a media query alone because the difference is
   * structural — a back button that exists on one and not the other — and it is
   * the one place the breakpoint is defined, so JavaScript and the stylesheet
   * cannot disagree about where a phone ends.
   */
  const isMobile = useIsMobile();
  const isSheetOpen = isMobile && selectedReceiptId !== null;

  // Two permissions, not one. Reversing writes a visible counter-entry;
  // correcting rewrites a posted figure in place. See routes/transactions.ts.
  const canEdit = can(user, "payment:edit");
  const canVoid = can(user, "payment:reverse");
  // Attaching the proof behind a payment is part of recording it, so it rides
  // on the same capability rather than inventing a third.
  const canRecord = can(user, "payment:record");

  const projectNames = useMemo(
    () => [...new Set(transactions.map((t) => t.projectName))].sort((a, b) => a.localeCompare(b, "es")),
    [transactions],
  );

  const visible = useMemo(
    () => sortTransactions(filterTransactions(searchTransactions(transactions, search), filters), sort),
    [transactions, search, filters, sort],
  );

  const groups = useMemo(() => groupByCustomer(visible, sort), [visible, sort]);

  // Selecting a transaction shows its receipt. One without a receipt clears the
  // panel rather than leaving the previous customer's document on screen beside
  // a row it has nothing to do with.
  useEffect(() => {
    if (selectedReceiptId === null) {
      setDetail(null);
      return;
    }

    // A newer request can resolve before an older one; `cancelled` makes the
    // outdated response drop itself instead of overwriting the current sheet.
    let cancelled = false;
    setLoadingDetail(true);

    fetchReceipt(selectedReceiptId)
      .then((receipt) => {
        if (!cancelled) {
          setDetail(receipt);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetail(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDetail(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedReceiptId, transactions]);

  /*
   * Rasterise the offscreen copy whenever the receipt on screen changes.
   *
   * Keyed on the receipt's id and its voided state rather than on the object,
   * so re-reading the same receipt after somebody else's write — which
   * lib/liveUpdates.ts now makes routine — does not throw away a perfectly good
   * image and render it again. Voiding it must, because the document grows an
   * ANULADO banner and the old picture no longer tells the truth.
   *
   * A failure here is deliberately silent. Nothing on screen is wrong; the one
   * button that depends on it simply stays out of reach, and says so.
   */
  const shareKey = detail === null ? null : `${detail.id}:${detail.voidedAt ?? ""}`;

  useEffect(() => {
    setShareImage(null);
    setShareNote(null);

    if (detail === null) {
      return;
    }

    let cancelled = false;

    // One frame, so the stage below is laid out before it is measured. Reading
    // `offsetHeight` off a node React has only just mounted gives zero.
    const frame = requestAnimationFrame(() => {
      const stage = shareStageRef.current;

      if (stage === null) {
        return;
      }

      receiptToPng(stage, detail.code)
        .then((file) => {
          if (!cancelled) {
            setShareImage(file);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setShareNote({
              tone: "error",
              text: "No se pudo preparar la imagen del recibo.",
            });
          }
        });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareKey]);

  /*
   * Hand the receipt to WhatsApp, and say what happened.
   *
   * Which of the three routes runs is decided by the device, not here — see
   * whatsapp.ts. What this owns is the sentence afterwards, because two of the
   * three leave a step for the person to finish and an unexplained new tab is
   * indistinguishable from a bug.
   */
  const share = async () => {
    if (detail === null || shareImage === null) {
      return;
    }

    setSharing(true);
    setShareNote(null);

    try {
      const outcome = await sendReceiptOnWhatsApp(
        shareImage,
        receiptCaption(detail),
        detail.customer.phone,
      );

      if (outcome.status === "copied") {
        setShareNote({
          tone: "info",
          text: `Se abrió el chat de ${detail.customer.fullName}. ${pasteInstruction()}`,
        });
      } else if (outcome.status === "manual") {
        const gesture = copyGesture();

        // Neither the clipboard nor the share sheet was available, so the
        // receipt is shown HERE to be copied by hand. Opening it in the app's
        // own viewer rather than a new tab is the point: a blob in a tab is
        // saved to disk by several browsers, and eaten by popup blockers in the
        // rest.
        openReceiptImage();

        setShareNote({
          tone: "info",
          /*
           * "insecure" is worth its own sentence. This device can almost
           * certainly do better — an Android phone on HTTPS gets the share
           * sheet — and without being told, the fallback reads as the feature
           * being broken rather than as the address bar being http://.
           */
          text:
            outcome.reason === "insecure"
              ? `Esta página está abierta por http://, y los navegadores solo permiten compartir por HTTPS. Ábrela por HTTPS y este botón enviará el recibo directamente. Por ahora el recibo está abierto aquí: ${gesture}.`
              : `El recibo está abierto aquí. ${gesture[0]!.toUpperCase()}${gesture.slice(1)}.`,
          chatUrl: outcome.chatUrl,
        });
      }
      // "shared" and "cancelled" need no words: the share sheet either appeared
      // and was used, or appeared and was dismissed. Both are self-evident.
    } catch {
      setShareNote({ tone: "error", text: "No se pudo abrir WhatsApp." });
    } finally {
      setSharing(false);
    }
  };

  /*
   * The rendered receipt, addressable by the viewer.
   *
   * A `blob:` URL for the PNG that has already been rasterised for WhatsApp —
   * the same bytes, shown rather than sent. Revoked when the receipt changes,
   * because an object URL is held by the document until it is: without this,
   * clicking through thirty receipts leaves thirty full-page images in memory.
   *
   * This is what "Ver" opens. It used to be that the only way to see the
   * receipt at full size was the fallback path in whatsapp.ts, which opened a
   * blob in a new tab — and in several browsers a new tab pointed at an image
   * blob saves it instead of showing it. The document now stays inside Lindero.
   */
  const [shareImageUrl, setShareImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (shareImage === null) {
      setShareImageUrl(null);
      return;
    }

    const url = URL.createObjectURL(shareImage);
    setShareImageUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [shareImage]);

  /**
   * Show the rendered receipt, full size, inside the app.
   *
   * Shared by the Ver button and by the last-resort branch of Enviar, so the
   * document appears in exactly one place however it was asked for.
   */
  const openReceiptImage = () => {
    if (detail === null || shareImageUrl === null) {
      return;
    }

    setViewing({ source: "receipt" });
  };

  /** Every comprobante on the open receipt, labelled with the lot it belongs to. */
  const detailProofs: ViewerFile[] = useMemo(() => {
    if (detail === null) {
      return [];
    }

    return detail.attachments.map((file) =>
      storedProof(
        file,
        detail.lines.find((line) => line.paymentId === file.paymentId)?.lotCode ?? null,
      ),
    );
  }, [detail]);

  /** Re-read the receipt, and the list behind it, after the files change. */
  const refreshAfterProofChange = async (receiptId: string) => {
    try {
      setDetail(await fetchReceipt(receiptId));
    } catch {
      // The write succeeded; only the re-read did not. The parent reload below
      // gets a second chance at it, and the panel is not wrong meanwhile.
    }

    onProofsChanged();
  };

  /**
   * Attach more comprobantes to a receipt that already exists.
   *
   * The validation is `acceptProofFiles`, the same function the new-receipt
   * dropzone uses, so a file refused there is refused here for the same reason
   * in the same words. What differs is the timing: there is a receipt to belong
   * to already, so these upload immediately rather than waiting for a save.
   */
  const addProofs = async (incoming: FileList | null) => {
    if (detail === null || incoming === null || incoming.length === 0) {
      return;
    }

    setProofError(null);

    const { accepted, rejections } = acceptProofFiles(
      Array.from(incoming),
      detail.attachments.length,
      MAX_PROOFS,
    );

    if (rejections.length > 0) {
      setProofError(rejections[0]!);
    }

    for (const proof of accepted) {
      setProofBusy(`Subiendo ${proof.file.name}…`);

      try {
        await uploadAttachment(detail.id, proof.file);
      } catch (caught) {
        setProofError(
          caught instanceof Error ? caught.message : "No se pudo subir el comprobante.",
        );
      }

      // Held only to validate and to name the file; nothing here previews it,
      // so the object URL would otherwise leak one image per upload.
      URL.revokeObjectURL(proof.previewUrl);
    }

    setProofBusy(null);

    if (accepted.length > 0) {
      await refreshAfterProofChange(detail.id);
    }
  };

  /**
   * Actually remove it. Only ever reached from the confirmation dialog.
   *
   * Throws rather than swallowing, so `ConfirmDialog` can stay open and show
   * what went wrong — a prompt that closes on a failed delete looks exactly
   * like one that closed on a successful delete.
   */
  const removeProof = async (attachmentId: string) => {
    if (detail === null) {
      return;
    }

    setProofError(null);
    setProofBusy("Quitando el comprobante…");

    try {
      await deleteAttachment(attachmentId);
      /*
       * The viewer stays open, and re-reads.
       *
       * `refreshAfterProofChange` re-fetches the receipt, `detailProofs` is
       * derived from it, and the viewer reads that list on every render — so
       * the removed file simply leaves the strip and the neighbour takes its
       * place. Removing several in a row is one gesture repeated rather than
       * open-delete-close-reopen. The viewer closes itself once the last one
       * is gone.
       */
      await refreshAfterProofChange(detail.id);
    } finally {
      setProofBusy(null);
    }
  };

  /*
   * What the viewer is actually showing, resolved from the source.
   *
   * Derived rather than stored, so the panel's comprobantes re-read themselves
   * while the viewer is open — which is what makes deleting several in a row
   * one gesture, and what stops a teammate's write leaving a dead URL on
   * screen. Null when there is nothing to show, including the case where every
   * file has just been removed.
   */
  const viewerFiles = useMemo((): { files: ViewerFile[]; startId: string } | null => {
    if (viewing === null) {
      return null;
    }

    if (viewing.source === "row") {
      return { files: viewing.files, startId: viewing.startId };
    }

    if (viewing.source === "proofs") {
      return detailProofs.length === 0
        ? null
        : { files: detailProofs, startId: viewing.startId };
    }

    if (detail === null || shareImageUrl === null) {
      return null;
    }

    const id = `receipt-${detail.id}`;

    return {
      files: [
        {
          id,
          name: `Recibo ${detail.code}`,
          contentType: "image/png",
          url: shareImageUrl,
          caption: detail.customer.fullName,
        },
      ],
      startId: id,
    };
  }, [viewing, detailProofs, detail, shareImageUrl]);

  /*
   * Nothing left to show means nothing left open.
   *
   * `viewerFiles` goes null when the last comprobante on the receipt is
   * removed, or when the receipt it was showing is closed. Without this the
   * viewer would merely stop rendering while `viewing` still said it was open,
   * and attaching a new file afterwards would make it reappear unasked.
   */
  useEffect(() => {
    if (viewing !== null && viewerFiles === null) {
      setViewing(null);
    }
  }, [viewing, viewerFiles]);

  const toggleCustomer = (customerId: string) => {
    setExpanded((current) => {
      const next = new Set(current);

      if (next.has(customerId)) {
        next.delete(customerId);
      } else {
        next.add(customerId);
      }

      return next;
    });
  };

  const select = (transaction: Transaction) => setSelectedReceiptId(transaction.receiptId);

  const receivedTotal = visible
    .filter((transaction) => transaction.reversedAt === null)
    .reduce((sum, transaction) => sum + transaction.amount, 0);

  return (
    <div className="receipts-layout">
      <div className="card">
        <div className="card-head">
          <div>
            <h2>Transacciones</h2>
            <p className="cell-sub">
              {formatMoney(cents(receivedTotal), money)} en {visible.length} transacci
              {visible.length === 1 ? "ón" : "ones"}
            </p>
          </div>
        </div>

        <TransactionToolbar
          view={view}
          onViewChange={setView}
          projectNames={projectNames}
          filters={filters}
          onFiltersChange={setFilters}
          sort={sort}
          onSortChange={setSort}
          search={search}
          onSearchChange={setSearch}
          shownCount={visible.length}
          totalCount={transactions.length}
        />

        {visible.length === 0 && (
          <p className="state-message">
            {transactions.length === 0
              ? "Todavía no se ha registrado ninguna transacción."
              : "Ninguna transacción coincide con la búsqueda."}
          </p>
        )}

        {view === "date" &&
          visible.map((transaction) => (
            <TransactionRow
              key={transaction.id}
              transaction={transaction}
              money={money}
              isSelected={
                transaction.receiptId !== null && transaction.receiptId === selectedReceiptId
              }
              canEdit={canEdit}
              onSelect={() => select(transaction)}
              onEdit={() => onEditTransaction(transaction)}
              onOpenProof={(files, startId) => setViewing({ source: "row", files, startId })}
              showCustomer
            />
          ))}

        {view === "customer" &&
          groups.map((group) => {
            const isOpen = expanded.has(group.customerId);

            return (
              <div key={group.customerId} className="txn-group">
                <button
                  type="button"
                  className={`txn-group-head${isOpen ? " is-open" : ""}`}
                  aria-expanded={isOpen}
                  onClick={() => toggleCustomer(group.customerId)}
                >
                  <span className={`txn-caret${isOpen ? " is-open" : ""}`}>
                    <IconChevronDown />
                  </span>

                  <span className="txn-who">
                    <span className="txn-name">{group.customerName}</span>
                    <span className="txn-detail">
                      {group.transactions.length} transacci
                      {group.transactions.length === 1 ? "ón" : "ones"} · última{" "}
                      {shortDate(group.lastPaidOn)}
                    </span>
                  </span>

                  <span className="txn-amount">{formatMoney(cents(group.totalCents), money)}</span>
                </button>

                {isOpen && (
                  <div className="txn-group-body">
                    {group.transactions.map((transaction) => (
                      <TransactionRow
                        key={transaction.id}
                        transaction={transaction}
                        money={money}
                        isSelected={
                          transaction.receiptId !== null &&
                          transaction.receiptId === selectedReceiptId
                        }
                        canEdit={canEdit}
                        onSelect={() => select(transaction)}
                        onEdit={() => onEditTransaction(transaction)}
                        onOpenProof={(files, startId) =>
                          setViewing({ source: "row", files, startId })
                        }
                        showCustomer={false}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
      </div>

      <div className={`receipt-preview-wrap${isSheetOpen ? " is-sheet" : ""}`}>
        {isSheetOpen ? (
          /* Named for where it goes back TO, not for the act of going back:
             "Transacciones" answers the question the arrow raises. Rendered
             whatever the receipt does — while it loads and if it fails — so a
             receipt that will not open can never trap somebody on this screen. */
          <div className="receipt-sheet-head">
            <button
              type="button"
              className="receipt-sheet-back"
              onClick={() => setSelectedReceiptId(null)}
            >
              <span className="receipt-sheet-back-icon">
                <IconChevronDown />
              </span>
              Transacciones
            </button>
          </div>
        ) : (
          <p className="receipt-preview-label">Vista del recibo</p>
        )}

        {detail === null && !isLoadingDetail && (
          <p className="state-message">
            {selectedReceiptId === null
              ? "Selecciona una transacción para ver su recibo. Las marcadas «sin recibo» nunca se imprimieron."
              : "No se pudo cargar el recibo."}
          </p>
        )}

        {isLoadingDetail && detail === null && <p className="state-message">Cargando…</p>}

        {detail && (
          <>
            <ReceiptPaper receipt={detail} money={money} />
            <div className="receipt-tear" />

            <div className="receipt-actions">
              <div className="receipt-actions-main">
                {/* The document at full size, inside Lindero. The preview
                    beside the list is 320px of a sidebar and folds itself to
                    fit; this is the A4 sheet the customer would be handed. */}
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={shareImageUrl === null}
                  onClick={openReceiptImage}
                >
                  Ver
                </button>

                <button type="button" className="btn-secondary" onClick={() => window.print()}>
                  Imprimir
                </button>

                {/* The document itself, not a description of it — see
                    whatsapp.ts. Disabled rather than hidden while the image is
                    being prepared, so the control does not appear a moment
                    after somebody has looked for it and given up. */}
                <button
                  type="button"
                  className="btn-secondary receipt-send"
                  disabled={shareImage === null || isSharing}
                  onClick={() => void share()}
                  title={`Enviar el recibo a ${detail.customer.fullName} por WhatsApp`}
                >
                  <IconWhatsApp />
                  {shareImage === null && shareNote?.tone !== "error"
                    ? "Preparando…"
                    : isSharing
                      ? "Enviando…"
                      : "Enviar"}
                </button>
              </div>

              {canVoid && detail.voidedAt === null && (
                <button
                  type="button"
                  className="link-btn is-danger"
                  onClick={() => onVoidReceipt(detail)}
                >
                  Anular
                </button>
              )}
            </div>

            {/*
              The evidence, beside the document rather than on it.

              It used to be printed under the note on `ReceiptPaper`, which put
              the customer's own bank slip into the PNG sent back to them over
              WhatsApp. It belongs here: a receipt is what the office issues,
              and a comprobante is what the office keeps.
            */}
            <div className="receipt-proofs">
              <div className="receipt-proofs-head">
                <p className="receipt-preview-label">Comprobantes del cliente</p>

                {canRecord && detail.attachments.length < MAX_PROOFS && (
                  <button
                    type="button"
                    className="link-btn"
                    disabled={proofBusy !== null}
                    onClick={() => proofInputRef.current?.click()}
                  >
                    Agregar
                  </button>
                )}
              </div>

              {detail.attachments.length === 0 ? (
                <p className="state-message">
                  Este recibo no tiene comprobante adjunto
                  {canRecord ? ". Puedes agregar la captura del depósito." : "."}
                </p>
              ) : (
                <div className="proof-grid">
                  {detailProofs.map((file) => (
                    <button
                      key={file.id}
                      type="button"
                      className="proof-tile"
                      onClick={() => setViewing({ source: "proofs", startId: file.id })}
                      title={`Ver ${file.name}`}
                    >
                      <DocumentThumb file={file} />
                      <span className="proof-tile-name">{file.name}</span>
                      {file.caption && <span className="proof-tile-lot">{file.caption}</span>}
                    </button>
                  ))}
                </div>
              )}

              {proofBusy && <p className="state-message">{proofBusy}</p>}
              {proofError && <p className="form-error">{proofError}</p>}

              {/* Off-screen, opened by the Agregar button. The same accept list
                  the dropzone uses; the server's is the one that counts. */}
              <input
                ref={proofInputRef}
                type="file"
                multiple
                className="proof-input"
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.heic,.heif"
                onChange={(event) => {
                  void addProofs(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>

            {shareNote && (
              <p className={`receipt-share-note${shareNote.tone === "error" ? " is-error" : ""}`}>
                {shareNote.text}
                {shareNote.chatUrl && (
                  <>
                    {" "}
                    <a href={shareNote.chatUrl} target="_blank" rel="noreferrer">
                      Abrir el chat de {detail.customer.fullName}
                    </a>
                  </>
                )}
              </p>
            )}

            {/*
              The copy that actually gets photographed.

              The receipt beside the list is 320px of a sidebar, and its own
              container queries fold it into a narrow layout to fit — rendering
              THAT would send the customer a tall thin strip. This one is laid
              out offscreen at A4 proportions with the print type size, so what
              arrives on their phone is the document they would have been handed
              across the counter. Same component, same stylesheet; only the box
              around it differs. See `.receipt-share-stage`.
            */}
            <div className="receipt-share-stage" ref={shareStageRef} aria-hidden="true">
              <ReceiptPaper receipt={detail} money={money} />
            </div>
          </>
        )}
      </div>

      {viewerFiles !== null && (
        <DocumentViewer
          files={viewerFiles.files}
          startId={viewerFiles.startId}
          onClose={() => setViewing(null)}
          /*
           * Removing is offered only for the open receipt's own comprobantes.
           *
           * Not for a thumbnail opened from a transaction ROW, whose files may
           * belong to a receipt that is not the one in the panel — deleting
           * there would leave the screen describing a receipt it had not
           * re-read. Not for the receipt IMAGE either: it is drawn from the
           * ledger every time it is opened, so there is nothing to remove.
           */
          onRemove={
            canRecord && viewing?.source === "proofs" ? setPendingRemoval : undefined
          }
        />
      )}

      {pendingRemoval !== null && (
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
    </div>
  );
}
