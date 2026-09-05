import { useRef, useState } from "react";

/**
 * What a proof of payment is allowed to be. Mirrors the server's allow-list in
 * backend/src/lib/attachments.ts, which is the one that counts — this copy only
 * exists so a wrong file is refused instantly instead of after an upload.
 */
const ACCEPTED = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
];

/** 12 MB, the same ceiling the server enforces. */
const MAX_BYTES = 12 * 1024 * 1024;

export interface PendingProof {
  /** Stable across re-renders, so React keys and the remove button behave. */
  id: string;
  file: File;
  /** An object URL for the thumbnail, or null for a PDF. Revoked on removal. */
  previewUrl: string | null;
}

interface ProofDropzoneProps {
  files: PendingProof[];
  onFilesChange: (files: PendingProof[]) => void;
  /** Refused before anything is uploaded — wrong type, too big, too many. */
  onReject: (message: string) => void;
  maxFiles: number;
  disabled?: boolean;
}

function readableSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Which of these files may be attached, and what to say about the rest.
 *
 * Extracted from the dropzone rather than left inside it because a comprobante
 * no longer arrives only by drag or file picker: one shared from WhatsApp goes
 * straight into the form without this component ever rendering (see
 * lib/sharedIntake.ts). Both paths have to refuse the same files for the same
 * reasons, and two copies of these rules would drift — the shared path would
 * quietly start accepting a 40 MB video that the server then rejects, AFTER
 * the payment has already been recorded.
 *
 * Pure, and returns its complaints instead of reporting them, so the caller
 * decides whether they become a toast, an inline error, or nothing at all.
 */
export function acceptProofFiles(
  incoming: File[],
  alreadyHeld: number,
  maxFiles: number,
): { accepted: PendingProof[]; rejections: string[] } {
  const accepted: PendingProof[] = [];
  const rejections: string[] = [];

  for (const file of incoming) {
    if (alreadyHeld + accepted.length >= maxFiles) {
      rejections.push(`Puedes adjuntar hasta ${maxFiles} comprobantes por recibo.`);
      break;
    }

    // A HEIC straight off an iPhone sometimes arrives with an empty type, so
    // the extension is accepted as a fallback rather than refusing a file the
    // server would have taken.
    const isHeicByName = /\.hei[cf]$/i.test(file.name);

    if (!ACCEPTED.includes(file.type) && !(file.type === "" && isHeicByName)) {
      rejections.push(`«${file.name}» no es una imagen ni un PDF.`);
      continue;
    }

    if (file.size === 0) {
      rejections.push(`«${file.name}» está vacío.`);
      continue;
    }

    if (file.size > MAX_BYTES) {
      rejections.push(`«${file.name}» pesa ${readableSize(file.size)}; el máximo es 12 MB.`);
      continue;
    }

    accepted.push({
      id: `${file.name}-${file.size}-${file.lastModified}-${accepted.length}`,
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    });
  }

  return { accepted, rejections };
}

/**
 * Drag a screenshot in, or pick one.
 *
 * Built for exactly one gesture: the customer sends the deposit slip on
 * WhatsApp, and it goes straight from that window onto the receipt. Dropping an
 * image dragged out of another browser tab or a chat client is the fast path;
 * the file picker is there for the times the image was downloaded first.
 *
 * Nothing is uploaded here. The files are held until the receipt is saved,
 * because an attachment needs a receipt to belong to and the receipt does not
 * exist yet — see `NewReceiptDialog`. That also means abandoning the form
 * uploads nothing, which is the behaviour somebody who changed their mind
 * expects.
 */
export function ProofDropzone({
  files,
  onFilesChange,
  onReject,
  maxFiles,
  disabled = false,
}: ProofDropzoneProps) {
  const [isDraggingOver, setDraggingOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Counts enter/leave rather than toggling a boolean.
   *
   * `dragleave` fires every time the pointer crosses into a CHILD element, so a
   * plain boolean makes the highlight flicker off as soon as the cursor passes
   * over the icon or the text inside the zone. Depth reaches zero only when the
   * pointer has genuinely left.
   */
  const dragDepth = useRef(0);

  const alreadyHeld = files.length;

  const accept = (incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) {
      return;
    }

    const { accepted, rejections } = acceptProofFiles(Array.from(incoming), alreadyHeld, maxFiles);

    for (const message of rejections) {
      onReject(message);
    }

    if (accepted.length > 0) {
      onFilesChange([...files, ...accepted]);
    }
  };

  const remove = (id: string) => {
    const going = files.find((entry) => entry.id === id);

    // Object URLs are held by the document until revoked. Without this, every
    // image the user adds and removes stays in memory for the life of the page.
    if (going?.previewUrl) {
      URL.revokeObjectURL(going.previewUrl);
    }

    onFilesChange(files.filter((entry) => entry.id !== id));
  };

  return (
    <div className="proof-field">
      <div
        className={`proof-dropzone${isDraggingOver ? " is-over" : ""}${
          disabled ? " is-disabled" : ""
        }`}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          setDraggingOver(true);
        }}
        onDragOver={(event) => {
          // Without preventDefault the browser navigates to the dropped file,
          // which loses the form and everything typed into it.
          event.preventDefault();
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) {
            dragDepth.current = 0;
            setDraggingOver(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDraggingOver(false);

          if (!disabled) {
            accept(event.dataTransfer.files);
          }
        }}
      >
        <p className="proof-dropzone-title">Arrastra el comprobante aquí</p>
        <p className="proof-dropzone-hint">
          La captura del depósito o la transferencia, directo desde WhatsApp. JPG, PNG, HEIC o PDF,
          hasta 12 MB.
        </p>

        <button
          type="button"
          className="btn-secondary"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          Elegir archivo
        </button>

        <input
          ref={inputRef}
          type="file"
          multiple
          className="proof-input"
          accept={`${ACCEPTED.join(",")},.heic,.heif`}
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
          {files.map((entry) => (
            <li key={entry.id} className="proof-item">
              {entry.previewUrl ? (
                <img src={entry.previewUrl} alt="" className="proof-thumb" />
              ) : (
                <span className="proof-thumb proof-thumb-pdf">PDF</span>
              )}

              <span className="proof-meta">
                <span className="proof-name">{entry.file.name}</span>
                <span className="proof-size">{readableSize(entry.file.size)}</span>
              </span>

              <button
                type="button"
                className="link-btn is-danger"
                onClick={() => remove(entry.id)}
                aria-label={`Quitar ${entry.file.name}`}
              >
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
