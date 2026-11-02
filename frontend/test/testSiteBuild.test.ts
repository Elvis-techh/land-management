import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { testSiteHtml, testSiteManifest } from "../src/lib/testSiteBuild";

const frontend = join(import.meta.dirname, "..");
const realHtml = readFileSync(join(frontend, "index.html"), "utf8");
const realManifest = readFileSync(join(frontend, "public", "manifest.webmanifest"), "utf8");

/*
 * What a test-site build changes in the two files the browser and the phone
 * read before any of the app runs. Checked against the real files, so renaming
 * something in them fails here instead of quietly building a test site that
 * Google can index and a phone cannot tell from the real Lindero.
 */
describe("a test-site build", () => {
  it("is hidden from search engines and named in the browser tab", () => {
    const html = testSiteHtml(realHtml);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(html, /<title>PRUEBA · Lindero<\/title>/);
  });

  it("colours the phone's status bar, so it does not look like the real app", () => {
    assert.match(realHtml, /<meta name="theme-color" content="#FCF9F5">/);
    assert.doesNotMatch(testSiteHtml(realHtml), /<meta name="theme-color" content="#FCF9F5">/);
  });

  it("installs under another name, so the share sheet does not list two Linderos", () => {
    const manifest = JSON.parse(testSiteManifest(realManifest));
    assert.equal(manifest.name, "PRUEBA Lindero");
    assert.equal(manifest.short_name, "PRUEBA");
    assert.notEqual(manifest.theme_color, JSON.parse(realManifest).theme_color);
    // Everything else stays, so the share target can be tried on the test site.
    assert.deepEqual(manifest.share_target, JSON.parse(realManifest).share_target);
  });

  it("refuses to build if index.html no longer has what it replaces", () => {
    assert.throws(() => testSiteHtml("<html><head></head></html>"), /index\.html/);
  });
});
