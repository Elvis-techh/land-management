import { useEffect, useState } from "react";

/*
 * How each screen was last left — its search, filters, sort and toggles — so
 * stepping over to another tab and back does not throw them away.
 *
 * Every page unmounts when its tab is left, and a plain `useState` starts over
 * at its default on the way back. That is a real cost on a phone, where
 * rebuilding a filter means several taps through a sheet.
 *
 * Deliberately held in module memory and NOT in localStorage/sessionStorage:
 * both of those survive a refresh, and a refresh — like signing out or closing
 * the app — is exactly when these choices should go back to their defaults.
 * Module memory dies with the page on its own; sign-out clears it explicitly
 * via `forgetViewMemory`, so the next person on the same phone starts clean.
 */
const remembered = new Map<string, unknown>();

/** What `key` was last left at, or `fallback` if nothing was remembered. */
export function recallView<T>(key: string, fallback: T): T {
  return remembered.has(key) ? (remembered.get(key) as T) : fallback;
}

export function rememberView<T>(key: string, value: T): void {
  remembered.set(key, value);
}

/** Every screen back to its defaults. Called on sign-out and session expiry. */
export function forgetViewMemory(): void {
  remembered.clear();
}

/**
 * `useState` that comes back to where it was left when the screen remounts.
 *
 * `key` must be unique across the app — namespace it by screen, like
 * `"contracts.sort"`.
 */
export function useRememberedState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => recallView(key, fallback));

  useEffect(() => {
    rememberView(key, value);
  }, [key, value]);

  return [value, setValue] as const;
}
