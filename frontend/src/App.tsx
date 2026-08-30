import { useCallback, useEffect, useRef, useState } from "react";

import { PlaceholderPage } from "./components/PlaceholderPage";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { AuditPage } from "./features/audit/AuditPage";
import { CustomerDeleteDialog } from "./features/customers/CustomerDeleteDialog";
import { CustomerFormDialog } from "./features/customers/CustomerFormDialog";
import { CustomerPanel } from "./features/customers/CustomerPanel";
import { CustomersPage } from "./features/customers/CustomersPage";
import { createCustomer, deleteCustomer, updateCustomer } from "./features/customers/api";
import type { CustomerDraft } from "./features/customers/api";
import { useCustomers } from "./features/customers/useCustomers";
import { ContractCancelDialog } from "./features/contracts/ContractCancelDialog";
import { ContractCreateDialog } from "./features/contracts/ContractCreateDialog";
import { ContractEditDialog } from "./features/contracts/ContractEditDialog";
import { ContractPanel } from "./features/contracts/ContractPanel";
import { ContractsPage } from "./features/contracts/ContractsPage";
import { SplitPreviewDialog } from "./features/contracts/SplitPreviewDialog";
import { cancelContract, createContract, updateContract } from "./features/contracts/api";
import type { ContractCreateDraft, ContractTermsDraft } from "./features/contracts/api";
import { useContracts } from "./features/contracts/useContracts";
import { LoginPage } from "./features/auth/LoginPage";
import { authApi } from "./features/auth/api";
import { LotArchiveDialog } from "./features/lots/LotArchiveDialog";
import { LotCreateDialog } from "./features/lots/LotCreateDialog";
import { LotEditDialog } from "./features/lots/LotEditDialog";
import { LotsPage } from "./features/lots/LotsPage";
import { ProjectArchiveDialog } from "./features/projects/ProjectArchiveDialog";
import { ProjectFormDialog } from "./features/projects/ProjectFormDialog";
import { ProjectsPage } from "./features/projects/ProjectsPage";
import {
  archiveProject,
  createProject,
  restoreProject,
  updateProject,
} from "./features/projects/api";
import { useProjects } from "./features/projects/useProjects";
import { PermissionsPage } from "./features/permissions/PermissionsPage";
import { NewReceiptDialog } from "./features/receipts/NewReceiptDialog";
import { ReceiptVoidDialog } from "./features/receipts/ReceiptVoidDialog";
import { ReceiptsPage } from "./features/receipts/ReceiptsPage";
import { TransactionEditDialog } from "./features/receipts/TransactionEditDialog";
import { useTransactions } from "./features/receipts/useTransactions";
import { useExchangeRate } from "./features/rate/useExchangeRate";
import { archiveLot, createLot, updateLot } from "./features/lots/api";
import { useLots } from "./features/lots/useLots";
import { ApiError } from "./lib/api";
import type { Currency, MoneyView } from "./lib/money";
import type { User } from "./lib/permissions";
import { isMobileViewport } from "./lib/viewport";
import { can } from "./lib/permissions";
import type { AreaUnit } from "./lib/area";
import type { Contract, CustomerRecord, Lot, Project, Receipt, TabId, Transaction } from "./types";

const pageTitles: Record<TabId, string> = {
  dashboard: "Panel general",
  lots: "Lotes",
  projects: "Proyectos",
  contracts: "Contratos",
  customers: "Clientes",
  receipts: "Recibos",
  audit: "Historial",
  permissions: "Permisos",
};

const primaryActionLabels: Record<TabId, string> = {
  dashboard: "Nuevo contrato",
  lots: "Nuevo lote",
  projects: "Nuevo proyecto",
  contracts: "Nuevo contrato",
  customers: "Nuevo cliente",
  receipts: "Nueva transacción",
  audit: "Nuevo lote",
  permissions: "Nuevo lote",
};

/**
 * Should clicking outside the sidebar hide it on a DESKTOP screen?
 * Phones always behave this way. Set to `false` if it feels too eager on a
 * large screen; the close button and the hamburger are unaffected.
 */
const CLOSE_ON_OUTSIDE_CLICK_ON_DESKTOP = true;

/** Which customer the quick-look panel is showing, and from which lot. */
interface CustomerSelection {
  customerId: string;
  lot: Lot;
}

type Session =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "signed-in"; user: User };

export default function App() {
  // On load, ask the server whether this browser already has a valid session
  // cookie. This is what keeps you signed in after a refresh.
  const [session, setSession] = useState<Session>({ status: "checking" });

  useEffect(() => {
    authApi
      .me()
      .then((user) => setSession({ status: "signed-in", user }))
      .catch(() => setSession({ status: "anonymous" }));
  }, []);

  const [activeTab, setActiveTab] = useState<TabId>("lots");
  const [currency, setCurrency] = useState<Currency>("HNL");
  const [isSidebarOpen, setSidebarOpen] = useState(() => !isMobileViewport());
  const [customerSelection, setCustomerSelection] = useState<CustomerSelection | null>(null);
  const [lotBeingEdited, setLotBeingEdited] = useState<Lot | null>(null);
  const [lotBeingArchived, setLotBeingArchived] = useState<Lot | null>(null);
  const [isCreatingLot, setCreatingLot] = useState(false);
  // `null` in `projectBeingEdited` means the form is creating rather than
  // editing, so the two states have to be kept apart.
  const [isProjectFormOpen, setProjectFormOpen] = useState(false);
  const [projectBeingEdited, setProjectBeingEdited] = useState<Project | null>(null);
  const [projectBeingArchived, setProjectBeingArchived] = useState<Project | null>(null);
  // As with the project form, `null` in `customerBeingEdited` means the form is
  // creating rather than editing, so the two states are kept apart.
  const [isCustomerFormOpen, setCustomerFormOpen] = useState(false);
  const [customerBeingEdited, setCustomerBeingEdited] = useState<CustomerRecord | null>(null);
  const [customerBeingDeleted, setCustomerBeingDeleted] = useState<CustomerRecord | null>(null);
  const [isCreatingContract, setCreatingContract] = useState(false);
  const [isCreatingReceipt, setCreatingReceipt] = useState(false);
  const [receiptBeingVoided, setReceiptBeingVoided] = useState<Receipt | null>(null);
  const [transactionBeingEdited, setTransactionBeingEdited] = useState<Transaction | null>(null);
  const [contractBeingViewed, setContractBeingViewed] = useState<Contract | null>(null);
  const [contractBeingEdited, setContractBeingEdited] = useState<Contract | null>(null);
  const [contractBeingCancelled, setContractBeingCancelled] = useState<Contract | null>(null);
  // The lots of ONE purchase, while their split is being previewed.
  const [contractsBeingSplit, setContractsBeingSplit] = useState<Contract[] | null>(null);

  const isSignedIn = session.status === "signed-in";
  const { state: lotsState, reload: reloadLots } = useLots(isSignedIn);
  const { state: projectsState, reload: reloadProjects } = useProjects(isSignedIn);
  const { state: customersState, reload: reloadCustomers } = useCustomers(isSignedIn);
  const { state: contractsState, reload: reloadContracts } = useContracts(isSignedIn);
  const { state: transactionsState, reload: reloadTransactions } = useTransactions(isSignedIn);
  const { rate, setRate } = useExchangeRate(isSignedIn);

  // Currency and rate travel together, so a component cannot format money with
  // one and forget the other.
  const money: MoneyView = { currency, usdRate: rate.rate };

  const sidebarRef = useRef<HTMLElement>(null);

  // If the session expires while the app is open, any request will come back
  // 401. Drop straight to the login screen rather than showing stale data.
  const handleApiError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.isUnauthenticated) {
      setSession({ status: "anonymous" });
    }
    throw error;
  }, []);

  useEffect(() => {
    if (!isSidebarOpen || !isSignedIn) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (sidebarRef.current?.contains(target)) {
        return;
      }
      if (target.closest(".menu-btn") || target.closest(".modal-backdrop")) {
        return;
      }
      if (!isMobileViewport() && !CLOSE_ON_OUTSIDE_CLICK_ON_DESKTOP) {
        return;
      }

      setSidebarOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isSidebarOpen, isSignedIn]);

  if (session.status === "checking") {
    return <div className="app-booting">Cargando…</div>;
  }

  if (session.status === "anonymous") {
    return <LoginPage onSignedIn={(user) => setSession({ status: "signed-in", user })} />;
  }

  const { user } = session;

  const handleSelectTab = (tab: TabId) => {
    setActiveTab(tab);
    if (isMobileViewport()) {
      setSidebarOpen(false);
    }
  };

  const handleSignOut = async () => {
    await authApi.logout().catch(() => undefined);
    setSession({ status: "anonymous" });
  };

  const handleSaveLot = async (changes: {
    code: string;
    projectName: string;
    areaM2: number;
    basePriceCents: number;
    reason?: string;
  }) => {
    if (!lotBeingEdited) {
      return;
    }

    await updateLot(lotBeingEdited.id, changes).catch(handleApiError);

    // Re-read from the server rather than patching the local list. Lot status
    // and paid-to-date are derived server-side, so only the server knows the
    // true result of a write.
    await reloadLots();
    setLotBeingEdited(null);
  };

  const openProjectForm = (project: Project | null) => {
    setProjectBeingEdited(project);
    setProjectFormOpen(true);
  };

  const closeProjectForm = () => {
    setProjectFormOpen(false);
    setProjectBeingEdited(null);
  };

  const handleSaveProject = async (draft: { name: string; areaUnit: AreaUnit }) => {
    if (projectBeingEdited) {
      await updateProject(projectBeingEdited.id, draft).catch(handleApiError);
    } else {
      await createProject(draft).catch(handleApiError);
    }

    await reloadProjects();
    // The lots screen names projects and shows areas in their units, so it is
    // stale the moment a project is renamed or re-united.
    await reloadLots();
    closeProjectForm();
  };

  const handleArchiveProject = async (reason: string) => {
    if (!projectBeingArchived) {
      return;
    }

    await archiveProject(projectBeingArchived.id, reason).catch(handleApiError);
    await reloadProjects();
    await reloadLots();
    setProjectBeingArchived(null);
  };

  const handleRestoreProject = async (project: Project) => {
    await restoreProject(project.id).catch(handleApiError);
    await reloadProjects();
    await reloadLots();
  };

  const openCustomerForm = (customer: CustomerRecord | null) => {
    setCustomerBeingEdited(customer);
    setCustomerFormOpen(true);
  };

  const closeCustomerForm = () => {
    setCustomerFormOpen(false);
    setCustomerBeingEdited(null);
  };

  const handleSaveCustomer = async (draft: CustomerDraft) => {
    if (customerBeingEdited) {
      await updateCustomer(customerBeingEdited.id, draft).catch(handleApiError);
    } else {
      await createCustomer(draft).catch(handleApiError);
    }

    await reloadCustomers();
    // The lots table names the customer holding each lot, so it goes stale the
    // moment somebody is renamed.
    await reloadLots();
    closeCustomerForm();
  };

  const handleDeleteCustomer = async (reason: string) => {
    if (!customerBeingDeleted) {
      return;
    }

    await deleteCustomer(customerBeingDeleted.id, reason).catch(handleApiError);

    await reloadCustomers();
    // A deleted customer can never have held a lot — the server refuses
    // otherwise — but the Lotes table also names them, so it is re-read for the
    // same reason a rename forces it: nothing on screen should outlive the row.
    await reloadLots();
    setCustomerBeingDeleted(null);
  };

  const handleSaveContract = async (draft: ContractTermsDraft) => {
    if (!contractBeingEdited) {
      return;
    }

    await updateContract(contractBeingEdited.id, draft).catch(handleApiError);

    // Re-read rather than patch: the balance, the arrears, the payment health
    // and the next due date are all recomputed server-side from the terms that
    // just changed, so only the server knows what this edit actually did.
    await reloadContracts();
    // A reservation that became a contract changes what the Lotes table says
    // about the lot, and a new sale price changes the customer's holdings.
    await reloadLots();
    await reloadCustomers();
    setContractBeingEdited(null);
    // The panel underneath is now showing the terms as they were before the
    // save. Close it rather than leave a stale copy on screen.
    setContractBeingViewed(null);
  };

  const handleCancelContract = async (reason: string) => {
    if (!contractBeingCancelled) {
      return;
    }

    await cancelContract(contractBeingCancelled.id, reason).catch(handleApiError);

    await reloadContracts();
    // Cancelling releases the lot, and the Lotes table derives availability
    // from active contracts — so it is wrong on screen until it is re-read.
    await reloadLots();
    await reloadCustomers();
    setContractBeingCancelled(null);
    setContractBeingViewed(null);
  };

  const handleCreateContract = async (draft: ContractCreateDraft) => {
    await createContract(draft).catch(handleApiError);

    // All three lists move, and none of them can be patched by hand. The new
    // contract carries a balance and a payment health only the server computes;
    // the lot it names has just left the available inventory; and the customer
    // is now holding something they were not holding a second ago.
    await reloadContracts();
    await reloadLots();
    await reloadCustomers();
    setCreatingContract(false);
  };

  const handleCreateLot = async (lot: {
    code: string;
    projectName: string;
    areaM2: number;
    basePriceCents: number;
  }) => {
    await createLot(lot).catch(handleApiError);
    await reloadLots();
    setCreatingLot(false);
  };

  const handleArchiveLot = async (reason: string) => {
    if (!lotBeingArchived) {
      return;
    }

    await archiveLot(lotBeingArchived.id, reason).catch(handleApiError);
    await reloadLots();
    setLotBeingArchived(null);
  };

  /**
   * What the button in the top right does on this screen, or `undefined` when
   * there is nothing for it to do — which is what hides it.
   *
   * A `switch` rather than the chain of ternaries this used to be. Each arm
   * also waits on the data its form is built from: "Nuevo contrato" opens onto
   * two pickers made of customers and lots, so offering it before those have
   * loaded would open an empty form that tells the user they have no clients.
   */
  const primaryAction = (): (() => void) | undefined => {
    switch (activeTab) {
      case "lots":
        return lotsState.status === "ready" && can(user, "lot:create")
          ? () => setCreatingLot(true)
          : undefined;

      case "projects":
        return can(user, "project:create") ? () => openProjectForm(null) : undefined;

      case "customers":
        return customersState.status === "ready" && can(user, "customer:create")
          ? () => openCustomerForm(null)
          : undefined;

      case "contracts":
        return contractsState.status === "ready" &&
          lotsState.status === "ready" &&
          customersState.status === "ready" &&
          can(user, "contract:create")
          ? () => setCreatingContract(true)
          : undefined;

      // Recording a payment needs the customers to pick from and their
      // contracts to split across, so both have to have arrived first.
      case "receipts":
        return contractsState.status === "ready" &&
          customersState.status === "ready" &&
          can(user, "payment:record")
          ? () => setCreatingReceipt(true)
          : undefined;

      default:
        return undefined;
    }
  };

  const selectedCustomer =
    customerSelection && lotsState.status === "ready"
      ? lotsState.data.customersById.get(customerSelection.customerId)
      : undefined;

  return (
    <div className={isSidebarOpen ? "app" : "app sidebar-collapsed"}>
      <Sidebar
        ref={sidebarRef}
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        onClose={() => setSidebarOpen(false)}
        isOpen={isSidebarOpen}
        user={user}
        onSignOut={() => void handleSignOut()}
      />

      <div
        className={isSidebarOpen ? "sidebar-overlay show" : "sidebar-overlay"}
        onClick={() => setSidebarOpen(false)}
      />

      <div className="main">
        <Topbar
          title={pageTitles[activeTab]}
          primaryActionLabel={primaryActionLabels[activeTab]}
          onPrimaryAction={primaryAction()}
          currency={currency}
          onCurrencyChange={setCurrency}
          rate={rate}
          canEditRate={can(user, "rate:edit")}
          onRateChanged={setRate}
          onOpenMenu={() => setSidebarOpen(true)}
        />

        <div className="content">
          {activeTab !== "lots" &&
            activeTab !== "projects" &&
            activeTab !== "customers" &&
            activeTab !== "contracts" &&
            activeTab !== "receipts" &&
            activeTab !== "audit" &&
            activeTab !== "permissions" && (
              <PlaceholderPage title={pageTitles[activeTab]} />
            )}

          {activeTab === "audit" && <AuditPage money={money} />}

          {/* Re-reading the session after a save keeps THIS user's own view in
              step; a supervisor editing associate permissions does not change
              their own, but the round trip costs nothing and cannot drift. */}
          {activeTab === "permissions" && (
            <PermissionsPage
              onSaved={() => {
                void authApi
                  .me()
                  .then((refreshed) => setSession({ status: "signed-in", user: refreshed }))
                  .catch(() => undefined);
              }}
            />
          )}

          {activeTab === "projects" && projectsState.status === "loading" && (
            <section className="panel active">
              <div className="card">
                <p className="state-message">Cargando proyectos…</p>
              </div>
            </section>
          )}

          {activeTab === "projects" && projectsState.status === "error" && (
            <section className="panel active">
              <div className="card">
                <p className="form-error">{projectsState.message}</p>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void reloadProjects()}
                >
                  Reintentar
                </button>
              </div>
            </section>
          )}

          {activeTab === "projects" && projectsState.status === "ready" && (
            <ProjectsPage
              projects={projectsState.projects}
              money={money}
              user={user}
              onEdit={(project) => openProjectForm(project)}
              onArchive={setProjectBeingArchived}
              onRestore={(project) => void handleRestoreProject(project)}
            />
          )}

          {activeTab === "customers" && customersState.status === "loading" && (
            <section className="panel active">
              <div className="card">
                <p className="state-message">Cargando clientes…</p>
              </div>
            </section>
          )}

          {activeTab === "customers" && customersState.status === "error" && (
            <section className="panel active">
              <div className="card">
                <p className="form-error">{customersState.message}</p>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void reloadCustomers()}
                >
                  Reintentar
                </button>
              </div>
            </section>
          )}

          {activeTab === "customers" && customersState.status === "ready" && (
            <CustomersPage
              customers={customersState.customers}
              user={user}
              onEditCustomer={openCustomerForm}
              onDeleteCustomer={setCustomerBeingDeleted}
            />
          )}

          {activeTab === "contracts" && contractsState.status === "loading" && (
            <section className="panel active">
              <div className="card">
                <p className="state-message">Cargando contratos…</p>
              </div>
            </section>
          )}

          {activeTab === "contracts" && contractsState.status === "error" && (
            <section className="panel active">
              <div className="card">
                <p className="form-error">{contractsState.message}</p>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void reloadContracts()}
                >
                  Reintentar
                </button>
              </div>
            </section>
          )}

          {activeTab === "contracts" && contractsState.status === "ready" && (
            <ContractsPage
              contracts={contractsState.contracts}
              money={money}
              user={user}
              onOpenContract={setContractBeingViewed}
              onSplitPayment={setContractsBeingSplit}
            />
          )}

          {activeTab === "receipts" && transactionsState.status === "loading" && (
            <section className="panel active">
              <div className="card">
                <p className="state-message">Cargando transacciones…</p>
              </div>
            </section>
          )}

          {activeTab === "receipts" && transactionsState.status === "error" && (
            <section className="panel active">
              <div className="card">
                <p className="form-error">{transactionsState.message}</p>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void reloadTransactions()}
                >
                  Reintentar
                </button>
              </div>
            </section>
          )}

          {activeTab === "receipts" && transactionsState.status === "ready" && (
            <ReceiptsPage
              transactions={transactionsState.transactions}
              money={money}
              user={user}
              onVoidReceipt={setReceiptBeingVoided}
              onEditTransaction={setTransactionBeingEdited}
            />
          )}

          {activeTab === "lots" && lotsState.status === "loading" && (
            <section className="panel active">
              <div className="card">
                <p className="state-message">Cargando inventario…</p>
              </div>
            </section>
          )}

          {activeTab === "lots" && lotsState.status === "error" && (
            <section className="panel active">
              <div className="card">
                <p className="form-error">{lotsState.message}</p>
                <button type="button" className="btn-secondary" onClick={() => void reloadLots()}>
                  Reintentar
                </button>
              </div>
            </section>
          )}

          {activeTab === "lots" && lotsState.status === "ready" && (
            <LotsPage
              lots={lotsState.data.lots}
              customersById={lotsState.data.customersById}
              money={money}
              unitByProject={lotsState.data.unitByProject}
              onOpenCustomer={(customerId, lot) => setCustomerSelection({ customerId, lot })}
              user={user}
              onEditLot={setLotBeingEdited}
              onArchiveLot={setLotBeingArchived}
            />
          )}
        </div>
      </div>

      {isCreatingReceipt &&
        contractsState.status === "ready" &&
        customersState.status === "ready" && (
          <NewReceiptDialog
            customers={customersState.customers}
            contracts={contractsState.contracts}
            money={money}
            onClose={() => setCreatingReceipt(false)}
            onIssued={() => {
              setCreatingReceipt(false);
              // Everything that counts money has to be re-read, not just the
              // receipts: a payment moves the contract's balance, the lot's
              // paid-to-date and the customer's totals, all of which are
              // derived server-side.
              void reloadTransactions();
              void reloadContracts();
              void reloadCustomers();
              void reloadLots();
            }}
          />
        )}

      {/* Editing shows the customer's whole history beside the form, so a
          changed amount is judged against the payments around it rather than
          as a number on its own. */}
      {transactionBeingEdited && transactionsState.status === "ready" && (
        <TransactionEditDialog
          transaction={transactionBeingEdited}
          customerTransactions={transactionsState.transactions.filter(
            (transaction) => transaction.customerId === transactionBeingEdited.customerId,
          )}
          money={money}
          onClose={() => setTransactionBeingEdited(null)}
          onSaved={() => {
            setTransactionBeingEdited(null);
            // A corrected transaction moves every balance after it, so
            // everything that shows money has to be re-read.
            void reloadTransactions();
            void reloadContracts();
            void reloadCustomers();
            void reloadLots();
          }}
        />
      )}

      {receiptBeingVoided && (
        <ReceiptVoidDialog
          receipt={receiptBeingVoided}
          money={money}
          onClose={() => setReceiptBeingVoided(null)}
          onVoided={() => {
            setReceiptBeingVoided(null);
            void reloadTransactions();
            void reloadContracts();
            void reloadCustomers();
            void reloadLots();
          }}
        />
      )}

      {isCreatingLot && lotsState.status === "ready" && (
        <LotCreateDialog
          lots={lotsState.data.lots}
          projectNames={lotsState.data.projectNames}
          unitByProject={lotsState.data.unitByProject}
          onCancel={() => setCreatingLot(false)}
          onCreate={handleCreateLot}
        />
      )}

      {isCreatingContract &&
        contractsState.status === "ready" &&
        lotsState.status === "ready" &&
        customersState.status === "ready" && (
          <ContractCreateDialog
            customers={customersState.customers}
            lots={lotsState.data.lots}
            contracts={contractsState.contracts}
            unitByProject={lotsState.data.unitByProject}
            money={money}
            onCancel={() => setCreatingContract(false)}
            onCreate={handleCreateContract}
          />
        )}

      {isProjectFormOpen && (
        <ProjectFormDialog
          project={projectBeingEdited}
          onCancel={closeProjectForm}
          onSave={handleSaveProject}
        />
      )}

      {isCustomerFormOpen && (
        <CustomerFormDialog
          customer={customerBeingEdited}
          customers={customersState.status === "ready" ? customersState.customers : []}
          onCancel={closeCustomerForm}
          onSave={handleSaveCustomer}
        />
      )}

      {customerBeingDeleted && (
        <CustomerDeleteDialog
          customer={customerBeingDeleted}
          onCancel={() => setCustomerBeingDeleted(null)}
          onConfirm={handleDeleteCustomer}
        />
      )}

      {projectBeingArchived && (
        <ProjectArchiveDialog
          project={projectBeingArchived}
          onCancel={() => setProjectBeingArchived(null)}
          onConfirm={handleArchiveProject}
        />
      )}

      {lotBeingEdited && (
        <LotEditDialog
          lot={lotBeingEdited}
          lots={lotsState.status === "ready" ? lotsState.data.lots : []}
          unitByProject={
            lotsState.status === "ready" ? lotsState.data.unitByProject : new Map()
          }
          canChangePrice={can(user, "price:change")}
          onCancel={() => setLotBeingEdited(null)}
          onSave={handleSaveLot}
        />
      )}

      {lotBeingArchived && (
        <LotArchiveDialog
          lot={lotBeingArchived}
          onCancel={() => setLotBeingArchived(null)}
          onConfirm={handleArchiveLot}
        />
      )}

      {contractBeingViewed && (
        <ContractPanel
          contract={contractBeingViewed}
          // The other lots of the SAME purchase, not merely the same customer:
          // two lots bought years apart share a person, not a receipt.
          siblings={
            contractBeingViewed.saleGroupId === null || contractsState.status !== "ready"
              ? []
              : contractsState.contracts.filter(
                  (candidate) =>
                    candidate.saleGroupId === contractBeingViewed.saleGroupId &&
                    candidate.id !== contractBeingViewed.id,
                )
          }
          money={money}
          user={user}
          onClose={() => setContractBeingViewed(null)}
          onEditContract={setContractBeingEdited}
          onCancelContract={setContractBeingCancelled}
        />
      )}

      {contractBeingEdited && (
        <ContractEditDialog
          contract={contractBeingEdited}
          money={money}
          canReprice={can(user, "contract:reprice")}
          onCancel={() => setContractBeingEdited(null)}
          onSave={handleSaveContract}
        />
      )}

      {contractBeingCancelled && (
        <ContractCancelDialog
          contract={contractBeingCancelled}
          money={money}
          onCancel={() => setContractBeingCancelled(null)}
          onConfirm={handleCancelContract}
        />
      )}

      {contractsBeingSplit && (
        <SplitPreviewDialog
          contracts={contractsBeingSplit}
          money={money}
          onClose={() => setContractsBeingSplit(null)}
        />
      )}

      {customerSelection && selectedCustomer && (
        <CustomerPanel
          customer={selectedCustomer}
          lot={customerSelection.lot}
          money={money}
          onClose={() => setCustomerSelection(null)}
          onViewFullRecord={() => {
            setCustomerSelection(null);
            setActiveTab("customers");
          }}
        />
      )}
    </div>
  );
}
