import { useRef } from "react";

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
 * The search box of every toolbar (Contratos, Clientes, Recibos).
 *
 * It stays white, like the other boxes you type in, while the buttons beside it
 * are filled: a box you type in and a button you tap should never look alike.
 * Once something is typed, a «×» empties it in one tap and leaves the cursor in
 * the box, ready for the next search. The browser's own clear button is hidden
 * (see .table-search in styles.css), since Chrome and Safari show it only
 * sometimes, and Firefox never.
 */
export function SearchBox({ value, onChange, placeholder, label, title }: SearchBoxProps) {
  const inputRef = useRef<HTMLInputElement>(null);

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
