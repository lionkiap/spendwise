/**
 * Adviser operations: pure, deterministic spending analysis and goal impact
 * arithmetic for the conversation layer in conversation.ts.
 *
 * Every function here is pure: no clock reads, no randomness, no locale
 * formatting. Inputs are caller-supplied ledger rows and tracked goals; every
 * output number is plain arithmetic on those inputs. Coverage is honest by
 * construction: a month with no records reports hasRecords false and its note
 * says spending for that month is unknown, never zero, because the ledger is a
 * log of what the user recorded, not a measure of everything they spent.
 *
 * The ledger input type is LedgerEntry from src/lib/cards/types. The UI's
 * LedgerRow (src/app/components/shared) extends LedgerEntry with an optional
 * merchant label, so any LedgerRow array is structurally an array of
 * LedgerEntry and passes straight through; importing app code into src/lib
 * would invert the layering, so ops speaks the lib-side type.
 */
import type { ExpenseCategory, LedgerEntry } from '../cards/types';
import { monthsToTarget, type TrackedGoal } from '../planner/progress';

/** Display labels for expense categories, mirroring the UI's CATEGORIES table. */
export const CATEGORY_LABELS: Readonly<Record<ExpenseCategory, string>> = {
  groceries: 'Groceries',
  dining: 'Dining',
  online_shopping: 'Online shopping',
  transport: 'Transport',
  petrol: 'Petrol',
  travel: 'Travel',
  utilities: 'Utilities',
  entertainment: 'Entertainment',
  insurance: 'Insurance',
  education: 'Education',
  medical: 'Medical',
  other: 'Other',
};

/**
 * Deterministic SGD formatting with no locale dependence: grouping commas,
 * two decimals, trailing ".00" trimmed. Mirrors the client formatter in
 * src/app/components/shared so engine strings and UI strings agree.
 */
export function formatSgd(amount: number): string {
  if (!Number.isFinite(amount)) {
    return 'S$?';
  }
  const rounded = Math.round(amount * 100) / 100;
  const negative = rounded < 0;
  const fixed = Math.abs(rounded).toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  let grouped = '';
  for (let index = 0; index < intPart.length; index += 1) {
    if (index > 0 && (intPart.length - index) % 3 === 0) {
      grouped += ',';
    }
    grouped += intPart[index];
  }
  const decimals = decPart === '00' ? '' : `.${decPart}`;
  return `${negative ? '-' : ''}S$${grouped}${decimals}`;
}

/** Note explaining that a month without records is unknown, not zero. */
export function noRecordsNote(monthKey: string): string {
  return `No records are logged for ${monthKey}. Spending for that month is unknown, not zero.`;
}

/* ---------------------------------------------------------------------- */
/* spendingByCategory                                                     */
/* ---------------------------------------------------------------------- */

/** One category's recorded total for a month. */
export interface CategorySpendRow {
  category: ExpenseCategory;
  total: number;
  count: number;
}

/** Recorded spending for one month, with honest coverage. */
export interface MonthSpendSummary {
  monthKey: string;
  /** Categories with at least one record this month, sorted by total desc then category asc. */
  rows: CategorySpendRow[];
  /** Sum of row totals. Zero when hasRecords is false, and then it means unknown. */
  monthTotal: number;
  transactionCount: number;
  /** False when the month has zero rows; consumers must treat that as unknown. */
  hasRecords: boolean;
  /** The coverage sentence to show next to any figure derived from this summary. */
  coverageNote: string;
}

/**
 * Recorded spending by category for one month.
 *
 * Formula: rows = for each category c with at least one ledger entry whose
 * monthKey equals the requested month, { category: c, total: sum of
 * amountSgd, count: number of entries }, sorted by total descending with
 * category name ascending as the tie-break so the order is deterministic.
 * monthTotal = sum of row totals, transactionCount = entries this month,
 * hasRecords = rows is nonempty. When hasRecords is false every consumer must
 * treat the month as unknown, never as zero spending; coverageNote says so.
 */
export function spendingByCategory(
  ledger: ReadonlyArray<LedgerEntry>,
  monthKey: string
): MonthSpendSummary {
  const totals = new Map<ExpenseCategory, { total: number; count: number }>();
  let transactionCount = 0;
  for (const entry of ledger) {
    if (entry.monthKey !== monthKey) {
      continue;
    }
    if (!Number.isFinite(entry.amountSgd)) {
      continue;
    }
    transactionCount += 1;
    const current = totals.get(entry.category);
    if (current === undefined) {
      totals.set(entry.category, { total: entry.amountSgd, count: 1 });
    } else {
      current.total += entry.amountSgd;
      current.count += 1;
    }
  }
  const rows: CategorySpendRow[] = [...totals.entries()].map(([category, value]) => ({
    category,
    total: value.total,
    count: value.count,
  }));
  rows.sort((a, b) =>
    b.total !== a.total
      ? b.total - a.total
      : a.category < b.category
        ? -1
        : a.category > b.category
          ? 1
          : 0
  );
  const monthTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const hasRecords = rows.length > 0;
  return {
    monthKey,
    rows,
    monthTotal,
    transactionCount,
    hasRecords,
    coverageNote: hasRecords
      ? `Figures cover the ${transactionCount} record${transactionCount === 1 ? '' : 's'} logged for ${monthKey}. Logged records may not be all spending.`
      : noRecordsNote(monthKey),
  };
}

/* ---------------------------------------------------------------------- */
/* monthComparison                                                        */
/* ---------------------------------------------------------------------- */

/** Both months must carry at least this many records to compare at all. */
export const MIN_RECORDS_FOR_COMPARISON = 3;

/** Caveat attached to every comparable result. */
export const COMPARISON_CAVEAT =
  'This comparison covers logged records only. Logged records may not be all spending, so a lower total means less was logged, not necessarily less was spent.';

/** Per-category delta between two months. delta is monthB minus monthA. */
export interface CategoryComparisonRow {
  category: ExpenseCategory;
  totalA: number;
  totalB: number;
  /** monthB total minus monthA total; positive means the later month logged more. */
  delta: number;
  countA: number;
  countB: number;
}

export type MonthComparisonResult =
  | {
      comparable: false;
      /** Why the comparison refused, naming the record counts of both months. */
      reason: string;
      monthKeyA: string;
      monthKeyB: string;
      countA: number;
      countB: number;
    }
  | {
      comparable: true;
      caveat: string;
      monthKeyA: string;
      monthKeyB: string;
      /** Union of both months' categories, sorted by abs delta desc then category asc. */
      rows: CategoryComparisonRow[];
      totalA: number;
      totalB: number;
      /** monthB total minus monthA total. */
      totalDelta: number;
      transactionCountA: number;
      transactionCountB: number;
    };

/**
 * Compare two recorded months.
 *
 * Formula: summaryA = spendingByCategory(ledger, monthKeyA), summaryB =
 * spendingByCategory(ledger, monthKeyB). comparable = summaryA and summaryB
 * both have transactionCount >= MIN_RECORDS_FOR_COMPARISON; when either month
 * has fewer records the result is { comparable: false } with a reason naming
 * both counts, because a one or two record month says nothing reliable about
 * change. When comparable, rows cover the union of categories, each delta is
 * totalB - totalA, totalDelta is monthTotalB - monthTotalA and caveat states
 * that logged records may not be all spending.
 */
export function monthComparison(
  ledger: ReadonlyArray<LedgerEntry>,
  monthKeyA: string,
  monthKeyB: string
): MonthComparisonResult {
  const summaryA = spendingByCategory(ledger, monthKeyA);
  const summaryB = spendingByCategory(ledger, monthKeyB);
  if (summaryA.transactionCount < MIN_RECORDS_FOR_COMPARISON ||
      summaryB.transactionCount < MIN_RECORDS_FOR_COMPARISON) {
    return {
      comparable: false,
      reason:
        `Not enough history to compare ${monthKeyA} and ${monthKeyB}: ${monthKeyA} has ${summaryA.transactionCount} logged record${summaryA.transactionCount === 1 ? '' : 's'} and ${monthKeyB} has ${summaryB.transactionCount}. Both months need at least ${MIN_RECORDS_FOR_COMPARISON} records for an honest comparison.`,
      monthKeyA,
      monthKeyB,
      countA: summaryA.transactionCount,
      countB: summaryB.transactionCount,
    };
  }
  const categories = new Set<ExpenseCategory>([
    ...summaryA.rows.map((row) => row.category),
    ...summaryB.rows.map((row) => row.category),
  ]);
  const rows: CategoryComparisonRow[] = [...categories].map((category) => {
    const rowA = summaryA.rows.find((row) => row.category === category);
    const rowB = summaryB.rows.find((row) => row.category === category);
    const totalA = rowA?.total ?? 0;
    const totalB = rowB?.total ?? 0;
    return {
      category,
      totalA,
      totalB,
      delta: totalB - totalA,
      countA: rowA?.count ?? 0,
      countB: rowB?.count ?? 0,
    };
  });
  rows.sort((a, b) => {
    const absDeltaDiff = Math.abs(b.delta) - Math.abs(a.delta);
    if (absDeltaDiff !== 0) {
      return absDeltaDiff;
    }
    return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
  });
  return {
    comparable: true,
    caveat: COMPARISON_CAVEAT,
    monthKeyA,
    monthKeyB,
    rows,
    totalA: summaryA.monthTotal,
    totalB: summaryB.monthTotal,
    totalDelta: summaryB.monthTotal - summaryA.monthTotal,
    transactionCountA: summaryA.transactionCount,
    transactionCountB: summaryB.transactionCount,
  };
}

/* ---------------------------------------------------------------------- */
/* reducibleCategories                                                    */
/* ---------------------------------------------------------------------- */

/** Default cap: a proposal may cut at most 25 percent of the category month total. */
export const DEFAULT_MAX_CUT_FRACTION = 0.25;
/** Proposed cuts are rounded down to a multiple of this many dollars. */
export const CUT_ROUNDING_SGD = 10;

export interface ReducibleOptions {
  /**
   * Maximum share of a category's recorded month total one proposal may cut.
   * Clamped to (0, 1]; non-finite or non-positive values fall back to the
   * default 0.25.
   */
  maxCutFraction?: number;
}

/** One reduction proposal against one category's recorded month total. */
export interface ReduceProposal {
  category: ExpenseCategory;
  /** Recorded month total for the category (logged records only). */
  monthTotal: number;
  /** Proposed monthly cut, a multiple of 10, at most maxCutFraction of monthTotal. */
  proposedCut: number;
  /** Money freed per month by the cut; equal to proposedCut by definition. */
  freedMonthly: number;
  /** Plain-word rationale carrying the exact figures and the coverage caveat. */
  rationale: string;
}

/** Reduction proposals for a month, honest about coverage and caps. */
export interface ReducibleResult {
  monthKey: string;
  hasRecords: boolean;
  protectedCategories: ReadonlyArray<ExpenseCategory>;
  /** Sum of the month totals of all non-protected categories with records. */
  reducibleTotal: number;
  /** Sum of proposedCut across proposals; never exceeds reducibleTotal. */
  totalProposedCut: number;
  maxCutFraction: number;
  /** Sorted by proposedCut desc then category asc. */
  proposals: ReduceProposal[];
  coverageNote: string;
}

/**
 * Propose reducible spending for a month.
 *
 * Formula: rows = spendingByCategory(ledger, monthKey).rows excluding every
 * protected category. fraction = clamped maxCutFraction. For each row,
 * proposedCut = floor(row.total * fraction / 10) * 10, kept only when >= 10.
 * A running guard caps the cumulative cuts at reducibleTotal (re-floored to a
 * multiple of 10), so the sum of proposed cuts can never exceed the recorded
 * reducible total even if a caller passes fraction 1. freedMonthly equals
 * proposedCut. Every rationale states the recorded total, the cap share and
 * that logged records may not be all spending.
 */
export function reducibleCategories(
  ledger: ReadonlyArray<LedgerEntry>,
  monthKey: string,
  protectedCategories: ReadonlyArray<ExpenseCategory>,
  opts?: ReducibleOptions
): ReducibleResult {
  const rawFraction = opts?.maxCutFraction;
  const fraction =
    rawFraction !== undefined && Number.isFinite(rawFraction) && rawFraction > 0
      ? Math.min(rawFraction, 1)
      : DEFAULT_MAX_CUT_FRACTION;
  const summary = spendingByCategory(ledger, monthKey);
  const candidates = summary.rows.filter(
    (row) => !protectedCategories.includes(row.category) && row.total > 0
  );
  const reducibleTotal = candidates.reduce((sum, row) => sum + row.total, 0);
  const proposals: ReduceProposal[] = [];
  let remaining = reducibleTotal;
  const percentLabel = `${(fraction * 100).toFixed(fraction * 100 % 1 === 0 ? 0 : 1)} percent`;
  for (const row of candidates) {
    const rawCut = Math.floor((row.total * fraction) / CUT_ROUNDING_SGD) * CUT_ROUNDING_SGD;
    const capped = Math.min(rawCut, Math.floor(remaining / CUT_ROUNDING_SGD) * CUT_ROUNDING_SGD);
    if (capped < CUT_ROUNDING_SGD) {
      continue;
    }
    remaining -= capped;
    proposals.push({
      category: row.category,
      monthTotal: row.total,
      proposedCut: capped,
      freedMonthly: capped,
      rationale:
        `Trim ${CATEGORY_LABELS[row.category]} by up to ${formatSgd(capped)} a month: at most ${percentLabel} of the ${formatSgd(row.total)} logged this month, freed gradually rather than all at once. Figures come from logged records only and logged records may not be all spending.`,
    });
  }
  proposals.sort((a, b) =>
    b.proposedCut !== a.proposedCut
      ? b.proposedCut - a.proposedCut
      : a.category < b.category
        ? -1
        : a.category > b.category
          ? 1
          : 0
  );
  const totalProposedCut = proposals.reduce((sum, proposal) => sum + proposal.proposedCut, 0);
  return {
    monthKey,
    hasRecords: summary.hasRecords,
    protectedCategories,
    reducibleTotal,
    totalProposedCut,
    maxCutFraction: fraction,
    proposals,
    coverageNote: summary.coverageNote,
  };
}

/* ---------------------------------------------------------------------- */
/* goalImpactWithExtra                                                    */
/* ---------------------------------------------------------------------- */

/** Before and after timeline of one goal under extra monthly saving. */
export interface GoalImpact {
  /** Months to target at the goal's frozen required pace; null when it never lands. */
  monthsBefore: number | null;
  /** Months to target at required pace plus extraMonthlySgd; null when it never lands. */
  monthsAfter: number | null;
  finishAgeBefore: number | null;
  finishAgeAfter: number | null;
}

/**
 * Impact of saving extra each month on a tracked goal.
 *
 * Formula: monthsBefore = monthsToTarget(goal.startSavingsSgd, goal.ratePa,
 * goal.requiredMonthlySgd, goal.targetSgd) and monthsAfter is the same call
 * with goal.requiredMonthlySgd + extraMonthlySgd, so the numbers match
 * monthsToTarget directly. finishAge = goal.startAge + months / 12, kept
 * exact; formatting is a facts-layer concern. Every null propagates: when
 * either pace never lands within the monthsToTarget horizon the matching
 * months and finishAge are null and no figure is invented.
 */
export function goalImpactWithExtra(goal: TrackedGoal, extraMonthlySgd: number): GoalImpact {
  const monthsBefore = monthsToTarget(
    goal.startSavingsSgd,
    goal.ratePa,
    goal.requiredMonthlySgd,
    goal.targetSgd
  );
  const monthsAfter = monthsToTarget(
    goal.startSavingsSgd,
    goal.ratePa,
    goal.requiredMonthlySgd + extraMonthlySgd,
    goal.targetSgd
  );
  return {
    monthsBefore,
    monthsAfter,
    finishAgeBefore: monthsBefore === null ? null : goal.startAge + monthsBefore / 12,
    finishAgeAfter: monthsAfter === null ? null : goal.startAge + monthsAfter / 12,
  };
}

/* ---------------------------------------------------------------------- */
/* oneOffImpact                                                           */
/* ---------------------------------------------------------------------- */

/** Impact of a one-off expense paid out of a goal's pot. */
export interface OneOffImpact {
  /** Months the target moves out because the pot paid for the one-off; null when the frozen pace never lands. */
  monthsOfDelay: number | null;
  /** True when more than one tracked goal shares this space's pot. */
  sharedPotWarning: boolean;
  /** Plain-word note carrying the model of the delay and the honest warnings. */
  note: string;
}

/**
 * Delay caused by a one-off expense against a goal's pot, at the goal's own
 * rates.
 *
 * Formula: monthsBefore = monthsToTarget(start, rate, required, target);
 * monthsAfter = monthsToTarget(max(0, start - amountSgd), rate, required,
 * target); monthsOfDelay = monthsAfter - monthsBefore, null when either is
 * null (the pace never lands). Because monthsToTarget grows the pot with
 * fvLump at goal.ratePa, the delay compounds at the goal's own rate. Negative
 * amounts are treated as zero. sharedPotWarning is true when goalsInSpace
 * (default just the goal itself) holds more than one goal in the same space
 * as this one, where space defaults to 'you' as everywhere else; the note
 * then states that the same savings cannot fund two goals at once.
 */
export function oneOffImpact(
  goal: TrackedGoal,
  amountSgd: number,
  goalsInSpace: ReadonlyArray<TrackedGoal> = [goal]
): OneOffImpact {
  const amount = Number.isFinite(amountSgd) && amountSgd > 0 ? amountSgd : 0;
  const space = goal.space ?? 'you';
  const goalsSharing = goalsInSpace.filter((other) => (other.space ?? 'you') === space);
  const sharedPotWarning = goalsSharing.length > 1;
  const monthsBefore = monthsToTarget(
    goal.startSavingsSgd,
    goal.ratePa,
    goal.requiredMonthlySgd,
    goal.targetSgd
  );
  const potAfter = Math.max(0, goal.startSavingsSgd - amount);
  const monthsAfter = monthsToTarget(
    potAfter,
    goal.ratePa,
    goal.requiredMonthlySgd,
    goal.targetSgd
  );
  const monthsOfDelay =
    monthsBefore === null || monthsAfter === null ? null : monthsAfter - monthsBefore;
  const sentences: string[] = [];
  if (monthsOfDelay === null) {
    sentences.push(
      `The goal's frozen pace never reaches ${formatSgd(goal.targetSgd)}, so a one-off expense cannot be translated into a delay in months.`
    );
  } else {
    sentences.push(
      `A one-off ${formatSgd(amount)} paid out of the goal pot is modelled by removing it from the ${formatSgd(goal.startSavingsSgd)} starting savings and re-solving at the goal's own ${formatSgd(goal.requiredMonthlySgd)} monthly pace, which pushes the target ${monthsOfDelay} month${monthsOfDelay === 1 ? '' : 's'} later.`
    );
  }
  sentences.push(
    'This is an approximation: the pace, rate and target stay exactly as frozen when the goal was tracked.'
  );
  if (sharedPotWarning) {
    sentences.push(
      `The same savings cannot fund two goals at once: ${goalsSharing.length} tracked goals share the ${space} space's pot.`
    );
  }
  return { monthsOfDelay, sharedPotWarning, note: sentences.join(' ') };
}
