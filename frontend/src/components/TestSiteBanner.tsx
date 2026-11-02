import { isTestSite, testSiteBranch, testSiteCommit } from "../lib/site";

/**
 * «SITIO DE PRUEBA», on every screen of the test site, so nobody records a real
 * payment there by mistake.
 *
 * It floats over the page instead of pushing it down: the test site is where a
 * layout gets checked, so it must lay out exactly as the real site does. Taps
 * go straight through it (see .test-site-banner in styles.css).
 *
 * After the warning, on the same line, which branch and commit are on it, so
 * whoever is trying a change on a phone can see whether it has arrived yet. One
 * line, so it covers no more of the page than before: a long branch name is cut
 * short, and the commit always stays whole.
 */
export function TestSiteBanner() {
  if (!isTestSite) {
    return null;
  }

  return (
    <div className="test-site-banner" role="note">
      <span className="test-site-warning">SITIO DE PRUEBA · No registre pagos reales</span>
      {testSiteBranch && <span className="test-site-branch">{testSiteBranch}</span>}
      {testSiteCommit && <span className="test-site-commit">{testSiteCommit}</span>}
    </div>
  );
}
