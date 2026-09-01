import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DashboardLayout, SectionId } from "../src/features/dashboard/dashboardSections";
import {
  DEFAULT_SECTION_ORDER,
  dropSection,
  isDefaultLayout,
  moveSection,
  resolveLayout,
} from "../src/features/dashboard/dashboardSections";

/**
 * The reconciliation is the whole "cannot break the layout" guarantee, so it is
 * the one piece of frontend logic worth testing on its own.
 *
 * It is testable at all because it is plain TypeScript — no React, no DOM, no
 * network — which is also why it lives in a file of its own rather than inside
 * the component that uses it.
 */

const layout = (order: string[], hidden: string[] = []): DashboardLayout =>
  ({ order, hidden }) as DashboardLayout;

describe("resolving a saved arrangement", () => {
  it("gives the default order to somebody who has never chosen", () => {
    assert.deepEqual(resolveLayout(null).order, [...DEFAULT_SECTION_ORDER]);
    assert.deepEqual(resolveLayout(null).hidden, []);
  });

  it("never reorders the bands somebody chose", () => {
    /*
     * The invariant that matters, and it is weaker than it first looks: bands
     * that were saved keep their order RELATIVE to each other. Restored bands
     * are inserted around them, so asserting on absolute positions would be
     * asserting on the restoration rule rather than on the user's intent.
     */
    const chosen = ["worklist", "collections", "income"];
    const resolved = resolveLayout(layout(chosen));
    const positions = chosen.map((id) => resolved.order.indexOf(id as SectionId));

    assert.ok(positions.every((position) => position !== -1));
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
      "a saved band was moved past another saved band",
    );
  });

  it("keeps a full saved order untouched, which is the everyday case", () => {
    // A real stored arrangement holds every band, so nothing is restored and
    // nothing may move.
    const chosen = [...DEFAULT_SECTION_ORDER].reverse();

    assert.deepEqual(resolveLayout(layout(chosen)).order, chosen);
  });

  it("puts back a band that shipped after the arrangement was saved", () => {
    // The case people forget: a user customises their screen, a later release
    // adds a band, and unless it is restored the new feature is invisible to
    // exactly the users engaged enough to have arranged their dashboard.
    const saved = layout(DEFAULT_SECTION_ORDER.filter((id) => id !== "projection"));
    const resolved = resolveLayout(saved);

    assert.equal(resolved.order.length, DEFAULT_SECTION_ORDER.length);
    assert.ok(resolved.order.includes("projection"));
  });

  it("puts a new band beside the neighbour it ships next to, not at the end", () => {
    // "projection" comes after "projects" by default. Dropping it at the end
    // would bury a chart under the notices it belongs above.
    const saved = layout(DEFAULT_SECTION_ORDER.filter((id) => id !== "projection"));
    const resolved = resolveLayout(saved);

    assert.equal(resolved.order.indexOf("projection"), resolved.order.indexOf("projects") + 1);
  });

  it("puts back a new FIRST band at the front", () => {
    // The index-minus-one lookup has no neighbour to hang off here, and getting
    // it wrong is an off-by-one that silently moves the band to position two.
    const saved = layout(DEFAULT_SECTION_ORDER.filter((id) => id !== "income"));

    assert.equal(resolveLayout(saved).order[0], "income");
  });

  it("drops an id the code no longer has", () => {
    // A band removed in a later release must not leave a hole, an undefined
    // card, or a crash in the layout of everybody who saved one.
    const resolved = resolveLayout(layout(["worklist", "a-band-that-was-deleted", "income"]));

    assert.ok(!resolved.order.includes("a-band-that-was-deleted" as SectionId));
    assert.equal(resolved.order.length, DEFAULT_SECTION_ORDER.length);
  });

  it("drops a repeated id rather than rendering a band twice", () => {
    const resolved = resolveLayout(layout(["income", "income", "worklist"]));

    assert.equal(resolved.order.filter((id) => id === "income").length, 1);
    // Two identical React keys is the other half of this bug.
    assert.equal(new Set(resolved.order).size, resolved.order.length);
  });

  it("always resolves to every band the code has, exactly once", () => {
    // The invariant the renderer depends on, whatever nonsense was stored.
    for (const stored of [
      null,
      layout([]),
      layout(["nope"]),
      layout(["control", "control", "control"]),
      layout([...DEFAULT_SECTION_ORDER].reverse()),
    ]) {
      const resolved = resolveLayout(stored);

      assert.deepEqual(
        [...resolved.order].sort(),
        [...DEFAULT_SECTION_ORDER].sort(),
        `failed for ${JSON.stringify(stored)}`,
      );
    }
  });

  it("falls back to the default when nothing stored survives", () => {
    assert.deepEqual(resolveLayout(layout(["gone", "also-gone"])).order, [
      ...DEFAULT_SECTION_ORDER,
    ]);
  });

  it("keeps hidden bands, but only ones that still exist", () => {
    const resolved = resolveLayout(layout([...DEFAULT_SECTION_ORDER], ["control", "deleted"]));

    assert.deepEqual(resolved.hidden, ["control"]);
  });
});

describe("moving a band", () => {
  it("swaps it with its neighbour", () => {
    const order = ["a", "b", "c"] as unknown as SectionId[];

    assert.deepEqual(moveSection(order, "b" as SectionId, -1), ["b", "a", "c"]);
    assert.deepEqual(moveSection(order, "b" as SectionId, 1), ["a", "c", "b"]);
  });

  it("does nothing at the ends, rather than wrapping around", () => {
    // Wrapping would send the top band to the bottom on a mis-click, which is
    // the most annoying possible response to pressing "up" on the first item.
    const order = ["a", "b", "c"] as unknown as SectionId[];

    assert.deepEqual(moveSection(order, "a" as SectionId, -1), order);
    assert.deepEqual(moveSection(order, "c" as SectionId, 1), order);
  });

  it("leaves the input array alone", () => {
    const order = ["a", "b", "c"] as unknown as SectionId[];
    moveSection(order, "a" as SectionId, 1);

    assert.deepEqual(order, ["a", "b", "c"]);
  });
});

describe("dropping a band onto another", () => {
  it("lands it in front of the one it was dropped on", () => {
    const order = ["a", "b", "c", "d"] as unknown as SectionId[];

    assert.deepEqual(dropSection(order, "d" as SectionId, "b" as SectionId), ["a", "d", "b", "c"]);
  });

  it("moves a band down without leaving a gap where it was", () => {
    // The lift-then-insert order matters: computing the target index before
    // removing the dragged band puts it one place too far when moving down.
    const order = ["a", "b", "c", "d"] as unknown as SectionId[];

    assert.deepEqual(dropSection(order, "a" as SectionId, "c" as SectionId), ["b", "a", "c", "d"]);
  });

  it("does nothing when a band is dropped on itself", () => {
    const order = ["a", "b", "c"] as unknown as SectionId[];

    assert.deepEqual(dropSection(order, "b" as SectionId, "b" as SectionId), order);
  });
});

describe("recognising the default", () => {
  it("knows an untouched arrangement from a rearranged one", () => {
    // What decides whether "Restaurar el orden original" is offered at all.
    assert.equal(isDefaultLayout(resolveLayout(null)), true);
    assert.equal(
      isDefaultLayout(resolveLayout(layout([...DEFAULT_SECTION_ORDER].reverse()))),
      false,
    );
    assert.equal(
      isDefaultLayout(resolveLayout(layout([...DEFAULT_SECTION_ORDER], ["control"]))),
      false,
    );
  });
});
