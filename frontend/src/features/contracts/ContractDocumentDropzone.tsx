import { useRef, useState } from "react";

import { DocumentThumb, DocumentViewer } from "../../components/DocumentViewer";
import type { ViewerFile } from "../../components/DocumentViewer";
import { readableSize } from "../../lib/documentFiles";
import { useFileDrop } from "../../lib/useFileDrop";
import {
  CONTRACT_DOCUMENT_ACCEPT,
  MAX_CONTRACT_DOCUMENTS,
  screenContractFiles,
} from "./contractFiles";

/** A file waiting for the contract it belongs to to exist. */
export interface PendingDocument {
  /** Stable across re-renders, so React keys and the remove button behave. */
  id: string;
  file: File;
  /**
   * An object URL for this file, whatever its type. Revoked on removal.
   *
   * It feeds the thumbnail and the viewer, and the browser's PDF viewer reads a
   * `blob:` URL perfectly well — which is what makes the scan checkable BEFORE
   * the contract is created rather than only after. "Is that the right PDF?" is
   * a question with an expensive wrong answer: the file that settles a dispute
   * over a lot is not one to discover is somebody else's contract.
   */
  previewUrl: string;
}

/**
 * Turn accepted files into held ones, minting the preview URLs.
 *
 * Kept out of `screenContractFiles` so the rules stay pure and testable: this
 * is the half with a side effect, and whoever calls it owes each returned
 * `previewUrl` a `URL.revokeObjectURL`.
 */
export function holdContractFiles(files: File[], keyPrefix = ""): PendingDocument[] {
  return files.map((file, at) => ({
    id: `${keyPrefix}${file.name}-${file.size}-${file.lastModified}-${at}`,
    file,
    previewUrl: URL.createObjectURL(file),
  }));
}

interface ContractDocumentDropzoneProps {
  files: PendingDocument[];
  onFilesChange: (files: PendingDocument[]) => void;
  /** Refused before anything is uploaded — wrong type, too big, too many. */
  onReject: (message: string) => void;
  disabled?: boolean;
}

/**
 * Attach the signed contract while the contract is still being written.
 *
 * The gap this closes is a sequence nobody would choose: until now the ONLY
 * way to file the paperwork was to save the contract, find it in the list, open
 * its panel and add the file there — three screens after the one where the
 * scanned PDF was already sitting open on the desk. The document and the terms
 * are typed from the same piece of paper, in the same minute, so they are asked
 * for in the same place.
 *
 * Nothing is uploaded here. The files are held until the contract is created,
 * because a document needs a contract to belong to and the contract does not
 * exist yet — see `ContractCreateDialog`. That also means abandoning the form
 * uploads nothing, which is what somebody who changed their mind expects.
 */
export function ContractDocumentDropzone({
  files,
  onFilesChange,
  onReject,
  disabled = false,
}: ContractDocumentDropzoneProps) {
  const [viewing, setViewing] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = (incoming: FileList | File[] | null) => {
    if (incoming === null) {
      return;
    }

    const arriving = Array.from(incoming);

    if (arriving.length === 0) {
      return;
    }

    const { accepted, rejections } = screenContractFiles(arriving, files.length);

    for (const message of rejections) {
      onReject(message);
    }

    if (accepted.length > 0) {
      // The key prefix keeps ids apart when the same file is added twice in one
      // session — name, size and date are identical, and two rows sharing a
      // React key make the second one impossible to remove.
      onFilesChange([...files, ...holdContractFiles(accepted, `${files.length}-`)]);
    }
  };

  const remove = (id: string) => {
    const going = files.find((entry) => entry.id === id);

    // Object URLs are held by the document until revoked. Without this, every
    // scan added and removed stays in memory for the life of the page.
    if (going) {
      URL.revokeObjectURL(going.previewUrl);
    }

    onFilesChange(files.filter((entry) => entry.id !== id));
  };

  const { isDraggingOver, dropHandlers } = useFileDrop(accept, disabled);

  const viewerFiles: ViewerFile[] = files.map((entry) => ({
    id: entry.id,
    name: entry.file.name,
    contentType: entry.file.type,
    url: entry.previewUrl,
    caption: null,
    sizeBytes: entry.file.size,
  }));

  const isFull = files.length >= MAX_CONTRACT_DOCUMENTS;

  return (
    <div className="proof-field">
      <div
        className={`proof-dropzone${isDraggingOver ? " is-over" : ""}${
          disabled || isFull ? " is-disabled" : ""
        }`}
        {...dropHandlers}
      >
        <p className="proof-dropzone-title">Arrastra el contrato firmado aquí</p>
        <p className="proof-dropzone-hint">
          El PDF o el escaneo de lo que se firmó. También imágenes, hasta 30 MB. Se guarda junto
          al contrato en cuanto se crea.
        </p>

        <button
          type="button"
          className="btn-secondary"
          disabled={disabled || isFull}
          onClick={() => inputRef.current?.click()}
        >
          Elegir archivo
        </button>

        <input
          ref={inputRef}
          type="file"
          multiple
          className="proof-input"
          accept={CONTRACT_DOCUMENT_ACCEPT}
          onChange={(event) => {
            accept(event.target.files);
            // Cleared so choosing the SAME file twice in a row still fires a
            // change event — otherwise re-adding a file you just removed does
            // nothing at all.
            event.target.value = "";
          }}
        />
      </div>

      {files.length > 0 && (
        <ul className="proof-list">
          {files.map((entry, at) => (
            <li key={entry.id} className="proof-item">
              {/* The thumbnail IS the way to look at it. A PDF has no picture
                  to show, so the badge stands in — and clicking either it or
                  the name opens the document itself. */}
              <button
                type="button"
                className="proof-open"
                onClick={() => setViewing(entry.id)}
                title="Ver este documento"
                aria-label={`Ver ${entry.file.name}`}
              >
                <DocumentThumb file={viewerFiles[at]!} />
              </button>

              <span className="proof-meta">
                <button
                  type="button"
                  className="proof-name link-btn"
                  onClick={() => setViewing(entry.id)}
                >
                  {entry.file.name}
                </button>
                <span className="proof-size">{readableSize(entry.file.size)}</span>
              </span>

              <button
                type="button"
                className="link-btn is-danger"
                disabled={disabled}
                onClick={() => remove(entry.id)}
                aria-label={`Quitar ${entry.file.name}`}
              >
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}

      {viewing !== null && (
        <DocumentViewer
          files={viewerFiles}
          startId={viewing}
          onClose={() => setViewing(null)}
          onRemove={(file) => remove(file.id)}
        />
      )}
    </div>
  );
}
