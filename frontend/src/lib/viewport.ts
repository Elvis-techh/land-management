import { useEffect, useState } from "react";

/**
 * The one place the phone breakpoint is defined.
 *
 * It has to match the `@media (max-width: 760px)` rules in styles.css: layout
 * decided in JavaScript and layout decided in CSS disagreeing at some in-between
 * width is the kind of bug that only shows up on somebody else's screen.
 */
export const MOBILE_QUERY = "(max-width: 760px)";

export function isMobileViewport(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}

/**
 * Re-renders when the viewport crosses the phone breakpoint.
 *
 * Needed wherever the DIFFERENCE is structural rather than cosmetic — a menu
 * that is a popover on a desktop and a full-screen sheet on a phone is two
 * different trees, and CSS alone cannot make that swap.
 */
export function useIsMobile(): boolean {
  const [isMobile, setMobile] = useState(isMobileViewport);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(query.matches);

    update();
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  return isMobile;
}
