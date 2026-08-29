import { useEffect, useMemo, useState } from "react";

import type { Capability } from "../../lib/permissions";
import { ROLE_LABELS } from "../../lib/permissions";
import type { PermissionsData } from "./api";
import { fetchPermissions, savePermissions } from "./api";

/**
 * How each capability reads to a person, grouped the way somebody thinks about
 * the work rather than the way the code is organised.
 *
 * Every entry says what the associate would be able to DO, in the words used
 * elsewhere in the interface — "Archivar lotes", not "lot:archive".
 */
const GROUPS: Array<{
  title: string;
  description: string;
  items: Array<{ capability: Capability; label: string; hint?: string }>;
}> = [
  {
    title: "Lotes",
    description: "El inventario de terrenos.",
    items: [
      { capability: "lot:create", label: "Crear lotes" },
      { capability: "lot:edit", label: "Editar lotes" },
      {
        capability: "lot:archive",
        label: "Archivar lotes",
        hint: "Los saca del inventario activo; nada se elimina.",
      },
    ],
  },
  {
    title: "Proyectos",
    description: "Los desarrollos que agrupan los lotes.",
    items: [
      { capability: "project:create", label: "Crear proyectos" },
      { capability: "project:edit", label: "Editar proyectos y su unidad de área" },
      { capability: "project:archive", label: "Archivar proyectos" },
    ],
  },
  {
    title: "Clientes y contratos",
    description: "El trabajo del día a día.",
    items: [
      { capability: "customer:create", label: "Registrar clientes" },
      { capability: "customer:edit", label: "Editar clientes" },
      {
        capability: "customer:delete",
        label: "Eliminar clientes",
        hint: "Solo a quien nunca ha tenido un contrato. Exige escribir un motivo.",
      },
      { capability: "contract:create", label: "Crear contratos y reservas" },
      {
        capability: "contract:edit",
        label: "Editar los términos de un contrato",
        hint: "Plazo, cuota, día de pago. Cambiar el precio exige además el permiso de precios.",
      },
      {
        capability: "contract:cancel",
        label: "Cancelar contratos",
        hint: "Libera el lote y deja el contrato en el historial.",
      },
    ],
  },
  {
    title: "Dinero",
    description: "Lo que toca los saldos. Piénsalo dos veces antes de ceder estos.",
    items: [
      { capability: "payment:record", label: "Registrar pagos" },
      {
        capability: "payment:reverse",
        label: "Reversar pagos",
        hint: "Corrige un pago mal capturado escribiendo una reversa.",
      },
      {
        capability: "price:change",
        label: "Cambiar el precio de un lote con contrato",
        hint: "Exige escribir un motivo, que queda en el historial.",
      },
      {
        capability: "rate:edit",
        label: "Cambiar la tasa de cambio",
        hint: "Solo afecta lo que se muestra en pantalla, nunca un saldo.",
      },
    ],
  },
  {
    title: "Control",
    description: "Ver lo que ha pasado en el sistema.",
    items: [
      {
        capability: "audit:view",
        label: "Ver el historial",
        hint: "Quién cambió qué, cuándo y por qué.",
      },
    ],
  },
];

interface PermissionsPageProps {
  /** Called after a successful save, so the app can re-read its own session. */
  onSaved: () => void;
}

/**
 * The supervisor's switchboard for what the associate role may do.
 *
 * Per ROLE, not per person: every associate account follows these switches, so
 * a new hire is governed by the same rules without anybody configuring them.
 */
export function PermissionsPage({ onSaved }: PermissionsPageProps) {
  const [data, setData] = useState<PermissionsData | null>(null);
  const [granted, setGranted] = useState<Set<Capability>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    fetchPermissions()
      .then((loaded) => {
        setData(loaded);
        setGranted(
          new Set(loaded.capabilities.filter((row) => row.enabled).map((row) => row.capability)),
        );
      })
      .catch((caught: unknown) =>
        setLoadError(
          caught instanceof Error ? caught.message : "No se pudieron cargar los permisos.",
        ),
      );
  }, []);

  // The saved set, for comparison — so the Guardar button can tell the
  // supervisor whether anything is actually pending.
  const savedSet = useMemo(
    () => new Set(data?.capabilities.filter((row) => row.enabled).map((row) => row.capability)),
    [data],
  );

  const isDirty =
    granted.size !== savedSet.size || [...granted].some((capability) => !savedSet.has(capability));

  const toggle = (capability: Capability) => {
    setSavedAt(null);
    setGranted((current) => {
      const next = new Set(current);
      if (next.has(capability)) {
        next.delete(capability);
      } else {
        next.add(capability);
      }
      return next;
    });
  };

  const handleSave = async () => {
    setSaveError(null);
    setSaving(true);

    try {
      const result = await savePermissions([...granted]);

      setData((current) =>
        current
          ? {
              ...current,
              capabilities: current.capabilities.map((row) => ({
                ...row,
                enabled: result.capabilities.includes(row.capability),
              })),
            }
          : current,
      );
      setSavedAt(Date.now());
      onSaved();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "No se pudieron guardar los cambios.");
    } finally {
      setSaving(false);
    }
  };

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

  const offered = new Set(data.capabilities.map((row) => row.capability));

  return (
    <section className="panel active">
      <div className="card permissions-intro">
        <h3>Qué puede hacer el {ROLE_LABELS.staff.toLowerCase()}</h3>
        <p>
          Estos interruptores aplican a <strong>todas las cuentas de asociado</strong>. Los
          cambios toman efecto de inmediato, incluso si el asociado ya tiene la aplicación
          abierta, y quedan registrados en el Historial con tu nombre.
        </p>
      </div>

      {GROUPS.map((group) => {
        const items = group.items.filter((item) => offered.has(item.capability));

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

                return (
                  <li key={item.capability}>
                    <label className="permission-row">
                      <input
                        type="checkbox"
                        className="permission-switch"
                        checked={isOn}
                        onChange={() => toggle(item.capability)}
                      />
                      <span className="permission-text">
                        <span className="permission-label">{item.label}</span>
                        {item.hint && <span className="field-hint">{item.hint}</span>}
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

      <div className="card permission-locked">
        <h3>Siempre del supervisor</h3>
        <p className="field-hint">
          Gestionar usuarios y editar estos permisos no se pueden ceder. Si el asociado pudiera
          editar permisos, podría concederse todo lo demás a sí mismo — incluida la cuenta que
          tendría que quitárselo.
        </p>
      </div>

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
    </section>
  );
}
