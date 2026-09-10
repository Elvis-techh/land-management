import { useEffect, useState } from "react";

import { formatRate, formatRateInput, parseMoneyInput } from "../../lib/money";
import type { ExchangeRate } from "./api";
import { setManualRate, setRateAdjustment, useMarketRate } from "./api";

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
  const [adjustmentDraft, setAdjustmentDraft] = useState(() => String(rate.adjustmentPercent));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  // Follow the rate if it changes underneath — a scheduled refresh, or another
  // save — as long as the user is not midway through typing their own.
  useEffect(() => {
    setDraft(formatRateInput(formatRate(rate.rate)));
  }, [rate.rate]);

  useEffect(() => {
    setAdjustmentDraft(String(rate.adjustmentPercent));
  }, [rate.adjustmentPercent]);

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

  const handleAdjust = () => {
    const percent = Number(adjustmentDraft.replace(",", ".").trim());

    if (!Number.isFinite(percent)) {
      setError("Escribe el ajuste como un porcentaje, por ejemplo 0.33.");
      return;
    }

    void run(() => setRateAdjustment(percent));
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
        <p className="field-hint">
          Tomada de {rate.provider}
          {/*
            Both numbers, whenever they differ. An adjustment nobody can see is
            indistinguishable from a feed that is simply wrong — and the next
            person to ask why Lindero says one thing and a search says another
            gets the answer on the same screen as the question.
          */}
          {rate.providerRate !== null && rate.adjustmentPercent !== 0 && (
            <>
              {" "}
              a L. {formatRate(rate.providerRate)}, más un ajuste de{" "}
              {rate.adjustmentPercent > 0 ? "+" : ""}
              {rate.adjustmentPercent} %
            </>
          )}
          .
        </p>
      )}

      {rate.source === "manual" && rate.adjustmentPercent !== 0 && (
        <p className="field-hint">
          El ajuste de {rate.adjustmentPercent > 0 ? "+" : ""}
          {rate.adjustmentPercent} % está guardado, pero no se aplica a una tasa escrita a
          mano. Vuelve a automática para que cuente.
        </p>
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
          {/*
            Two fields, and the difference between them is the whole point.

            The first overrides the feed and freezes it: the number typed is the
            number shown, until somebody asks for automatic again. The second
            stays pinned to the feed and travels with it. "The market moved and
            nobody told us" wants the first; "the market rate is not the number
            people here quote" wants the second, and using the first for it
            means retyping a rate by hand every morning forever.
          */}
          <div className="rate-edit">
            <label htmlFor="rate-input">Lempiras por dólar</label>
            <div className="rate-edit-row">
              <input
                id="rate-input"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={draft}
                onChange={(event) => setDraft(formatRateInput(event.target.value))}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={isSaving}
                onClick={handleSave}
              >
                {isSaving ? "Guardando…" : "Guardar"}
              </button>
            </div>
            <span className="field-hint">
              Escribirla la fija: deja de seguir al mercado hasta que alguien pida lo
              contrario.
            </span>
          </div>

          <div className="rate-edit">
            <label htmlFor="rate-adjustment">Ajuste sobre la tasa del mercado (%)</label>
            <div className="rate-edit-row">
              <input
                id="rate-adjustment"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={adjustmentDraft}
                onChange={(event) => setAdjustmentDraft(event.target.value)}
              />
              <button
                type="button"
                className="btn-secondary"
                disabled={isSaving}
                onClick={handleAdjust}
              >
                Guardar ajuste
              </button>
            </div>
            <span className="field-hint">
              El proveedor publica la tasa del mercado, y un banco compra y vende a los lados
              de ella. Un porcentaje, no una cantidad, para que siga significando lo mismo
              cuando la tasa se mueva: con 0.33 %, una tasa de 26.8118 se muestra como
              26.9003.
            </span>
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
