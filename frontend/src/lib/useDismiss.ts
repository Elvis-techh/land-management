import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * Close a popover when the user clicks outside it or presses Escape.
 *
 * Both gestures matter: a menu that only closes via its own button traps the
 * user, and one that only closes on click leaves keyboard users stuck. Written
 * once here because the header's rate popover and the Lotes toolbar all need
 * exactly this behaviour.
 */
export function useDismiss(
  isOpen: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;

      if (target instanceof Element && !containerRef.current?.contains(target)) {
        onDismiss();
      }
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [isOpen, containerRef, onDismiss]);
}
