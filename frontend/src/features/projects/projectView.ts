import type { AreaUnit } from "../../lib/area";
import type { SortRule } from "../../lib/sortRules";
import { compareByRules } from "../../lib/sortRules";
import type { Project } from "../../types";

/*
 * #5: search, filter and sort for Proyectos, the same three as every other
 * list. Kept apart from the screen so the rules can be tested on their own.
 */

/* ---------- search ---------- */

/**
 * By name, the only text a project has. The same rules as the other lists:
 * not case-sensitive, and every word has to match.
 */
export function searchProjects(projects: Project[], search: string): Project[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter((word) => word !== "");

  if (words.length === 0) {
    return projects;
  }

  return projects.filter((project) => {
    const name = project.name.toLowerCase();
    return words.every((word) => name.includes(word));
  });
}

/* ---------- filters ---------- */

export interface ProjectFilters {
  /** Only projects with at least one lot still for sale. */
  onlyWithAvailable: boolean;
  /** Empty means every unit. */
  units: AreaUnit[];
}

export const NO_PROJECT_FILTERS: ProjectFilters = { onlyWithAvailable: false, units: [] };

/** How many restrictions are active: the number on the Filtros button. */
export function countActiveFilters(filters: ProjectFilters): number {
  return (filters.onlyWithAvailable ? 1 : 0) + (filters.units.length > 0 ? 1 : 0);
}

export function filterProjects(projects: Project[], filters: ProjectFilters): Project[] {
  return projects.filter(
    (project) =>
      (!filters.onlyWithAvailable || project.availableCount > 0) &&
      (filters.units.length === 0 || filters.units.includes(project.areaUnit)),
  );
}

/* ---------- sort ---------- */

export type ProjectSortField = "name" | "available" | "lots" | "area" | "inventory";

export type ProjectSort = SortRule<ProjectSortField>[];

export const DEFAULT_PROJECT_SORT: ProjectSort = [{ field: "name", direction: "asc" }];

export const PROJECT_SORT_OPTIONS: Array<{
  field: ProjectSortField;
  label: string;
  ascLabel: string;
  descLabel: string;
}> = [
  { field: "name", label: "Nombre", ascLabel: "A → Z", descLabel: "Z → A" },
  { field: "available", label: "Lotes disponibles", ascLabel: "Menos primero", descLabel: "Más primero" },
  { field: "lots", label: "Lotes", ascLabel: "Menos primero", descLabel: "Más primero" },
  { field: "area", label: "Área total", ascLabel: "Menor a mayor", descLabel: "Mayor a menor" },
  { field: "inventory", label: "Inventario", ascLabel: "Menor a mayor", descLabel: "Mayor a menor" },
];

/** A name reads best A → Z first; a number, the biggest first. */
export function defaultProjectSortDirection(field: ProjectSortField): "asc" | "desc" {
  return field === "name" ? "asc" : "desc";
}

/**
 * Area compares stored square metres, never the number on the card, since two
 * projects can be written in different units. Ties fall back to the name,
 * which is not flipped by direction, so equal projects keep a steady order.
 */
export function sortProjects(projects: Project[], sort: ProjectSort): Project[] {
  const compareField = (a: Project, b: Project, rule: SortRule<ProjectSortField>): number => {
    const raw = ((): number => {
      switch (rule.field) {
        case "available":
          return a.availableCount - b.availableCount;
        case "lots":
          return a.lotCount - b.lotCount;
        case "area":
          return a.areaM2 - b.areaM2;
        case "inventory":
          return a.inventoryValue - b.inventoryValue;
        case "name":
        default:
          return a.name.localeCompare(b.name, "es");
      }
    })();

    return rule.direction === "asc" ? raw : -raw;
  };

  return [...projects].sort(
    (a, b) => compareByRules(a, b, sort, compareField) || a.name.localeCompare(b.name, "es"),
  );
}
