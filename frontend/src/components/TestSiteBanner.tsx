import { isTestSite } from "../lib/site";

/**
 * «SITIO DE PRUEBA», on every screen of the test site, so nobody records a real
 * payment there by mistake.
 *
 * It floats over the page instead of pushing it down: the test site is where a
 * layout gets checked, so it must lay out exactly as the real site does. Taps
 * go straight through it (see .test-site-banner in styles.css).
 */
export function TestSiteBanner() {
  if (!isTestSite) {
    return null;
  }

  return (
    <div className="test-site-banner" role="note">
      SITIO DE PRUEBA · No registre pagos reales
    </div>
  );
}
