import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { moduleScripts } from "../src/lib/appVersion";

/*
 * How the app tells one build from the next: the scripts its index.html names.
 * A build renames `/assets/index-<hash>.js`, so a different name means a
 * deploy has happened since this page was loaded.
 */

const built = (hash: string) => `<!DOCTYPE html>
<html lang="es">
<head>
  <script type="module" crossorigin src="/assets/index-${hash}.js"></script>
  <link rel="stylesheet" crossorigin href="/assets/index-CN7FCEkp.css">
</head>
<body><div id="root"></div></body>
</html>`;

describe("moduleScripts", () => {
  it("names the build's entry script", () => {
    assert.equal(moduleScripts(built("DbQN3Sww")), "/assets/index-DbQN3Sww.js");
  });

  it("tells two builds apart, and one build from itself", () => {
    assert.notEqual(moduleScripts(built("DbQN3Sww")), moduleScripts(built("CgnRVS-K")));
    assert.equal(moduleScripts(built("CgnRVS-K")), moduleScripts(built("CgnRVS-K")));
  });

  it("takes the attributes in any order and either quote", () => {
    assert.equal(moduleScripts(`<script src='/assets/index-A.js' type='module'></script>`), "/assets/index-A.js");
  });

  it("leaves out scripts that are not modules, and inline ones", () => {
    const html = `<script src="/legacy.js"></script><script type="module">import "/x.js";</script>`;

    assert.equal(moduleScripts(html), "");
  });

  it("finds nothing in a page that is not Lindero's, such as a proxy's error", () => {
    assert.equal(moduleScripts("<html><body><h1>502 Bad Gateway</h1></body></html>"), "");
  });
});
