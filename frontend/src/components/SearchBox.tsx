import { useEffect, useRef } from "react";

import { IconClose, IconSearch } from "./Icons";

interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** What the box searches, for screen readers and the browser tests. */
  label: string;
  /** The longer list of what it looks through, shown on hover. */
  title?: string;
}

/**
 * The search box of every toolbar (Contratos, Clientes, Recibos, Lotes, Proyectos,
 * Historial).
 *
 * It stays white, like the other boxes you type in, while the buttons beside it
 * are filled: a box you type in and a button you tap should never look alike.
 * Once something is typed, a «×» empties it in one tap and leaves the cursor in
 * the box, ready for the next search. The browser's own clear button is hidden
 * (see .table-search in styles.css), since Chrome and Safari show it only
 * sometimes, and Firefox never.
 *
 * #3: Ctrl+F (⌘F on a Mac) jumps to this box and selects what is in it, ready
 * to type over. Pressed again while already in the box, it opens the browser's
 * own search as usual. A screen without a search box is left alone, and so is
 * any open window (a payment form, say), which may have a search of its own.
 */
export function SearchBox({ value, onChange, placeholder, label, title }: SearchBoxProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const input = inputRef.current;

      if (
        !isFindShortcut(event) ||
        event.defaultPrevented ||
        input === null ||
        document.activeElement === input ||
        // Hidden (another tab kept on the page), or under an open window.
        input.getClientRects().length === 0 ||
        document.querySelector('[aria-modal="true"]') !== null
      ) {
        return;
      }

      event.preventDefault();
      input.focus();
      input.select();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="table-search">
      <IconSearch />
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        title={title}
        onChange={(event) => onChange(event.target.value)}
      />
      {value !== "" && (
        <button
          type="button"
          className="table-search-clear"
          aria-label="Borrar la búsqueda"
          title="Borrar la búsqueda"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
        >
          <IconClose />
        </button>
      )}
    </div>
  );
}

/** Ctrl+F, or ⌘F on a Mac, with no other key held. */
function isFindShortcut(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === "f" &&
    (event.ctrlKey || event.metaKey) &&
    !(event.ctrlKey && event.metaKey) &&
    !event.shiftKey &&
    !event.altKey
  );
}
