import { useEffect, useMemo, useState } from "react";

import { ConfirmDialog } from "../../components/ConfirmDialog";
import type { Capability } from "../../lib/permissions";
import { ROLE_LABELS } from "../../lib/permissions";
import type { PermissionsData, PersonPermissionsData } from "./api";
import {
  fetchPermissions,
  fetchPersonPermissions,
  savePermissions,
  savePersonPermissions,
} from "./api";
import { CAPABILITY_GROUPS } from "./capabilityGroups";
import type { PermissionMode, PersonChoice } from "./permissionChoice";
import {
  differencesFromGeneral,
  effectiveCapabilities,
  personChoiceChanged,
  sameCapabilities,
} from "./permissionChoice";

interface PermissionsPageProps {
  /** Called after a successful save, so the app can re-read its own session. */
  onSaved: () => void;
}

/** «Todos los asociados», or one associate's id. */
type Selection = { kind: "general" } | { kind: "person"; id: string };

/**
 * The supervisor's switchboard for what associates may do.
 *
 * «Todos los asociados» is the general list: every associate account follows
 * it, so a new hire is governed by the same rules without anybody configuring
 * them. Since QI-5 step 3, one associate can instead be given a list of their
 * own, chosen from the row of names at the top.
 */
export function PermissionsPage({ onSaved }: PermissionsPageProps) {
  const [data, setData] = useState<PermissionsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: "general" });
  const [isDirty, setDirty] = useState(false);
  // Where the supervisor asked to go while switches were moved and unsaved.
  const [pending, setPending] = useState<Selection | null>(null);

  const load = () =>
    fetchPermissions()
      .then(setData)
      .catch((caught: unknown) =>
        setLoadError(
          caught instanceof Error ? caught.message : "No se pudieron cargar los permisos.",
        ),
      );

  useEffect(() => {
    void load();
  }, []);

  if (loadError) {
    return (
      <section className="panel active">
        <div className="card">
          <p className="form-error">{loadError}</p>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="panel active">
        <div className="card">
          <p className="state-message">Cargando permisos…</p>
        </div>
      </section>
    );
  }

  const associates = data.associates ?? [];
  const selectedPerson =
    selection.kind === "person" ? associates.find((associate) => associate.id === selection.id) : undefined;

  const choose = (next: Selection) => {
    if (isDirty) {
      setPending(next);
      return;
    }
    setSelection(next);
  };

  const isSelected = (candidate: Selection) =>
    candidate.kind === selection.kind &&
    (candidate.kind === "general" || (selection.kind === "person" && candidate.id === selection.id));

  return (
    <section className="panel active">
      {/* No associates, no choice to make: the general list is all there is. */}
      {associates.length > 0 && (
        <div className="toolbar permission-people" role="group" aria-label="De quién son los permisos">
          {[{ kind: "general" } as Selection, ...associates.map((a) => ({ kind: "person", id: a.id }) as Selection)].map(
            (candidate) => {
              const person =
                candidate.kind === "person"
                  ? associates.find((associate) => associate.id === candidate.id)
                  : undefined;

              return (
                <button
                  key={candidate.kind === "general" ? "general" : candidate.id}
                  type="button"
                  className={isSelected(candidate) ? "chip active" : "chip"}
                  aria-pressed={isSelected(candidate)}
                  onClick={() => choose(candidate)}
                >
                  {person ? person.name : "Todos los asociados"}
                  {person?.ownPermissions && <span className="permission-people-own"> · propios</span>}
                </button>
              );
            },
          )}
        </div>
      )}

      {selectedPerson ? (
        <PersonPermissions
          key={selectedPerson.id}
          userId={selectedPerson.id}
          onDirtyChange={setDirty}
          onSaved={() => {
            // Re-read the list, so the names at the top say who has their own.
            void load();
            onSaved();
          }}
        />
      ) : (
        <GeneralPermissions
          data={data}
          exceptions={associates.filter((associate) => associate.ownPermissions).map((a) => a.name)}
          onDirtyChange={setDirty}
          onSaved={(capabilities) => {
            setData((current) =>
              current
                ? {
                    ...current,
                    capabilities: current.capabilities.map((row) => ({
                      ...row,
                      enabled: capabilities.includes(row.capability),
                    })),
                  }
                : current,
            );
            onSaved();
          }}
        />
      )}

      {pending && (
        <ConfirmDialog
          eyebrow="Permisos"
          title="¿Descartar los cambios?"
          confirmLabel="Descartar"
          busyLabel="Descartando…"
          cancelLabel="Seguir aquí"
          onCancel={() => setPending(null)}
          onConfirm={async () => {
            setDirty(false);
            setSelection(pending);
            setPending(null);
          }}
        >
          Moviste interruptores y no los guardaste. Si sigues, se pierden y nada cambia.
        </ConfirmDialog>
      )}
    </section>
  );
}

interface GeneralPermissionsProps {
  data: PermissionsData;
  /** Associates with a list of their own, whom these switches don't reach. */
  exceptions: string[];
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (capabilities: Capability[]) => void;
}

/** The general list: what every associate without a list of their own may do. */
function GeneralPermissions({ data, exceptions, onDirtyChange, onSaved }: GeneralPermissionsProps) {
  const savedSet = useMemo(
    () => new Set(data.capabilities.filter((row) => row.enabled).map((row) => row.capability)),
    [data],
  );
  const [granted, setGranted] = useState<Set<Capability>>(() => new Set(savedSet));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const isDirty = !sameCapabilities(granted, savedSet);

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const toggle = (capability: Capability) => {
    setSavedAt(null);
    setGranted((current) => toggled(current, capability));
  };

  const handleSave = async () => {
    setSaveError(null);
    setSaving(true);

    try {
      const result = await savePermissions([...granted]);
      setSavedAt(Date.now());
      onSaved(result.capabilities);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "No se pudieron guardar los cambios.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="card permissions-intro">
        <h3>Qué puede hacer el {ROLE_LABELS.staff.toLowerCase()}</h3>
        <p>
          Estos interruptores aplican a <strong>todas las cuentas de asociado</strong>
          {exceptions.length > 0 ? (
            <>
              , salvo a quien tiene permisos propios: <strong>{joinNames(exceptions)}</strong>
            </>
          ) : null}
          . Los cambios toman efecto de inmediato, incluso si el asociado ya tiene la aplicación
          abierta, y quedan registrados en el Historial con tu nombre.
        </p>
        <p className="field-hint">
          Para darle a una sola persona permisos distintos, elige su nombre arriba.
        </p>
      </div>

      <PermissionSwitches
        offered={data.capabilities.map((row) => row.capability)}
        granted={granted}
        onToggle={toggle}
      />

      <LockedNote />

      <div className="permission-actions">
        {saveError && <p className="form-error">{saveError}</p>}
        {savedAt !== null && !isDirty && <p className="field-hint">Cambios guardados.</p>}
        <button
          type="button"
          className="btn-primary"
          disabled={!isDirty || isSaving}
          onClick={() => void handleSave()}
        >
          {isSaving ? "Guardando…" : "Guardar permisos"}
        </button>
      </div>
    </>
  );
}

interface PersonPermissionsProps {
  userId: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}

/**
 * One associate: the general list, or a list of their own.
 *
 * A list of their own is COMPLETE, not a handful of exceptions: from the moment
 * it is saved, changes to the general list stop reaching this person. That is
 * the simpler rule to hold in your head — «sigue los generales» or «tiene los
 * suyos» — and the switches that differ from the general list are marked, so
 * what makes this person different is visible at a glance.
 */
function PersonPermissions({ userId, onDirtyChange, onSaved }: PersonPermissionsProps) {
  const [data, setData] = useState<PersonPermissionsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<PersonChoice | null>(null);
  const [choice, setChoice] = useState<PersonChoice | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    fetchPersonPermissions(userId)
      .then((loaded) => {
        const own = new Set(loaded.capabilities.filter((row) => row.enabled).map((row) => row.capability));
        const initial: PersonChoice = { mode: loaded.mode, own };
        setData(loaded);
        setSaved(initial);
        setChoice(initial);
      })
      .catch((caught: unknown) =>
        setLoadError(
          caught instanceof Error ? caught.message : "No se pudieron cargar sus permisos.",
        ),
      );
  }, [userId]);

  const general = useMemo(
    () => new Set(data?.capabilities.filter((row) => row.general).map((row) => row.capability)),
    [data],
  );

  const isDirty = saved !== null && choice !== null && personChoiceChanged(saved, choice);

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  // Leaving with nothing saved must not leave the page thinking it is dirty.
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  if (loadError) {
    return (
      <div className="card">
        <p className="form-error">{loadError}</p>
      </div>
    );
  }

  if (!data || !choice || !saved) {
    return (
      <div className="card">
        <p className="state-message">Cargando sus permisos…</p>
      </div>
    );
  }

  const name = data.user.name;
  const offered = data.capabilities.map((row) => row.capability);
  const differences = differencesFromGeneral(choice, general, offered);

  const chooseMode = (mode: PermissionMode) => {
    setSavedAt(null);
    setChoice((current) => {
      if (!current || current.mode === mode) {
        return current;
      }
      // Starting a list of their own from what they can do today, so choosing
      // «Permisos propios» changes nothing until a switch moves.
      return mode === "own" ? { mode, own: new Set(general) } : { ...current, mode };
    });
  };

  const toggle = (capability: Capability) => {
    setSavedAt(null);
    setChoice((current) =>
      current && current.mode === "own" ? { ...current, own: toggled(current.own, capability) } : current,
    );
  };

  const handleSave = async () => {
    setSaveError(null);
    setSaving(true);

    try {
      const result = await savePersonPermissions(
        userId,
        choice.mode === "own" ? { mode: "own", capabilities: [...choice.own] } : { mode: "general" },
      );
      const next: PersonChoice = {
        mode: result.mode,
        own: result.mode === "own" ? new Set(result.capabilities) : choice.own,
      };
      setSaved(next);
      setChoice(next);
      setSavedAt(Date.now());
      onSaved();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "No se pudieron guardar los cambios.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="card permissions-intro">
        <h3>Qué puede hacer {name}</h3>
        <fieldset className="permission-mode">
          <legend className="sr-only">De dónde salen sus permisos</legend>
          <label className="settlement-option">
            <input
              type="radio"
              name="permission-mode"
              checked={choice.mode === "general"}
              onChange={() => chooseMode("general")}
            />
            <span>
              <span className="settlement-title">Los permisos generales</span>
              <span className="settlement-detail">
                Lo mismo que todos los asociados. Si cambias los generales, {name} cambia con ellos.
              </span>
            </span>
          </label>
          <label className="settlement-option">
            <input
              type="radio"
              name="permission-mode"
              checked={choice.mode === "own"}
              onChange={() => chooseMode("own")}
            />
            <span>
              <span className="settlement-title">Permisos propios</span>
              <span className="settlement-detail">
                Solo para {name}. Desde que guardes, los cambios a los generales ya no le llegan.
              </span>
            </span>
          </label>
        </fieldset>
        {choice.mode === "own" && (
          <p className="field-hint permission-mode-summary">
            {differences.length === 0
              ? "Por ahora igual que los generales. Mueve los interruptores que quieras cambiar."
              : differences.length === 1
                ? "1 permiso distinto de los generales, marcado abajo."
                : `${differences.length} permisos distintos de los generales, marcados abajo.`}
          </p>
        )}
      </div>

      <PermissionSwitches
        offered={offered}
        granted={effectiveCapabilities(choice, general)}
        general={choice.mode === "own" ? general : undefined}
        readOnly={choice.mode === "general"}
        onToggle={toggle}
      />

      <LockedNote />

      <div className="permission-actions">
        {saveError && <p className="form-error">{saveError}</p>}
        {savedAt !== null && !isDirty && <p className="field-hint">Cambios guardados.</p>}
        <button
          type="button"
          className="btn-primary"
          disabled={!isDirty || isSaving}
          onClick={() => void handleSave()}
        >
          {isSaving ? "Guardando…" : `Guardar permisos de ${name}`}
        </button>
      </div>
    </>
  );
}

interface PermissionSwitchesProps {
  offered: Capability[];
  granted: ReadonlySet<Capability>;
  /** The general list, to mark what a person's own list does differently. */
  general?: ReadonlySet<Capability>;
  /** Shown but not movable: a person who follows the general list. */
  readOnly?: boolean;
  onToggle: (capability: Capability) => void;
}

/** The switches, grouped the way the work is thought about. */
function PermissionSwitches({ offered, granted, general, readOnly = false, onToggle }: PermissionSwitchesProps) {
  const offeredSet = new Set(offered);

  /*
   * Anything the server offers that the list of descriptions has never heard
   * of.
   *
   * `CAPABILITY_GROUPS` is written by hand, and the failure it invites is
   * silent: add a capability to the server and forget the entry there, and the
   * switch simply does not exist. Nobody sees a gap — they see a
   * complete-looking page — and the new power stays permanently off for the
   * associate while appearing to nobody as a decision. That is the same class
   * of bug as a permission that looks granted and is not.
   *
   * So an undescribed capability is shown rather than dropped. It reads badly
   * on purpose — a raw `payment:edit` next to a plea for a proper label is
   * exactly the nudge needed — but the supervisor can still grant it, and it
   * cannot go missing.
   */
  const described = new Set(CAPABILITY_GROUPS.flatMap((group) => group.items.map((item) => item.capability)));
  const undescribed = offered.filter((capability) => !described.has(capability));

  const groups =
    undescribed.length === 0
      ? CAPABILITY_GROUPS
      : [
          ...CAPABILITY_GROUPS,
          {
            title: "Otros permisos",
            description:
              "Permisos que el servidor ofrece y que esta pantalla todavía no sabe describir. " +
              "Funcionan igual; solo les falta un nombre en español.",
            items: undescribed.map((capability) => ({ capability, label: capability, hint: undefined })),
          },
        ];

  return (
    <>
      {groups.map((group) => {
        const items = group.items.filter((item) => offeredSet.has(item.capability));

        if (items.length === 0) {
          return null;
        }

        return (
          <div key={group.title} className="card permission-group">
            <header className="permission-group-head">
              <h3>{group.title}</h3>
              <p className="field-hint">{group.description}</p>
            </header>

            <ul className="permission-list">
              {items.map((item) => {
                const isOn = granted.has(item.capability);
                const differs = general !== undefined && isOn !== general.has(item.capability);

                return (
                  <li key={item.capability}>
                    <label
                      className={[
                        "permission-row",
                        differs ? "is-different" : "",
                        readOnly ? "is-readonly" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <input
                        type="checkbox"
                        className="permission-switch"
                        checked={isOn}
                        disabled={readOnly}
                        onChange={() => onToggle(item.capability)}
                      />
                      <span className="permission-text">
                        <span className="permission-label">{item.label}</span>
                        {item.hint && <span className="field-hint">{item.hint}</span>}
                        {differs && (
                          <span className="permission-differs">
                            Distinto de los generales: los demás asociados{" "}
                            {isOn ? "no pueden." : "sí pueden."}
                          </span>
                        )}
                      </span>
                      <span className={isOn ? "stamp success" : "stamp neutral"}>
                        {isOn ? "Permitido" : "Bloqueado"}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </>
  );
}

/** What never leaves the supervisor, said on every view of this screen. */
function LockedNote() {
  return (
    <div className="card permission-locked">
      <h3>Siempre del supervisor</h3>
      <p className="field-hint">
        Gestionar usuarios y editar estos permisos no se pueden ceder, ni en general ni a una
        persona. Si un asociado pudiera editar permisos, podría concederse todo lo demás a sí
        mismo — incluida la cuenta que tendría que quitárselo. Tampoco se cede cambiar la mora ni
        apagarla, ni en la configuración general ni en un contrato.
      </p>
    </div>
  );
}

function toggled(current: ReadonlySet<Capability>, capability: Capability): Set<Capability> {
  const next = new Set(current);
  if (next.has(capability)) {
    next.delete(capability);
  } else {
    next.add(capability);
  }
  return next;
}

/** «Ana», «Ana y Luis», «Ana, Luis y Marta». */
function joinNames(names: string[]): string {
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}
