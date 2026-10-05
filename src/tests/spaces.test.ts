import { describe, expect, it } from 'vitest';
import { fvLump } from '../lib/kernels';
import {
  actualBalance,
  actualPace,
  chartSeries,
  chartSeriesByContributor,
  contributorTotals,
  paceStatus,
  plannedBalance,
  progressRatio,
  type SavingsLog,
  type TrackedGoal,
} from '../lib/planner/progress';
import {
  combineProfiles,
  userProfileSchema,
  type GoalSpec,
  type UserProfile,
} from '../lib/planner/goalspec';

/**
 * Couples / spaces tests. Every expected number below is hand-computed on
 * paper: the chart fixtures run at a zero rate so growth factors are all 1 and
 * the balances are plain sums, and the one growth fixture is verified against
 * the monthly-compounding arithmetic (monthly i = 0.018 / 12 = 0.0015,
 * 1.0015^2 = 1.00300225, 1.0015^3 = 1.004506753375) written out in comments.
 */

const SPACE_SPEC: GoalSpec = {
  kind: 'savings_target',
  targetAmountSgd: 30_000,
  deadlineAge: 30,
};

/**
 * Base tracked goal at a ZERO rate so every balance below is integer
 * arithmetic. startMonthKey 2026-01, pot S$4,000, ages 25 to 30.
 */
function makeGoal(overrides: Partial<TrackedGoal> = {}): TrackedGoal {
  const base: TrackedGoal = {
    id: 'save-30k-by-30',
    name: 'Save S$30k by age 30',
    goalSpec: SPACE_SPEC,
    targetSgd: 30_000,
    requiredMonthlySgd: 350,
    ratePa: 0,
    startAge: 25,
    startSavingsSgd: 4_000,
    deadlineAge: 30,
    startMonthKey: '2026-01',
    logs: [],
  };
  return { ...base, ...overrides };
}

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    age: 28,
    grossMonthlyIncome: 6_500,
    monthlyExpenses: 3_000,
    liquidSavings: 20_000,
    cpfOaBalance: 30_000,
    milesValuationCents: 2.2,
    ...overrides,
  };
}

describe('combineProfiles', () => {
  it('sums the additive fields and carries age and miles valuation from you', () => {
    const you = makeProfile({ investmentsSgd: 15_000, investmentRatePa: 0.05 });
    const partner = makeProfile({
      age: 27,
      grossMonthlyIncome: 4_200,
      monthlyExpenses: 2_500,
      liquidSavings: 15_000,
      cpfOaBalance: 22_000,
      milesValuationCents: 1.5,
    });
    const combined = combineProfiles(you, partner);
    // Hand sums: 6,500 + 4,200 = 10,700; 3,000 + 2,500 = 5,500;
    // 20,000 + 15,000 = 35,000; 30,000 + 22,000 = 52,000.
    expect(combined).toEqual({
      age: 28,
      grossMonthlyIncome: 10_700,
      monthlyExpenses: 5_500,
      liquidSavings: 35_000,
      cpfOaBalance: 52_000,
      milesValuationCents: 2.2,
      investmentsSgd: 15_000,
      investmentRatePa: 0.05,
    });
    expect(userProfileSchema.safeParse(combined).success).toBe(true);
  });

  it('takes investmentRatePa from you when set, else partner, else omits it', () => {
    const partner = makeProfile({ investmentRatePa: 0.04 });
    expect(combineProfiles(makeProfile({ investmentRatePa: 0.05 }), partner).investmentRatePa).toBe(0.05);
    expect(combineProfiles(makeProfile(), partner).investmentRatePa).toBe(0.04);
    const neither = combineProfiles(makeProfile(), makeProfile());
    expect('investmentRatePa' in neither).toBe(false);
  });

  it('sums investmentsSgd treating undefined as 0 and omits an exact zero', () => {
    // 15,000 + 12,000 = 27,000.
    expect(
      combineProfiles(makeProfile({ investmentsSgd: 15_000 }), makeProfile({ investmentsSgd: 12_000 })).investmentsSgd
    ).toBe(27_000);
    // undefined counts as 0: 0 + 8,000 = 8,000.
    expect(combineProfiles(makeProfile(), makeProfile({ investmentsSgd: 8_000 })).investmentsSgd).toBe(8_000);
    // Both unstated: 0 + 0, omitted entirely.
    expect('investmentsSgd' in combineProfiles(makeProfile(), makeProfile())).toBe(false);
    // Zero-sum collapses to undefined-on-both: 5,000 + -5,000 = 0, omitted.
    expect(
      'investmentsSgd' in
        combineProfiles(makeProfile({ investmentsSgd: 5_000 }), makeProfile({ investmentsSgd: -5_000 }))
    ).toBe(false);
  });
});

describe('contributorTotals', () => {
  const mixedLogs: SavingsLog[] = [
    { monthKey: '2025-11', contributedSgd: 200 }, // pre-start, no contributor: yours, counts at month 0
    { monthKey: '2026-01', contributedSgd: 1_000, contributor: 'you' },
    { monthKey: '2026-02', contributedSgd: 300, contributor: 'partner' },
    { monthKey: '2026-03', contributedSgd: 700 }, // absent contributor means you
    { monthKey: '2026-09', contributedSgd: 1_000, contributor: 'partner' }, // month 8, future until then
  ];

  it('splits a mixed log list into raw per-contributor sums', () => {
    const goal = makeGoal({ logs: mixedLogs });
    // At month 4: you 200 + 1,000 + 700 = 1,900; partner 300 (month-8 log excluded).
    expect(contributorTotals(goal, 4)).toEqual({ you: 1_900, partner: 300 });
  });

  it('follows the actualBalance window rules at the edges', () => {
    const goal = makeGoal({ logs: mixedLogs });
    // Month 0: only month-0 and pre-start logs count: you 200 + 1,000 = 1,200.
    expect(contributorTotals(goal, 0)).toEqual({ you: 1_200, partner: 0 });
    // Month 8: the partner log at month 8 is now inside the window: partner 1,300.
    expect(contributorTotals(goal, 8)).toEqual({ you: 1_900, partner: 1_300 });
  });
});

describe('chartSeriesByContributor', () => {
  const sharedFixture = makeGoal({
    ratePa: 0,
    logs: [
      { monthKey: '2025-12', contributedSgd: 200 }, // pre-start, yours, counts at month 0
      { monthKey: '2026-01', contributedSgd: 500, contributor: 'you' },
      { monthKey: '2026-02', contributedSgd: 300, contributor: 'partner' },
      { monthKey: '2026-03', contributedSgd: 700 }, // yours
      { monthKey: '2026-08', contributedSgd: 1_000, contributor: 'partner' }, // month 7, future at month 4
    ],
  });

  it('samples month 0 through the elapsed month for both series', () => {
    const series = chartSeriesByContributor(sharedFixture, 4);
    expect(series.you.map((point) => point.month)).toEqual([0, 1, 2, 3, 4]);
    expect(series.partner.map((point) => point.month)).toEqual([0, 1, 2, 3, 4]);
    // Zero rate, so every balance is pot plus plain sums:
    // you at 0: 4,000 + 200 + 500 = 4,700; partner at 0: pot only 4,000.
    expect(series.you[0]).toEqual({ month: 0, balance: 4_700 });
    expect(series.partner[0]).toEqual({ month: 0, balance: 4_000 });
    // By month 2: your 2026-03 log is month index 2, so it is already in the
    // window: you = 4,000 + 200 + 500 + 700 = 5,400; partner = 4,000 + 300 = 4,300.
    expect(series.you[2]).toEqual({ month: 2, balance: 5_400 });
    expect(series.partner[2]).toEqual({ month: 2, balance: 4_300 });
  });

  it('end property: you + partner - one pot equals the combined actual', () => {
    const series = chartSeriesByContributor(sharedFixture, 4);
    const youLast = series.you[series.you.length - 1];
    const partnerLast = series.partner[series.partner.length - 1];
    expect(youLast?.month).toBe(4);
    expect(partnerLast?.month).toBe(4);
    // you(4) = 4,000 + 200 + 500 + 700 = 5,400; partner(4) = 4,000 + 300 = 4,300.
    expect(youLast?.balance).toBe(5_400);
    expect(partnerLast?.balance).toBe(4_300);
    // Identity: 5,400 + 4,300 - 4,000 = 5,700 and actualBalance(4) =
    // 4,000 + 200 + 500 + 300 + 700 = 5,700. Equal.
    expect(Math.abs(youLast!.balance + partnerLast!.balance - 4_000 - actualBalance(sharedFixture, 4))).toBeLessThanOrEqual(0.01);
  });

  it('caps sampled points and always ends exactly on the elapsed month', () => {
    const series = chartSeriesByContributor(sharedFixture, 4, 2);
    // step = ceil(5 / 2) = 3, so months 0 and 3, then a forced final point at 4.
    expect(series.you.map((point) => point.month)).toEqual([0, 3, 4]);
    expect(series.partner.map((point) => point.month)).toEqual([0, 3, 4]);
    // you(3) = 4,000 + 200 + 500 + 700 = 5,400; partner(3) = 4,000 + 300 = 4,300.
    expect(series.you[1]).toEqual({ month: 3, balance: 5_400 });
    expect(series.partner[1]).toEqual({ month: 3, balance: 4_300 });
  });

  it('holds the same identity under growth at the 1.8 percent default rate', () => {
    const goal = makeGoal({
      ratePa: 0.018,
      startSavingsSgd: 5_000,
      logs: [
        { monthKey: '2026-01', contributedSgd: 1_000, contributor: 'you' },
        { monthKey: '2026-02', contributedSgd: 800, contributor: 'partner' },
      ],
    });
    const series = chartSeriesByContributor(goal, 3);
    const youLast = series.you[series.you.length - 1];
    const partnerLast = series.partner[series.partner.length - 1];
    const pot = fvLump(5_000, 0.018, 3 / 12);
    expect(Math.abs(youLast!.balance + partnerLast!.balance - pot - actualBalance(goal, 3))).toBeLessThanOrEqual(1e-8);
    // Hand check at monthly i = 0.0015: pot = 5,000 * 1.004506753375 = 5,022.533766875;
    // your 1,000 grows 3 months to 1,004.506753375; partner's 800 grows 2 months
    // (1.0015^2 = 1.00300225) to 802.4018; combined actual = 6,829.44232025.
    expect(actualBalance(goal, 3)).toBeCloseTo(6_829.44232, 4);
    expect(youLast!.balance + partnerLast!.balance - pot).toBeCloseTo(6_829.44232, 4);
  });
});

describe('contributor-less logs and us-space goals', () => {
  it('treats a goal with contributor-less logs as all-you', () => {
    const plain = makeGoal({
      logs: [
        { monthKey: '2026-01', contributedSgd: 500 },
        { monthKey: '2026-02', contributedSgd: 250 },
      ],
    });
    expect(contributorTotals(plain, 2)).toEqual({ you: 750, partner: 0 });
    const series = chartSeriesByContributor(plain, 2);
    // you(2) = 4,000 + 500 + 250 = 4,750; partner holds the pot alone at 4,000.
    expect(series.you[2]).toEqual({ month: 2, balance: 4_750 });
    expect(series.partner[2]).toEqual({ month: 2, balance: 4_000 });
    // Explicit 'you' tags change nothing.
    const explicit = makeGoal({
      logs: [
        { monthKey: '2026-01', contributedSgd: 500, contributor: 'you' },
        { monthKey: '2026-02', contributedSgd: 250, contributor: 'you' },
      ],
    });
    expect(actualBalance(explicit, 2)).toBe(actualBalance(plain, 2));
    expect(actualBalance(plain, 2)).toBe(4_750);
  });

  it('round-trips a space us goal through the existing functions unchanged', () => {
    const logs: SavingsLog[] = [
      { monthKey: '2026-01', contributedSgd: 500, contributor: 'you' },
      { monthKey: '2026-02', contributedSgd: 300, contributor: 'partner' },
    ];
    const usGoal = makeGoal({ space: 'us', logs });
    const plainGoal = makeGoal({ logs });
    expect(actualBalance(usGoal, 3)).toBe(actualBalance(plainGoal, 3));
    expect(plannedBalance(usGoal, 3)).toBe(plannedBalance(plainGoal, 3));
    expect(actualPace(usGoal, 3)).toBe(actualPace(plainGoal, 3));
    expect(paceStatus(usGoal, 3)).toBe(paceStatus(plainGoal, 3));
    expect(progressRatio(usGoal, 3)).toBe(progressRatio(plainGoal, 3));
    expect(chartSeries(usGoal, 3)).toEqual(chartSeries(plainGoal, 3));
    // The field itself survives storage round-tripping.
    expect(JSON.parse(JSON.stringify(usGoal)).space).toBe('us');
  });
});
