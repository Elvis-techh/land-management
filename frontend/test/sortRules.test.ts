import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addLevel,
  compareByRules,
  promoteField,
  removeLevel,
  setLevelField,
  toggleLevelDirection,
} from "../src/lib/sortRules";
import type { SortRule } from "../src/lib/sortRules";

type Field = "a" | "b";
type Row = { a: number; b: number };

/** `(a.x - b.x)`, direction applied — the shape every ordinary field takes. */
function compareField(x: Row, y: Row, rule: SortRule<Field>): number {
  const raw = x[rule.field] - y[rule.field];

  return rule.direction === "asc" ? raw : -raw;
}

describe("compareByRules", () => {
  it("decides on the first rule that tells the rows apart", () => {
    const x = { a: 1, b: 9 };
    const y = { a: 2, b: 1 };

    assert.equal(
      compareByRules(x, y, [{ field: "a", direction: "asc" }], compareField) < 0,
      true,
    );
  });

  it("falls through to the next rule only when the current one ties", () => {
    const x = { a: 1, b: 9 };
    const y = { a: 1, b: 1 };
    const rules: SortRule<Field>[] = [
      { field: "a", direction: "asc" },
      { field: "b", direction: "desc" },
    ];

    // Tied on "a"; "b" descending puts the bigger "b" first.
    assert.equal(compareByRules(x, y, rules, compareField) < 0, true);
  });

  it("a later rule never overrides an earlier one that already decided", () => {
    const x = { a: 1, b: 1 };
    const y = { a: 2, b: 9 };
    const rules: SortRule<Field>[] = [
      { field: "a", direction: "asc" },
      // If this ran, descending "b" would put y before x — the opposite of
      // what "a" ascending already decided.
      { field: "b", direction: "desc" },
    ];

    assert.equal(compareByRules(x, y, rules, compareField) < 0, true);
  });

  it("returns 0 when every rule ties, leaving the caller's own tie-break to run", () => {
    const x = { a: 1, b: 1 };
    const y = { a: 1, b: 1 };

    assert.equal(compareByRules(x, y, [{ field: "a", direction: "asc" }], compareField), 0);
  });

  it("returns 0 for no rules at all", () => {
    assert.equal(compareByRules({ a: 1, b: 2 }, { a: 2, b: 1 }, [], compareField), 0);
  });

  it("lets a field own its direction instead of being flipped uniformly", () => {
    // A stand-in for lotSort's "blanks always sink, whichever way the column
    // is sorted" — the reason `compareByRules` hands over the whole rule
    // rather than flipping the sign itself. See lotSort.ts's `compareField`.
    const directionInvariant = (x: Row, y: Row): number => {
      const blankX = x.a === 0;
      const blankY = y.a === 0;

      if (blankX !== blankY) {
        return blankX ? 1 : -1;
      }

      return 0;
    };

    const blank = { a: 0, b: 0 };
    const real = { a: 5, b: 0 };

    for (const direction of ["asc", "desc"] as const) {
      const result = compareByRules(blank, real, [{ field: "a", direction }], () =>
        directionInvariant(blank, real),
      );

      assert.equal(result > 0, true, `blank must sink even sorted ${direction}`);
    }
  });
});

const asc = () => "asc" as const;

type Field3 = "a" | "b" | "c";
const asc3 = () => "asc" as const;

describe("promoteField", () => {
  it("flips direction when the field promoted is already primary", () => {
    const rules: SortRule<Field>[] = [{ field: "a", direction: "asc" }];

    assert.deepEqual(promoteField(rules, "a", asc), [{ field: "a", direction: "desc" }]);
  });

  it("replaces the primary outright when the field is unused, rather than demoting the old one into a new level", () => {
    // The bug this guards: clicking a plain, unused field in the "Ordenar
    // por" list used to keep the old primary around as a second level nobody
    // asked for — only "Agregar otro orden" is supposed to add a level.
    const rules: SortRule<Field>[] = [{ field: "a", direction: "asc" }];

    assert.deepEqual(promoteField(rules, "b", asc), [{ field: "b", direction: "asc" }]);
  });

  it("leaves existing secondary levels alone when the primary is replaced", () => {
    const rules: SortRule<Field3>[] = [
      { field: "a", direction: "asc" },
      { field: "c", direction: "desc" },
    ];

    assert.deepEqual(promoteField(rules, "b", asc3), [
      { field: "b", direction: "asc" },
      { field: "c", direction: "desc" },
    ]);
  });

  it("moves a secondary level to the front instead of appearing twice", () => {
    // The bug this guards: clicking "b" in the primary list while it is
    // already the SECOND level used to leave two rules both reading "b".
    const rules: SortRule<Field>[] = [
      { field: "a", direction: "asc" },
      { field: "b", direction: "desc" },
    ];

    const next = promoteField(rules, "b", asc);

    // "b" keeps the direction it already had — promoting it must not silently
    // discard a choice the user already made — and "a" is demoted rather than
    // dropped, so this reads as a swap, not a replacement.
    assert.deepEqual(next, [
      { field: "b", direction: "desc" },
      { field: "a", direction: "asc" },
    ]);
    assert.equal(next.filter((rule) => rule.field === "b").length, 1);
  });
});

describe("setLevelField", () => {
  it("replaces one level's field and resets it to that field's default direction", () => {
    const rules: SortRule<Field>[] = [
      { field: "a", direction: "asc" },
      { field: "b", direction: "desc" },
    ];

    assert.deepEqual(setLevelField(rules, 1, "a", asc), [
      { field: "a", direction: "asc" },
      { field: "a", direction: "asc" },
    ]);
  });
});

describe("toggleLevelDirection", () => {
  it("flips only the level asked for", () => {
    const rules: SortRule<Field>[] = [
      { field: "a", direction: "asc" },
      { field: "b", direction: "asc" },
    ];

    assert.deepEqual(toggleLevelDirection(rules, 1), [
      { field: "a", direction: "asc" },
      { field: "b", direction: "desc" },
    ]);
  });
});

describe("removeLevel", () => {
  it("drops the level at that index and closes the gap", () => {
    const rules: SortRule<Field>[] = [
      { field: "a", direction: "asc" },
      { field: "b", direction: "desc" },
    ];

    assert.deepEqual(removeLevel(rules, 1), [{ field: "a", direction: "asc" }]);
  });
});

describe("addLevel", () => {
  const options = [{ field: "a" as const }, { field: "b" as const }];

  it("appends the first field not already used", () => {
    const rules: SortRule<Field>[] = [{ field: "a", direction: "asc" }];

    assert.deepEqual(addLevel(rules, options, asc), [
      { field: "a", direction: "asc" },
      { field: "b", direction: "asc" },
    ]);
  });

  it("is a no-op once every option is already in use", () => {
    const rules: SortRule<Field>[] = [
      { field: "a", direction: "asc" },
      { field: "b", direction: "desc" },
    ];

    assert.deepEqual(addLevel(rules, options, asc), rules);
  });
});
