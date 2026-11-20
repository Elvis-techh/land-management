import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { capabilityChanges } from "../src/features/audit/capabilityChanges";
import type { PersonChoice } from "../src/features/permissions/permissionChoice";
import {
  differencesFromGeneral,
  effectiveCapabilities,
  personChoiceChanged,
} from "../src/features/permissions/permissionChoice";
import type { Capability } from "../src/lib/permissions";

/*
 * Permissions for one associate (QI-5 step 3): the general list, or a complete
 * list of their own, with the switches that differ from the general marked.
 */

const set = (...capabilities: Capability[]) => new Set<Capability>(capabilities);
const general = set("lot:create", "customer:create", "payment:record");
const offered: Capability[] = ["lot:create", "lot:archive", "customer:create", "payment:record", "rate:edit"];

describe("one associate's permissions", () => {
  it("follows the general list while «Los permisos generales» is chosen", () => {
    const choice: PersonChoice = { mode: "general", own: set("lot:archive") };

    assert.deepEqual([...effectiveCapabilities(choice, general)].sort(), [...general].sort());
    assert.deepEqual(differencesFromGeneral(choice, general, offered), []);
  });

  it("marks only the switches that differ from the general list", () => {
    const choice: PersonChoice = { mode: "own", own: set("customer:create", "payment:record", "lot:archive") };

    // «Archivar lotes» given, «Crear lotes» taken away. The rest match.
    assert.deepEqual(differencesFromGeneral(choice, general, offered), ["lot:create", "lot:archive"]);
  });

  it("finds nothing to mark when their own list matches the general one", () => {
    const choice: PersonChoice = { mode: "own", own: new Set(general) };
    assert.deepEqual(differencesFromGeneral(choice, general, offered), []);
  });

  it("has something to save once «Permisos propios» is chosen, even before a switch moves", () => {
    const saved: PersonChoice = { mode: "general", own: set() };
    assert.equal(personChoiceChanged(saved, { mode: "own", own: new Set(general) }), true);
  });

  it("has nothing to save when a switch is moved and moved back", () => {
    const saved: PersonChoice = { mode: "own", own: set("lot:create", "payment:record") };
    assert.equal(personChoiceChanged(saved, { mode: "own", own: set("payment:record", "lot:create") }), false);
    assert.equal(personChoiceChanged(saved, { mode: "own", own: set("payment:record") }), true);
  });

  it("ignores the hidden own list while back on the general one", () => {
    const saved: PersonChoice = { mode: "general", own: set("lot:create") };
    assert.equal(personChoiceChanged(saved, { mode: "general", own: set("rate:edit") }), false);
  });
});

describe("a permissions change in the Historial", () => {
  it("says what was given and taken away, in the screen's words", () => {
    const changes = capabilityChanges(
      ["customer:create", "lot:create", "payment:record"],
      ["customer:create", "lot:archive", "payment:record"],
    );

    assert.deepEqual(changes, { added: ["Archivar lotes"], removed: ["Crear lotes"] });
  });

  it("shows an unknown capability as it is, rather than dropping it", () => {
    assert.deepEqual(capabilityChanges([], ["lot:teleport"]), { added: ["lot:teleport"], removed: [] });
  });

  it("gives up on anything that isn't two lists", () => {
    assert.equal(capabilityChanges(null, ["lot:create"]), null);
    assert.equal(capabilityChanges(["lot:create"], "lot:create"), null);
  });
});
