import { describe, expect, it } from 'vitest';
import { fvAnnuity, fvLump, pmtForFv } from '../lib/kernels';
import {
  actualBalance,
  actualPace,
  chartSeries,
  goalNameFromSpec,
  monthKeyDiff,
  monthKeyOffset,
  monthsToTarget,
  paceStatus,
  plannedBalance,
  progressRatio,
  projectedBalanceAtDeadline,
  rateFromAssumptions,
  removeGoal,
  removeSavingsLog,
  sameGoal,
  upsertSavingsLog,
  type TrackedGoal,
} from '../lib/planner/progress';
import { PLANNER_DEFAULTS, type GoalSpec } from '../lib/planner/goalspec';

const GOAL_SPEC: GoalSpec = {
  kind: 'property_purchase',
  propertyType: 'hdb_resale',
  targetPriceSgd: 600_000,
  deadlineAge: 28,
  firstProperty: true,
};

/**
 * Baseline tracked goal: starts at 22 with S$5,000, needs S$182,139 in cash by
 * 28 at the 1.8 percent default rate. requiredMonthlySgd is the kernel-solved
 * figure so plannedBalance is provably the plan's own schedule.
 */
function makeGoal(overrides: Partial<TrackedGoal> = {}): TrackedGoal {
  const totalMonths = 72;
  const targetSgd = 182_139;
  const base: TrackedGoal = {
    id: 'hdb-resale-by-28',
    name: 'HDB resale at S$600k by age 28',
    goalSpec: GOAL_SPEC,
    targetSgd,
    requiredMonthlySgd: pmtForFv(targetSgd, 5_000, PLANNER_DEFAULTS.instrumentRatePa, totalMonths),
    ratePa: PLANNER_DEFAULTS.instrumentRatePa,
    startAge: 22,
    startSavingsSgd: 5_000,
    deadlineAge: 28,
    startMonthKey: '2026-01',
    logs: [],
  };
  return { ...base, ...overrides };
}

describe('month keys', () => {
  it('diffs across year boundaries in both directions', () => {
    expect(monthKeyDiff('2026-01', '2026-01')).toBe(0);
    expect(monthKeyDiff('2026-01', '2026-04')).toBe(3);
    expect(monthKeyDiff('2025-11', '2026-02')).toBe(3);
    expect(monthKeyDiff('2026-04', '2026-01')).toBe(-3);
    expect(monthKeyDiff('2024-01', '2026-01')).toBe(24);
  });

  it('round-trips offset against diff', () => {
    expect(monthKeyOffset('2026-01', 3)).toBe('2026-04');
    expect(monthKeyOffset('2026-01', -1)).toBe('2025-12');
    expect(monthKeyOffset('2025-12', 2)).toBe('2026-02');
    expect(monthKeyDiff('2025-12', monthKeyOffset('2025-12', 17))).toBe(17);
  });
});

describe('plannedBalance', () => {
  it('matches the kernel formula directly', () => {
    const goal = makeGoal();
    expect(plannedBalance(goal, 24)).toBeCloseTo(
      fvLump(5_000, goal.ratePa, 2) + fvAnnuity(goal.requiredMonthlySgd, goal.ratePa, 24),
      6
    );
  });

  it('reaches the target by the deadline within the payment tolerance', () => {
    const goal = makeGoal();
    const finalBalance = plannedBalance(goal, 72);
    expect(Math.abs(finalBalance - goal.targetSgd)).toBeLessThanOrEqual(goal.targetSgd * 0.015);
  });
});

describe('actualBalance and pace', () => {
  it('grows each logged contribution from its own month to now', () => {
    const goal = makeGoal({
      logs: [
        { monthKey: '2026-01', contributedSgd: 1_000 },
        { monthKey: '2026-03', contributedSgd: 2_000 },
      ],
    });
    const expected =
      fvLump(5_000, goal.ratePa, 6 / 12) +
      fvLump(1_000, goal.ratePa, 6 / 12) +
      fvLump(2_000, goal.ratePa, 4 / 12);
    expect(actualBalance(goal, 6)).toBeCloseTo(expected, 6);
  });

  it('treats pre-start logs as month zero and ignores future logs', () => {
    const goal = makeGoal({
      logs: [
        { monthKey: '2025-12', contributedSgd: 1_000 },
        { monthKey: '2026-09', contributedSgd: 1_000 },
      ],
    });
    const expected =
      fvLump(5_000, goal.ratePa, 0.5) + fvLump(1_000, goal.ratePa, 0.5);
    expect(actualBalance(goal, 6)).toBeCloseTo(expected, 6);
  });

  it('averages contributions over elapsed months and reports zero pace at start', () => {
    const goal = makeGoal({
      logs: [
        { monthKey: '2026-01', contributedSgd: 1_500 },
        { monthKey: '2026-02', contributedSgd: 2_500 },
      ],
    });
    expect(actualPace(goal, 0)).toBe(0);
    expect(actualPace(goal, 4)).toBeCloseTo(1_000, 6);
  });
});

describe('paceStatus', () => {
  it('classifies behind, on-track and ahead by balance versus plan', () => {
    const goal = makeGoal();
    // Saving exactly the required amount lands on the planned balance.
    const onPace = makeGoal({
      logs: Array.from({ length: 4 }, (_, index) => ({
        monthKey: monthKeyOffset('2026-01', index),
        contributedSgd: goal.requiredMonthlySgd,
      })),
    });
    expect(paceStatus(onPace, 4)).toBe('on-track');
    expect(paceStatus(makeGoal(), 4)).toBe('behind');
    const ahead = makeGoal({
      logs: Array.from({ length: 4 }, (_, index) => ({
        monthKey: monthKeyOffset('2026-01', index),
        contributedSgd: goal.requiredMonthlySgd * 2.5,
      })),
    });
    expect(paceStatus(ahead, 4)).toBe('ahead');
  });

  it('treats month zero as on-track by definition', () => {
    expect(paceStatus(makeGoal(), 0)).toBe('on-track');
  });
});

describe('projections', () => {
  it('projects the deadline balance from the observed pace', () => {
    const goal = makeGoal({
      logs: [{ monthKey: '2026-01', contributedSgd: 3_000 }],
    });
    expect(projectedBalanceAtDeadline(goal, 4)).toBeCloseTo(
      fvLump(5_000, goal.ratePa, 6) + fvAnnuity(750, goal.ratePa, 72),
      6
    );
  });

  it('solves months to target and returns null for a zero pace', () => {
    const goal = makeGoal();
    const months = monthsToTarget(5_000, goal.ratePa, goal.requiredMonthlySgd, goal.targetSgd);
    expect(months).not.toBeNull();
    expect(months ?? 0).toBeGreaterThanOrEqual(70);
    expect(months ?? 0).toBeLessThanOrEqual(74);
    expect(monthsToTarget(5_000, goal.ratePa, 0, goal.targetSgd)).toBeNull();
    expect(monthsToTarget(10_000, 0.01, 500, 5_000)).toBe(0);
  });

  it('caps the displayed progress ratio at 1', () => {
    const goal = makeGoal({
      targetSgd: 1_000,
      startSavingsSgd: 5_000,
    });
    expect(progressRatio(goal, 0)).toBe(1);
    expect(progressRatio(makeGoal(), 0)).toBeCloseTo(5_000 / 182_139, 6);
  });
});

describe('chart series and naming', () => {
  it('samples the planned curve to the deadline and steps the actual points', () => {
    const goal = makeGoal({
      logs: [
        { monthKey: '2026-01', contributedSgd: 2_000 },
        { monthKey: '2026-02', contributedSgd: 2_000 },
      ],
    });
    const series = chartSeries(goal, 2, 10);
    expect(series.totalMonths).toBe(72);
    expect(series.planned.length).toBeGreaterThanOrEqual(10);
    expect(series.planned.length).toBeLessThanOrEqual(11);
    expect(series.planned[0]).toEqual({ month: 0, balance: 5_000 });
    expect(series.planned[series.planned.length - 1]?.month).toBe(72);
    expect(series.actual).toHaveLength(3);
    expect(series.actual[2]?.month).toBe(2);
  });

  it('names each goal kind sensibly and defaults the unstated rate', () => {
    expect(goalNameFromSpec(GOAL_SPEC)).toBe('HDB resale at S$600k by age 28');
    expect(
      goalNameFromSpec({ kind: 'savings_target', targetAmountSgd: 1_000_000, deadlineAge: 50 })
    ).toBe('Save S$1000k by age 50');
    expect(rateFromAssumptions([])).toBe(PLANNER_DEFAULTS.instrumentRatePa);
    expect(
      rateFromAssumptions([{ field: 'instrumentRatePa', value: 0.03, reason: 'stated' }])
    ).toBe(0.03);
  });
});

describe('log and goal storage semantics', () => {
  it('keeps logging you then partner in the same month as two entries', () => {
    let goal = makeGoal({ ratePa: 0 });
    goal = upsertSavingsLog(goal, { monthKey: '2026-03', contributedSgd: 1_000 });
    goal = upsertSavingsLog(goal, { monthKey: '2026-03', contributedSgd: 400, contributor: 'partner' });
    expect(goal.logs).toHaveLength(2);
    expect(goal.logs.map((log) => log.contributedSgd)).toEqual([1_000, 400]);
    // Both entries count toward the balance: 5,000 pot + 1,000 + 400 at a zero
    // rate = 6,400.
    expect(actualBalance(goal, 2)).toBeCloseTo(6_400, 6);
  });

  it('replaces the entry with the same monthKey and contributor, absent meaning you', () => {
    let goal = makeGoal({ logs: [{ monthKey: '2026-03', contributedSgd: 1_000 }] });
    goal = upsertSavingsLog(goal, { monthKey: '2026-03', contributedSgd: 1_500, contributor: 'you' });
    expect(goal.logs).toHaveLength(1);
    expect(goal.logs[0]?.contributedSgd).toBe(1_500);
    // An entry stored without a contributor is the you entry.
    goal = upsertSavingsLog(goal, { monthKey: '2026-03', contributedSgd: 2_000 });
    expect(goal.logs).toHaveLength(1);
    expect(goal.logs[0]?.contributedSgd).toBe(2_000);
    expect(goal.logs[0]?.contributor).toBeUndefined();
    // The partner entry for the same month is a different entry.
    goal = upsertSavingsLog(goal, { monthKey: '2026-03', contributedSgd: 300, contributor: 'partner' });
    expect(goal.logs).toHaveLength(2);
  });

  it('removes only the named contributor entry for the month', () => {
    const goal = makeGoal({
      logs: [
        { monthKey: '2026-03', contributedSgd: 1_000 },
        { monthKey: '2026-03', contributedSgd: 400, contributor: 'partner' },
      ],
    });
    // Absent contributor means you: the partner entry survives.
    expect(removeSavingsLog(goal, '2026-03').logs).toEqual([
      { monthKey: '2026-03', contributedSgd: 400, contributor: 'partner' },
    ]);
    expect(removeSavingsLog(goal, '2026-03', 'partner').logs).toEqual([
      { monthKey: '2026-03', contributedSgd: 1_000 },
    ]);
    // A month with no entry is a no-op.
    expect(removeSavingsLog(goal, '2026-04').logs).toHaveLength(2);
  });

  it('never mutates the goal it copies from', () => {
    const original = makeGoal({ logs: [{ monthKey: '2026-03', contributedSgd: 1_000 }] });
    const snapshot = JSON.stringify(original.logs);
    upsertSavingsLog(original, { monthKey: '2026-03', contributedSgd: 9_000 });
    removeSavingsLog(original, '2026-03');
    removeGoal([original], original.id);
    expect(JSON.stringify(original.logs)).toBe(snapshot);
  });

  it('treats the same id in different spaces as different goals', () => {
    const mine = makeGoal();
    const partners = makeGoal({ space: 'partner' });
    const shared = makeGoal({ space: 'us' });
    const legacy = makeGoal({ space: undefined });
    expect(sameGoal(mine, mine)).toBe(true);
    expect(sameGoal(mine, legacy)).toBe(true);
    expect(sameGoal(mine, partners)).toBe(false);
    expect(sameGoal(partners, shared)).toBe(false);
    expect(sameGoal(makeGoal({ id: 'other-id' }), mine)).toBe(false);
  });

  it('removes goals by id and space only, keeping other spaces intact', () => {
    const goals = [
      makeGoal(),
      makeGoal({ space: 'partner' }),
      makeGoal({ id: 'other-goal', space: 'us' }),
    ];
    // Absent space means you: only the you-space entry with this id goes.
    expect(removeGoal(goals, 'hdb-resale-by-28').map((goal) => [goal.id, goal.space ?? 'you'])).toEqual([
      ['hdb-resale-by-28', 'partner'],
      ['other-goal', 'us'],
    ]);
    // Naming the partner space removes the partner copy, not the you copy.
    expect(removeGoal(goals, 'hdb-resale-by-28', 'partner').map((goal) => goal.space ?? 'you')).toEqual([
      'you',
      'us',
    ]);
    // An unknown id removes nothing.
    expect(removeGoal(goals, 'no-such-goal')).toHaveLength(3);
  });
});
