import { useMemo, useRef, useState } from "react";

import { IconClose, IconFilter, IconSearch, IconSort } from "../../components/Icons";
import { MenuSurface } from "../../components/MenuSurface";
import { useDismiss } from "../../lib/useDismiss";
import { useIsMobile } from "../../lib/viewport";
import type { CustomerFilters, HoldingFilter } from "./customerFilters";
import { NO_CUSTOMER_FILTERS, countActiveFilters } from "./customerFilters";
import { SORT_OPTIONS } from "./customerSort";
import type { CustomerSort, SortField } from "./customerSort";

/** The wording used everywhere else for what a person is holding. */
const HOLDING_LABELS: Array<{ value: HoldingFilter; label: string }> = [
  { value: "contract", label: "Con contrato" },
  { value: "reservation", label: "Con reserva" },
  { value: "none", label: "Sin contrato activo" },
];

interface CustomerToolbarProps {
  /** Every project a customer currently holds something in. */
  projectNames: string[];
  filters: CustomerFilters;
  onFiltersChange: (filters: CustomerFilters) => void;
  sort: CustomerSort;
  onSortChange: (sort: CustomerSort) => void;
  search: string;
  onSearchChange: (search: string) => void;
  /** For the "Mostrando X de Y" count. */
  shownCount: number;
  totalCount: number;
}

/**
 * The Clientes toolbar: one search box, one sort menu, one filter panel.
 *
 * Deliberately the same object as `LotToolbar`, down to the chips underneath —
 * the two tables are the two lists people spend their day in, and a filter
 * button that behaves differently on the second screen is a filter button
 * somebody has to learn twice.
 *
 * The search box stays outside the panel because it is not a saved restriction:
 * its text is on screen, so it can never be the invisible filter that makes the
 * list look wrong. Everything that CAN hide is repeated as a removable chip.
 */
export function CustomerToolbar({
  projectNames,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  search,
  onSearchChange,
  shownCount,
  totalCount,
}: CustomerToolbarProps) {
  const [openMenu, setOpenMenu] = useState<"sort" | "filter" | null>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // On a phone these open as sheets, which bring their own backdrop and Escape
  // handling; a second outside-click listener would only fight with them.
  useDismiss(!isMobile && openMenu === "sort", sortRef, () => setOpenMenu(null));
  useDismiss(!isMobile && openMenu === "filter", filterRef, () => setOpenMenu(null));

  // Years are edited as text and committed on change, so the fields keep what
  // the user typed rather than snapping under their cursor.
  const [sinceFromText, setSinceFromText] = useState(() =>
    filters.sinceFrom === null ? "" : String(filters.sinceFrom),
  );
  const [sinceToText, setSinceToText] = useState(() =>
    filters.sinceTo === null ? "" : String(filters.sinceTo),
  );

  const activeCount = countActiveFilters(filters);
  const sortOption = SORT_OPTIONS.find((option) => option.field === sort.field) ?? SORT_OPTIONS[0]!;

  const setSortField = (field: SortField) => {
    // Picking the field already selected flips the direction — the shortcut
    // people expect from a column header, kept here so the menu behaves the
    // same way it does on the Lotes screen.
    onSortChange(
      field === sort.field
        ? { field, direction: sort.direction === "asc" ? "desc" : "asc" }
        : { field, direction: "asc" },
    );
  };

  const toggleHolding = (value: HoldingFilter) => {
    const next = filters.holdings.includes(value)
      ? filters.holdings.filter((holding) => holding !== value)
      : [...filters.holdings, value];

    onFiltersChange({ ...filters, holdings: next });
  };

  const toggleProject = (name: string) => {
    const next = filters.projects.includes(name)
      ? filters.projects.filter((project) => project !== name)
      : [...filters.projects, name];

    onFiltersChange({ ...filters, projects: next });
  };

  const commitSince = (which: "from" | "to", text: string) => {
    const value = Number(text);
    // A half-typed "20" is not a year anybody means, so nothing is applied
    // until there are four digits to apply.
    const year =
      /^\d{4}$/.test(text.trim()) && Number.isFinite(value) && value >= 1900 && value <= 2200
        ? value
        : null;

    onFiltersChange({ ...filters, [which === "from" ? "sinceFrom" : "sinceTo"]: year });
  };

  const clearAll = () => {
    setSinceFromText("");
    setSinceToText("");
    onFiltersChange(NO_CUSTOMER_FILTERS);
  };

  /** One removable chip per applied restriction. */
  const activeChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = [];

    for (const holding of filters.holdings) {
      chips.push({
        key: `holding:${holding}`,
        label: HOLDING_LABELS.find((option) => option.value === holding)?.label ?? holding,
        clear: () =>
          onFiltersChange({
            ...filters,
            holdings: filters.holdings.filter((value) => value !== holding),
          }),
      });
    }

    for (const project of filters.projects) {
      chips.push({
        key: `project:${project}`,
        label: project,
        clear: () =>
          onFiltersChange({
            ...filters,
            projects: filters.projects.filter((value) => value !== project),
          }),
      });
    }

    if (filters.sinceFrom !== null || filters.sinceTo !== null) {
      const from = filters.sinceFrom;
      const to = filters.sinceTo;

      chips.push({
        key: "since",
        label:
          from && to
            ? `Cliente desde ${from} – ${to}`
            : from
              ? `Cliente desde ${from}`
              : `Cliente hasta ${to}`,
        clear: () => {
          setSinceFromText("");
          setSinceToText("");
          onFiltersChange({ ...filters, sinceFrom: null, sinceTo: null });
        },
      });
    }

    return chips;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const filterBody = (
    <>
      <div className="filter-section">
        <p className="menu-title">Contratos</p>
        {HOLDING_LABELS.map((option) => (
          <label key={option.value} className="filter-check">
            <input
              type="checkbox"
              checked={filters.holdings.includes(option.value)}
              onChange={() => toggleHolding(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
        {filters.holdings.length === 0 && (
          <p className="field-hint">Sin marcar ninguno se muestran todos.</p>
        )}
      </div>

      <div className="filter-section">
        <p className="menu-title">Proyecto</p>
        {projectNames.length === 0 && (
          <p className="field-hint">Todavía nadie tiene un contrato activo.</p>
        )}
        {projectNames.map((name) => (
          <label key={name} className="filter-check">
            <input
              type="checkbox"
              checked={filters.projects.includes(name)}
              onChange={() => toggleProject(name)}
            />
            <span>{name}</span>
          </label>
        ))}
        {projectNames.length > 0 && (
          <span className="field-hint">
            Según los contratos vigentes de cada cliente.
          </span>
        )}
      </div>

      <div className="filter-section">
        <p className="menu-title">Cliente desde</p>
        <div className="filter-range">
          <input
            type="number"
            inputMode="numeric"
            min="1900"
            max="2200"
            step="1"
            placeholder="Desde"
            value={sinceFromText}
            onChange={(event) => {
              setSinceFromText(event.target.value);
              commitSince("from", event.target.value);
            }}
          />
          <input
            type="number"
            inputMode="numeric"
            min="1900"
            max="2200"
            step="1"
            placeholder="Hasta"
            value={sinceToText}
            onChange={(event) => {
              setSinceToText(event.target.value);
              commitSince("to", event.target.value);
            }}
          />
        </div>
        <span className="field-hint">El año en que la persona entró a la cartera.</span>
      </div>
    </>
  );

  return (
    <div className="lots-toolbar">
      <div className="toolbar">
        <span className="result-count">
          Mostrando {shownCount} de {totalCount} cliente{totalCount === 1 ? "" : "s"}
        </span>

        <div className="toolbar-spacer" />

        {/* The placeholder names the two things people actually type. What else
            it searches — teléfono, identidad, dirección, notas — is on the
            tooltip: a box wide enough to list all six would not fit beside the
            chips, and nobody reads a placeholder that long anyway. */}
        <div className="table-search">
          <IconSearch />
          <input
            type="search"
            value={search}
            placeholder="Buscar cliente o lote…"
            aria-label="Buscar cliente"
            title="Busca por nombre, teléfono, identidad, dirección, notas, lote o contrato"
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>

        <div className="menu-anchor" ref={sortRef}>
          <button
            type="button"
            className="chip menu-trigger"
            aria-expanded={openMenu === "sort"}
            onClick={() => setOpenMenu(openMenu === "sort" ? null : "sort")}
          >
            <IconSort />
            <span>
              {sortOption.label}
              <span className="menu-trigger-detail">
                {sort.direction === "asc" ? sortOption.ascLabel : sortOption.descLabel}
              </span>
            </span>
          </button>

          <MenuSurface
            isOpen={openMenu === "sort"}
            title="Ordenar por"
            onClose={() => setOpenMenu(null)}
          >
            <p className="menu-title desktop-only">Ordenar por</p>
            {SORT_OPTIONS.map((option) => {
              const isCurrent = option.field === sort.field;

              return (
                <button
                  key={option.field}
                  type="button"
                  aria-checked={isCurrent}
                  role="menuitemradio"
                  className={isCurrent ? "menu-item selected" : "menu-item"}
                  onClick={() => setSortField(option.field)}
                >
                  <span>{option.label}</span>
                  <span className="menu-item-detail">
                    {isCurrent
                      ? sort.direction === "asc"
                        ? option.ascLabel
                        : option.descLabel
                      : ""}
                  </span>
                </button>
              );
            })}
            <p className="menu-foot">Vuelve a elegir el mismo campo para invertir el orden.</p>
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
                  Ver {shownCount} cliente{shownCount === 1 ? "" : "s"}
                </button>
              </>
            }
          >
            {filterBody}
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
