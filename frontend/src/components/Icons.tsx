/**
 * The SVG icons from the prototype, each wrapped as a small React component so
 * the markup below stays readable. Nothing here is Lindero-specific logic.
 */

export function IconDashboard() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

export function IconLots() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </svg>
  );
}

export function IconContracts() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 3H15L19 7V21H7V3Z" />
      <path d="M15 3V7H19" />
      <path d="M10 12H16M10 16H16" />
    </svg>
  );
}

export function IconCustomers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20C3 16.5 5.5 14 9 14C12.5 14 15 16.5 15 20" />
      <circle cx="17" cy="9" r="2.6" />
      <path d="M15.5 14.2C18.4 14.6 21 16.9 21 20" />
    </svg>
  );
}

export function IconReceipts() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 3H18V21L15.5 19.3L13 21L10.5 19.3L8 21L5.5 19.3L6 21V3Z" />
      <path d="M9 8H15M9 12H15M9 16H12.5" />
    </svg>
  );
}

export function IconBrand() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M3 21L12 3L21 21H3Z" stroke="#FBF2ED" strokeWidth="2" strokeLinejoin="round" />
      <path d="M8 21V13H16V21" stroke="#FBF2ED" strokeWidth="2" />
    </svg>
  );
}

export function IconMenu() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6H21M3 12H21M3 18H21" />
    </svg>
  );
}

export function IconSearch() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21L16.5 16.5" />
    </svg>
  );
}

export function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="M12 5V19M5 12H19" />
    </svg>
  );
}

export function IconBell() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 8C6 5 8.5 3 12 3C15.5 3 18 5 18 8C18 13 20 14 20 15.5C20 16.5 19 17 12 17C5 17 4 16.5 4 15.5C4 14 6 13 6 8Z" />
      <path d="M9.5 20C10 21 11 21.5 12 21.5C13 21.5 14 21 14.5 20" />
    </svg>
  );
}

/** Double chevron pointing left — "hide the sidebar". */
export function IconCollapse() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 17L8 12L13 7" />
      <path d="M18 17L13 12L18 7" />
    </svg>
  );
}

/** X — close a panel. */
export function IconClose() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6L18 18M18 6L6 18" />
    </svg>
  );
}

/** Pencil — edit a record. */
export function IconEdit() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20H8L18.5 9.5A2.1 2.1 0 0 0 15.5 6.5L5 17V20Z" />
      <path d="M14.5 7.5L17.5 10.5" />
    </svg>
  );
}

/** Box — archive a record (never destroy it). */
export function IconArchive() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8V19H19V8" />
      <path d="M10 12H14" />
    </svg>
  );
}

/**
 * Bin — delete a record for good.
 *
 * Deliberately NOT the archive box: archiving hides something and keeps it,
 * deleting destroys it. Two actions that cannot be undone the same way must not
 * share a picture.
 */
export function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7H20" />
      <path d="M9 7V5H15V7" />
      <path d="M6 7L7 20H17L18 7" />
      <path d="M10 11V16" />
      <path d="M14 11V16" />
    </svg>
  );
}

/** Arrow leaving a door — sign out. */
export function IconSignOut() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 4H19V20H15" />
      <path d="M10 8L14 12L10 16" />
      <path d="M14 12H4" />
    </svg>
  );
}

/** Clock with a turning arrow — change history. */
export function IconHistory() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 9A9 9 0 1 1 3 12" />
      <path d="M3 4V9H8" />
      <path d="M12 7.5V12L15 14" />
    </svg>
  );
}

/** A surveyor's map fold — the Proyectos screen. */
export function IconProjects() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6.5L9 4L15 6.5L21 4V17.5L15 20L9 17.5L3 20Z" />
      <path d="M9 4V17.5" />
      <path d="M15 6.5V20" />
    </svg>
  );
}

/** Arrow curving back out of a box — restore something archived. */
export function IconRestore() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10a8 8 0 1 1 1.5 6" />
      <path d="M4 5V10H9" />
    </svg>
  );
}

/** A key — who is allowed through which door. */
export function IconPermissions() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12H21" />
      <path d="M17 12V16" />
      <path d="M20 12V15" />
    </svg>
  );
}

/** Two figures with a badge — the people who can sign in. */
export function IconUsers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="8" r="3.4" />
      <path d="M3.5 20C3.5 16.4 6.4 13.6 10 13.6C11.4 13.6 12.7 14 13.8 14.7" />
      <circle cx="17.5" cy="17.5" r="3.5" />
      <path d="M16 17.5L17.2 18.7L19.2 16.5" />
    </svg>
  );
}

/** Bars of decreasing length with arrows — sort order. */
export function IconSort() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7H14" />
      <path d="M4 12H11" />
      <path d="M4 17H8" />
      <path d="M17 6V18" />
      <path d="M14 15L17 18L20 15" />
    </svg>
  );
}

/** A funnel — narrowing a list down. */
export function IconFilter() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5H20L14 12.5V19L10 17V12.5L4 5Z" />
    </svg>
  );
}

/** A small chevron — this control opens something. */
export function IconChevronDown() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 10L12 15L17 10" />
    </svg>
  );
}

/**
 * WhatsApp's handset-in-a-speech-bubble.
 *
 * Drawn as filled paths rather than the stroked outlines above, because this
 * mark is recognised by its silhouette — traced as an outline at 16px it reads
 * as a generic chat bubble, which is the one thing a button labelled "Enviar"
 * must not look like. `currentColor` throughout so it takes the button's colour
 * and stays legible in a disabled state, rather than carrying the brand green
 * into a palette that has none.
 */
export function IconWhatsApp() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.87 9.87 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 1.67a8.2 8.2 0 0 1 5.83 2.42 8.18 8.18 0 0 1 2.41 5.82c0 4.54-3.7 8.24-8.24 8.24a8.23 8.23 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.24-8.24Z" />
      <path d="M9.06 7.1c-.19-.42-.38-.43-.56-.44h-.48c-.16 0-.43.06-.66.31-.23.25-.86.85-.86 2.06s.89 2.39 1.01 2.56c.12.16 1.71 2.75 4.22 3.74 2.09.82 2.51.66 2.97.62.46-.04 1.48-.6 1.69-1.19.21-.58.21-1.08.15-1.19-.06-.1-.23-.16-.48-.29-.25-.12-1.48-.73-1.71-.81-.23-.09-.4-.13-.56.12-.17.25-.64.81-.79.98-.14.16-.29.19-.54.06-.25-.12-1.06-.39-2.01-1.24-.74-.66-1.24-1.48-1.39-1.73-.14-.25-.01-.38.11-.51.11-.11.25-.29.37-.44.13-.14.17-.25.25-.41.08-.17.04-.31-.02-.44-.06-.12-.55-1.34-.76-1.83Z" />
    </svg>
  );
}

/**
 * The grip on a band that can be dragged — six dots, the convention everywhere.
 *
 * Filled circles rather than the two stroked lines this is sometimes drawn as:
 * at 16px a pair of lines reads as a hamburger menu, and a handle that looks
 * like a menu is a handle nobody grabs.
 */
/**
 * A plain SMS bubble, deliberately unlike the WhatsApp mark beside it.
 *
 * The two sit next to each other in the contact column and go to different
 * places, so they must not be mistakable at 16px: this one is a stroked outline
 * with no handset, where WhatsApp is a filled silhouette with one.
 */
export function IconMessage() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-2.9-.4L4 21l1.4-3.8A8.1 8.1 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
    </svg>
  );
}

/** An envelope. */
export function IconMail() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  );
}

export function IconDrag() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

/** Shown on screen. */
export function IconEye() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}

/** Folded away. The stroke through it is what says so at a glance. */
export function IconEyeOff() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 7.2C2.9 8.9 2 12 2 12s3.6 6.5 10 6.5c1.6 0 3-.25 4.2-.68" />
      <path d="M9.6 5.7A11.7 11.7 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5s-1 1.8-2.8 3.5" />
      <path d="M9.9 9.9a2.9 2.9 0 0 0 4.1 4.1" />
      <path d="M3 3l18 18" />
    </svg>
  );
}
