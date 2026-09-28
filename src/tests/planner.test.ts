import { describe, expect, it } from 'vitest';
import { bsd, downPaymentSplit, fvAnnuity, fvLump, legalFeesEstimate, oaProjection, pmtForFv } from '../lib/kernels';
import { chatJson, isConfigured } from '../lib/nebius';
import { buildPlan } from '../lib/planner/build';
import type { GoalSpec, UserProfile } from '../lib/planner/goalspec';
import {
  fillAssumptions,
  missingFields,
  parseGoal,
  parseGoalFallback,
} from '../lib/planner/parse';

/**
 * Asserts actual lies within relTol (default 1.5 percent) of expected,
 * matching the tolerance budget the acceptance gate allows for.
 */
function expectNear(actual: number, expected: number, relTol = 0.015): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * relTol);
}

const baseProfile: UserProfile = {
  age: 25,
  grossMonthlyIncome: 6000,
  monthlyExpenses: 2500,
  liquidSavings: 20000,
  cpfOaBalance: 15000,
  milesValuationCents: 1.8,
};

const HDB_PROMPT = 'I want to buy a hdb worth about 600k by age 28';
const SAVINGS_PROMPT =
  'I wish to save up 1mil by 50 years old with my savings account at 1.8 percent pa';

describe('fallback parser', () => {
  it('parses the hdb 600k by age 28 prompt into a property_purchase goal', () => {
    const goal = parseGoalFallback(HDB_PROMPT, baseProfile);
    expect(goal).not.toBeNull();
    expect(goal?.kind).toBe('property_purchase');
    if (goal?.kind === 'property_purchase') {
      expect(goal.propertyType).toBe('hdb_resale');
      expect(goal.targetPriceSgd).toBe(600_000);
      expect(goal.deadlineAge).toBe(28);
      expect(goal.firstProperty).toBe(true);
    }
  });

  it('parses the 1mil by 50 savings prompt with the 1.8 percent pa rate', () => {
    const goal = parseGoalFallback(SAVINGS_PROMPT, baseProfile);
    expect(goal).not.toBeNull();
    expect(goal?.kind).toBe('savings_target');
    if (goal?.kind === 'savings_target') {
      expect(goal.targetAmountSgd).toBe(1_000_000);
      expect(goal.deadlineAge).toBe(50);
      expect(goal.instrumentRatePa).toBeCloseTo(0.018, 9);
    }
  });

  it('never reads plain ages as money and reports unstated fields as missing', () => {
    const goal = parseGoalFallback('I want to save money for a rainy day', baseProfile);
    expect(goal).not.toBeNull();
    if (goal?.kind === 'savings_target') {
      expect(goal.targetAmountSgd).toBe(0);
      expect(goal.deadlineAge).toBe(0);
      const missing = missingFields(goal, baseProfile);
      expect(missing).toContain('targetAmountSgd');
      expect(missing).toContain('deadlineAge');
      expect(missing).toContain('instrumentRatePa');
    }
  });

  it('parseGoal falls back offline and agrees with the heuristic parser', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    try {
      expect(isConfigured()).toBe(false);
      const goal = await parseGoal(SAVINGS_PROMPT, baseProfile);
      expect(goal).toEqual(parseGoalFallback(SAVINGS_PROMPT, baseProfile));
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      }
    }
  });

  it('chatJson returns null instead of throwing when Nebius is unconfigured', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    try {
      await expect(chatJson('system', 'user', 'any-model')).resolves.toBeNull();
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      }
    }
  });
});

describe('fillAssumptions', () => {
  it('carries the five snapshot defaults for a resale property goal', () => {
    const goal: GoalSpec = {
      kind: 'property_purchase',
      propertyType: 'hdb_resale',
      targetPriceSgd: 600_000,
      deadlineAge: 28,
      firstProperty: true,
    };
    const assumptions = fillAssumptions(goal, baseProfile);
    const valueOf = (field: string): number => {
      const found = assumptions.find((entry) => entry.field === field);
      expect(found).toBeDefined();
      return found?.value ?? Number.NaN;
    };
    expect(valueOf('mortgageStressRatePa')).toBeCloseTo(0.04, 9);
    expect(valueOf('hdbConcessionaryRatePa')).toBeCloseTo(0.026, 9);
    expect(valueOf('inflationPa')).toBeCloseTo(0.025, 9);
    expect(valueOf('renovationBufferSgd')).toBe(30_000);
    expect(valueOf('instrumentRatePa')).toBeCloseTo(0.018, 9);
  });

  it('fills a missing deadline 5 years from today', () => {
    const goal: GoalSpec = {
      kind: 'savings_target',
      targetAmountSgd: 100_000,
      deadlineAge: 0,
    };
    const assumptions = fillAssumptions(goal, baseProfile);
    const deadline = assumptions.find((entry) => entry.field === 'deadlineAge');
    expect(deadline?.value).toBe(30);
    expect(missingFields(goal, baseProfile)).toContain('deadlineAge');
  });
});

describe('buildPlan for the 600k HDB goal', () => {
  const goal: GoalSpec = {
    kind: 'property_purchase',
    propertyType: 'hdb_resale',
    targetPriceSgd: 600_000,
    deadlineAge: 28,
    firstProperty: true,
  };
  const assumptions = fillAssumptions(goal, baseProfile);
  const plan = buildPlan(goal, baseProfile, assumptions);

  it('includes a costStack row of 12600 for BSD', () => {
    const bsdRow = plan.costStack?.find((row) => row.label.includes('BSD'));
    expect(bsdRow).toBeDefined();
    expect(bsdRow?.amountSgd).toBe(bsd(600_000));
    expect(bsdRow?.amountSgd).toBe(12_600);
  });

  it('requiredMonthlySavings matches a direct pmtForFv call within 1.5 percent', () => {
    const ratePa = 0.018; // fillAssumptions default because the prompt states none
    const split = downPaymentSplit(600_000);
    const upfrontStack = split.total + bsd(600_000) + legalFeesEstimate(600_000) + 30_000;
    const oaRows = oaProjection(baseProfile.cpfOaBalance, 0, 3);
    const oaAtDeadline = oaRows[oaRows.length - 1]?.balance ?? baseProfile.cpfOaBalance;
    const cashNeeded = Math.max(upfrontStack - Math.min(split.cpfPortion, oaAtDeadline), 0);
    const expected = Math.max(pmtForFv(cashNeeded, baseProfile.liquidSavings, ratePa, 36), 0);

    expectNear(plan.requiredMonthlySavings, expected);
    expect(plan.requiredMonthlySavings).toBeGreaterThan(0);
  });

  it('checks CPF OA reachability and reports it in reasoning and actions', () => {
    const joinedActions = plan.actions.join(' ');
    expect(plan.verdict.reasoning).toContain('CPF OA');
    expect(joinedActions).toContain('CPF OA');
  });

  it('runs the debt check at the concessionary and stress rates', () => {
    expect(plan.debt).toBeDefined();
    expect(plan.debt?.concessionary.ratePa).toBeCloseTo(0.026, 9);
    expect(plan.debt?.stress.ratePa).toBeCloseTo(0.04, 9);
    expect(plan.debt?.stress.monthlyInstallment).toBeGreaterThan(
      plan.debt?.concessionary.monthlyInstallment ?? 0
    );
    expect(plan.debt?.msr.limitRatio).toBeCloseTo(0.3, 9);
    expect(plan.debt?.tdsr.limitRatio).toBeCloseTo(0.55, 9);
  });

  it('ends the savings schedule at the cash target and emits 9 grid cells', () => {
    const split = downPaymentSplit(600_000);
    const upfrontStack = split.total + bsd(600_000) + legalFeesEstimate(600_000) + 30_000;
    const oaRows = oaProjection(baseProfile.cpfOaBalance, 0, 3);
    const oaAtDeadline = oaRows[oaRows.length - 1]?.balance ?? baseProfile.cpfOaBalance;
    const cashNeeded = Math.max(upfrontStack - Math.min(split.cpfPortion, oaAtDeadline), 0);
    const lastRow = plan.savingsSchedule[plan.savingsSchedule.length - 1];
    expectNear(lastRow?.balance ?? 0, cashNeeded);

    expect(plan.scenarioGrid).toHaveLength(9);
    expect(plan.actions).toHaveLength(3);
    expect(plan.teaching).toHaveLength(5);
    expect(plan.milestones.length).toBeGreaterThanOrEqual(3);
    const gridRate = 0.018; // fillAssumptions default because the prompt states none
    for (const cell of plan.scenarioGrid) {
      const balance =
        fvLump(baseProfile.liquidSavings, gridRate + cell.rateDelta, 3) +
        fvAnnuity(
          plan.requiredMonthlySavings * (1 + cell.contributionDelta),
          gridRate + cell.rateDelta,
          36
        );
      expect(cell.monthlySgd).toBeCloseTo(plan.requiredMonthlySavings * (1 + cell.contributionDelta), 6);
      expect(cell.balanceSgd).toBeCloseTo(balance, 4);
      expect(cell.gapSgd).toBeCloseTo(cashNeeded - balance, 4);
      expect(cell.achievable).toBe(cell.gapSgd <= 1e-6);
    }
  });
});

describe('buildPlan verdicts', () => {
  const goal: GoalSpec = {
    kind: 'property_purchase',
    propertyType: 'hdb_resale',
    targetPriceSgd: 600_000,
    deadlineAge: 28,
    firstProperty: true,
  };
  const assumptions = fillAssumptions(goal, baseProfile);

  it('is achievable for a high income profile', () => {
    const highEarner: UserProfile = { ...baseProfile, grossMonthlyIncome: 12_000, monthlyExpenses: 3000 };
    const plan = buildPlan(goal, highEarner, assumptions);
    expect(plan.verdict.status).toBe('achievable');
  });

  it('is not_achievable for a near zero income profile', () => {
    const barelyEarns: UserProfile = { ...baseProfile, grossMonthlyIncome: 400, monthlyExpenses: 250 };
    const plan = buildPlan(goal, barelyEarns, assumptions);
    expect(plan.verdict.status).toBe('not_achievable');
  });

  it('is stretch for a required monthly saving just above the surplus', () => {
    // Required monthly is about 4393 for this goal regardless of income, so a
    // surplus of 3800 puts it between 1.0x and 1.3x of the surplus.
    const middling: UserProfile = { ...baseProfile, grossMonthlyIncome: 6000, monthlyExpenses: 2200 };
    const plan = buildPlan(goal, middling, assumptions);
    const surplus = middling.grossMonthlyIncome - middling.monthlyExpenses;
    expect(plan.requiredMonthlySavings).toBeGreaterThan(surplus);
    expect(plan.requiredMonthlySavings).toBeLessThanOrEqual(surplus * 1.3);
    expect(plan.verdict.status).toBe('stretch');
  });
});

describe('buildPlan for savings and car goals', () => {
  it('savings plan reaches the nominal target and keeps the grid consistent', () => {
    const goal: GoalSpec = {
      kind: 'savings_target',
      targetAmountSgd: 1_000_000,
      deadlineAge: 50,
      instrumentRatePa: 0.018,
    };
    const profile: UserProfile = { ...baseProfile, liquidSavings: 1000 };
    const plan = buildPlan(goal, profile, fillAssumptions(goal, profile));

    expect(plan.requiredMonthlySavings).toBeGreaterThan(0);
    expect(plan.costStack).toBeUndefined();
    expect(plan.debt).toBeUndefined();
    const lastRow = plan.savingsSchedule[plan.savingsSchedule.length - 1];
    expectNear(lastRow?.balance ?? 0, 1_000_000);
    const center = plan.scenarioGrid.find(
      (cell) => cell.rateDelta === 0 && cell.contributionDelta === 0
    );
    expect(center).toBeDefined();
    expect(center?.achievable).toBe(true);
    expect(center?.monthlySgd).toBeCloseTo(plan.requiredMonthlySavings, 6);
    expect(Math.abs(center?.gapSgd ?? 1)).toBeLessThan(1);
    const cheaper = plan.scenarioGrid.find(
      (cell) => cell.rateDelta === 0 && cell.contributionDelta === -0.2
    );
    expect(cheaper?.achievable).toBe(false);
    expect(cheaper?.gapSgd).toBeGreaterThan(0);
    const lowerRate = plan.scenarioGrid.find(
      (cell) => cell.rateDelta === -0.01 && cell.contributionDelta === 0
    );
    expect(lowerRate?.achievable).toBe(false);
    expect(plan.assumptions).toEqual(fillAssumptions(goal, profile));
  });

  it('car plan splits the price at the MAS loan cap', () => {
    const goal: GoalSpec = { kind: 'car_purchase', priceSgd: 100_000, deadlineAge: 30 };
    const plan = buildPlan(goal, baseProfile, fillAssumptions(goal, baseProfile));

    expect(plan.costStack).toHaveLength(2);
    expect(plan.costStack?.[0]?.amountSgd).toBeCloseTo(40_000, 6);
    expect(plan.costStack?.[1]?.amountSgd).toBeCloseTo(60_000, 6);
    expectNear(
      plan.requiredMonthlySavings,
      Math.max(pmtForFv(40_000, baseProfile.liquidSavings, 0.018, 60), 0)
    );
    expect(plan.verdict.reasoning).toContain('CPF cannot fund a car');
  });
});
