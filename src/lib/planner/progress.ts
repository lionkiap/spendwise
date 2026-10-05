/**
 * Tracked-goal progress math, pure like the kernels it leans on.
 *
 * A tracked goal freezes the plan's key numbers at save time (target, required
 * monthly saving, rate, starting age and savings) and then measures reality
 * against that plan month by month from the user's savings logs. Every figure
 * the dashboard shows comes from here: balances, pace, projections and the
 * chart series. No clock reads, no randomness, no locale formatting.
 */
import { fvAnnuity, fvLump } from '../kernels';
import type { Assumption, GoalSpec } from './goalspec';
import { PLANNER_DEFAULTS } from './goalspec';

/** One logged month of saving toward a goal. */
export interface SavingsLog {
  /** "YYYY-MM". */
  monthKey: string;
  /** Amount actually set aside that month. */
  contributedSgd: number;
  /** Optional free-text note. */
  note?: string;
  /**
   * Who set the money aside. Absent means 'you', so every log stored before
   * the couples feature keeps counting toward the primary profile.
   */
  contributor?: 'you' | 'partner';
}

/**
 * A plan frozen for tracking. startSavingsSgd and startAge capture the profile
 * as it was when the user pressed Track, so later profile edits never rewrite
 * history; deleting and re-tracking re-baselines the goal.
 */
export interface TrackedGoal {
  /** Stable slug id derived from the name. */
  id: string;
  /** Human name derived from the goal spec, for example "HDB resale by 28". */
  name: string;
  /** The validated goal spec the plan was built from. */
  goalSpec: GoalSpec;
  /** The cash figure the plan said must exist by the deadline. */
  targetSgd: number;
  /** The plan's required monthly saving. */
  requiredMonthlySgd: number;
  /** Annual rate the plan grew savings at (decimal, 0.018 means 1.8 percent). */
  ratePa: number;
  /** Age when tracking started. */
  startAge: number;
  /** Liquid savings when tracking started. */
  startSavingsSgd: number;
  /** Deadline age from the plan. */
  deadlineAge: number;
  /** "YYYY-MM" when tracking started. */
  startMonthKey: string;
  /**
   * Whose space this goal belongs to: 'you', 'partner' or the shared 'us'.
   * Absent means 'you', so every goal stored before the couples feature stays
   * the primary profile's. Purely informational for the UI; no function in
   * this module branches on it, the math treats all logs alike.
   */
  space?: 'you' | 'partner' | 'us';
  /** Monthly savings logs, any order; month keys unique per goal by UI design. */
  logs: SavingsLog[];
}

export type PaceStatus = 'ahead' | 'on-track' | 'behind';

/** Months between two "YYYY-MM" keys: b - a, negative when b is earlier. */
export function monthKeyDiff(a: string, b: string): number {
  const parse = (key: string): { year: number; month: number } | null => {
    const match = /^(\d{4})-(\d{2})$/.exec(key);
    if (match === null) {
      return null;
    }
    return { year: Number(match[1]), month: Number(match[2]) };
  };
  const from = parse(a);
  const to = parse(b);
  if (from === null || to === null) {
    return 0;
  }
  return (to.year - from.year) * 12 + (to.month - from.month);
}

/** A month key shifted by n months, n possibly negative. */
export function monthKeyOffset(key: string, n: number): string {
  const diff = monthKeyDiff('0000-01', key) + n;
  const total = Math.max(0, diff);
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/** Instrument rate from a plan's assumption list, defaulting when unstated. */
export function rateFromAssumptions(assumptions: ReadonlyArray<Assumption>): number {
  const found = assumptions.find((entry) => entry.field === 'instrumentRatePa');
  return found !== undefined && Number.isFinite(found.value) ? found.value : PLANNER_DEFAULTS.instrumentRatePa;
}

/** Short human name for a goal spec. */
export function goalNameFromSpec(goal: GoalSpec): string {
  if (goal.kind === 'property_purchase') {
    const label =
      goal.propertyType === 'hdb_resale'
        ? 'HDB resale'
        : goal.propertyType === 'bto'
          ? 'BTO flat'
          : 'Condo';
    return `${label} at S$${Math.round(goal.targetPriceSgd / 1000)}k by age ${goal.deadlineAge}`;
  }
  if (goal.kind === 'car_purchase') {
    return `Car at S$${Math.round(goal.priceSgd / 1000)}k by age ${goal.deadlineAge}`;
  }
  return `Save S$${Math.round(goal.targetAmountSgd / 1000)}k by age ${goal.deadlineAge}`;
}

/** Deterministic slug id for a tracked goal, de-duplicated by the caller. */
export function goalSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'goal';
}

/** Planned balance after monthIndex months of saving at the required pace. */
export function plannedBalance(goal: TrackedGoal, monthIndex: number): number {
  const months = Math.max(0, monthIndex);
  return fvLump(goal.startSavingsSgd, goal.ratePa, months / 12) + fvAnnuity(goal.requiredMonthlySgd, goal.ratePa, months);
}

/**
 * Actual balance after monthIndex months: the starting pot grown to now plus
 * every logged contribution grown from its own month to now. A log from
 * before tracking started counts as made at month zero (it is part of the pot
 * the goal began with); logs from after the queried month are ignored so the
 * figure is honest at any point on the timeline.
 */
export function actualBalance(goal: TrackedGoal, monthIndex: number): number {
  const months = Math.max(0, monthIndex);
  let balance = fvLump(goal.startSavingsSgd, goal.ratePa, months / 12);
  for (const log of goal.logs) {
    const logMonth = Math.max(0, monthKeyDiff(goal.startMonthKey, log.monthKey));
    if (logMonth > months) {
      continue;
    }
    balance += fvLump(log.contributedSgd, goal.ratePa, (months - logMonth) / 12);
  }
  return balance;
}

/** Average actual monthly contribution across elapsed months, 0 before month 1. */
export function actualPace(goal: TrackedGoal, monthIndex: number): number {
  const months = Math.max(0, monthIndex);
  if (months === 0) {
    return 0;
  }
  let total = 0;
  for (const log of goal.logs) {
    const logMonth = monthKeyDiff(goal.startMonthKey, log.monthKey);
    if (logMonth <= months) {
      total += log.contributedSgd;
    }
  }
  return total / months;
}

/**
 * Pace verdict at monthIndex: ahead by 5 percent of plan, behind below plan,
 * on-track in between. Before the first month elapses there is nothing to
 * judge, so the plan itself is on-track.
 */
export function paceStatus(goal: TrackedGoal, monthIndex: number): PaceStatus {
  const months = Math.max(0, monthIndex);
  if (months === 0) {
    return 'on-track';
  }
  const actual = actualBalance(goal, months);
  const planned = plannedBalance(goal, months);
  if (actual >= planned * 1.05) {
    return 'ahead';
  }
  if (actual >= planned) {
    return 'on-track';
  }
  return 'behind';
}

/** Balance the current average pace reaches by the deadline. */
export function projectedBalanceAtDeadline(goal: TrackedGoal, monthIndex: number): number {
  const totalMonths = Math.max(1, (goal.deadlineAge - goal.startAge) * 12);
  const pace = actualPace(goal, monthIndex);
  return fvLump(goal.startSavingsSgd, goal.ratePa, totalMonths / 12) + fvAnnuity(pace, goal.ratePa, totalMonths);
}

/**
 * Months still needed for a fixed monthly pace to reach the target, by bounded
 * month-by-month search (the annuity equation solved by iteration). Returns
 * null when the pace never gets there within 100 years.
 */
export function monthsToTarget(
  startSgd: number,
  ratePa: number,
  monthly: number,
  targetSgd: number
): number | null {
  if (targetSgd <= startSgd) {
    return 0;
  }
  if (monthly <= 0 && ratePa <= 0) {
    return null;
  }
  for (let months = 1; months <= 1200; months += 1) {
    const balance = fvLump(startSgd, ratePa, months / 12) + fvAnnuity(monthly, ratePa, months);
    if (balance >= targetSgd) {
      return months;
    }
  }
  return null;
}

/** Share of the target actually saved, capped above at 1 for display. */
export function progressRatio(goal: TrackedGoal, monthIndex: number): number {
  if (goal.targetSgd <= 0) {
    return 0;
  }
  return Math.min(actualBalance(goal, monthIndex) / goal.targetSgd, 1);
}

/**
 * Sampled planned curve and the actual points, ready for the chart: planned
 * sampled at up to 60 evenly spaced months, actual one point per elapsed month
 * that has a log or the start point.
 */
export interface ChartSeries {
  planned: Array<{ month: number; balance: number }>;
  actual: Array<{ month: number; balance: number }>;
  totalMonths: number;
}

export function chartSeries(goal: TrackedGoal, monthIndex: number, maxPlannedPoints = 60): ChartSeries {
  const totalMonths = Math.max(1, (goal.deadlineAge - goal.startAge) * 12);
  const step = Math.max(1, Math.ceil(totalMonths / maxPlannedPoints));
  const planned: Array<{ month: number; balance: number }> = [];
  for (let month = 0; month <= totalMonths; month += step) {
    planned.push({ month, balance: plannedBalance(goal, month) });
  }
  const last = planned[planned.length - 1];
  if (last === undefined || last.month !== totalMonths) {
    planned.push({ month: totalMonths, balance: plannedBalance(goal, totalMonths) });
  }
  const elapsed = Math.max(0, monthIndex);
  const actual: Array<{ month: number; balance: number }> = [{ month: 0, balance: goal.startSavingsSgd }];
  for (let month = 1; month <= elapsed; month += 1) {
    actual.push({ month, balance: actualBalance(goal, month) });
  }
  return { planned, actual, totalMonths };
}

/** Raw logged contributions per contributor inside the elapsed window. */
export interface ContributorTotals {
  you: number;
  partner: number;
}

/**
 * Raw sums of logged contributions per contributor over the elapsed window.
 *
 * Window rules match actualBalance exactly: a log dated before tracking
 * started counts (clamped to month zero), a log dated after the queried month
 * is ignored, and every log contributes its raw contributedSgd with no growth
 * applied. A log with no contributor field counts as 'you', so pre-couples
 * history lands entirely in the you bucket. Formula:
 * totals[c] = sum of log.contributedSgd where log.contributor resolves to c
 * and 0 <= clampedLogMonth(log) <= max(0, monthIndex).
 */
export function contributorTotals(goal: TrackedGoal, monthIndex: number): ContributorTotals {
  const months = Math.max(0, monthIndex);
  const totals: ContributorTotals = { you: 0, partner: 0 };
  for (const log of goal.logs) {
    const logMonth = Math.max(0, monthKeyDiff(goal.startMonthKey, log.monthKey));
    if (logMonth > months) {
      continue;
    }
    if (log.contributor === 'partner') {
      totals.partner += log.contributedSgd;
    } else {
      totals.you += log.contributedSgd;
    }
  }
  return totals;
}

/** One sampled point of a per-contributor balance line. */
export interface ContributorPoint {
  month: number;
  balance: number;
}

/** Per-contributor chart lines: pot plus that person's contributions. */
export interface ContributorChartSeries {
  you: ContributorPoint[];
  partner: ContributorPoint[];
}

/**
 * Balance of one contributor's line at monthIndex: the whole starting pot
 * grown at the plan's rate, plus only that contributor's logged contributions
 * each grown from its own month to now. Window rules match actualBalance:
 * pre-start logs count at month zero, logs after the queried month are
 * ignored, contributor-less logs belong to 'you'.
 */
function contributorBalance(
  goal: TrackedGoal,
  contributor: 'you' | 'partner',
  monthIndex: number
): number {
  const months = Math.max(0, monthIndex);
  let balance = fvLump(goal.startSavingsSgd, goal.ratePa, months / 12);
  for (const log of goal.logs) {
    const isPartner = log.contributor === 'partner';
    if (isPartner !== (contributor === 'partner')) {
      continue;
    }
    const logMonth = Math.max(0, monthKeyDiff(goal.startMonthKey, log.monthKey));
    if (logMonth > months) {
      continue;
    }
    balance += fvLump(log.contributedSgd, goal.ratePa, (months - logMonth) / 12);
  }
  return balance;
}

/**
 * Per-contributor actual lines for the chart, honest by construction.
 *
 * Semantics: BOTH series start from the same starting pot. Each line at month
 * m is contributorBalance = fvLump(startSavingsSgd, ratePa, m / 12) plus that
 * contributor's in-window logs each grown from its own month to m. So each
 * line reads as "the whole pot as if this person alone had been contributing
 * alongside the shared pot", and the identity
 * you[m] + partner[m] - fvLump(startSavingsSgd, ratePa, m / 12)
 * = actualBalance(goal, m) holds exactly at every sampled month: the two lines
 * double-count the pot once, and every log belongs to exactly one line. Label
 * the lines "pot + you" and "pot + partner", never "you's balance" alone.
 * At a zero rate the subtracted pot is startSavingsSgd itself.
 *
 * Sampling: points at months 0, step, 2 * step, ... up to the elapsed month,
 * where step = max(1, ceil((elapsed + 1) / maxPlannedPoints)) so each array
 * holds at most maxPlannedPoints + 1 points no matter how long the goal has
 * run. The final point always lands exactly on max(0, monthIndex), so the end
 * property above is checkable against actualBalance at that month. Both
 * series sample the identical months.
 */
export function chartSeriesByContributor(
  goal: TrackedGoal,
  monthIndex: number,
  maxPlannedPoints = 60
): ContributorChartSeries {
  const elapsed = Math.max(0, monthIndex);
  const cap = Math.max(1, maxPlannedPoints);
  const step = Math.max(1, Math.ceil((elapsed + 1) / cap));
  const months: number[] = [];
  for (let month = 0; month <= elapsed; month += step) {
    months.push(month);
  }
  if (months[months.length - 1] !== elapsed) {
    months.push(elapsed);
  }
  return {
    you: months.map((month) => ({ month, balance: contributorBalance(goal, 'you', month) })),
    partner: months.map((month) => ({ month, balance: contributorBalance(goal, 'partner', month) })),
  };
}
