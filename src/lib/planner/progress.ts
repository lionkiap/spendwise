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
 * history; deleting and re-tracking re-baselines the goal. The optional
 * startInvestmentsSgd and investmentRatePa freeze the plan's investments leg
 * the same way, so progress measures the two-leg plan the planner built:
 * cash (startSavingsSgd, requiredMonthlySgd and every log) grows at ratePa
 * while the portfolio grows at investmentRatePa. Both default so that every
 * goal stored before they existed keeps its exact arithmetic.
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
  /**
   * Investment portfolio the plan credited at its own rate. Absent or invalid
   * means 0, which reproduces the single-leg arithmetic exactly.
   */
  startInvestmentsSgd?: number;
  /**
   * Annual growth rate of the investments leg (decimal). Absent or invalid
   * means the goal's ratePa, so the two legs share one rate unless the plan
   * said otherwise. ratePa itself is the stated savings rate actually used and
   * is never re-defaulted.
   */
  investmentRatePa?: number;
  /** Deadline age from the plan. */
  deadlineAge: number;
  /** "YYYY-MM" when tracking started. */
  startMonthKey: string;
  /**
   * Whose space this goal belongs to: 'you', 'partner' or the shared 'us'.
   * Absent means 'you', so every goal stored before the couples feature stays
   * the primary profile's. The math never branches on it; only the storage
   * helpers below (sameGoal, removeGoal) treat it as goal identity.
   */
  space?: 'you' | 'partner' | 'us';
  /**
   * Monthly savings logs, any order. A (monthKey, contributor) pair is unique
   * per goal: the same month can hold one 'you' entry and one 'partner' entry,
   * enforced by upsertSavingsLog rather than by UI convention.
   */
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

/**
 * Savings-leg rate the plan actually used: the goal spec's stated
 * instrumentRatePa when present (a stated rate never gets an assumption chip,
 * so reading the chip alone would silently re-default it), else the
 * instrumentRatePa assumption chip, else the planner default. The goalSpec
 * parameter is optional so existing callers keep compiling, but pass it
 * whenever a spec is at hand or a user-stated rate will be replaced by the
 * default and tracking will disagree with the plan it froze.
 */
export function rateFromAssumptions(
  assumptions: ReadonlyArray<Assumption>,
  goalSpec?: GoalSpec
): number {
  if (goalSpec !== undefined && goalSpec.kind === 'savings_target') {
    const stated = goalSpec.instrumentRatePa;
    if (stated !== undefined && Number.isFinite(stated)) {
      return stated;
    }
  }
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

/**
 * The investments leg captured at tracking start: a stated positive finite
 * value, else 0 so pre-existing goals reproduce the single-leg arithmetic.
 */
function investmentsLeg(goal: TrackedGoal): number {
  const value = goal.startInvestmentsSgd;
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Growth rate of the investments leg: a stated finite value, else the goal's
 * ratePa (the stated savings rate actually used). Cash never borrows this rate
 * and the investments leg never grows at anything else.
 */
function investmentsRate(goal: TrackedGoal): number {
  const value = goal.investmentRatePa;
  return value !== undefined && Number.isFinite(value) ? value : goal.ratePa;
}

/**
 * The whole starting pot after the given whole months: liquid savings grown at
 * ratePa plus the investments leg grown at its own rate. plannedBalance,
 * actualBalance, the deadline projection and the per-contributor lines all
 * start from this same two-leg pot so plan and progress can never disagree
 * about which money grew at which rate. At month zero this is simply
 * startSavingsSgd + investmentsLeg(goal).
 */
function grownPot(goal: TrackedGoal, months: number): number {
  return (
    fvLump(goal.startSavingsSgd, goal.ratePa, months / 12) +
    fvLump(investmentsLeg(goal), investmentsRate(goal), months / 12)
  );
}

/**
 * Planned balance after monthIndex months of saving at the required pace: the
 * two-leg starting pot grown at its own rates plus the required monthly cash
 * saving compounded at ratePa.
 */
export function plannedBalance(goal: TrackedGoal, monthIndex: number): number {
  const months = Math.max(0, monthIndex);
  return grownPot(goal, months) + fvAnnuity(goal.requiredMonthlySgd, goal.ratePa, months);
}

/**
 * Actual balance after monthIndex months: the starting pot grown to now plus
 * every logged contribution grown from its own month to now. A log from
 * before tracking started counts as made at month zero (it is part of the pot
 * the goal began with); logs from after the queried month are ignored so the
 * figure is honest at any point on the timeline. Logs are cash saving, so they
 * grow at ratePa; the frozen investments leg keeps growing at its own rate.
 */
export function actualBalance(goal: TrackedGoal, monthIndex: number): number {
  const months = Math.max(0, monthIndex);
  let balance = grownPot(goal, months);
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

/** Balance the current average pace reaches by the deadline, both legs grown at their own rates. */
export function projectedBalanceAtDeadline(goal: TrackedGoal, monthIndex: number): number {
  const totalMonths = Math.max(1, (goal.deadlineAge - goal.startAge) * 12);
  const pace = actualPace(goal, monthIndex);
  return grownPot(goal, totalMonths) + fvAnnuity(pace, goal.ratePa, totalMonths);
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
  const actual: Array<{ month: number; balance: number }> = [
    { month: 0, balance: grownPot(goal, 0) },
  ];
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
 * Balance of one contributor's line at monthIndex: the whole two-leg starting
 * pot grown at its own rates, plus only that contributor's logged cash
 * contributions each grown from its own month to now at ratePa. Window rules
 * match actualBalance: pre-start logs count at month zero, logs after the
 * queried month are ignored, contributor-less logs belong to 'you'.
 */
function contributorBalance(
  goal: TrackedGoal,
  contributor: 'you' | 'partner',
  monthIndex: number
): number {
  const months = Math.max(0, monthIndex);
  let balance = grownPot(goal, months);
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
 * Semantics: BOTH series start from the same two-leg starting pot (cash at
 * ratePa plus investments at their own rate). Each line at month m is
 * contributorBalance = grownPot(goal, m) plus that contributor's in-window
 * logs each grown from its own month to m at ratePa. So each line reads as
 * "the whole pot as if this person alone had been contributing alongside the
 * shared pot", and the identity
 * you[m] + partner[m] - grownPot(goal, m)
 * = actualBalance(goal, m) holds exactly at every sampled month: the two lines
 * double-count the pot once, and every log belongs to exactly one line. Label
 * the lines "pot + you" and "pot + partner", never "you's balance" alone.
 * At a zero rate the subtracted pot is startSavingsSgd + investmentsLeg itself.
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

/** The contributor a log belongs to; an absent contributor means 'you'. */
function contributorOf(log: SavingsLog): 'you' | 'partner' {
  return log.contributor ?? 'you';
}

/**
 * Insert-or-replace one savings log entry.
 *
 * Storage identity: a log entry is keyed by monthKey AND contributor (absent
 * contributor means 'you'), so the same month can hold one entry for you and
 * one for the partner. Upserting an entry whose monthKey and contributor match
 * an existing entry replaces that entry in place; any other entry is appended.
 * Formula: logs' = logs where the entry e with e.monthKey = log.monthKey and
 * contributorOf(e) = contributorOf(log) is replaced by log, else logs + [log].
 * The input goal is never mutated; a new goal with a new log array is returned.
 */
export function upsertSavingsLog(goal: TrackedGoal, log: SavingsLog): TrackedGoal {
  const index = goal.logs.findIndex(
    (entry) => entry.monthKey === log.monthKey && contributorOf(entry) === contributorOf(log)
  );
  if (index < 0) {
    return { ...goal, logs: [...goal.logs, log] };
  }
  const logs = goal.logs.slice();
  logs[index] = log;
  return { ...goal, logs };
}

/**
 * Remove the savings log entry for one monthKey and contributor (absent
 * contributor means 'you'). Every matching entry is dropped; the partner's
 * entry for the same month survives. The input goal is never mutated.
 */
export function removeSavingsLog(
  goal: TrackedGoal,
  monthKey: string,
  contributor?: 'you' | 'partner'
): TrackedGoal {
  const who = contributor ?? 'you';
  return {
    ...goal,
    logs: goal.logs.filter(
      (entry) => !(entry.monthKey === monthKey && contributorOf(entry) === who)
    ),
  };
}

/**
 * Identity test for tracked goals across spaces: two goals are the same goal
 * exactly when both id and space match, where an absent space means 'you'.
 * The same slug in two different spaces is therefore NOT the same goal.
 * Formula: same = a.id = b.id AND (a.space ?? 'you') = (b.space ?? 'you').
 */
export function sameGoal(a: TrackedGoal, b: TrackedGoal): boolean {
  return a.id === b.id && (a.space ?? 'you') === (b.space ?? 'you');
}

/**
 * Remove every goal with the given id from the given space (absent space means
 * 'you') and return the remaining goals in their original order. Goals sharing
 * the id in other spaces survive, so clearing 'you' never deletes the
 * partner-space goal that happens to share the slug.
 */
export function removeGoal(
  goals: TrackedGoal[],
  id: string,
  space?: 'you' | 'partner' | 'us'
): TrackedGoal[] {
  const where = space ?? 'you';
  return goals.filter((goal) => !(goal.id === id && (goal.space ?? 'you') === where));
}

/**
 * Fresh id for a goal about to be tracked into a space: the desired slug when
 * that space does not hold it yet, otherwise the slug with a numeric suffix
 * (-2, -3, ...) up to the first free candidate. Scoping matches sameGoal,
 * id plus space with absent space meaning 'you', so the same slug tracked in
 * another space never forces a suffix. Because the returned id differs from
 * every stored goal in that space, appending the new goal can never collide
 * with an existing sameGoal match, so re-tracking never silently re-baselines
 * the history already logged against the earlier goal.
 *
 * Migration-free and backward compatible: stored ids are never rewritten, and
 * the first goal of any name still gets the bare slug goalSlug would produce.
 * Formula: let taken = { goal.id : goal in goals where (goal.space ?? 'you')
 * = (space ?? 'you') }; return desiredId when desiredId is not in taken, else
 * the first desiredId-n (n = 2, 3, ...) not in taken.
 */
export function uniqueGoalId(
  goals: ReadonlyArray<TrackedGoal>,
  desiredId: string,
  space?: 'you' | 'partner' | 'us'
): string {
  const where = space ?? 'you';
  const taken = new Set(
    goals.filter((goal) => (goal.space ?? 'you') === where).map((goal) => goal.id)
  );
  if (!taken.has(desiredId)) {
    return desiredId;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${desiredId}-${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
