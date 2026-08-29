import { useMemo, useRef, useState } from "react";

import { IconClose, IconFilter, IconSort } from "../../components/Icons";
import { MenuSurface } from "../../components/MenuSurface";
import { MoneyInput } from "../../components/MoneyInput";
import { AREA_UNIT_INFO, fromSquareMetres, toSquareMetres } from "../../lib/area";
import type { AreaUnit } from "../../lib/area";
import { formatMoney, fromCurrencyUnits, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { MoneyView } from "../../lib/money";
import { useDismiss } from "../../lib/useDismiss";
import { useIsMobile } from "../../lib/viewport";
import type { LotStatus } from "../../types";
import type { LotFilters } from "./lotFilters";
import { NO_FILTERS, countActiveFilters } from "./lotFilters";
import { SORT_OPTIONS } from "./lotSort";
import type { LotSort, SortField } from "./lotSort";

/** The wording used everywhere else for each status. */
const STATUS_LABELS: Array<{ value: LotStatus; label: string }> = [
  { value: "available", label: "Disponibles" },
  { value: "reserved", label: "Reservados" },
  { value: "sold", label: "Vendidos" },
];

interface LotToolbarProps {
  /** Every project present in the inventory, for the project checkboxes. */
  projectNames: string[];
  /** Used to label the area range in a unit the user actually works in. */
  unitByProject: Map<string, AreaUnit>;
  money: MoneyView;
  filters: LotFilters;
  onFiltersChange: (filters: LotFilters) => void;
  sort: LotSort;
  onSortChange: (sort: LotSort) => void;
  /** For the "Mostrando X de Y" count. */
  shownCount: number;
  totalCount: number;
}

/**
 * The Lotes toolbar: one sort menu, one filter panel.
 *
 * Status used to sit outside as its own row of chips, which meant it could not
 * be combined with anything — picking a project threw away the status, and the
 * two controls quietly competed. Inside the panel it is just another
 * restriction, so "los disponibles de Valle Verde" is one question.
 *
 * Everything applied is repeated underneath as a removable chip. A filter you
 * cannot see is a filter you forget you set, and then the list looks wrong for
 * reasons nobody can find.
 */
export function LotToolbar({
  projectNames,
  unitByProject,
  money,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  shownCount,
  totalCount,
}: LotToolbarProps) {
  const [openMenu, setOpenMenu] = useState<"sort" | "filter" | null>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // On a phone these open as sheets, which bring their own backdrop and Escape
  // handling; a second outside-click listener would only fight with them.
  useDismiss(!isMobile && openMenu === "sort", sortRef, () => setOpenMenu(null));
  useDismiss(!isMobile && openMenu === "filter", filterRef, () => setOpenMenu(null));

  /**
   * The unit the area range is typed in.
   *
   * With exactly one project selected, that project's unit — someone filtering
   * Monte Real thinks in varas, not metres. Otherwise square metres, because a
   * range spanning projects written in different units has no other honest
   * unit to be in.
   */
  const areaUnit: AreaUnit =
    filters.projects.length === 1 ? (unitByProject.get(filters.projects[0]!) ?? "m2") : "m2";
  const areaUnitInfo = AREA_UNIT_INFO[areaUnit];

  // Money and area are edited as text and converted on change, so the fields
  // keep whatever the user typed rather than snapping under their cursor.
  const [minPriceText, setMinPriceText] = useState(() =>
    filters.minPrice === null ? "" : toMoneyInput(filters.minPrice),
  );
  const [maxPriceText, setMaxPriceText] = useState(() =>
    filters.maxPrice === null ? "" : toMoneyInput(filters.maxPrice),
  );
  const [minAreaText, setMinAreaText] = useState("");
  const [maxAreaText, setMaxAreaText] = useState("");

  const activeCount = countActiveFilters(filters);
  const sortOption = SORT_OPTIONS.find((option) => option.field === sort.field) ?? SORT_OPTIONS[0]!;

  const setSortField = (field: SortField) => {
    // Picking the field already selected flips the direction — the shortcut
    // people expect from a column header, kept here so the menu behaves the
    // same way.
    onSortChange(
      field === sort.field
        ? { field, direction: sort.direction === "asc" ? "desc" : "asc" }
        : { field, direction: "asc" },
    );
  };

  const toggleStatus = (value: LotStatus) => {
    const next = filters.statuses.includes(value)
      ? filters.statuses.filter((status) => status !== value)
      : [...filters.statuses, value];

    onFiltersChange({ ...filters, statuses: next });
  };

  const toggleProject = (name: string) => {
    const next = filters.projects.includes(name)
      ? filters.projects.filter((project) => project !== name)
      : [...filters.projects, name];

    onFiltersChange({ ...filters, projects: next });
  };

  const commitPrice = (which: "min" | "max", text: string) => {
    const value = parseMoneyInput(text);
    const amount = Number.isFinite(value) && value >= 0 ? fromCurrencyUnits(value) : null;

    onFiltersChange({ ...filters, [which === "min" ? "minPrice" : "maxPrice"]: amount });
  };

  const commitArea = (which: "min" | "max", text: string) => {
    const value = Number(text);
    const areaM2 =
      text.trim() !== "" && Number.isFinite(value) && value >= 0
        ? toSquareMetres(value, areaUnit)
        : null;

    onFiltersChange({ ...filters, [which === "min" ? "minAreaM2" : "maxAreaM2"]: areaM2 });
  };

  const clearAll = () => {
    setMinPriceText("");
    setMaxPriceText("");
    setMinAreaText("");
    setMaxAreaText("");
    onFiltersChange(NO_FILTERS);
  };

  /** One removable chip per applied restriction. */
  const activeChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = [];

    for (const status of filters.statuses) {
      chips.push({
        key: `status:${status}`,
        label: STATUS_LABELS.find((option) => option.value === status)?.label ?? status,
        clear: () =>
          onFiltersChange({
            ...filters,
            statuses: filters.statuses.filter((value) => value !== status),
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

    if (filters.minPrice !== null || filters.maxPrice !== null) {
      const from = filters.minPrice === null ? null : formatMoney(filters.minPrice, money);
      const to = filters.maxPrice === null ? null : formatMoney(filters.maxPrice, money);

      chips.push({
        key: "price",
        label: from && to ? `${from} – ${to}` : from ? `Desde ${from}` : `Hasta ${to}`,
        clear: () => {
          setMinPriceText("");
          setMaxPriceText("");
          onFiltersChange({ ...filters, minPrice: null, maxPrice: null });
        },
      });
    }

    if (filters.minAreaM2 !== null || filters.maxAreaM2 !== null) {
      const show = (value: number) =>
        `${Number(fromSquareMetres(value, areaUnit).toFixed(areaUnitInfo.decimals))} ${areaUnitInfo.symbol}`;
      const from = filters.minAreaM2 === null ? null : show(filters.minAreaM2);
      const to = filters.maxAreaM2 === null ? null : show(filters.maxAreaM2);

      chips.push({
        key: "area",
        label: from && to ? `${from} – ${to}` : from ? `Desde ${from}` : `Hasta ${to}`,
        clear: () => {
          setMinAreaText("");
          setMaxAreaText("");
          onFiltersChange({ ...filters, minAreaM2: null, maxAreaM2: null });
        },
      });
    }

    return chips;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, money, areaUnit, areaUnitInfo]);

  const filterBody = (
    <>
      <div className="filter-section">
        <p className="menu-title">Estado</p>
        {STATUS_LABELS.map((option) => (
          <label key={option.value} className="filter-check">
            <input
              type="checkbox"
              checked={filters.statuses.includes(option.value)}
              onChange={() => toggleStatus(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
        {filters.statuses.length === 0 && (
          <p className="field-hint">Sin marcar ninguno se muestran todos.</p>
        )}
      </div>

      <div className="filter-section">
        <p className="menu-title">Proyecto</p>
        {projectNames.length === 0 && <p className="field-hint">No hay proyectos.</p>}
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
      </div>

      <div className="filter-section">
        <p className="menu-title">Precio base</p>
        <div className="filter-range">
          <MoneyInput
            id="filter-min-price"
            value={minPriceText}
            placeholder="Desde"
            onChange={(next) => {
              setMinPriceText(next);
              commitPrice("min", next);
            }}
          />
          <MoneyInput
            id="filter-max-price"
            value={maxPriceText}
            placeholder="Hasta"
            onChange={(next) => {
              setMaxPriceText(next);
              commitPrice("max", next);
            }}
          />
        </div>
        <span className="field-hint">Siempre en lempiras, como se capturan.</span>
      </div>

      <div className="filter-section">
        <p className="menu-title">Área</p>
        <div className="filter-range">
          <div className="input-with-suffix">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              placeholder="Desde"
              value={minAreaText}
              onChange={(event) => {
                setMinAreaText(event.target.value);
                commitArea("min", event.target.value);
              }}
            />
            <span className="unit-suffix">{areaUnitInfo.symbol}</span>
          </div>
          <div className="input-with-suffix">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              placeholder="Hasta"
              value={maxAreaText}
              onChange={(event) => {
                setMaxAreaText(event.target.value);
                commitArea("max", event.target.value);
              }}
            />
            <span className="unit-suffix">{areaUnitInfo.symbol}</span>
          </div>
        </div>
        <span className="field-hint">
          {filters.projects.length === 1
            ? `En ${areaUnitInfo.label.toLowerCase()}, la unidad de ${filters.projects[0]}.`
            : "En metros cuadrados, la unidad en que se guardan todas las áreas."}
        </span>
      </div>
    </>
  );

  return (
    <div className="lots-toolbar">
      <div className="toolbar">
        <span className="result-count">
          Mostrando {shownCount} de {totalCount} lote{totalCount === 1 ? "" : "s"}
        </span>

        <div className="toolbar-spacer" />

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
                  Ver {shownCount} lote{shownCount === 1 ? "" : "s"}
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
