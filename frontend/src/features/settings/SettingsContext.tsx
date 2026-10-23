import { createContext, useCallback, useContext, useEffect, useState } from "react";

import { ApiError } from "../../lib/api";
import type { AppSettings } from "./api";
import { DEFAULT_SETTINGS, fetchSettings } from "./api";

/**
 * The business's settings, for any component that needs one.
 *
 * A context rather than a prop because the readers sit deep and far apart: the
 * receipt and the constancia print the business details, «Nuevo contrato»
 * suggests the reservation length, and passing all of it down through every
 * screen in between would be noise in components that never look at it.
 */
const SettingsContext = createContext<AppSettings>(DEFAULT_SETTINGS);

export const SettingsProvider = SettingsContext.Provider;

export function useSettings(): AppSettings {
  return useContext(SettingsContext);
}

/**
 * Loads the settings once signed in, and again whenever `reload` is called.
 *
 * Starts on the defaults, which are what the server says until somebody saves,
 * so the first paint is right in the common case. A failed load keeps whatever
 * is in hand rather than interrupting anybody: the screens still work, with
 * the last values known.
 */
export function useAppSettings(enabled: boolean, onSessionExpired: () => void) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  const reload = useCallback(async () => {
    setSettings(await fetchSettings());
  }, []);

  useEffect(() => {
    if (enabled) {
      void reload().catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.isUnauthenticated) {
          onSessionExpired();
        }
      });
    }
  }, [enabled, reload, onSessionExpired]);

  return { settings, setSettings, reload };
}
