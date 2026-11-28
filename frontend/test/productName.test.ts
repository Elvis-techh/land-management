import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

import ts from "typescript";

const repo = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(repo, path), "utf8");

/*
 * What people see is «TerraCuota». "lindero" stays the name inside: the
 * repository, the server's folders, the database, and keys such as
 * "lindero.draft." that a phone already holds. Those are all lower case, so the
 * capital L is what tells the old product name apart from them.
 */
const OLD_NAME = /Lindero/;

function codeFiles(folder: string): string[] {
  return readdirSync(join(repo, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return codeFiles(path);
    return /\.(ts|tsx|js)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Every piece of text a file can hand to a person: strings, the fixed parts of
 * templates, patterns, and the words written inside JSX. Comments are not among
 * them, and may go on saying Lindero.
 */
function textsNaming(path: string, name: RegExp): string[] {
  const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const isText =
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isJsxText(node);
    if (isText && name.test(node.text)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${relative(repo, join(repo, path))}:${line + 1}: ${node.text.replace(/\s+/g, " ").trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("the product's name", () => {
  it("is TerraCuota in the browser tab and on a phone's home screen", () => {
    assert.match(source("frontend/index.html"), /<title>TerraCuota<\/title>/);
    const manifest = JSON.parse(source("frontend/public/manifest.webmanifest")) as Record<string, unknown>;
    assert.equal(manifest.name, "TerraCuota");
    assert.equal(manifest.short_name, "TerraCuota");
  });

  it("is not the old one anywhere in the app's own words", () => {
    const files = [...codeFiles("frontend/src"), ...codeFiles("backend/src"), "frontend/public/sw.js"];
    // So that a moved folder cannot leave this passing on nothing.
    assert.ok(files.length > 100, `only ${files.length} files were read`);
    assert.deepEqual(files.flatMap((path) => textsNaming(path, OLD_NAME)), []);
    assert.doesNotMatch(source("frontend/index.html"), OLD_NAME);
    assert.doesNotMatch(source("frontend/public/manifest.webmanifest"), OLD_NAME);
  });
});
