import { useCallback, useEffect, useRef, useState } from "react";

import { Dialog, useAnyDialogOpen } from "./components/Dialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { AuditPage } from "./features/audit/AuditPage";
import { DashboardPage } from "./features/dashboard/DashboardPage";
import { useDashboard } from "./features/dashboard/useDashboard";
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
import type { ContractFilterPreset } from "./features/contracts/contractFilters";
import {
  cancelContract,
  createContract,
  defaultContract,
  updateContract,
} from "./features/contracts/api";
import type {
  CancelSettlement,
  ContractCreateDraft,
  ContractTermsDraft,
} from "./features/contracts/api";
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
import { UserDeactivateDialog } from "./features/users/UserDeactivateDialog";
import { UserFormDialog } from "./features/users/UserFormDialog";
import { UserPasswordDialog } from "./features/users/UserPasswordDialog";
import { UsersPage } from "./features/users/UsersPage";
import {
  createUser,
  deactivateUser,
  reactivateUser,
  resetUserPassword,
  updateUser,
} from "./features/users/api";
import type { UserAccount, UserDraft } from "./features/users/api";
import { useUsers } from "./features/users/useUsers";
import { NewReceiptDialog } from "./features/receipts/NewReceiptDialog";
import { ReceiptVoidDialog } from "./features/receipts/ReceiptVoidDialog";
import { ReceiptsPage } from "./features/receipts/ReceiptsPage";
import { TransactionEditDialog } from "./features/receipts/TransactionEditDialog";
import { useTransactions } from "./features/receipts/useTransactions";
import { useExchangeRate } from "./features/rate/useExchangeRate";
import { archiveLot, createLot, restoreLot, updateLot } from "./features/lots/api";
import { useLots } from "./features/lots/useLots";
import { ApiError } from "./lib/api";
import type { Currency, MoneyView } from "./lib/money";
import type { User } from "./lib/permissions";
import { useLiveUpdates } from "./lib/liveUpdates";
import { clearShareFromUrl, readShareRequest, takeSharedPayload } from "./lib/sharedIntake";
import { useWindowFileDrop } from "./lib/useFileDrop";
import { windowDropTarget } from "./lib/windowDropTarget";
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
  users: "Usuarios",
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
  users: "Nueva cuenta",
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

  /* Captured on the first render and never re-read: by the time the effect
     below runs, clearShareFromUrl has taken the marker back out of the URL. */
  const pendingShare = useRef(readShareRequest(window.location.search));

  useEffect(() => {
    authApi
      .me()
      .then((user) => setSession({ status: "signed-in", user }))
      .catch(() => setSession({ status: "anonymous" }));
  }, []);

  /*
   * The Panel General is home.
   *
   * Lotes was the landing screen while it was the only one built. The question
   * somebody opens this app to answer is "how are we doing" — which is the one
   * screen that cannot be reached by looking at a single row, and is therefore
   * the one worth showing before anybody has clicked anything.
   */
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  /** Filters the Contratos tab should adopt the next time it renders. */
  const [contractsPreset, setContractsPreset] = useState<ContractFilterPreset | null>(null);
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

  /* Comprobantes handed to the receipt form from outside it — shared in from
     WhatsApp, or dropped anywhere on the window — waiting for it to open with
     them. Cleared when it closes, so pressing "Nueva transacción" afterwards
     does not reopen the form holding somebody else's photo. */
  const [intakeFiles, setIntakeFiles] = useState<File[] | null>(null);
  const [intakeNotice, setIntakeNotice] = useState<string | null>(null);

  /* Why a share was turned away, when it was. Separate from `intakeNotice`,
     which the receipt form shows INSIDE itself: this is the case where that
     form is never going to open, so the explanation has nowhere else to go. */
  const [shareRefusal, setShareRefusal] = useState<string | null>(null);

  /* The same thing for the contract form: a scan dropped on the Contratos tab,
     waiting for "Nuevo contrato" to open around it. Kept apart from
     `intakeFiles` because the two forms take different files under different
     rules — 30 MB of scanned contract is not a comprobante — and a leftover in
     one must never surface in the other. */
  const [contractIntakeFiles, setContractIntakeFiles] = useState<File[] | null>(null);
  const [receiptBeingVoided, setReceiptBeingVoided] = useState<Receipt | null>(null);
  const [transactionBeingEdited, setTransactionBeingEdited] = useState<Transaction | null>(null);
  const [contractBeingViewed, setContractBeingViewed] = useState<Contract | null>(null);
  const [contractBeingEdited, setContractBeingEdited] = useState<Contract | null>(null);
  const [contractBeingCancelled, setContractBeingCancelled] = useState<Contract | null>(null);
  const [contractBeingDefaulted, setContractBeingDefaulted] = useState<Contract | null>(null);
  // The lots of ONE purchase, while their split is being previewed.
  const [contractsBeingSplit, setContractsBeingSplit] = useState<Contract[] | null>(null);
  // As with the project and customer forms, `null` in `accountBeingEdited`
  // means the form is creating rather than editing, so the two are kept apart.
  const [isUserFormOpen, setUserFormOpen] = useState(false);
  const [accountBeingEdited, setAccountBeingEdited] = useState<UserAccount | null>(null);
  const [accountChangingPassword, setAccountChangingPassword] = useState<UserAccount | null>(null);
  const [accountBeingDeactivated, setAccountBeingDeactivated] = useState<UserAccount | null>(null);

  const isSignedIn = session.status === "signed-in";

  // The session expired underneath a request. Drop to the login screen rather
  // than sit on stale numbers. Defined before the data hooks because they call
  // it from their own refresh failures — a 401 there used to surface as a
  // generic "no se pudo cargar" card with a Retry button that could only 401
  // again.
  const handleSessionExpired = useCallback(() => {
    setSession({ status: "anonymous" });
  }, []);

  const { state: lotsState, reload: reloadLots } = useLots(isSignedIn, handleSessionExpired);
  const { state: projectsState, reload: reloadProjects } = useProjects(isSignedIn, handleSessionExpired);
  const { state: customersState, reload: reloadCustomers } = useCustomers(isSignedIn, handleSessionExpired);
  const { state: contractsState, reload: reloadContracts } = useContracts(isSignedIn, handleSessionExpired);
  const { state: transactionsState, reload: reloadTransactions } = useTransactions(
    isSignedIn,
    handleSessionExpired,
  );
  const {
    state: dashboardState,
    reload: reloadDashboard,
    setMonth: setDashboardMonth,
  } = useDashboard(isSignedIn);
  const { rate, setRate, reload: reloadRate } = useExchangeRate(isSignedIn, handleSessionExpired);
  /*
   * Only fetched for somebody who can manage accounts.
   *
   * Every other list here loads for anyone signed in, because everyone can see
   * lots and customers. This one comes back 403 for an associate, which would
   * put a permanent error card behind a tab they cannot even reach.
   */
  const canManageUsers =
    session.status === "signed-in" && can(session.user, "user:manage");
  const { state: usersState, reload: reloadUsers } = useUsers(canManageUsers);

  /*
   * Re-read everything.
   *
   * ALL of it, on any write by anybody, rather than a careful subset — for the
   * reason set out in backend/src/lib/changes.ts. A single payment moves the
   * transactions list, the contract's health, the lot's paid-to-date, the
   * customer's holdings and the project's totals, because every one of those is
   * derived on read rather than stored. There is no subset to be clever about
   * that is not also a subset to be wrong about, and each of these is one GET
   * of a few hundred rows.
   *
   * Nothing flickers: each hook swaps its data in place and only shows
   * "Cargando…" when it has nothing yet.
   */
  const reloadEverything = useCallback(() => {
    void reloadLots();
    void reloadProjects();
    void reloadCustomers();
    void reloadContracts();
    void reloadTransactions();
    void reloadDashboard();
    void reloadRate().catch(() => undefined);
    // Guarded, unlike the rest: GET /api/users is a 403 for an associate, and
    // firing one on every write anybody makes would be a stream of refusals in
    // the log for a screen that account cannot open.
    if (canManageUsers) {
      void reloadUsers();
    }
  }, [
    reloadLots,
    reloadProjects,
    reloadCustomers,
    reloadContracts,
    reloadTransactions,
    reloadDashboard,
    reloadRate,
    canManageUsers,
    reloadUsers,
  ]);

  // What makes the app live: a teammate's write, or coming back to this tab,
  // runs the same reload your own write already runs. See lib/liveUpdates.ts.
  useLiveUpdates(isSignedIn, reloadEverything);

  // Currency and rate travel together, so a component cannot format money with
  // one and forget the other.
  const money: MoneyView = { currency, usdRate: rate.rate };

  const sidebarRef = useRef<HTMLElement>(null);

  // If the session expires while the app is open, any request will come back
  // 401. Drop straight to the login screen rather than showing stale data.
  const handleApiError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.isUnauthenticated) {
        handleSessionExpired();
      }
      throw error;
    },
    [handleSessionExpired],
  );

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

  /* The permission every way into the receipt form is gated on — the button,
     a dropped file and a share — read from one place so the three cannot
     drift. The server checks it again on the way in; this only decides what is
     worth offering. */
  const canRecordPayment =
    session.status === "signed-in" && can(session.user, "payment:record");

  /*
   * A comprobante shared from WhatsApp.
   *
   * The service worker has already parked it in IndexedDB and redirected here
   * with its id in the query string; this picks it up, opens the form with the
   * image attached, and gets out of the way. See lib/sharedIntake.ts.
   *
   * Read into a ref on the FIRST render, before anything else can rewrite the
   * URL, but acted on only once there is a session — sharing into an app you
   * are signed out of is entirely normal, and the payload has to survive the
   * login screen rather than being thrown away at the door.
   */
  useEffect(() => {
    const request = pendingShare.current;

    if (!request || session.status !== "signed-in") {
      return;
    }

    // Claimed exactly once, whatever happens next. A retry would find nothing
    // — takeSharedPayload deletes as it reads — and would reopen an empty form
    // over whatever the user had moved on to.
    pendingShare.current = null;
    clearShareFromUrl();

    setActiveTab("receipts");

    /*
     * Somebody who may not record payments gets told so, here, instead of a
     * form that would be refused on save.
     *
     * The share arrives from another app entirely — the slip was in WhatsApp a
     * second ago — so silence reads as Lindero being broken rather than as an
     * answer. Recibos is still where they are taken: the tab itself is not
     * gated, and seeing the payment appear once a colleague records it is the
     * next thing they will want.
     *
     * The payload is still claimed and thrown away. It was parked in IndexedDB
     * by the service worker and nothing else will ever come back for it.
     */
    if (!canRecordPayment) {
      setShareRefusal(
        "Tu cuenta no puede registrar pagos. Pídele a quien sí pueda que registre el comprobante.",
      );

      if (request !== "failed") {
        void takeSharedPayload(request.id);
      }

      return;
    }

    setCreatingReceipt(true);

    if (request === "failed") {
      setIntakeNotice("No se pudo leer lo que compartiste. Adjunta el comprobante aquí abajo.");
      return;
    }

    void takeSharedPayload(request.id).then((payload) => {
      if (payload && payload.files.length > 0) {
        setIntakeFiles(payload.files);
        return;
      }

      /* Text with no attachment is a real share — a forwarded bank
         notification, say — and so is a payload that expired. Either way the
         form is already open on the right screen, which is most of the value;
         it just has nothing to attach. */
      setIntakeNotice("Lo compartido no traía una imagen. Adjunta el comprobante aquí abajo.");
    });
  }, [session.status, canRecordPayment]);

  /*
   * Drop a file anywhere on the window and the form that wants it opens.
   *
   * The same destination as a share and the same reason for existing: the slip
   * arrives in a chat window next to this one, and the fewer steps between
   * seeing it and having a receipt to send back, the sooner the customer gets
   * an answer. Dragging it onto Lindero opens the transaction form around it,
   * on the Recibos tab, with the image already attached — no menu, no tab, no
   * file picker, and no need to hit any particular part of the screen.
   *
   * Deliberately not gated on the Recibos tab being open. The whole point is
   * that it works from wherever you happen to be looking — with ONE exception,
   * which is Contratos: there the same gesture opens "Nuevo contrato" with the
   * scan attached instead, because a file dropped while looking at contracts is
   * a contract. See `dropTarget` below.
   */
  const isDialogOpen = useAnyDialogOpen();

  /** What the "Nueva transacción" button is enabled under. */
  const canOpenReceiptForm =
    canRecordPayment &&
    contractsState.status === "ready" &&
    customersState.status === "ready";

  /*
   * A first load that never landed — the one case where waiting will not help.
   *
   * Only ever a FIRST load: a failed refresh deliberately leaves a `ready`
   * state alone rather than blanking a working screen (see useContracts), so
   * "error" cannot appear under a form that was already openable.
   */
  const isReceiptDataMissing =
    contractsState.status === "error" || customersState.status === "error";

  /* The same pair for the contract form. It needs the lots too — a contract is
     a customer and a lot — so it has one more first load that can fail. */
  const canFileContract = session.status === "signed-in" && can(session.user, "contract:create");

  const isContractDataMissing =
    contractsState.status === "error" ||
    customersState.status === "error" ||
    lotsState.status === "error";

  /*
   * Where a dropped file goes, given the screen it landed on.
   *
   * A dropped file does not say what it is: the same JPG is a comprobante on
   * one screen and a photographed contract on another. Recibos and everywhere
   * else mean "record a payment"; Contratos means "write a contract", because
   * somebody filing paperwork is looking at the paperwork screen. The rule
   * itself lives in lib/windowDropTarget.ts where it can be read and tested.
   */
  const dropTarget = windowDropTarget({
    tab: activeTab,
    canRecordPayment,
    canFileContract,
    isReceiptDataMissing,
    isContractDataMissing,
    isDialogOpen,
  });

  const { isDraggingFiles, isWindowTarget } = useWindowFileDrop(
    (files) => {
      if (dropTarget === "contract") {
        setActiveTab("contracts");
        setContractIntakeFiles(files);
        setCreatingContract(true);
        return;
      }

      setActiveTab("receipts");
      setIntakeNotice(null);
      setIntakeFiles(files);
      /*
       * Asks for the form; does not conjure it. The dialog below renders only
       * once the contracts and the customers have arrived, so a drop during
       * those first seconds waits here and opens the moment they do — which is
       * also exactly how a share behaves.
       */
      setCreatingReceipt(true);
    },
    /*
     * Deliberately a LOOSER gate than the button above: permission, and not
     * also "the lists have arrived".
     *
     * A button can afford to wait to be pressed. A drop cannot — it carries the
     * comprobante with it, and the gesture this feature is built around is
     * opening Lindero and dragging the slip straight in, which lands squarely
     * in the second or two the app spends loading. Refusing it there did
     * nothing visible and looked exactly like the feature not working.
     *
     * Not while a dialog is up, either. The receipt form has a dropzone of its
     * own for a second slip, and everything else on top of the page is a form
     * with typing in it or a document being read — none of which should be
     * swept away by a file landing on the window behind them. That, and the
     * rest of the rule, is `windowDropTarget` above.
     */
    dropTarget === null,
  );

  /*
   * Tell the whole page a file is looking for somewhere to land.
   *
   * On <body> rather than through props or a context because the places that
   * can receive one are scattered — the receipt panel, the receipt form, the
   * correction dialog, two of them behind portals — and every one of them
   * should light up from the same fact without App having to know where they
   * are. `body.modal-open` already works this way. The styling lives in
   * styles.css, on `.proof-dropzone`.
   *
   * Driven by the drag itself and NOT by whether this hook would take the
   * files: while the receipt form is open the window stands down, and the
   * form's own dropzone is exactly the thing that should be showing itself.
   */
  useEffect(() => {
    document.body.classList.toggle("is-dragging-file", isDraggingFiles);

    return () => document.body.classList.remove("is-dragging-file");
  }, [isDraggingFiles]);

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

  /*
   * Open one contract's panel from a screen that only knows its id.
   *
   * The Panel General holds summary rows of its own rather than `Contract`
   * objects, so the lookup happens here, against the list this component
   * already owns. A contract the list does not have — one archived since the
   * dashboard was last refreshed — opens nothing rather than an empty panel.
   */
  const handleOpenContractById = (contractId: string) => {
    if (contractsState.status !== "ready") {
      return;
    }

    const contract = contractsState.contracts.find((row) => row.id === contractId);

    if (contract) {
      setContractBeingViewed(contract);
    }
  };

  /*
   * Leave for Contratos with filters already applied.
   *
   * The preset is held here rather than pushed into ContractsPage, because that
   * screen owns its own filter state and a prop that overwrote it on every
   * render would fight the reader every time they changed a chip. It is handed
   * over once, consumed, and cleared — see `onPresetApplied`.
   */
  const handleShowContracts = (preset: ContractFilterPreset) => {
    setContractsPreset(preset);
    handleSelectTab("contracts");
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

  // Cancelling or defaulting releases the lot, and the Lotes table derives
  // availability from active contracts — so it is wrong on screen until it is
  // re-read. A refund also reverses payments, which moves every balance and can
  // void a receipt, so the money screens have to re-read too.
  const reloadAfterClose = async () => {
    await reloadContracts();
    await reloadLots();
    await reloadCustomers();
    await reloadTransactions();
    setContractBeingViewed(null);
  };

  const handleCancelContract = async (reason: string, settlement?: CancelSettlement) => {
    if (!contractBeingCancelled) {
      return;
    }

    await cancelContract(contractBeingCancelled.id, reason, settlement).catch(handleApiError);
    await reloadAfterClose();
    setContractBeingCancelled(null);
  };

  const handleDefaultContract = async (reason: string, settlement?: CancelSettlement) => {
    if (!contractBeingDefaulted) {
      return;
    }

    await defaultContract(contractBeingDefaulted.id, reason, settlement).catch(handleApiError);
    await reloadAfterClose();
    setContractBeingDefaulted(null);
  };

  /**
   * Write the contract and hand back what the server named it.
   *
   * It deliberately does NOT close the form or re-read anything. The signed
   * paperwork is uploaded from inside the dialog once the contract exists —
   * a document needs a contract to belong to — so the dialog has to still be on
   * screen after this resolves. Closing and reloading is `handleContractCreated`
   * below, which the dialog calls when it is really finished.
   */
  const handleCreateContract = async (draft: ContractCreateDraft) => {
    const { contract } = await createContract(draft).catch(handleApiError);

    return contract;
  };

  const handleContractCreated = () => {
    setCreatingContract(false);
    setContractIntakeFiles(null);

    // All three lists move, and none of them can be patched by hand. The new
    // contract carries a balance and a payment health only the server computes;
    // the lot it names has just left the available inventory; and the customer
    // is now holding something they were not holding a second ago.
    void reloadContracts();
    void reloadLots();
    void reloadCustomers();
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

  const handleRestoreLot = async (lot: Lot) => {
    await restoreLot(lot.id).catch(handleApiError);
    await reloadLots();
  };

  const openUserForm = (account: UserAccount | null) => {
    setAccountBeingEdited(account);
    setUserFormOpen(true);
  };

  const closeUserForm = () => {
    setUserFormOpen(false);
    setAccountBeingEdited(null);
  };

  const handleSaveUser = async (draft: UserDraft & { password?: string }) => {
    if (accountBeingEdited) {
      await updateUser(accountBeingEdited.id, draft).catch(handleApiError);
    } else {
      // The form guarantees a password when creating; the type cannot, since
      // one draft shape serves both. The server refuses a missing one anyway.
      await createUser({ ...draft, password: draft.password ?? "" }).catch(handleApiError);
    }

    await reloadUsers();
    closeUserForm();
  };

  const handleResetPassword = async (password: string) => {
    if (!accountChangingPassword) {
      return;
    }

    await resetUserPassword(accountChangingPassword.id, password).catch(handleApiError);

    // Not just the row: resetting your OWN password ends this session too, and
    // the next request is what will find that out and drop to the login screen.
    await reloadUsers();
    setAccountChangingPassword(null);
  };

  const handleDeactivateUser = async () => {
    if (!accountBeingDeactivated) {
      return;
    }

    await deactivateUser(accountBeingDeactivated.id).catch(handleApiError);
    await reloadUsers();
    setAccountBeingDeactivated(null);
  };

  const handleReactivateUser = async (account: UserAccount) => {
    await reactivateUser(account.id).catch(handleApiError);
    await reloadUsers();
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

      // The Panel General offers the same action as Contratos, since its own
      // heading already says "Nuevo contrato" and a button that does nothing is
      // worse than no button.
      case "dashboard":
      case "contracts":
        return contractsState.status === "ready" &&
          lotsState.status === "ready" &&
          customersState.status === "ready" &&
          can(user, "contract:create")
          ? () => setCreatingContract(true)
          : undefined;

      case "users":
        return usersState.status === "ready" && can(user, "user:manage")
          ? () => openUserForm(null)
          : undefined;

      // Recording a payment needs the customers to pick from and their
      // contracts to split across, so both have to have arrived first.
      case "receipts":
        return canOpenReceiptForm ? () => setCreatingReceipt(true) : undefined;

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
          {/* Keyed by tab, so a render error is contained to the screen that
              caused it: the sidebar, the top bar and every other tab keep
              working, and switching away resets the boundary. */}
          <ErrorBoundary variant="panel" area={`la pantalla de ${pageTitles[activeTab]}`} key={activeTab}>
          {activeTab === "dashboard" && dashboardState.status === "loading" && (
            <section className="panel active">
              <div className="card">
                <p className="state-message">Cargando el panel…</p>
              </div>
            </section>
          )}

          {activeTab === "dashboard" && dashboardState.status === "error" && (
            <section className="panel active">
              <div className="card">
                <p className="form-error">{dashboardState.message}</p>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void reloadDashboard()}
                >
                  Reintentar
                </button>
              </div>
            </section>
          )}

          {activeTab === "dashboard" && dashboardState.status === "ready" && (
            <DashboardPage
              data={dashboardState.data}
              money={money}
              onSelectMonth={setDashboardMonth}
              onOpenContract={handleOpenContractById}
              onShowContracts={handleShowContracts}
            />
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

          {activeTab === "users" && usersState.status === "loading" && (
            <section className="panel active">
              <div className="card">
                <p className="state-message">Cargando cuentas…</p>
              </div>
            </section>
          )}

          {activeTab === "users" && usersState.status === "error" && (
            <section className="panel active">
              <div className="card">
                <p className="form-error">{usersState.message}</p>
                <button type="button" className="btn-secondary" onClick={() => void reloadUsers()}>
                  Reintentar
                </button>
              </div>
            </section>
          )}

          {activeTab === "users" && usersState.status === "ready" && (
            <UsersPage
              users={usersState.users}
              onCreate={() => openUserForm(null)}
              onEdit={openUserForm}
              onResetPassword={setAccountChangingPassword}
              onDeactivate={setAccountBeingDeactivated}
              onReactivate={handleReactivateUser}
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
              filterPreset={contractsPreset}
              onPresetApplied={() => setContractsPreset(null)}
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
              // The thumbnails hang off the transaction rows, so attaching a
              // comprobante from the receipt panel has to re-read this list.
              onProofsChanged={() => void reloadTransactions()}
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
              onRestoreLot={(lot) => void handleRestoreLot(lot)}
            />
          )}
          </ErrorBoundary>
        </div>
      </div>

      {/* The dialogs share a boundary of their own: a crash inside a form must
          not blank the tables and the navigation behind it. */}
      <ErrorBoundary variant="panel" area="una ventana">
      {/* A share this account cannot act on. Its own dialog rather than a line
          inside the receipt form, because the whole point is that the receipt
          form is not opening. */}
      {shareRefusal && (
        <Dialog ariaLabel="No se puede registrar el pago" onClose={() => setShareRefusal(null)}>
          <div className="modal-header">
            <div>
              <p className="modal-eyebrow">Comprobante compartido</p>
              <h2>No se puede registrar el pago</h2>
            </div>
          </div>

          <p className="modal-description">{shareRefusal}</p>

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setShareRefusal(null)}>
              Entendido
            </button>
          </div>
        </Dialog>
      )}

      {isCreatingReceipt && canOpenReceiptForm && (
        <NewReceiptDialog
          customers={customersState.customers}
          contracts={contractsState.contracts}
          money={money}
          initialFiles={intakeFiles ?? undefined}
          initialNotice={intakeNotice ?? undefined}
          onClose={() => {
            setCreatingReceipt(false);
            setIntakeFiles(null);
            setIntakeNotice(null);
          }}
          onIssued={() => {
            setCreatingReceipt(false);
            setIntakeFiles(null);
            setIntakeNotice(null);
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
          canAttachProof={can(user, "payment:record")}
          onProofsChanged={() => void reloadTransactions()}
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
            initialFiles={contractIntakeFiles ?? undefined}
            onCancel={() => {
              setCreatingContract(false);
              setContractIntakeFiles(null);
            }}
            onCreate={handleCreateContract}
            onCreated={handleContractCreated}
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

      {isUserFormOpen && (
        <UserFormDialog
          account={accountBeingEdited}
          users={usersState.status === "ready" ? usersState.users : []}
          isSelf={accountBeingEdited?.id === user.id}
          onCancel={closeUserForm}
          onSave={handleSaveUser}
        />
      )}

      {accountChangingPassword && (
        <UserPasswordDialog
          account={accountChangingPassword}
          onCancel={() => setAccountChangingPassword(null)}
          onConfirm={handleResetPassword}
        />
      )}

      {accountBeingDeactivated && (
        <UserDeactivateDialog
          account={accountBeingDeactivated}
          onCancel={() => setAccountBeingDeactivated(null)}
          onConfirm={handleDeactivateUser}
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
          onDefaultContract={setContractBeingDefaulted}
          // The list marks which contracts have their signed copy on file, so
          // filing one from the panel has to re-read the list behind it.
          onDocumentsChanged={() => void reloadContracts()}
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
          canRefund={can(user, "payment:reverse")}
          onCancel={() => setContractBeingCancelled(null)}
          onConfirm={handleCancelContract}
        />
      )}

      {contractBeingDefaulted && (
        <ContractCancelDialog
          contract={contractBeingDefaulted}
          money={money}
          mode="default"
          canRefund={can(user, "payment:reverse")}
          onCancel={() => setContractBeingDefaulted(null)}
          onConfirm={handleDefaultContract}
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
      </ErrorBoundary>

      {/* What makes an invisible target discoverable: it appears under the
          file the moment one is dragged over the app, and says what letting go
          will do. It steps aside the moment the pointer finds a dropzone with a
          more specific answer — those light up on their own while this is in
          flight, so the choice between "a new transaction" and "onto the
          receipt already open" is visible rather than guessed at.

          `pointer-events: none` in the stylesheet is load-bearing — without it
          this would become the drop target itself and swallow the drop meant
          for the receipt panel's own zone underneath. */}
      {isWindowTarget && (
        <div className="window-drop" aria-hidden="true">
          <div className="window-drop-card">
            {/* Named for the tab, because the tab is what decides where the
                file lands. Saying "comprobante" on the Contratos screen would
                promise the wrong form. */}
            <p className="window-drop-title">
              {dropTarget === "contract" ? "Suelta el contrato firmado" : "Suelta el comprobante"}
            </p>
            <p className="window-drop-hint">
              {dropTarget === "contract"
                ? "Se abre un contrato nuevo con el documento adjunto."
                : "Se abre una transacción nueva con la imagen adjunta."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
