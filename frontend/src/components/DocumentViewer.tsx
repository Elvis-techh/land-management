import { useEffect, useState } from "react";

import { Dialog } from "./Dialog";
import { IconChevronDown } from "./Icons";
import { documentKind, formatBadge, isFragileImage, readableSize } from "../lib/documentFiles";

/**
 * One document the viewer can show.
 *
 * `url` is deliberately the only thing it knows about WHERE the bytes are, so
 * the same component serves a file already stored on the server (an
 * `/api/attachments/:id/file` or `/api/contract-documents/:id/file` URL) and
 * one the user has only just picked and not uploaded yet (a `blob:` URL for
 * the File in hand). Checking a file before it is saved and checking one saved
 * months ago are the same act, and they should not be two different screens.
 */
export interface ViewerFile {
  id: string;
  name: string;
  contentType: string;
  url: string;
  /** The lot this is evidence for, when it is filed against one. */
  caption?: string | null;
  sizeBytes?: number;
}

interface DocumentViewerProps {
  files: ViewerFile[];
  /** Which one to open on. Falls back to the first if it is no longer here. */
  startId: string;
  onClose: () => void;
  /**
   * Offered only where the caller can actually act on it. Absent rather than
   * disabled: a delete button that cannot delete is worse than none.
   *
   * The caller is expected to CONFIRM before destroying anything stored — this
   * hands over the intent, not the deed. The dropzone is the one exception and
   * removes immediately, because nothing has been uploaded there yet and
   * picking the file again is the whole cost of being wrong.
   */
  onRemove?: (file: ViewerFile) => void;
}

/**
 * Look at a document, without it landing in Downloads.
 *
 * One viewer for every stored file the app holds — the comprobante behind a
 * payment, the signed contract for a lot, and the receipt image on its way to
 * WhatsApp. They are the same act (look at this, full size, without saving it
 * anywhere), so they are the same component, and a file behaves identically
 * wherever it is opened from.
 *
 * This is the whole reason the serving endpoints stopped saying
 * `Content-Disposition: attachment`. A stored file used to be readable only by
 * downloading it, which meant every "is this the right one?" left a copy on
 * whatever machine asked — usually the shared one at the front desk,
 * permanently, in a folder nobody ever empties. That was bad for a customer's
 * bank slip and worse for a signed contract. The files are kept on the server
 * precisely so they stop being scattered across devices; a viewer that
 * downloads them defeats the point of storing them centrally at all.
 *
 * So: the bytes are streamed from Lindero, drawn in place, and forgotten when
 * this closes. Nothing is written to disk, and there is deliberately no
 * "descargar" button anywhere in it.
 */
export function DocumentViewer({ files, startId, onClose, onRemove }: DocumentViewerProps) {
  const [index, setIndex] = useState(() => {
    const found = files.findIndex((file) => file.id === startId);
    return found === -1 ? 0 : found;
  });

  /*
   * A failed render is per-file, not per-viewer.
   *
   * Held as a set of ids rather than a boolean so that paging from a HEIC that
   * would not draw onto a JPG that will does not carry the error message
   * across with it — and so that paging back shows the message again without
   * re-attempting a load that has already been shown not to work.
   */
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());

  // The list shrinks when a file is removed from inside the viewer. Landing on
  // the one that took its place is what somebody deleting several in a row
  // expects; running off the end closes instead of showing a blank frame.
  const safeIndex = Math.min(index, Math.max(0, files.length - 1));
  const current = files[safeIndex];

  useEffect(() => {
    if (files.length === 0) {
      onClose();
    }
  }, [files.length, onClose]);

  useEffect(() => {
    // Arrow keys page through. Escape is the Dialog's, which also owns the
    // stack — this can be opened from ON TOP of the new-receipt form, and only
    // the topmost surface may answer a keypress.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        setIndex((at) => (at === 0 ? files.length - 1 : at - 1));
      } else if (event.key === "ArrowRight") {
        setIndex((at) => (at + 1) % files.length);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [files.length]);

  if (!current) {
    return null;
  }

  const kind = documentKind(current.contentType);
  const isBroken = broken.has(current.id);
  const hasMany = files.length > 1;

  const step = (by: number) =>
    setIndex((at) => (at + by + files.length) % files.length);

  return (
    <Dialog ariaLabel={`Documento ${current.name}`} size="viewer" onClose={onClose}>
      <div className="viewer">
        <header className="viewer-head">
          <div className="viewer-title">
            <p className="viewer-name">{current.name}</p>
            <p className="viewer-sub">
              {current.caption && <span className="viewer-lot">{current.caption}</span>}
              {current.sizeBytes !== undefined && <span>{readableSize(current.sizeBytes)}</span>}
              {hasMany && (
                <span>
                  {safeIndex + 1} de {files.length}
                </span>
              )}
            </p>
          </div>

          {/*
            Close, and nothing else.

            "Quitar" used to sit right here, a few pixels from the ×. Two
            controls that far apart in consequence must not be that close
            together on screen — the hand goes to the top-right corner to
            dismiss something, and the thing it found there could destroy a
            signed contract. It now lives at the foot of the viewer, diagonally
            opposite this button.
          */}
          <button type="button" className="viewer-close" onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </header>

        <div className="viewer-stage">
          {hasMany && (
            <button
              type="button"
              className="viewer-step is-prev"
              onClick={() => step(-1)}
              aria-label="Comprobante anterior"
            >
              <IconChevronDown />
            </button>
          )}

          {kind === "image" && !isBroken && (
            /*
             * Keyed on the id so React swaps the element rather than reusing it
             * with a new `src`. Without the key, paging from a large photo to a
             * small one leaves the previous picture on screen while the next
             * decodes, which reads as the arrow having done nothing.
             */
            <img
              key={current.id}
              className="viewer-image"
              src={current.url}
              alt={current.name}
              onError={() => setBroken((was) => new Set(was).add(current.id))}
            />
          )}

          {kind === "pdf" && (
            /*
             * The browser's own PDF viewer, in a frame. The response carries
             * `Content-Security-Policy: sandbox allow-scripts`, so the document
             * inside renders in an opaque origin and cannot reach this page,
             * the session cookie or any endpoint — see routes/receipts.ts.
             *
             * A blob: URL works here as well, which is what makes a PDF
             * checkable BEFORE it is uploaded and not only after.
             */
            <iframe key={current.id} className="viewer-frame" src={current.url} title={current.name} />
          )}

          {(kind === "opaque" || isBroken) && (
            <div className="viewer-unavailable">
              <span className="doc-thumb doc-thumb-badge">{formatBadge(current.contentType)}</span>
              <p>
                {isFragileImage(current.contentType)
                  ? "Este navegador no puede mostrar fotos HEIC de iPhone. El archivo está guardado y completo; ábrelo desde Safari, o pide la captura como JPG."
                  : "Este archivo está guardado, pero el navegador no puede mostrarlo aquí."}
              </p>
            </div>
          )}

          {hasMany && (
            <button
              type="button"
              className="viewer-step is-next"
              onClick={() => step(1)}
              aria-label="Comprobante siguiente"
            >
              <IconChevronDown />
            </button>
          )}
        </div>

        {hasMany && (
          <div className="viewer-strip">
            {files.map((file, at) => (
              <button
                key={file.id}
                type="button"
                className={`viewer-strip-item${at === safeIndex ? " is-current" : ""}`}
                onClick={() => setIndex(at)}
                aria-label={file.name}
                aria-current={at === safeIndex}
              >
                <DocumentThumb file={file} />
              </button>
            ))}
          </div>
        )}

        {onRemove && (
          /*
           * Bottom-left, which is the furthest point in this box from the close
           * button in the top-right. Deliberately not a bare icon and not
           * beside anything else that gets pressed routinely: it is the only
           * control down here, it says what it removes, and pressing it opens a
           * confirmation rather than doing the thing.
           */
          <div className="viewer-foot">
            <button
              type="button"
              className="link-btn is-danger"
              onClick={() => onRemove(current)}
            >
              Quitar este archivo
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The small square that stands for a stored file.
 *
 * The picture itself where the browser can draw it, and an honest label where
 * it cannot — a PDF or an iPhone HEIC gets its format written on a tile rather
 * than a broken-image icon. A scanned contract is almost always the PDF case,
 * so that tile is not an edge case here: it is the normal appearance of the
 * feature it was written for.
 *
 * Used in four places (the transactions row, the receipt panel, the dropzone,
 * the contract panel), which is why it is one component: a thumbnail that looks
 * different depending on where it appears reads as a different kind of thing.
 *
 * `loading="lazy"` is doing real work on the transactions list. Every row can
 * carry one of these, the bytes are full-size phone photographs, and a hundred
 * rows of eager <img> would be a hundred megabytes fetched to draw a screen
 * showing twelve of them.
 */
export function DocumentThumb({ file }: { file: ViewerFile }) {
  const [isBroken, setBroken] = useState(false);
  const kind = documentKind(file.contentType);

  if (kind !== "image" || isBroken) {
    return <span className="doc-thumb doc-thumb-badge">{formatBadge(file.contentType)}</span>;
  }

  return (
    <img
      className="doc-thumb"
      src={file.url}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
    />
  );
}
