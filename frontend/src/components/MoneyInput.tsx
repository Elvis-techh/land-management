import { useLayoutEffect, useRef, useState } from "react";

import { formatMoneyInput } from "../lib/money";

interface MoneyInputProps {
  id: string;
  /** The formatted text, e.g. "1,750,000.00". Owned by the parent form. */
  value: string;
  onChange: (formatted: string) => void;
  placeholder?: string;
  /**
   * Show the amount but refuse edits — for a user who may see a price without
   * being allowed to move it.
   *
   * A real `readOnly` rather than a no-op `onChange`: both stop the keystroke,
   * but only this one tells a screen reader why and gives CSS something to
   * style, instead of a field that silently swallows what is typed into it.
   */
  readOnly?: boolean;
  /**
   * Mark the field as the one a validation notice is pointing at.
   *
   * `aria-invalid` rather than a class: it is what a screen reader announces
   * when the caret lands here, and the stylesheet already colours the border
   * from it, so the visual and the spoken cue cannot drift apart.
   */
  invalid?: boolean;
}

/** Where the caret should sit to be after the same `digits` characters as before. */
function caretAfterDigits(text: string, digits: number): number {
  if (digits <= 0) {
    return 0;
  }

  let seen = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (/[\d.]/.test(text[index]!)) {
      seen += 1;
      if (seen === digits) {
        return index + 1;
      }
    }
  }

  return text.length;
}

/**
 * A lempira amount with live thousand separators.
 *
 * It is a text input rather than `type="number"` on purpose: a number input
 * refuses to display separators, and separators are the entire point. Digits, a
 * decimal point and the separators themselves are the only characters that
 * survive, so pasting "L. 1,750,000.00" from a spreadsheet works.
 *
 * Reformatting on every keystroke would otherwise throw the caret to the end of
 * the field the moment a separator is inserted, which makes correcting a digit
 * in the middle of a long number impossible. So the caret is tracked by how
 * many DIGITS precede it — a position that survives commas appearing and
 * disappearing around it — and restored after the value is rewritten.
 */
export function MoneyInput({
  id,
  value,
  onChange,
  placeholder,
  readOnly,
  invalid,
}: MoneyInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [digitsBeforeCaret, setDigitsBeforeCaret] = useState<number | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;

    if (input && digitsBeforeCaret !== null) {
      const caret = caretAfterDigits(value, digitsBeforeCaret);
      input.setSelectionRange(caret, caret);
      setDigitsBeforeCaret(null);
    }
  }, [value, digitsBeforeCaret]);

  return (
    <div className="input-with-prefix">
      <span className="currency-prefix">L.</span>
      <input
        id={id}
        ref={inputRef}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        readOnly={readOnly}
        aria-invalid={invalid}
        value={value}
        onChange={(event) => {
          const caret = event.target.selectionStart ?? event.target.value.length;
          const digits = event.target.value.slice(0, caret).replace(/[^\d.]/g, "").length;

          setDigitsBeforeCaret(digits);
          onChange(formatMoneyInput(event.target.value));
        }}
      />
    </div>
  );
}
