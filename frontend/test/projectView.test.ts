import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NO_PROJECT_FILTERS,
  countActiveFilters,
  filterProjects,
  searchProjects,
  sortProjects,
} from "../src/features/projects/projectView";
import { cents } from "../src/lib/money";
import type { Project } from "../src/types";

/* #5: search, filter and sort on Proyectos. */

function project(name: string, extra: Partial<Project> = {}): Project {
  return {
    id: name,
    name,
    areaUnit: "m2",
    archivedAt: null,
    lotCount: 4,
    availableCount: 2,
    reservedCount: 0,
    financedCount: 1,
    soldCount: 1,
    donatedCount: 0,
    inventoryValue: cents(1_000_000),
    areaM2: 1000,
    ...extra,
  };
}

const etapa1 = project("Proyecto Santiago Etapa 1", { availableCount: 0, lotCount: 6 });
const etapa2 = project("Proyecto Santiago Etapa 2", { availableCount: 5, areaM2: 5000 });
const monte = project("Monte Real", { areaUnit: "vara2", availableCount: 2, areaM2: 3000 });
const all = [etapa1, etapa2, monte];
const names = (list: Project[]) => list.map((entry) => entry.name);

describe("the Proyectos search", () => {
  it("finds a project by any part of its name, whatever the capitals", () => {
    assert.deepEqual(names(searchProjects(all, "monte")), ["Monte Real"]);
    assert.deepEqual(names(searchProjects(all, "santiago 2")), ["Proyecto Santiago Etapa 2"]);
    assert.deepEqual(names(searchProjects(all, "  ")), names(all));
  });
});

describe("the Proyectos filters", () => {
  it("hides projects with nothing left for sale", () => {
    const filters = { ...NO_PROJECT_FILTERS, onlyWithAvailable: true };
    assert.deepEqual(names(filterProjects(all, filters)), ["Proyecto Santiago Etapa 2", "Monte Real"]);
    assert.equal(countActiveFilters(filters), 1);
  });

  it("keeps the projects written in the chosen units", () => {
    const filters = { ...NO_PROJECT_FILTERS, units: ["vara2" as const] };
    assert.deepEqual(names(filterProjects(all, filters)), ["Monte Real"]);
  });

  it("restricts nothing when untouched", () => {
    assert.deepEqual(names(filterProjects(all, NO_PROJECT_FILTERS)), names(all));
    assert.equal(countActiveFilters(NO_PROJECT_FILTERS), 0);
  });
});

describe("the Proyectos sort", () => {
  it("opens A → Z by name", () => {
    assert.deepEqual(names(sortProjects(all, [{ field: "name", direction: "asc" }])), [
      "Monte Real",
      "Proyecto Santiago Etapa 1",
      "Proyecto Santiago Etapa 2",
    ]);
  });

  it("puts the most lots for sale first", () => {
    assert.deepEqual(names(sortProjects(all, [{ field: "available", direction: "desc" }])), [
      "Proyecto Santiago Etapa 2",
      "Monte Real",
      "Proyecto Santiago Etapa 1",
    ]);
  });

  it("compares area in square metres, whatever unit the card shows", () => {
    assert.deepEqual(names(sortProjects(all, [{ field: "area", direction: "desc" }])), [
      "Proyecto Santiago Etapa 2",
      "Monte Real",
      "Proyecto Santiago Etapa 1",
    ]);
  });

  it("breaks a tie by name, the same way whichever direction", () => {
    const tied = [project("B"), project("A")];
    assert.deepEqual(names(sortProjects(tied, [{ field: "lots", direction: "desc" }])), ["A", "B"]);
    assert.deepEqual(names(sortProjects(tied, [{ field: "lots", direction: "asc" }])), ["A", "B"]);
  });
});
