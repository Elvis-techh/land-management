import { useMemo, useRef, useState } from "react";

import { IconClose, IconFilter, IconSearch, IconSort } from "../../components/Icons";
import { MenuSurface } from "../../components/MenuSurface";
import { useDismiss } from "../../lib/useDismiss";
import { useIsMobile } from "../../lib/viewport";
import type { Contract, ContractStatus, PaymentHealth, SaleType } from "../../types";
import type { ContractFilters } from "./contractFilters";
import { NO_CONTRACT_FILTERS, countActiveFilters } from "./contractFilters";
import {
  HEALTH_PRESENTATION,
  KIND_LABELS,
  SALE_TYPE_LABELS,
  STATUS_PRESENTATION,
} from "./contractPresentation";
import { SORT_OPTIONS } from "./contractSort";
import type { ContractSort, SortField } from "./contractSort";

const HEALTH_ORDER: PaymentHealth[] = ["at_risk", "overdue", "due_soon", "current"];
const STATUS_ORDER: ContractStatus[] = ["active", "paid_off", "cancelled", "defaulted", "draft"];
const SALE_TYPE_ORDER: SaleType[] = ["financed", "cash", "donation"];
const KIND_ORDER: Array<Contract["kind"]> = ["contract", "reservation"];

interface ContractToolbarProps {
  projectNames: string[];
  filters: ContractFilters;
  onFiltersChange: (filters: ContractFilters) => void;
  sort: ContractSort;
  onSortChange: (sort: ContractSort) => void;
  search: string;
  onSearchChange: (search: string) => void;
  shownCount: number;
  totalCount: number;
}

/**
 * The Contratos toolbar: one search box, one sort menu, one filter panel.
 *
 * Deliberately the same object as `LotToolbar` and `CustomerToolbar`, down to
 * the removable chips underneath. These are the three tables people live in,
 * and a filter button that behaves differently on the third screen is a filter
 * button somebody has to learn three times.
 */
export function ContractToolbar({
  projectNames,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  search,
  onSearchChange,
  shownCount,
  totalCount,
}: ContractToolbarProps) {
  const [openMenu, setOpenMenu] = useState<"sort" | "filter" | null>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // On a phone these open as sheets, which bring their own backdrop and Escape
  // handling; a second outside-click listener would only fight with them.
  useDismiss(!isMobile && openMenu === "sort", sortRef, () => setOpenMenu(null));
  useDismiss(!isMobile && openMenu === "filter", filterRef, () => setOpenMenu(null));

  const activeCount = countActiveFilters(filters);
  const sortOption = SORT_OPTIONS.find((option) => option.field === sort.field) ?? SORT_OPTIONS[0]!;

  const setSortField = (field: SortField) => {
    // Picking the field already selected flips the direction — the shortcut
    // people expect from a column header, kept the same across all three tables.
    onSortChange(
      field === sort.field
        ? { field, direction: sort.direction === "asc" ? "desc" : "asc" }
        : { field, direction: field === "health" ? "desc" : "asc" },
    );
  };

  /** Add or remove one value from one of the list filters. */
  function toggle<K extends "statuses" | "health" | "saleTypes" | "kinds" | "projects">(
    key: K,
    value: ContractFilters[K][number],
  ) {
    const current = filters[key] as Array<typeof value>;
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];

    onFiltersChange({ ...filters, [key]: next });
  }

  const clearAll = () => onFiltersChange(NO_CONTRACT_FILTERS);

  /** One removable chip per applied restriction. */
  const activeChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = [];

    const push = <K extends "statuses" | "health" | "saleTypes" | "kinds" | "projects">(
      key: K,
      value: ContractFilters[K][number],
      label: string,
    ) => {
      chips.push({
        key: `${key}:${String(value)}`,
        label,
        clear: () =>
          onFiltersChange({
            ...filters,
            [key]: (filters[key] as Array<typeof value>).filter((entry) => entry !== value),
          }),
      });
    };

    for (const status of filters.statuses) {
      push("statuses", status, STATUS_PRESENTATION[status].label);
    }
    for (const health of filters.health) {
      push("health", health, HEALTH_PRESENTATION[health].label);
    }
    for (const saleType of filters.saleTypes) {
      push("saleTypes", saleType, SALE_TYPE_LABELS[saleType]);
    }
    for (const kind of filters.kinds) {
      push("kinds", kind, KIND_LABELS[kind]);
    }
    for (const project of filters.projects) {
      push("projects", project, project);
    }

    if (filters.onlyWithBalance) {
      chips.push({
        key: "balance",
        label: "Con saldo pendiente",
        clear: () => onFiltersChange({ ...filters, onlyWithBalance: false }),
      });
    }

    return chips;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const filterBody = (
    <>
      <div className="filter-section">
        <p className="menu-title">Estado de pago</p>
        {HEALTH_ORDER.map((health) => (
          <label key={health} className="filter-check">
            <input
              type="checkbox"
              checked={filters.health.includes(health)}
              onChange={() => toggle("health", health)}
            />
            <span>{HEALTH_PRESENTATION[health].label}</span>
          </label>
        ))}
        <span className="field-hint">
          Se calcula con los pagos registrados, cinco días de gracia y dos meses para el riesgo.
        </span>
      </div>

      <div className="filter-section">
        <p className="menu-title">Situación del contrato</p>
        {STATUS_ORDER.map((status) => (
          <label key={status} className="filter-check">
            <input
              type="checkbox"
              checked={filters.statuses.includes(status)}
              onChange={() => toggle("statuses", status)}
            />
            <span>{STATUS_PRESENTATION[status].label}</span>
          </label>
        ))}
        {/* The one filter that starts switched on, so it says why. */}
        <span className="field-hint">
          Nada se elimina en Lindero: los contratos cancelados siguen aquí. La lista abre en
          vigentes para que sea la cartera viva.
        </span>
      </div>

      <div className="filter-section">
        <p className="menu-title">Tipo</p>
        {SALE_TYPE_ORDER.map((saleType) => (
          <label key={saleType} className="filter-check">
            <input
              type="checkbox"
              checked={filters.saleTypes.includes(saleType)}
              onChange={() => toggle("saleTypes", saleType)}
            />
            <span>{SALE_TYPE_LABELS[saleType]}</span>
          </label>
        ))}
        {KIND_ORDER.map((kind) => (
          <label key={kind} className="filter-check">
            <input
              type="checkbox"
              checked={filters.kinds.includes(kind)}
              onChange={() => toggle("kinds", kind)}
            />
            <span>{KIND_LABELS[kind]}</span>
          </label>
        ))}
      </div>

      <div className="filter-section">
        <p className="menu-title">Proyecto</p>
        {projectNames.length === 0 && <p className="field-hint">Todavía no hay contratos.</p>}
        {projectNames.map((name) => (
          <label key={name} className="filter-check">
            <input
              type="checkbox"
              checked={filters.projects.includes(name)}
              onChange={() => toggle("projects", name)}
            />
            <span>{name}</span>
          </label>
        ))}
      </div>

      <div className="filter-section">
        <label className="filter-check">
          <input
            type="checkbox"
            checked={filters.onlyWithBalance}
            onChange={() =>
              onFiltersChange({ ...filters, onlyWithBalance: !filters.onlyWithBalance })
            }
          />
          <span>Solo con saldo pendiente</span>
        </label>
        <span className="field-hint">Esconde los contratos que ya no deben nada.</span>
      </div>
    </>
  );

  return (
    <div className="lots-toolbar">
      <div className="toolbar">
        <span className="result-count">
          Mostrando {shownCount} de {totalCount} contrato{totalCount === 1 ? "" : "s"}
        </span>

        <div className="toolbar-spacer" />

        <div className="table-search">
          <IconSearch />
          <input
            type="search"
            value={search}
            placeholder="Buscar contrato, cliente o lote…"
            aria-label="Buscar contrato"
            title="Busca por número de contrato, cliente, teléfono, lote, proyecto o notas"
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
                  Ver {shownCount} contrato{shownCount === 1 ? "" : "s"}
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
