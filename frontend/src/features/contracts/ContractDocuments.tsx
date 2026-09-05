import { useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DocumentThumb, DocumentViewer } from "../../components/DocumentViewer";
import type { ViewerFile } from "../../components/DocumentViewer";
import { readableSize } from "../../lib/documentFiles";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import type { ContractDocument } from "../../types";
import {
  deleteContractDocument,
  fetchContractDocuments,
  storedDocument,
  uploadContractDocument,
} from "./api";

/**
 * What a contract document is allowed to be. Mirrors the server's allow-list in
 * backend/src/lib/storedFiles.ts, which is the one that counts — this copy only
 * exists so a wrong file is refused instantly instead of after an upload of a
 * fifteen-page scan.
 */
const ACCEPTED = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

/** 30 MB, the same ceiling the server enforces — see MAX_DOCUMENT_BYTES. */
const MAX_BYTES = 30 * 1024 * 1024;

/** Matches MAX_DOCUMENTS_PER_CONTRACT on the server. */
const MAX_DOCUMENTS = 12;

interface ContractDocumentsProps {
  contractId: string;
  user: User;
  /**
   * Tell the list its count has moved.
   *
   * The Contratos screen marks which contracts have their paperwork on file,
   * and that marker comes from the list's own data — so filing one here has to
   * reach back up, or the row that prompted the upload keeps reading as empty.
   */
  onCountChanged: () => void;
}

/**
 * The signed paperwork for one contract: file it, read it, and nothing else.
 *
 * The gap this closes is that Lindero held everything ABOUT a contract — the
 * price, the term, the cuotas, who is behind — and nothing OF it. The one
 * artefact that settles a dispute lived in a filing cabinet, and in practice in
 * a folder on somebody's phone. Now it is beside the record it belongs to, and
 * reading it is a click rather than a drive to the office.
 *
 * Fetched when the panel opens rather than carried on the contracts list: the
 * list is every contract in the business, each can hold a dozen scans, and a
 * screen that only marks WHICH contracts have paperwork does not need to know
 * what the paperwork is called.
 */
export function ContractDocuments({ contractId, user, onCountChanged }: ContractDocumentsProps) {
  const [documents, setDocuments] = useState<ContractDocument[] | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  /*
   * The document somebody has asked to remove, waiting on a second press.
   *
   * Held here rather than inside the viewer because BOTH ways of removing —
   * the row in the list and the button in the viewer — have to go through the
   * same confirmation. One piece of state, so a route that skips the prompt
   * cannot be added by accident.
   */
  const [pendingRemoval, setPendingRemoval] = useState<ContractDocument | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /*
   * Filing the signed copy is the last step of writing a contract, so it rides
   * on the capability that writes one. DESTROYING it does not: this is the
   * legal instrument for a lot, and unlike a mis-attached photo of a deposit
   * slip there is no second copy of it in a chat somewhere. The server checks
   * both again — hiding a button is convenience, not security.
   */
  const canFile = can(user, "contract:create");
  const canRemove = can(user, "contract:edit");

  useEffect(() => {
    let cancelled = false;

    fetchContractDocuments(contractId)
      .then((found) => {
        if (!cancelled) {
          setDocuments(found);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDocuments([]);
          setError("No se pudieron cargar los documentos.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [contractId]);

  const reload = async () => {
    try {
      setDocuments(await fetchContractDocuments(contractId));
    } catch {
      // The write landed; only the re-read did not. What is on screen is stale
      // rather than wrong, and the next open corrects it.
    }

    onCountChanged();
  };

  const add = async (incoming: FileList | null) => {
    if (incoming === null || incoming.length === 0) {
      return;
    }

    setError(null);

    const held = documents?.length ?? 0;
    let filed = 0;

    for (const file of Array.from(incoming)) {
      if (held + filed >= MAX_DOCUMENTS) {
        setError(`Un contrato admite hasta ${MAX_DOCUMENTS} documentos.`);
        break;
      }

      // A HEIC straight off an iPhone sometimes arrives with an empty type, so
      // the extension is accepted as a fallback rather than refusing a file the
      // server would have taken.
      const isHeicByName = /\.hei[cf]$/i.test(file.name);

      if (!ACCEPTED.includes(file.type) && !(file.type === "" && isHeicByName)) {
        setError(`«${file.name}» no es un PDF ni una imagen escaneada.`);
        continue;
      }

      if (file.size === 0) {
        setError(`«${file.name}» está vacío.`);
        continue;
      }

      if (file.size > MAX_BYTES) {
        setError(`«${file.name}» pesa ${readableSize(file.size)}; el máximo es 30 MB.`);
        continue;
      }

      setBusy(`Subiendo ${file.name}…`);

      try {
        await uploadContractDocument(contractId, file);
        filed += 1;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "No se pudo subir el documento.");
      }
    }

    setBusy(null);

    if (filed > 0) {
      await reload();
    }
  };

  /**
   * Actually remove it. Only ever reached from the confirmation dialog.
   *
   * Throws rather than swallowing, so `ConfirmDialog` can keep itself open and
   * show what went wrong — a prompt that closes on a failed delete looks
   * exactly like a prompt that closed on a successful one.
   */
  const remove = async (documentId: string) => {
    setError(null);
    setBusy("Quitando el documento…");

    try {
      await deleteContractDocument(documentId);
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const files: ViewerFile[] = (documents ?? []).map(storedDocument);

  /*
   * The viewer reads this list on every render rather than a copy taken when it
   * opened, so removing a document from inside it makes the neighbour take its
   * place instead of leaving a URL that now 404s. It closes itself once the
   * last one is gone.
   */
  const open = viewing === null ? null : files.find((file) => file.id === viewing) ?? null;

  useEffect(() => {
    if (viewing !== null && open === null) {
      setViewing(null);
    }
  }, [viewing, open]);

  return (
    <section className="cp-section">
      <div className="cp-docs-head">
        <h3 className="cp-section-title">Documentos del contrato</h3>

        {canFile && (documents?.length ?? 0) < MAX_DOCUMENTS && (
          <button
            type="button"
            className="link-btn"
            disabled={busy !== null || documents === null}
            onClick={() => inputRef.current?.click()}
          >
            Agregar
          </button>
        )}
      </div>

      {documents === null && <p className="state-message">Cargando…</p>}

      {documents !== null && documents.length === 0 && (
        <p className="state-message">
          Todavía no se ha guardado el contrato firmado
          {canFile ? ". Sube el PDF o el escaneo para tenerlo a mano." : "."}
        </p>
      )}

      {documents !== null && documents.length > 0 && (
        <ul className="cp-docs">
          {documents.map((document, at) => (
            <li key={document.id} className="cp-doc">
              {/* The tile IS the way to read it. A PDF has no picture to show,
                  so the badge stands in — and clicking either it or the name
                  opens the document itself. */}
              <button
                type="button"
                className="proof-open"
                onClick={() => setViewing(document.id)}
                aria-label={`Ver ${document.fileName}`}
              >
                <DocumentThumb file={files[at]!} />
              </button>

              <span className="cp-doc-meta">
                <button
                  type="button"
                  className="cp-doc-name link-btn"
                  onClick={() => setViewing(document.id)}
                >
                  {document.fileName}
                </button>
                <span className="cp-doc-sub">
                  {readableSize(document.byteSize)} · {document.uploadedBy}
                </span>
              </span>

              {canRemove && (
                <button
                  type="button"
                  className="link-btn is-danger"
                  disabled={busy !== null}
                  onClick={() => setPendingRemoval(document)}
                  aria-label={`Quitar ${document.fileName}`}
                >
                  Quitar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {busy && <p className="state-message">{busy}</p>}
      {error && <p className="form-error">{error}</p>}

      {/* Off-screen, opened by the Agregar button. The server's allow-list is
          the one that counts; this only spares somebody the upload. */}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="proof-input"
        accept={`${ACCEPTED.join(",")},.heic,.heif`}
        onChange={(event) => {
          void add(event.target.files);
          // Cleared so choosing the SAME file twice in a row still fires a
          // change event — otherwise re-adding one you just removed does
          // nothing at all.
          event.target.value = "";
        }}
      />

      {open !== null && (
        <DocumentViewer
          files={files}
          startId={open.id}
          onClose={() => setViewing(null)}
          onRemove={
            canRemove
              ? (file) =>
                  setPendingRemoval(
                    (documents ?? []).find((entry) => entry.id === file.id) ?? null,
                  )
              : undefined
          }
        />
      )}

      {pendingRemoval !== null && (
        /*
         * The one prompt both routes pass through.
         *
         * Worth the extra press because of what this file IS. A comprobante is
         * a customer's copy of something the bank also has; this is the signed
         * instrument for a lot, and once the scan is gone the only copy left is
         * whatever is in a filing cabinet. The audit line naming it survives,
         * and that is the whole of what survives.
         */
        <ConfirmDialog
          eyebrow="Quitar documento"
          title={pendingRemoval.fileName}
          description={`${readableSize(pendingRemoval.byteSize)} · subido por ${pendingRemoval.uploadedBy}`}
          confirmLabel="Quitar documento"
          busyLabel="Quitando…"
          onCancel={() => setPendingRemoval(null)}
          onConfirm={async () => {
            await remove(pendingRemoval.id);
            setPendingRemoval(null);
          }}
        >
          Esto borra el archivo del servidor para siempre y no se puede deshacer. Si es el
          contrato firmado, asegúrate de tener otra copia antes de continuar. En el historial
          solo queda constancia de que lo quitaste.
        </ConfirmDialog>
      )}
    </section>
  );
}
