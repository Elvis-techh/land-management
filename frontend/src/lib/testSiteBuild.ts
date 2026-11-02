/**
 * What a test-site build changes in the two files that are read before any of
 * the app runs: index.html and the install manifest. Called from vite.config.ts,
 * and only when VITE_SITE=test.
 *
 * Both throw rather than return the file unchanged. A test site that Google can
 * index, or that a phone lists as a second «Lindero» in its share sheet, looks
 * fine to whoever built it, so it has to stop the build instead.
 */

/** The test site's colour, for the phone's status bar. Same as --test-site in styles.css. */
const TEST_SITE_COLOUR = "#C2410C";

export const TEST_SITE_NAME = "PRUEBA Lindero";

function replaceOrThrow(text: string, find: RegExp, replacement: string): string {
  if (!find.test(text)) {
    throw new Error(`index.html no longer has ${find}, which a test-site build replaces`);
  }
  return text.replace(find, replacement);
}

export function testSiteHtml(html: string): string {
  const named = replaceOrThrow(
    html,
    /<title>Lindero<\/title>/,
    '<title>PRUEBA · Lindero</title>\n  <meta name="robots" content="noindex, nofollow">',
  );
  return replaceOrThrow(named, /(<meta name="theme-color" content=")[^"]*/, `$1${TEST_SITE_COLOUR}`);
}

export function testSiteManifest(json: string): string {
  return JSON.stringify(
    { ...JSON.parse(json), name: TEST_SITE_NAME, short_name: "PRUEBA", theme_color: TEST_SITE_COLOUR },
    null,
    2,
  );
}
