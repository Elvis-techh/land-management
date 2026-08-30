/**
 * The schedule arithmetic a contract needs BEFORE the server has seen it.
 *
 * Everywhere else the frontend simply reads these figures off the API, because
 * the server recomputes them on every read (backend/src/lib/contracts.ts). A
 * contract that is still being typed does not exist yet, so the "Nuevo
 * contrato" form has to work them out itself to answer the two questions
 * somebody asks while filling it in: when does the first cuota fall due, and
 * what does the last one come to?
 *
 * These are a deliberate MIRROR of `addMonthsOnDay`, `firstDueDate` and
 * `buildSchedule` on the server, held to the same rules so the preview and the
 * contract that gets saved cannot disagree. The server stays the authority —
 * the moment the contract is created the screen re-reads it rather than
 * trusting a single number computed here.
 */

/*
 * Dates are handled as UTC milliseconds throughout, exactly as they are on the
 * server. Parsing "2026-03-05" with `new Date()` in a browser set to
 * Tegucigalpa yields the 4th at 18:00 local, and a due date that moves
 * depending on where the code runs is not a due date.
 */

function daysInMonth(year: number, monthIndex: number): number {
  // Day 0 of the following month is the last day of this one.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * The same day-of-month, `months` later, clamped to months too short to have
 * one.
 *
 * A due day of the 31st still falls due in February, and it falls due on the
 * 28th. Letting the date roll forward into March instead — which is what naive
 * month arithmetic does — would quietly grant an extra three days every
 * February and put the preview out of step with the schedule the server builds.
 */
export function addMonthsOnDay(isoDate: string, months: number, day: number): string {
  // Month overflow past December rolls the year over on its own.
  const target = new Date(
    Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1 + months, 1),
  );
  const year = target.getUTCFullYear();
  const month = target.getUTCMonth();

  return new Date(Date.UTC(year, month, Math.min(day, daysInMonth(year, month))))
    .toISOString()
    .slice(0, 10);
}

/**
 * When the first installment falls due.
 *
 * Default: one whole month after signing, on the agreed due day. Signing on
 * 15 January with a due day of the 5th means the first installment is due on
 * 5 February, not three weeks after the customer handed over the prima.
 *
 * `agreed` overrides it, because this really is negotiated — "empezamos a pagar
 * en enero" is a normal thing to agree to, and no rule can guess it.
 */
export function firstDueDate(
  signedOn: string,
  dueDay: number | null,
  agreed: string | null,
): string | null {
  if (agreed) {
    return agreed;
  }

  if (dueDay === null || signedOn === "") {
    return null;
  }

  return addMonthsOnDay(signedOn, 1, dueDay);
}

/** What is financed after the prima: the part being paid in installments. */
export function financedCents(salePriceCents: number, downPaymentCents: number): number {
  return Math.max(0, salePriceCents - downPaymentCents);
}

export interface ScheduleSummary {
  /** How many installments the terms actually work out to. */
  count: number;
  /** The final one, which absorbs the rounding — often not the agreed cuota. */
  lastAmountCents: number;
  /** YYYY-MM-DD of that final installment. */
  lastDueOn: string;
}

/**
 * What the agreed cuota really produces, without building the whole schedule.
 *
 * The LAST installment absorbs the rounding, exactly as `buildSchedule` does on
 * the server: an agreed L 3,500 a month against L 84,300 financed leaves L 300
 * unaccounted for, and it is the final payment that is short or long — never a
 * fractional monthly nobody could hand over at a window.
 *
 * A cuota large enough to cover the financed amount early ends the schedule
 * early, which is why `count` is computed rather than assumed to be the term.
 */
export function summarizeSchedule(
  financed: number,
  months: number,
  monthlyCents: number,
  firstDueOn: string,
  dueDay: number,
): ScheduleSummary | null {
  if (months < 1 || monthlyCents < 1 || financed < 1) {
    return null;
  }

  let placed = 0;
  let count = 0;
  let lastAmountCents = 0;

  for (let index = 0; index < months; index += 1) {
    const isLast = index === months - 1;
    const amountCents = isLast
      ? Math.max(0, financed - placed)
      : Math.min(monthlyCents, financed - placed);

    if (amountCents <= 0 && !isLast) {
      // The agreed cuota has already covered everything financed, so the
      // remaining installments are not owed.
      break;
    }

    placed += amountCents;
    count += 1;
    lastAmountCents = amountCents;
  }

  return {
    count,
    lastAmountCents,
    lastDueOn: addMonthsOnDay(firstDueOn, count - 1, dueDay),
  };
}

/**
 * A cuota to start from: the financed amount spread over the term, rounded UP
 * to a whole lempira.
 *
 * Rounded up rather than down so the schedule can never come up short and need
 * an extra installment tacked on the end. It is only ever a starting point —
 * the cuota is negotiated, and the field stays free to type in.
 */
export function suggestMonthlyPayment(financed: number, months: number): number | null {
  if (months < 1 || financed < 1) {
    return null;
  }

  return Math.ceil(financed / months / 100) * 100;
}

/* -------------------------------------------------------------------------- */
/* Reading numbers out of form fields                                          */
/* -------------------------------------------------------------------------- */

/**
 * A whole number typed into a field, `null` when the field is blank, and `NaN`
 * when what is in it is not a whole number.
 *
 * Three outcomes rather than two, because the contract forms have to tell them
 * apart: a blank plazo on a cash sale is correct and a blank plazo on a credit
 * sale is an error, and "2.5" is neither blank nor a month count. Collapsing
 * the empty case into `NaN` would make a cash sale complain about a field it
 * does not even show.
 */
export function parseIntOrNull(value: string): number | null {
  const trimmed = value.trim();

  if (trimmed === "") {
    return null;
  }

  const parsed = Number(trimmed);

  return Number.isInteger(parsed) ? parsed : Number.NaN;
}
