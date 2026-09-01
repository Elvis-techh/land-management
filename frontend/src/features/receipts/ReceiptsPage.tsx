import { useEffect, useMemo, useRef, useState } from "react";

import { IconChevronDown, IconEdit, IconWhatsApp } from "../../components/Icons";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney } from "../../lib/money";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import { useIsMobile } from "../../lib/viewport";
import type { Receipt, Transaction } from "../../types";
import { ReceiptPaper } from "./ReceiptPaper";
import { TransactionToolbar } from "./TransactionToolbar";
import type { TransactionView } from "./TransactionToolbar";
import { fetchReceipt } from "./api";
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
}

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
  /** Hidden inside a customer group, where the name is already the heading. */
  showCustomer: boolean;
}

/**
 * One transaction.
 *
 * The row is a button so the whole thing is one keyboard-reachable target, with
 * the edit control beside it rather than inside it — a button inside a button
 * is invalid HTML and behaves unpredictably when clicked.
 */
function TransactionRow({
  transaction,
  money,
  isSelected,
  canEdit,
  onSelect,
  onEdit,
  showCustomer,
}: RowProps) {
  const isReversed = transaction.reversedAt !== null;

  return (
    <div
      className={`txn-row${isSelected ? " is-selected" : ""}${isReversed ? " is-void" : ""}`}
    >
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

        setShareNote({
          tone: "info",
          /*
           * "insecure" is worth its own sentence. This device can almost
           * certainly do better — an Android phone on HTTPS gets the share
           * sheet — and without being told, the tab reads as the feature being
           * broken rather than as the address bar being http://.
           */
          text:
            outcome.reason === "insecure"
              ? `Esta página está abierta por http://, y los navegadores solo permiten compartir por HTTPS. Ábrela por HTTPS y este botón enviará el recibo directamente. Por ahora se abrió en otra pestaña: ${gesture}.`
              : `El recibo se abrió en otra pestaña. ${gesture[0]!.toUpperCase()}${gesture.slice(1)}.`,
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
    </div>
  );
}
