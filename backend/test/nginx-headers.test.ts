import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const repo = join(import.meta.dirname, "..", "..");
const example = readFileSync(join(repo, "docs", "nginx.conf.example"), "utf8");
const snippet = readFileSync(join(repo, "deploy", "nginx-headers.conf"), "utf8");

const withoutComments = (text: string) => text.replace(/^\s*#.*$/gm, "");

/** The body of `location <match> {…}` inside the HTTPS server block, braces balanced. */
function locationBody(match: string): string {
  const https = withoutComments(example.slice(example.search(/listen[^;]*443/)));
  const start = https.indexOf(`location ${match} {`);
  assert.ok(start >= 0, `no "location ${match}" in the HTTPS block`);

  let depth = 0;
  for (let index = https.indexOf("{", start); index < https.length; index += 1) {
    if (https[index] === "{") depth += 1;
    if (https[index] === "}" && --depth === 0) {
      return https.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces after "location ${match}"`);
}

/*
 * The browser security headers (code review P2-2) only arrive if every static
 * location includes them, since nginx drops server-level add_header in any
 * location with an add_header of its own. And they must stay out of /api/:
 * the document viewer frames files served from there.
 */
describe("nginx security headers", () => {
  it("are included in every static location of the example", () => {
    for (const match of ["/", "= /index.html", "/assets/", "= /sw.js", "= /manifest.webmanifest"]) {
      assert.match(locationBody(match), /include snippets\/lindero-headers\.conf;/, match);
    }
  });

  it("stay out of the API, which the document viewer frames", () => {
    assert.doesNotMatch(locationBody("/api/"), /lindero-headers/);
  });

  it("are not set at server level, where the static locations would drop them", () => {
    const outsideLocations = withoutComments(example).replace(/location [^{]*\{[\s\S]*?\n {4}\}/g, "");
    assert.doesNotMatch(outsideLocations, /add_header|lindero-headers/);
  });

  it("send HSTS for this host only, and the rest of the set", () => {
    const sent = [...snippet.matchAll(/^add_header ([\w-]+) "([^"]*)" always;$/gm)].map(([, name, value]) => [
      name,
      value,
    ]);
    const names = sent.map(([name]) => name);

    assert.deepEqual(names, [
      "Strict-Transport-Security",
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Content-Security-Policy-Report-Only",
    ]);
    // Other names under the domain are not Lindero's to put on HTTPS-only.
    assert.doesNotMatch(Object.fromEntries(sent)["Strict-Transport-Security"]!, /includeSubDomains/i);
    // The viewer previews a scan from a blob: URL before it is uploaded.
    assert.match(Object.fromEntries(sent)["Content-Security-Policy-Report-Only"]!, /frame-src[^;]*blob:/);
  });
});
