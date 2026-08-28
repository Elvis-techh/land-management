import { useCallback, useEffect, useRef, useState } from "react";

import { PlaceholderPage } from "./components/PlaceholderPage";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { AuditPage } from "./features/audit/AuditPage";
import { CustomerPanel } from "./features/customers/CustomerPanel";
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
import { useExchangeRate } from "./features/rate/useExchangeRate";
import { archiveLot, createLot, updateLot } from "./features/lots/api";
import { useLots } from "./features/lots/useLots";
import { ApiError } from "./lib/api";
import type { Currency, MoneyView } from "./lib/money";
import type { User } from "./lib/permissions";
import { isMobileViewport } from "./lib/viewport";
import { can } from "./lib/permissions";
import type { AreaUnit } from "./lib/area";
import type { Lot, Project, TabId } from "./types";

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

  const isSignedIn = session.status === "signed-in";
  const { state: lotsState, reload: reloadLots } = useLots(isSignedIn);
  const { state: projectsState, reload: reloadProjects } = useProjects(isSignedIn);
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
          onPrimaryAction={
            activeTab === "lots" && lotsState.status === "ready" && can(user, "lot:create")
              ? () => setCreatingLot(true)
              : activeTab === "projects" && can(user, "project:create")
                ? () => openProjectForm(null)
                : undefined
          }
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

      {isCreatingLot && lotsState.status === "ready" && (
        <LotCreateDialog
          lots={lotsState.data.lots}
          projectNames={lotsState.data.projectNames}
          unitByProject={lotsState.data.unitByProject}
          onCancel={() => setCreatingLot(false)}
          onCreate={handleCreateLot}
        />
      )}

      {isProjectFormOpen && (
        <ProjectFormDialog
          project={projectBeingEdited}
          onCancel={closeProjectForm}
          onSave={handleSaveProject}
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
          unitByProject={
            lotsState.status === "ready" ? lotsState.data.unitByProject : new Map()
          }
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
