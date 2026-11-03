import { useEffect, useRef, useState } from "react";

import { IconClose, IconFilter, IconSort } from "../../components/Icons";
import { MenuSurface } from "../../components/MenuSurface";
import { SearchBox } from "../../components/SearchBox";
import { SortMenu } from "../../components/SortMenu";
import type { SortRule } from "../../lib/sortRules";
import { useDismiss } from "../../lib/useDismiss";
import { useIsMobile } from "../../lib/viewport";
import type { AuditActor, AuditFilters } from "./api";
import { NO_AUDIT_FILTERS, fetchAuditActors } from "./api";

/** What changed, in the words of the screens it happened on. */
export const ENTITY_TYPE_LABELS: Array<{ value: string; label: string }> = [
  { value: "contract", label: "Contratos" },
  { value: "payment", label: "Pagos y recibos" },
  { value: "customer", label: "Clientes" },
  { value: "lot", label: "Lotes" },
  { value: "project", label: "Proyectos" },
  { value: "user", label: "Usuarios" },
  { value: "role", label: "Permisos" },
  { value: "exchange_rate", label: "Tasa de cambio" },
  { value: "settings", label: "Configuración" },
];

export type AuditOrder = "desc" | "asc";

const SORT_OPTIONS = [
  { field: "date" as const, label: "Fecha", ascLabel: "Más antiguos primero", descLabel: "Más recientes primero" },
];

/** "2026-10-09" as "09/10/2026", the way dates are read here. */
function shortDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

export function countActiveAuditFilters(filters: AuditFilters): number {
  return (
    (filters.actorIds.length > 0 ? 1 : 0) +
    (filters.entityTypes.length > 0 ? 1 : 0) +
    (filters.from !== "" || filters.to !== "" ? 1 : 0)
  );
}

interface AuditToolbarProps {
  filters: AuditFilters;
  onFiltersChange: (filters: AuditFilters) => void;
  order: AuditOrder;
  onOrderChange: (order: AuditOrder) => void;
  search: string;
  onSearchChange: (search: string) => void;
  /** How many changes match, or null while the first page is loading. */
  total: number | null;
}

/**
 * The Historial toolbar (#6): the same search box, sort menu and filter panel
 * as every other list. Unlike them it filters on the server, because the
 * history is read a page at a time (see AuditPage).
 */
export function AuditToolbar({
  filters,
  onFiltersChange,
  order,
  onOrderChange,
  search,
  onSearchChange,
  total,
}: AuditToolbarProps) {
  const [openMenu, setOpenMenu] = useState<"sort" | "filter" | null>(null);
  const [actors, setActors] = useState<AuditActor[]>([]);
  const sortRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  useDismiss(!isMobile && openMenu === "sort", sortRef, () => setOpenMenu(null));
  useDismiss(!isMobile && openMenu === "filter", filterRef, () => setOpenMenu(null));

  useEffect(() => {
    let current = true;
    fetchAuditActors()
      .then((result) => current && setActors(result.actors))
      // Without the list the «Quién» section is simply empty; the rest works.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  const activeCount = countActiveAuditFilters(filters);
  const option = SORT_OPTIONS[0]!;
  const rules: SortRule<"date">[] = [{ field: "date", direction: order }];

  const toggle = (key: "actorIds" | "entityTypes", value: string) =>
    onFiltersChange({
      ...filters,
      [key]: filters[key].includes(value)
        ? filters[key].filter((entry) => entry !== value)
        : [...filters[key], value],
    });

  const clearAll = () => onFiltersChange(NO_AUDIT_FILTERS);

  const chips: Array<{ key: string; label: string; clear: () => void }> = [];
  for (const id of filters.actorIds) {
    chips.push({
      key: `actor:${id}`,
      label: actors.find((actor) => actor.id === id)?.name ?? "Usuario",
      clear: () => toggle("actorIds", id),
    });
  }
  for (const type of filters.entityTypes) {
    chips.push({
      key: `type:${type}`,
      label: ENTITY_TYPE_LABELS.find((entry) => entry.value === type)?.label ?? type,
      clear: () => toggle("entityTypes", type),
    });
  }
  if (filters.from !== "" || filters.to !== "") {
    chips.push({
      key: "dates",
      label:
        filters.from !== "" && filters.to !== ""
          ? `${shortDate(filters.from)} – ${shortDate(filters.to)}`
          : filters.from !== ""
            ? `Desde ${shortDate(filters.from)}`
            : `Hasta ${shortDate(filters.to)}`,
      clear: () => onFiltersChange({ ...filters, from: "", to: "" }),
    });
  }

  const narrowed = search.trim() !== "" || activeCount > 0;

  return (
    <div className="lots-toolbar">
      <div className="toolbar">
        <span className="result-count">
          {total === null
            ? "Cargando…"
            : narrowed
              ? `${total} ${total === 1 ? "cambio coincide" : "cambios coinciden"}`
              : `${total} ${total === 1 ? "cambio" : "cambios"}`}
        </span>

        <div className="toolbar-spacer" />

        <SearchBox
          value={search}
          onChange={onSearchChange}
          placeholder="Buscar cliente, lote o contrato…"
          label="Buscar en el historial"
          title="Busca por cliente, lote, contrato, proyecto, recibo o el motivo escrito"
        />

        <div className="menu-anchor" ref={sortRef}>
          <button
            type="button"
            className="chip menu-trigger"
            aria-expanded={openMenu === "sort"}
            onClick={() => setOpenMenu(openMenu === "sort" ? null : "sort")}
          >
            <IconSort />
            <span>{order === "asc" ? option.ascLabel : option.descLabel}</span>
          </button>

          <MenuSurface
            isOpen={openMenu === "sort"}
            title="Ordenar por"
            onClose={() => setOpenMenu(null)}
            className="sort-popover"
          >
            <SortMenu
              options={SORT_OPTIONS}
              rules={rules}
              onChange={(next) => onOrderChange(next[0]?.direction ?? "desc")}
              defaultDirection={() => "desc"}
              hint="Vuelve a elegir «Fecha» para invertir el orden."
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
                  {total === null ? "Ver cambios" : `Ver ${total} ${total === 1 ? "cambio" : "cambios"}`}
                </button>
              </>
            }
          >
            <div className="filter-section">
              <p className="menu-title">Quién</p>
              {actors.length === 0 && <p className="field-hint">Nadie ha hecho cambios todavía.</p>}
              {actors.map((actor) => (
                <label key={actor.id} className="filter-check">
                  <input
                    type="checkbox"
                    checked={filters.actorIds.includes(actor.id)}
                    onChange={() => toggle("actorIds", actor.id)}
                  />
                  <span>{actor.name}</span>
                </label>
              ))}
            </div>

            <div className="filter-section">
              <p className="menu-title">Qué cambió</p>
              {ENTITY_TYPE_LABELS.map((entry) => (
                <label key={entry.value} className="filter-check">
                  <input
                    type="checkbox"
                    checked={filters.entityTypes.includes(entry.value)}
                    onChange={() => toggle("entityTypes", entry.value)}
                  />
                  <span>{entry.label}</span>
                </label>
              ))}
            </div>

            <div className="filter-section">
              <p className="menu-title">Fecha del cambio</p>
              <div className="filter-range filter-range-dates">
                <label>
                  <span>Desde</span>
                  <input
                    type="date"
                    value={filters.from}
                    onChange={(event) => onFiltersChange({ ...filters, from: event.target.value })}
                  />
                </label>
                <label>
                  <span>Hasta</span>
                  <input
                    type="date"
                    value={filters.to}
                    onChange={(event) => onFiltersChange({ ...filters, to: event.target.value })}
                  />
                </label>
              </div>
            </div>
          </MenuSurface>
        </div>
      </div>

      {chips.length > 0 && (
        <div className="active-filters">
          {chips.map((chip) => (
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
