import { useRef, useState } from "react";

import { IconClose, IconFilter, IconSort } from "../../components/Icons";
import { MenuSurface } from "../../components/MenuSurface";
import { SearchBox } from "../../components/SearchBox";
import { SortMenu } from "../../components/SortMenu";
import { AREA_UNIT_INFO } from "../../lib/area";
import type { AreaUnit } from "../../lib/area";
import { useDismiss } from "../../lib/useDismiss";
import { useIsMobile } from "../../lib/viewport";
import type { ProjectFilters, ProjectSort } from "./projectView";
import {
  NO_PROJECT_FILTERS,
  PROJECT_SORT_OPTIONS,
  countActiveFilters,
  defaultProjectSortDirection,
} from "./projectView";

interface ProjectToolbarProps {
  /** The units the listed projects are written in, for the unit checkboxes. */
  units: AreaUnit[];
  filters: ProjectFilters;
  onFiltersChange: (filters: ProjectFilters) => void;
  sort: ProjectSort;
  onSortChange: (sort: ProjectSort) => void;
  search: string;
  onSearchChange: (search: string) => void;
  shownCount: number;
  totalCount: number;
}

/**
 * The Proyectos toolbar (#5): one search box, one sort menu, one filter panel,
 * with every applied filter repeated underneath as a removable chip. The same
 * object as on Contratos, Clientes, Recibos and Lotes, so it is learned once.
 */
export function ProjectToolbar({
  units,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  search,
  onSearchChange,
  shownCount,
  totalCount,
}: ProjectToolbarProps) {
  const [openMenu, setOpenMenu] = useState<"sort" | "filter" | null>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // On a phone these open as sheets with their own backdrop and Escape.
  useDismiss(!isMobile && openMenu === "sort", sortRef, () => setOpenMenu(null));
  useDismiss(!isMobile && openMenu === "filter", filterRef, () => setOpenMenu(null));

  const activeCount = countActiveFilters(filters);
  const primaryOption =
    PROJECT_SORT_OPTIONS.find((option) => option.field === sort[0]?.field) ??
    PROJECT_SORT_OPTIONS[0]!;

  const toggleUnit = (unit: AreaUnit) =>
    onFiltersChange({
      ...filters,
      units: filters.units.includes(unit)
        ? filters.units.filter((entry) => entry !== unit)
        : [...filters.units, unit],
    });

  const clearAll = () => onFiltersChange(NO_PROJECT_FILTERS);

  const activeChips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (filters.onlyWithAvailable) {
    activeChips.push({
      key: "available",
      label: "Con lotes disponibles",
      clear: () => onFiltersChange({ ...filters, onlyWithAvailable: false }),
    });
  }
  for (const unit of filters.units) {
    activeChips.push({
      key: `unit:${unit}`,
      label: `En ${AREA_UNIT_INFO[unit].symbol}`,
      clear: () => toggleUnit(unit),
    });
  }

  const plural = (count: number) => `proyecto${count === 1 ? "" : "s"}`;

  return (
    <div className="lots-toolbar">
      <div className="toolbar">
        <span className="result-count">
          Mostrando {shownCount} de {totalCount} {plural(totalCount)}
        </span>

        <div className="toolbar-spacer" />

        <SearchBox
          value={search}
          onChange={onSearchChange}
          placeholder="Buscar proyecto…"
          label="Buscar proyecto"
          title="Busca por el nombre del proyecto"
        />

        <div className="menu-anchor" ref={sortRef}>
          <button
            type="button"
            className="chip menu-trigger"
            aria-expanded={openMenu === "sort"}
            onClick={() => setOpenMenu(openMenu === "sort" ? null : "sort")}
          >
            <IconSort />
            <span>
              {primaryOption.label}
              <span className="menu-trigger-detail">
                {sort[0]?.direction === "asc" ? primaryOption.ascLabel : primaryOption.descLabel}
              </span>
            </span>
            {sort.length > 1 && <span className="filter-count">+{sort.length - 1}</span>}
          </button>

          <MenuSurface
            isOpen={openMenu === "sort"}
            title="Ordenar por"
            onClose={() => setOpenMenu(null)}
            className="sort-popover"
          >
            <SortMenu
              options={PROJECT_SORT_OPTIONS}
              rules={sort}
              onChange={onSortChange}
              defaultDirection={defaultProjectSortDirection}
              hint="Vuelve a elegir el mismo campo para invertir el orden."
            />
          </MenuSurface>
        </div>

        <div className="menu-anchor" ref={filterRef}>
          <button
            type="button"
            className={activeCount > 0 ? "chip menu-trigger active" : "chip menu-trigger"}
            aria-expanded={openMenu === "filter"}
            onClick={() => setOpenMenu(openMenu === "filter" ? null : "filter")}
          >
            <IconFilter />
            <span>Filtros</span>
            {activeCount > 0 && <span className="filter-count">{activeCount}</span>}
          </button>

          <MenuSurface
            isOpen={openMenu === "filter"}
            title="Filtros"
            onClose={() => setOpenMenu(null)}
            className="filter-popover"
            footer={
              <>
                <button type="button" className="link-btn" onClick={clearAll}>
                  Limpiar filtros
                </button>
                <button type="button" className="btn-primary" onClick={() => setOpenMenu(null)}>
                  Ver {shownCount} {plural(shownCount)}
                </button>
              </>
            }
          >
            <div className="filter-section">
              <p className="menu-title">Disponibilidad</p>
              <label className="filter-check">
                <input
                  type="checkbox"
                  checked={filters.onlyWithAvailable}
                  onChange={() =>
                    onFiltersChange({ ...filters, onlyWithAvailable: !filters.onlyWithAvailable })
                  }
                />
                <span>Solo con lotes disponibles</span>
              </label>
              <span className="field-hint">Esconde los proyectos que ya no tienen nada a la venta.</span>
            </div>

            {units.length > 1 && (
              <div className="filter-section">
                <p className="menu-title">Unidad de área</p>
                {units.map((unit) => (
                  <label key={unit} className="filter-check">
                    <input
                      type="checkbox"
                      checked={filters.units.includes(unit)}
                      onChange={() => toggleUnit(unit)}
                    />
                    <span>{AREA_UNIT_INFO[unit].label}</span>
                  </label>
                ))}
              </div>
            )}
          </MenuSurface>
        </div>
      </div>

      {activeChips.length > 0 && (
        <div className="active-filters">
          {activeChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="filter-chip"
              onClick={chip.clear}
              title={`Quitar ${chip.label}`}
            >
              <span>{chip.label}</span>
              <IconClose />
            </button>
          ))}

          <button type="button" className="link-btn" onClick={clearAll}>
            Limpiar filtros
          </button>
        </div>
      )}
    </div>
  );
}
