import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface DialogProps {
  /** Read out by screen readers to name the dialog. */
  ariaLabel: string;
  /**
   * How much horizontal room this dialog is allowed to take.
   *
   * `"default"` is 620px, which is what a column of form fields wants — wider
   * than that and the eye has to travel back across empty space to find the
   * next label.
   *
   * `"wide"` is for the dialogs that put a form NEXT TO something, where the
   * something is a table rather than prose. Both are `min(…, 100%)`, so this
   * only ever grants a ceiling: a dialog that cannot have the room simply does
   * not take it, and the layout inside is what decides to stack instead.
   */
  size?: "default" | "wide";
  onClose: () => void;
  children: ReactNode;
}

/**
 * The shared shell for anything that floats above the page.
 *
 * It owns the behaviour every dialog needs and every dialog gets wrong when
 * written twice: fade in, Escape to close, click-the-backdrop to close, stop
 * the page behind from scrolling, and put keyboard focus back where it came
 * from on the way out.
 *
 * It renders through a portal into <body> rather than where it sits in the
 * tree. `position: fixed` is only relative to the viewport while no ancestor
 * has a transform, a filter or a backdrop-filter — and the header has a
 * backdrop-filter, so a dialog opened from a control up there was being
 * confined to the 66px header and drawn off the top of the screen. The portal
 * takes that whole class of bug off the table for every dialog.
 */
export function Dialog({ ariaLabel, size = "default", onClose, children }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Mounts invisible, then fades in on the next frame — without this the CSS
  // transition has no starting point to animate from.
  const [isVisible, setVisible] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    panelRef.current?.focus();
    document.body.classList.add("modal-open");

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.classList.remove("modal-open");
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus();
      }
    };
  }, [onClose]);

  return createPortal(
    <div
      className={isVisible ? "modal-backdrop show" : "modal-backdrop"}
      // Only a press that lands on the backdrop itself counts as "outside".
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className={size === "wide" ? "entity-modal is-wide" : "entity-modal"}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
