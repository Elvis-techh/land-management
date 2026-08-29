import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { AREA_UNITS, AREA_UNIT_INFO } from "../../lib/area";
import type { AreaUnit } from "../../lib/area";
import type { Project } from "../../types";

interface ProjectFormDialogProps {
  /** `null` creates a new project; a project edits that one. */
  project: Project | null;
  onCancel: () => void;
  onSave: (draft: { name: string; areaUnit: AreaUnit }) => Promise<void>;
}

/**
 * Create or edit a project. One dialog for both, because the fields are
 * identical — the only difference is what it is called and what it starts with.
 */
export function ProjectFormDialog({ project, onCancel, onSave }: ProjectFormDialogProps) {
  const [name, setName] = useState(project?.name ?? "");
  const [areaUnit, setAreaUnit] = useState<AreaUnit>(project?.areaUnit ?? "m2");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const isEditing = project !== null;
  const unitChanged = isEditing && areaUnit !== project.areaUnit;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("El nombre del proyecto es obligatorio.");
      return;
    }

    setSaving(true);

    try {
      await onSave({ name: name.trim(), areaUnit });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo guardar el proyecto.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog ariaLabel={isEditing ? `Editar ${project.name}` : "Nuevo proyecto"} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">{isEditing ? "Editar proyecto" : "Nuevo proyecto"}</p>
            <h2>{name.trim() || "Sin nombre"}</h2>
            <p className="modal-description">
              La unidad decide cómo se escriben y se leen las áreas de sus lotes.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <div className="form-field full-width">
            <label htmlFor="project-name">Nombre</label>
            <input
              id="project-name"
              value={name}
              placeholder="Ej. Villa Lindero"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="form-field full-width">
            <label htmlFor="project-unit">Unidad de área</label>
            <select
              id="project-unit"
              value={areaUnit}
              onChange={(event) => setAreaUnit(event.target.value as AreaUnit)}
            >
              {AREA_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {AREA_UNIT_INFO[unit].label}
                </option>
              ))}
            </select>
            <span className="field-hint">
              Los lotes de este proyecto se capturan y se muestran en esta unidad.
            </span>
          </div>

          {unitChanged && (
            <p className="form-blocked full-width">
              Cambiar la unidad no altera el tamaño de ningún lote. Las áreas se guardan
              siempre en metros cuadrados; solo cambia cómo se escriben en pantalla — los{" "}
              {project.lotCount} lote{project.lotCount === 1 ? "" : "s"} de {project.name}{" "}
              seguirán midiendo exactamente lo mismo.
            </p>
          )}

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary modal-submit" disabled={isSaving}>
            <span>
              {isSaving ? "Guardando…" : isEditing ? "Guardar cambios" : "Crear proyecto"}
            </span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
