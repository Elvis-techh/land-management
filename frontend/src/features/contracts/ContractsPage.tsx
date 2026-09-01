import { useMemo, useState } from "react";

import { IconChevronDown } from "../../components/Icons";
import { getInitials } from "../../lib/initials";
import type { MoneyView } from "../../lib/money";
import { formatMoney, formatMoneyParts, subtractMoney } from "../../lib/money";
import type { Cents } from "../../lib/money";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import { buildProjectAccents } from "../../lib/projectAccent";
import type { Contract } from "../../types";
import { ContractToolbar } from "./ContractToolbar";
import type { ContractFilters } from "./contractFilters";
import {
  DEFAULT_CONTRACT_FILTERS,
  NO_CONTRACT_FILTERS,
  filterContracts,
  hasActiveFilters,
  searchContracts,
} from "./contractFilters";
import {
  KIND_LABELS,
  SALE_TYPE_LABELS,
  formatDate,
  healthDetail,
  primaryStamp,
} from "./contractPresentation";
import type { ContractSort } from "./contractSort";
import { DEFAULT_SORT, groupByCustomer, sortContracts } from "./contractSort";

/** The empty state has to span every column. */
const COLUMN_COUNT = 7;

interface ContractsPageProps {
  contracts: Contract[];
  money: MoneyView;
  user: User;
  /** Opens the detail panel. Owned by App, since it covers the page. */
  onOpenContract: (contract: Contract) => void;
  /** Opens the split preview for a purchase of several lots. */
  onSplitPayment: (contracts: Contract[]) => void;
}

export function ContractsPage({
  contracts,
  money,
  user,
  onOpenContract,
  onSplitPayment,
}: ContractsPageProps) {
  const canRecordPayment = can(user, "payment:record");

  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<ContractFilters>(DEFAULT_CONTRACT_FILTERS);
  const [sort, setSort] = useState<ContractSort>(DEFAULT_SORT);
  // Which customers are folded shut. Everything starts open: a collapsed group
  // hides a balance, and this screen exists to show balances.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  // Derived from state, recalculated when something it depends on changes.
  // Search, filter and sort are a VIEW of `contracts`, never a second copy.
  const visible = useMemo(
    () => sortContracts(filterContracts(searchContracts(contracts, search), filters), sort),
    [contracts, search, filters, sort],
  );

  // Grouped AFTER sorting, so a group sits wherever its first contract landed
  // and "atrasados primero" still puts the worst customer at the top.
  const groups = useMemo(() => groupByCustomer(visible), [visible]);

  const projectNames = useMemo(
    () =>
      [...new Set(contracts.map((contract) => contract.lot.projectName))].sort((a, b) =>
        a.localeCompare(b, "es"),
      ),
    [contracts],
  );

  // Built from the full list so a project keeps the same colour as the filters
  // narrow, and the same colour it has on Lotes and Clientes.
  const projectAccents = useMemo(() => buildProjectAccents(projectNames), [projectNames]);

  const isNarrowed = search.trim() !== "" || hasActiveFilters(filters);

  const toggleGroup = (customerId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(customerId)) {
        next.add(customerId);
      }
      return next;
    });
  };

  const clearEverything = () => {
    setSearch("");
    setFilters(NO_CONTRACT_FILTERS);
  };

  /** The money cell used all down the table: tinted symbol, full-strength digits. */
  const moneyCell = (amount: Cents, className = "") => {
    const parts = formatMoneyParts(amount, money);

    return (
      <span className={`cell-money ${className}`}>
        <span className="currency-symbol">{parts.symbol}</span>
        {parts.value}
      </span>
    );
  };

  return (
    <section className="panel active">
      <ContractToolbar
        projectNames={projectNames}
        filters={filters}
        onFiltersChange={setFilters}
        sort={sort}
        onSortChange={setSort}
        search={search}
        onSearchChange={setSearch}
        shownCount={visible.length}
        totalCount={contracts.length}
      />

      <div className="card">
        <div className="table-wrap contracts-desktop">
          <table className="contracts-table">
            <thead>
              <tr>
                <th>Contrato</th>
                <th>Cliente</th>
                <th>Lote</th>
                {/* Price and prima share a column: the prima is a PART of the
                    price, not a peer of it, and giving it a column of its own
                    pushed the payment health off a 1440px screen. */}
                <th className="col-money">Precio · prima</th>
                <th className="col-money">Saldo</th>
                <th className="col-money">Mensual</th>
                <th>Estado</th>
              </tr>
            </thead>

            {/* One <tbody> per customer rather than one for the whole table.
                A table may hold several row groups, and that is exactly what a
                customer with three lots is — which also gives the group header
                and its rows a single element to be styled and folded by. */}
            {groups.map((group) => {
                const isGrouped = group.contracts.length > 1;
                const isCollapsed = collapsed.has(group.customerId);
                const stamp = primaryStamp(group.worst);

                return (
                  <tbody key={group.customerId} className="contract-group">
                    {isGrouped && (
                      <tr className="group-row">
                        <td colSpan={3}>
                          <button
                            type="button"
                            className={isCollapsed ? "group-toggle" : "group-toggle open"}
                            onClick={() => toggleGroup(group.customerId)}
                            aria-expanded={!isCollapsed}
                          >
                            <IconChevronDown />
                            <span className="holder-avatar">
                              {getInitials(group.customerName)}
                            </span>
                            <span className="holder-text">
                              <span className="holder-name">{group.customerName}</span>
                              <span className="holder-contract">
                                {group.contracts.length} contratos
                                {/* One signature and one receipt, versus lots
                                    bought years apart by the same person. The
                                    split only makes sense for the first. */}
                                {group.isOnePurchase ? " · una sola compra" : ""}
                              </span>
                            </span>
                          </button>

                          {group.isOnePurchase && canRecordPayment && (
                            <button
                              type="button"
                              className="link-btn group-split"
                              onClick={(event) => {
                                event.stopPropagation();
                                onSplitPayment(group.contracts);
                              }}
                            >
                              Repartir pago
                            </button>
                          )}
                        </td>
                        <td className="col-money">
                          {moneyCell(group.totalPrice, "is-total")}
                          <span className="cell-sub">
                            prima {formatMoney(group.totalDownPayment, money)}
                          </span>
                        </td>
                        <td className="col-money">{moneyCell(group.totalBalance, "is-total")}</td>
                        <td className="col-money">{moneyCell(group.totalMonthly, "is-total")}</td>
                        <td>
                          <span className={stamp.stampClass}>{stamp.label}</span>
                        </td>
                      </tr>
                    )}

                    {(!isGrouped || !isCollapsed) &&
                      group.contracts.map((contract) => {
                        const rowStamp = primaryStamp(contract);
                        const detail = healthDetail(contract);
                        const accent = projectAccents.get(contract.lot.projectName) ?? "";

                        return (
                          <tr
                            key={contract.id}
                            className={isGrouped ? "contract-row is-grouped" : "contract-row"}
                            onClick={() => onOpenContract(contract)}
                          >
                            <td>
                              {/* The row is clickable for the mouse, but a
                                  <tr> is not reachable by keyboard. This button
                                  is the real control, so tabbing through the
                                  table still opens each contract. */}
                              <button
                                type="button"
                                className="contract-open"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onOpenContract(contract);
                                }}
                                title={`Ver el contrato ${contract.code}`}
                              >
                                <span className="code-badge">{contract.code}</span>
                                <span className="contract-kind">
                                  {KIND_LABELS[contract.kind]} ·{" "}
                                  {SALE_TYPE_LABELS[contract.saleType]}
                                </span>
                              </button>
                            </td>
                            <td>
                              {/* Repeating the name inside a group would be
                                  noise: the header above already says it — so
                                  a grouped row spends the cell on its note
                                  instead, beside the arrow. The note belongs to
                                  the CONTRACT, not the person, so three lots
                                  bought together can each carry their own. */}
                              {isGrouped ? (
                                <span className="holder-btn is-static">
                                  <span className="holder-empty">↳</span>
                                  {contract.notes && (
                                    <span className="contract-note">{contract.notes}</span>
                                  )}
                                </span>
                              ) : (
                                <span className="holder-btn is-static">
                                  <span className="holder-avatar">
                                    {getInitials(contract.customer.fullName)}
                                  </span>
                                  <span className="holder-text">
                                    <span className="holder-name">
                                      {contract.customer.fullName}
                                    </span>
                                    {/* Under the name rather than in a column
                                        of its own: notes run to a sentence, and
                                        a seventh column would push the payment
                                        health — the reason this screen exists —
                                        off a 1440px screen. It wraps onto as
                                        many lines as it needs rather than
                                        ending in a silent "…", so the row is
                                        allowed to grow with a long note. */}
                                    {contract.notes && (
                                      <span className="contract-note">{contract.notes}</span>
                                    )}
                                  </span>
                                </span>
                              )}
                            </td>
                            <td>
                              {/* Stacked rather than "A-07 · Proyecto Santiago
                                  Etapa 1" on one line: a project name that long
                                  in a nine-column table pushed the payment
                                  health — the column this screen exists for —
                                  off the right edge of a 1440px screen. */}
                              <span className="contract-lot">
                                <span className="code-badge">{contract.lot.code}</span>
                                <span className={`cell-project cell-sub ${accent}`}>
                                  <span className="project-dot" />
                                  {contract.lot.projectName}
                                </span>
                              </span>
                            </td>
                            <td className="col-money">
                              {moneyCell(contract.terms.salePrice)}
                              {/* The prima that was AGREED and the prima that
                                  arrived are different facts. The sub-line says
                                  which, so a customer who signed and never came
                                  back cannot hide behind a figure that only
                                  describes the paperwork. */}
                              {contract.terms.downPayment > 0 && (
                                <span
                                  className={
                                    contract.downPaymentPaid < contract.terms.downPayment
                                      ? "cell-sub warn"
                                      : "cell-sub"
                                  }
                                >
                                  prima {formatMoney(contract.terms.downPayment, money)}
                                  {contract.downPaymentPaid < contract.terms.downPayment &&
                                    (contract.downPaymentPaid === 0
                                      ? " · sin cobrar"
                                      : ` · faltan ${formatMoney(
                                          subtractMoney(
                                            contract.terms.downPayment,
                                            contract.downPaymentPaid,
                                          ),
                                          money,
                                        )}`)}
                                </span>
                              )}
                            </td>
                            <td className="col-money">
                              {moneyCell(contract.balance, "is-balance")}
                            </td>
                            <td className="col-money">
                              {contract.terms.monthlyPayment === null ? (
                                <span className="holder-empty">—</span>
                              ) : (
                                <>
                                  {moneyCell(contract.terms.monthlyPayment)}
                                  <span className="cell-sub">día {contract.terms.dueDay}</span>
                                </>
                              )}
                            </td>
                            <td>
                              <span className={rowStamp.stampClass}>{rowStamp.label}</span>
                              {detail !== "" && <span className="cell-sub">{detail}</span>}
                              {contract.health.nextDueOn && detail === "" && (
                                <span className="cell-sub">
                                  vence {formatDate(contract.health.nextDueOn)}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                );
            })}

            {visible.length === 0 && (
              <tbody>
                <tr>
                  <td colSpan={COLUMN_COUNT} className="table-empty">
                    {contracts.length === 0 ? (
                      "Todavía no hay contratos registrados."
                    ) : (
                      <>
                        <p>
                          {search.trim() === ""
                            ? "Ningún contrato coincide con los filtros."
                            : `Ningún contrato coincide con «${search.trim()}».`}
                        </p>
                        {/* An empty table is where a forgotten filter finally
                            shows itself — and this screen opens with one on, so
                            the way out has to be offered right here. */}
                      {isNarrowed && (
                        <button type="button" className="link-btn" onClick={clearEverything}>
                          Limpiar la búsqueda y los filtros
                        </button>
                      )}
                    </>
                  )}
                  </td>
                </tr>
              </tbody>
            )}
          </table>
        </div>

        {/*
          The phone view. A nine-column table on a 360px screen is a table
          nobody reads, so the same rows are rebuilt as cards that lead with the
          two things being looked for: who, and how much do they owe.
        */}
        <div className="contracts-cards">
          {groups.map((group) => (
            <div key={group.customerId} className="contract-card-group">
              {group.contracts.length > 1 && (
                <div className="contract-card-head">
                  <span className="holder-avatar">{getInitials(group.customerName)}</span>
                  <div className="holder-text">
                    <span className="holder-name">{group.customerName}</span>
                    <span className="holder-contract">
                      {group.contracts.length} contratos · saldo{" "}
                      {formatMoney(group.totalBalance, money)}
                    </span>
                  </div>
                </div>
              )}

              {group.contracts.map((contract) => {
                const stamp = primaryStamp(contract);
                const detail = healthDetail(contract);
                const isGrouped = group.contracts.length > 1;

                return (
                  <button
                    key={contract.id}
                    type="button"
                    className="contract-card"
                    onClick={() => onOpenContract(contract)}
                  >
                    <div className="contract-card-top">
                      <span className="code-badge">{contract.code}</span>
                      <span className={stamp.stampClass}>{stamp.label}</span>
                    </div>

                    {/* Inside a group the header above already names the
                        person, so the card leads with the lot instead of
                        repeating them three times down the screen. */}
                    {isGrouped ? (
                      <p className="contract-card-name">{contract.lot.code}</p>
                    ) : (
                      <>
                        <p className="contract-card-name">{contract.customer.fullName}</p>
                        <p className="contract-card-lot">
                          {contract.lot.code} · {contract.lot.projectName}
                        </p>
                      </>
                    )}
                    {isGrouped && <p className="contract-card-lot">{contract.lot.projectName}</p>}

                    <div className="contract-card-balance">
                      <span>Saldo</span>
                      <strong>{formatMoney(contract.balance, money)}</strong>
                    </div>

                    <p className="contract-card-foot">
                      {contract.terms.monthlyPayment === null
                        ? SALE_TYPE_LABELS[contract.saleType]
                        : `${formatMoney(contract.terms.monthlyPayment, money)} · día ${
                            contract.terms.dueDay
                          }`}
                      {detail !== "" ? ` · ${detail}` : ""}
                    </p>

                    {/* Not clamped here. A card has the width the table cell
                        does not, and a phone is exactly where somebody is
                        reading the note before making the call. */}
                    {contract.notes && (
                      <p className="contract-card-note">{contract.notes}</p>
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {visible.length === 0 && (
            <p className="state-message">
              {contracts.length === 0
                ? "Todavía no hay contratos registrados."
                : "Ningún contrato coincide con los filtros."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
