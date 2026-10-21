import { useNewVersion } from "../lib/appVersion";

/**
 * «Hay una versión nueva de Lindero», with the reload one tap away.
 *
 * Above everything, dialogs included, because a constancia or a receipt is
 * exactly where somebody notices a button missing. Small, and with «Luego»,
 * because they may be halfway through typing one. See lib/appVersion.ts.
 */
export function UpdateBanner() {
  const { isAvailable, dismiss } = useNewVersion();

  if (!isAvailable) {
    return null;
  }

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-text">Hay una versión nueva de Lindero.</span>
      <button type="button" className="btn-secondary is-small" onClick={dismiss}>
        Luego
      </button>
      <button type="button" className="btn-primary is-small" onClick={() => window.location.reload()}>
        Actualizar
      </button>
    </div>
  );
}
