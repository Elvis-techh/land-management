import { useEffect, useState } from "react";

import { formatRate, formatRateInput, parseMoneyInput } from "../../lib/money";
import type { ExchangeRate } from "./api";
import { setManualRate, useMarketRate } from "./api";

interface RatePanelProps {
  rate: ExchangeRate;
  /** Only a supervisor may change it; everyone else just reads the number. */
  canEdit: boolean;
  onChanged: (rate: ExchangeRate) => void;
  onDone: () => void;
}

/** "hace 3 horas" — how old a reading is, in words. */
export function describeAge(capturedAt: string | null): string {
  if (!capturedAt) {
    return "sin actualizar";
  }

  const minutes = Math.max(0, Math.round((Date.now() - new Date(capturedAt).getTime()) / 60000));

  if (minutes < 60) {
    return minutes <= 1 ? "hace un momento" : `hace ${minutes} minutos`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return hours === 1 ? "hace una hora" : `hace ${hours} horas`;
  }

  const days = Math.round(hours / 24);
  return days === 1 ? "ayer" : `hace ${days} días`;
}

const SOURCE_LABELS: Record<ExchangeRate["source"], string> = {
  auto: "Automática",
  manual: "Manual",
  default: "Sin definir",
};

/**
 * The lempira-per-dollar rate: where it came from, how old it is, and — for a
 * supervisor — how to change it.
 *
 * It no longer has a button of its own in the header. The rate is a property of
 * showing prices in dollars, so it lives behind the USD toggle: the second tap
 * on USD opens this. That keeps one less control on a phone header that had
 * grown too wide to fit.
 */
export function RatePanel({ rate, canEdit, onChanged, onDone }: RatePanelProps) {
  const [draft, setDraft] = useState(() => formatRateInput(formatRate(rate.rate)));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  // Follow the rate if it changes underneath — a scheduled refresh, or another
  // save — as long as the user is not midway through typing their own.
  useEffect(() => {
    setDraft(formatRateInput(formatRate(rate.rate)));
  }, [rate.rate]);

  const run = async (action: () => Promise<ExchangeRate>) => {
    setError(null);
    setSaving(true);

    try {
      onChanged(await action());
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo actualizar la tasa.");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    const value = parseMoneyInput(draft);

    if (!Number.isFinite(value) || value <= 0) {
      setError("Escribe cuántos lempiras cuesta un dólar.");
      return;
    }

    void run(() => setManualRate(value));
  };

  return (
    <div className="rate-panel">
      <p className="rate-headline">
        <span className="rate-headline-value">L. {formatRate(rate.rate)}</span>
        <span className="rate-headline-unit">por dólar</span>
      </p>

      <p className="rate-panel-head">
        <strong>{SOURCE_LABELS[rate.source]}</strong>
        <span> · {describeAge(rate.capturedAt)}</span>
      </p>

      {rate.source === "auto" && rate.provider && (
        <p className="field-hint">Tomada de {rate.provider}.</p>
      )}
      {rate.source === "default" && (
        <p className="field-hint">
          Todavía no hay una tasa registrada. Se está mostrando un valor de referencia.
        </p>
      )}
      {rate.isStale && rate.source !== "default" && (
        <p className="field-hint">Esta tasa lleva más de dos días sin actualizarse.</p>
      )}

      {canEdit ? (
        <>
          <div className="rate-edit">
            <label htmlFor="rate-input">Lempiras por dólar</label>
            <input
              id="rate-input"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={draft}
              onChange={(event) => setDraft(formatRateInput(event.target.value))}
            />
          </div>

          {error && <p className="form-error">{error}</p>}

          <div className="rate-actions">
            <button
              type="button"
              className="btn-secondary"
              disabled={isSaving}
              onClick={() => void run(useMarketRate)}
            >
              Volver a automática
            </button>
            <button type="button" className="btn-primary" disabled={isSaving} onClick={handleSave}>
              {isSaving ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </>
      ) : (
        <p className="field-hint">Solo el supervisor puede cambiarla.</p>
      )}

      {/* The one thing everybody must understand about this number. */}
      <p className="rate-caveat">
        Solo para referencia visual. Cada pago guarda la tasa con la que se recibió, y los saldos
        nunca se recalculan con esta.
      </p>
    </div>
  );
}
