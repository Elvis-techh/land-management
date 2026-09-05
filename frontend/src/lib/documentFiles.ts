/**
 * What a stored file is, in the terms the screen needs.
 *
 * Small and pure on purpose: several screens ask the same questions about a
 * file — is it a picture, can this browser draw it, how big is it — and the
 * answers have to agree. A thumbnail that says "PDF" beside a viewer that tries
 * to render it as an image is the kind of disagreement that makes somebody
 * think the file is corrupt.
 *
 * Two kinds of file go through here and they are treated identically, because
 * from the browser's point of view they are: the comprobante a customer sends
 * for a payment, and the signed legal contract for a lot.
 */

/** How a file is presented, which is a smaller question than what it is. */
export type DocumentKind =
  /** Drawn in an <img>. Every JPG, PNG and WEBP, and HEIC on Safari alone. */
  | "image"
  /** Drawn by the browser's own PDF viewer, in a frame. */
  | "pdf"
  /** Stored fine, but nothing here can show it. Said plainly rather than hidden. */
  | "opaque";

export function documentKind(contentType: string): DocumentKind {
  if (contentType === "application/pdf") {
    return "pdf";
  }

  return contentType.startsWith("image/") ? "image" : "opaque";
}

/**
 * A format only some browsers can draw.
 *
 * HEIC is what an iPhone takes photographs in, and outside Safari no browser
 * will render one — Chrome and Firefox both refuse. The file is perfectly
 * valid and worth keeping; it simply cannot be shown here, and saying which
 * file it is beats an empty box with a broken-image icon.
 *
 * In practice this is rare: WhatsApp re-encodes photos to JPEG on the way out,
 * and the share target is where most comprobantes arrive. It bites when
 * somebody picks a photo out of the iOS camera roll on a desktop browser.
 */
export function isFragileImage(contentType: string): boolean {
  return contentType === "image/heic" || contentType === "image/heif";
}

/** "340 KB", "2.4 MB" — a size somebody can judge at a glance. */
export function readableSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The short label a thumbnail tile shows when it cannot show the picture.
 *
 * The EXTENSION rather than the MIME type: "PDF" and "HEIC" are what the person
 * who sent the file would call it, and "application/pdf" is not.
 */
export function formatBadge(contentType: string): string {
  if (contentType === "application/pdf") {
    return "PDF";
  }

  const subtype = contentType.split("/")[1] ?? "";

  return subtype === "" ? "ARCHIVO" : subtype.toUpperCase();
}
