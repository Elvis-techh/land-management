import { useMemo, useState } from "react";

import { IconEdit, IconTrash } from "../../components/Icons";
import { getInitials } from "../../lib/initials";
import { formatPhone } from "../../lib/phone";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import { buildProjectAccents } from "../../lib/projectAccent";
import type { CustomerRecord } from "../../types";
import { filterCustomers, hasActiveFilters, NO_CUSTOMER_FILTERS } from "./customerFilters";
import type { CustomerFilters } from "./customerFilters";
import { DEFAULT_SORT, sortCustomers } from "./customerSort";
import type { CustomerSort } from "./customerSort";
import { CustomerToolbar } from "./CustomerToolbar";

interface CustomersPageProps {
  customers: CustomerRecord[];
  user: User;
  onEditCustomer: (customer: CustomerRecord) => void;
  onDeleteCustomer: (customer: CustomerRecord) => void;
}

/**
 * Everything about one customer that somebody might type into the search box.
 *
 * Contract and lot numbers are in here deliberately: "who is CT-2026-014?" is
 * asked as often as "what does José have?", and both should land on the same
 * row rather than sending the user to a different screen to translate first.
 */
function haystack(customer: CustomerRecord): string {
  return [
    customer.fullName,
    customer.identification,
    customer.phone,
    formatPhone(customer.phone),
    customer.email ?? "",
    customer.address ?? "",
    customer.notes ?? "",
    ...customer.contracts.flatMap((contract) => [
      contract.contractCode,
      contract.lotCode,
      contract.projectName,
    ]),
  ]
    .join(" ")
    .toLowerCase();
}

/** The rows left after the search box, before the filter panel has its say. */
function searchCustomers(customers: CustomerRecord[], search: string): CustomerRecord[] {
  const query = search.trim().toLowerCase();

  if (query === "") {
    return customers;
  }

  // Every word has to match something, so "jose valle" narrows rather than
  // widening — which is how people expect a search box to behave.
  const words = query.split(/\s+/);

  return customers.filter((customer) => {
    const text = haystack(customer);
    return words.every((word) => text.includes(word));
  });
}

export function CustomersPage({
  customers,
  user,
  onEditCustomer,
  onDeleteCustomer,
}: CustomersPageProps) {
  // Which buttons to render. The server re-checks the same capabilities on
  // every write — hiding a button is convenience, not protection.
  const canEdit = can(user, "customer:edit");
  const canDelete = can(user, "customer:delete");
  const showActions = canEdit || canDelete;

  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<CustomerFilters>(NO_CUSTOMER_FILTERS);
  const [sort, setSort] = useState<CustomerSort>(DEFAULT_SORT);

  // Derived from state, recalculated when something it depends on changes.
  // There is no second copy of the list to keep in sync: search, filter and
  // sort are a VIEW of `customers`, exactly as on the Lotes screen.
  const visible = useMemo(
    () => sortCustomers(filterCustomers(searchCustomers(customers, search), filters), sort),
    [customers, search, filters, sort],
  );

  // Offered in the filter panel, built from the contracts people actually hold
  // so a project nobody has bought into never appears as an option that matches
  // nothing.
  const projectNames = useMemo(
    () =>
      [
        ...new Set(
          customers.flatMap((customer) =>
            customer.contracts.map((contract) => contract.projectName),
          ),
        ),
      ].sort((a, b) => a.localeCompare(b, "es")),
    [customers],
  );

  // Projects keep the same colour they have on the Lotes screen, built from the
  // full list so it does not shift as the search narrows.
  const projectAccents = useMemo(() => buildProjectAccents(projectNames), [projectNames]);

  const isNarrowed = search.trim() !== "" || hasActiveFilters(filters);

  return (
    <section className="panel active">
      <CustomerToolbar
        projectNames={projectNames}
        filters={filters}
        onFiltersChange={setFilters}
        sort={sort}
        onSortChange={setSort}
        search={search}
        onSearchChange={setSearch}
        shownCount={visible.length}
        totalCount={customers.length}
      />

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Teléfono</th>
                <th>Identidad</th>
                <th>Contratos</th>
                <th>Notas</th>
                <th className="col-actions">{showActions ? "Acciones" : ""}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((customer) => (
                <tr key={customer.id}>
                  <td>
                    <span className="holder-btn is-static">
                      <span className="holder-avatar">{getInitials(customer.fullName)}</span>
                      <span className="holder-text">
                        <span className="holder-name">{customer.fullName}</span>
                        <span className="holder-contract">
                          Cliente desde {customer.customerSince}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td className="mono">{formatPhone(customer.phone)}</td>
                  <td className="mono">{customer.identification}</td>
                  <td>
                    {/* Read from the contracts themselves on every load. There
                        is no "número de contratos" stored on a customer. */}
                    {customer.contracts.length === 0 ? (
                      <span className="holder-empty">Sin contrato activo</span>
                    ) : (
                      <span className="contract-list">
                        {customer.contracts.map((contract) => (
                          <span key={contract.contractId} className="contract-line">
                            <span className="code-badge">{contract.contractCode}</span>
                            <span
                              className={`cell-project ${
                                projectAccents.get(contract.projectName) ?? ""
                              }`}
                            >
                              <span className="project-dot" />
                              {contract.lotCode} · {contract.projectName}
                            </span>
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>
                    {customer.notes ? (
                      // Long notes are clipped to keep rows a consistent height;
                      // the whole text is on the row's tooltip and in the form.
                      <span className="cell-notes" title={customer.notes}>
                        {customer.notes}
                      </span>
                    ) : (
                      <span className="holder-empty">—</span>
                    )}
                  </td>
                  <td>
                    {showActions ? (
                      <span className="row-actions">
                        {canEdit && (
                          <button
                            type="button"
                            className="row-action"
                            onClick={() => onEditCustomer(customer)}
                            title={`Editar ${customer.fullName}`}
                            aria-label={`Editar ${customer.fullName}`}
                          >
                            <IconEdit />
                          </button>
                        )}
                        {canDelete && (
                          // Shown even for somebody holding a contract: the
                          // dialog is where the refusal is explained, and a
                          // button that quietly vanishes teaches nobody why.
                          <button
                            type="button"
                            className="row-action danger"
                            onClick={() => onDeleteCustomer(customer)}
                            title={`Eliminar a ${customer.fullName}`}
                            aria-label={`Eliminar a ${customer.fullName}`}
                          >
                            <IconTrash />
                          </button>
                        )}
                      </span>
                    ) : (
                      <span className="row-actions-locked" title="Requiere permisos">
                        —
                      </span>
                    )}
                  </td>
                </tr>
              ))}

              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="table-empty">
                    {customers.length === 0 ? (
                      "Todavía no hay clientes registrados."
                    ) : (
                      <>
                        <p>
                          {search.trim() === ""
                            ? "Ningún cliente coincide con lo que estás buscando."
                            : `Ningún cliente coincide con «${search.trim()}».`}
                        </p>
                        {/* An empty table is where a forgotten filter finally
                            shows itself, so the way out is offered right here
                            instead of leaving the user hunting for it. */}
                        {isNarrowed && (
                          <button
                            type="button"
                            className="link-btn"
                            onClick={() => {
                              setSearch("");
                              setFilters(NO_CUSTOMER_FILTERS);
                            }}
                          >
                            {search.trim() === ""
                              ? "Limpiar filtros"
                              : hasActiveFilters(filters)
                                ? "Limpiar la búsqueda y los filtros"
                                : "Limpiar la búsqueda"}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
