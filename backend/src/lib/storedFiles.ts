/**
 * Storing the proof a customer sends for a payment.
 *
 * An uploaded file is the one thing in this app that arrives from outside and
 * is written to the filesystem, so everything here is about not trusting it:
 * not its name, not the content type the browser claims, and not its size.
 */

import { randomUUID } from "node:crypto";
import { extname } from "node:path";

/**
 * What may be attached, and what it is written to disk as.
 *
 * An allow-list rather than a block-list. The question is not "is this
 * dangerous" — it is "is this one of the handful of things a proof of payment
 * is ever going to be", and the answer is a photo, a screenshot, or a PDF from
 * the bank. Anything else is a mistake or an attack, and both deserve the same
 * refusal.
 *
 * The extension comes from THIS table, never from the uploaded filename, so a
 * file called "comprobante.pdf.html" cannot be written as anything but a PDF.
 */
const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "application/pdf": ".pdf",
};

export const ALLOWED_CONTENT_TYPES = Object.keys(ALLOWED_TYPES);

/**
 * 12 MB.
 *
 * Comfortably above a phone photo of a deposit slip, which is what this is for,
 * and far below the size at which somebody could fill the disk one upload at a
 * time. A modern phone camera produces 3–6 MB; a WhatsApp-compressed screenshot
 * is well under 1 MB.
 */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

/** How many files one receipt may carry. Enough for a slip and a screenshot. */
export const MAX_ATTACHMENTS_PER_RECEIPT = 8;

export function isAllowedContentType(contentType: string): boolean {
  return Object.hasOwn(ALLOWED_TYPES, contentType);
}

/**
 * The name this file gets ON DISK.
 *
 * Entirely generated: a UUID plus the extension implied by the ALLOWED_TYPES
 * entry. The uploaded name never reaches the filesystem, which takes path
 * traversal ("../../etc/passwd"), null bytes, case-collisions and
 * absurdly-long-name failures all off the table at once rather than trying to
 * sanitise a string that has no obligation to be sane.
 */
export function storageKeyFor(contentType: string): string {
  return `${randomUUID()}${ALLOWED_TYPES[contentType] ?? ".bin"}`;
}

/**
 * The uploaded name, made safe to store and show.
 *
 * Kept for the person reading the receipt later — "BAC-deposito-agosto.jpg"
 * means something where a UUID does not. It is display text only and is never
 * joined to a path, but it is still stripped of directory separators and
 * control characters so it cannot be used to fake one on screen.
 */
export function safeDisplayName(rawName: string): string {
  const trimmed = rawName
    // Control characters: the null byte, and the newline that would let a
    // filename forge a second line of output in a log or on screen.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "-")
    .trim();

  const name = trimmed === "" ? "comprobante" : trimmed;

  return name.length > 120 ? `${name.slice(0, 110)}…${extname(name).slice(0, 9)}` : name;
}

/**
 * Is this storage key one this application generated?
 *
 * Checked again on the way OUT, before a file is read back and served. The keys
 * come from our own database, so in principle this can never fail — which is
 * exactly why it is cheap to assert: a path read from a row and handed to the
 * filesystem is the shape of bug that turns one SQL injection into arbitrary
 * file disclosure, and one regex removes that whole possibility.
 */
export function isValidStorageKey(key: string): boolean {
  return /^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(key);
}
