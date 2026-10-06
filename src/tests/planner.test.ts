import { describe, expect, it } from 'vitest';
import {
  bsd,
  downPaymentSplit,
  employeeCpfContribution,
  fvAnnuity,
  fvLump,
  legalFeesEstimate,
  oaProjection,
  pmtForFv,
} from '../lib/kernels';
import { chatJson, isConfigured } from '../lib/nebius';
import { buildPlan } from '../lib/planner/build';
import { PLANNER_DEFAULTS, type GoalSpec, type UserProfile } from '../lib/planner/goalspec';
import { enrichPlanNarrative } from '../lib/planner/narrative';
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
    // Recomputed spendable surplus: 12,000 gross - 1,200 CPF (20 percent of
    // the 6,000 ceiling) - 3,000 expenses = 7,800 >= the 4,278.10 required.
    expect(plan.verdict.status).toBe('achievable');
  });

  it('is not_achievable for a near zero income profile', () => {
    const barelyEarns: UserProfile = { ...baseProfile, grossMonthlyIncome: 400, monthlyExpenses: 250 };
    const plan = buildPlan(goal, barelyEarns, assumptions);
    // Recomputed spendable surplus: 400 - 80 CPF - 250 expenses = 70.
    expect(plan.verdict.status).toBe('not_achievable');
  });

  it('is stretch for a required monthly saving just above the spendable surplus', () => {
    // Recomputed for the spendable-income verdict: required monthly is
    // 4278.10 for this goal regardless of income (kernel chain: 195,400
    // upfront stack minus 16,167 projected CPF OA = 179,233 cash needed,
    // pmtForFv over 36 months at 1.8 percent from a 20,000 pot). A stated
    // take-home of 5,000 minus 800 expenses leaves a spendable surplus of
    // 4,200, and 4,200 < 4,278.10 <= 1.3 x 4,200 = 5,460, so the verdict is
    // stretch. (The old test used gross 6,000 minus 2,200 expenses = 3,800,
    // which no longer bounds the verdict now the surplus is spendable.)
    const middling: UserProfile = { ...baseProfile, takeHomeMonthlyIncome: 5_000, monthlyExpenses: 800 };
    const plan = buildPlan(goal, middling, assumptions);
    const surplus = (middling.takeHomeMonthlyIncome ?? 0) - middling.monthlyExpenses;
    expect(surplus).toBe(4_200);
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

describe('investments as planner input', () => {
  const goal: GoalSpec = { kind: 'savings_target', targetAmountSgd: 100_000, deadlineAge: 35 };

  it('positive investments reduce requiredMonthlySavings versus a zero-investments baseline', () => {
    const baseline = buildPlan(goal, baseProfile, fillAssumptions(goal, baseProfile));
    const investor: UserProfile = { ...baseProfile, investmentsSgd: 20_000 };
    const invested = buildPlan(goal, investor, fillAssumptions(goal, investor));

    expect(baseline.requiredMonthlySavings).toBeGreaterThan(0);
    expect(invested.requiredMonthlySavings).toBeLessThan(baseline.requiredMonthlySavings);
    // The monthly payment only closes the gap the investments leg leaves after
    // growing at its own default rate for the 10 years to the deadline.
    const expected = Math.max(
      pmtForFv(100_000 - fvLump(20_000, 0.045, 10), baseProfile.liquidSavings, 0.018, 120),
      0
    );
    expectNear(invested.requiredMonthlySavings, expected, 0.001);
    // The combined balance column still ends at the target.
    const lastRow = invested.savingsSchedule[invested.savingsSchedule.length - 1];
    expectNear(lastRow?.balance ?? 0, 100_000, 0.001);
    // The coverage fact merges into an existing point, never a sixth one.
    expect(invested.teaching).toHaveLength(5);
    expect(invested.teaching.some((point) => point.body.includes('investment portfolio'))).toBe(true);
  });

  it('shows the investmentRatePa assumption chip only when investments exist and the rate is unstated', () => {
    const investor: UserProfile = { ...baseProfile, investmentsSgd: 20_000 };
    const chip = fillAssumptions(goal, investor).find((entry) => entry.field === 'investmentRatePa');
    expect(chip?.value).toBeCloseTo(PLANNER_DEFAULTS.investmentRatePa, 9);
    expect(missingFields(goal, investor)).toContain('investmentRatePa');

    const stated: UserProfile = { ...baseProfile, investmentsSgd: 20_000, investmentRatePa: 0.06 };
    expect(
      fillAssumptions(goal, stated).find((entry) => entry.field === 'investmentRatePa')
    ).toBeUndefined();

    expect(
      fillAssumptions(goal, baseProfile).find((entry) => entry.field === 'investmentRatePa')
    ).toBeUndefined();
  });
});

/**
 * Opens the isConfigured gate with a fake in-memory key so the stubbed paths
 * run. The fetcher is always stubbed in these tests, so nothing touches the
 * network; the key is restored afterwards.
 */
async function withFakeKeyEnv(run: () => Promise<void>): Promise<void> {
  const previous = process.env.NEBIUS_API_KEY;
  process.env.NEBIUS_API_KEY = 'unit-test-stub-never-sent-to-any-endpoint';
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.NEBIUS_API_KEY;
    } else {
      process.env.NEBIUS_API_KEY = previous;
    }
  }
}

describe('enrichPlanNarrative', () => {
  const goal: GoalSpec = { kind: 'savings_target', targetAmountSgd: 100_000, deadlineAge: 35 };
  const plan = buildPlan(goal, baseProfile, fillAssumptions(goal, baseProfile));

  it('stays deterministic without calling any model when Nebius is unconfigured', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    try {
      let called = false;
      const enriched = await enrichPlanNarrative(plan, async () => {
        called = true;
        return null;
      });
      expect(called).toBe(false);
      expect(enriched.narrativeEngine).toBe('deterministic');
      expect(enriched.verdict.reasoning).toBe(plan.verdict.reasoning);
      expect(enriched.teaching).toEqual(plan.teaching);
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      }
    }
  });

  it('keeps deterministic content when the fetcher returns null', async () => {
    await withFakeKeyEnv(async () => {
      const enriched = await enrichPlanNarrative(plan, async () => null);
      expect(enriched.narrativeEngine).toBe('deterministic');
      expect(enriched.verdict.reasoning).toBe(plan.verdict.reasoning);
      expect(enriched.teaching).toEqual(plan.teaching);
      expect(enriched.savingsSchedule).toEqual(plan.savingsSchedule);
      expect(enriched.requiredMonthlySavings).toBe(plan.requiredMonthlySavings);
    });
  });

  it('stays deterministic when the fetcher returns an invalid shape', async () => {
    await withFakeKeyEnv(async () => {
      const wrongCount = await enrichPlanNarrative(plan, async () => ({
        verdictReasoning: 'Rewritten.',
        teachingBodies: ['Only one body for five points.'],
      }));
      expect(wrongCount.narrativeEngine).toBe('deterministic');
      expect(wrongCount.teaching).toEqual(plan.teaching);

      const emptyBodies = await enrichPlanNarrative(plan, async () => ({
        verdictReasoning: 'Rewritten.',
        teachingBodies: plan.teaching.map(() => ''),
      }));
      expect(emptyBodies.narrativeEngine).toBe('deterministic');
      expect(emptyBodies.verdict.reasoning).toBe(plan.verdict.reasoning);

      const missingField = await enrichPlanNarrative(plan, async () => ({
        teachingBodies: plan.teaching.map(() => 'A body.'),
      }));
      expect(missingField.narrativeEngine).toBe('deterministic');
      expect(missingField.teaching).toEqual(plan.teaching);
    });
  });

  it('becomes ultra with bodies replaced and the right count under a valid stub', async () => {
    await withFakeKeyEnv(async () => {
      const bodies = plan.teaching.map((point, index) => `Rewritten ${index + 1}: ${point.title}.`);
      const enriched = await enrichPlanNarrative(plan, async () => ({
        verdictReasoning: 'Rewritten reasoning keeping every figure verbatim.',
        teachingBodies: bodies,
      }));
      expect(enriched.narrativeEngine).toBe('ultra');
      expect(enriched.verdict.reasoning).toBe('Rewritten reasoning keeping every figure verbatim.');
      expect(enriched.verdict.headline).toBe(plan.verdict.headline);
      expect(enriched.teaching).toHaveLength(plan.teaching.length);
      expect(enriched.teaching.map((point) => point.body)).toEqual(bodies);
      expect(enriched.teaching.map((point) => point.title)).toEqual(
        plan.teaching.map((point) => point.title)
      );
      expect(enriched.requiredMonthlySavings).toBe(plan.requiredMonthlySavings);
      expect(enriched.scenarioGrid).toEqual(plan.scenarioGrid);
      expect(enriched.assumptions).toEqual(plan.assumptions);
    });
  });
});

describe('savings schedule interest semantics', () => {
  const goal: GoalSpec = { kind: 'savings_target', targetAmountSgd: 100_000, deadlineAge: 35, instrumentRatePa: 0.018 };

  it('reports first-year interest as growth only, never the starting pot', () => {
    const plan = buildPlan(goal, baseProfile, fillAssumptions(goal, baseProfile));
    const pmt = plan.requiredMonthlySavings;
    const row = plan.savingsSchedule[0];
    // Hand formula: year-one interest = kernel-grown pot + kernel-grown
    // contributions - the pot - the contributions. With the S$20,000 pot at
    // 1.8 percent that is 363.02 of pot growth plus annuity growth = 420.59.
    const expected =
      fvLump(baseProfile.liquidSavings, 0.018, 1) +
      fvAnnuity(pmt, 0.018, 12) -
      baseProfile.liquidSavings -
      12 * pmt;
    expect(row?.year).toBe(1);
    expect(row?.interest).toBeCloseTo(expected, 6);
    // Regression: the old zero baseline reported the whole pot (about
    // S$20,420) as first-year interest; growth only is a few hundred.
    expect(row?.interest).toBeLessThan(baseProfile.liquidSavings * 0.1);
    expect(Math.abs((row?.interest ?? 0) - baseProfile.liquidSavings)).toBeGreaterThan(
      baseProfile.liquidSavings * 0.5
    );
  });

  it('excludes both starting legs, cash and investments, from the interest rows', () => {
    const investor: UserProfile = { ...baseProfile, investmentsSgd: 20_000 };
    const plan = buildPlan(goal, investor, fillAssumptions(goal, investor));
    const pmt = plan.requiredMonthlySavings;
    const row = plan.savingsSchedule[0];
    // Baseline is the cash pot plus the investments leg, so the interest row
    // counts only growth: cash at 1.8 percent, portfolio at the 4.5 default,
    // contributions at 1.8 percent, minus the 40,000 starting legs.
    const expected =
      fvLump(20_000, 0.018, 1) +
      fvLump(20_000, 0.045, 1) +
      fvAnnuity(pmt, 0.018, 12) -
      40_000 -
      12 * pmt;
    expect(row?.interest).toBeCloseTo(expected, 6);
    expect(row?.interest).toBeLessThan(2_000);
  });

  it('keeps starting legs plus contributions plus interest equal to the final balance', () => {
    const plan = buildPlan(goal, baseProfile, fillAssumptions(goal, baseProfile));
    const rows = plan.savingsSchedule;
    const contributions = rows.reduce((sum, entry) => sum + entry.contributions, 0);
    const interest = rows.reduce((sum, entry) => sum + entry.interest, 0);
    const finalBalance = rows[rows.length - 1]?.balance ?? 0;
    expect(contributions + interest + baseProfile.liquidSavings).toBeCloseTo(finalBalance, 6);
  });
});

describe('spendable income affordability', () => {
  const goal: GoalSpec = { kind: 'savings_target', targetAmountSgd: 100_000, deadlineAge: 35 };

  it('computes employee CPF as 20 percent of ordinary wages capped at the 6000 ceiling', () => {
    expect(employeeCpfContribution(3_000)).toBeCloseTo(600, 9);
    expect(employeeCpfContribution(6_000)).toBeCloseTo(1_200, 9);
    expect(employeeCpfContribution(6_001)).toBeCloseTo(1_200, 9);
    expect(employeeCpfContribution(20_000)).toBeCloseTo(1_200, 9);
    expect(employeeCpfContribution(0)).toBe(0);
  });

  it('derives take-home by deducting CPF at the ceiling and names it in the verdict', () => {
    const plan = buildPlan(goal, baseProfile, fillAssumptions(goal, baseProfile));
    // 6,000 gross - 1,200 CPF - 2,500 expenses = 2,300 spendable against a
    // required 578.96, so achievable with the deduction named.
    expect(plan.verdict.status).toBe('achievable');
    expect(plan.verdict.headline).toContain('after CPF');
    expect(plan.verdict.reasoning).toContain('take-home pay after CPF');
    expect(plan.verdict.reasoning).toContain('CPF contributions of $1,200 a month');
    expect(plan.verdict.reasoning).toContain('$2,300');
  });

  it('uses a stated take-home figure instead of deducting CPF', () => {
    const stated: UserProfile = { ...baseProfile, takeHomeMonthlyIncome: 5_000 };
    const plan = buildPlan(goal, stated, fillAssumptions(goal, stated));
    // 5,000 stated take-home - 2,500 expenses = 2,500 spendable, no CPF line.
    expect(plan.verdict.status).toBe('achievable');
    expect(plan.verdict.headline).not.toContain('after CPF');
    expect(plan.verdict.reasoning).toContain('stated take-home pay');
    expect(plan.verdict.reasoning).toContain('$2,500');
    expect(plan.verdict.reasoning).not.toContain('nets off CPF');
  });

  it('subtracts monthly debt commitments and names them next to CPF', () => {
    const indebted: UserProfile = { ...baseProfile, monthlyDebtCommitments: 1_900 };
    const plan = buildPlan(goal, indebted, fillAssumptions(goal, indebted));
    // 2,300 spendable before debts - 1,900 debts = 400, and 1.3 x 400 = 520
    // is below the 578.96 required, so not achievable.
    expect(plan.verdict.status).toBe('not_achievable');
    expect(plan.verdict.headline).toContain('after CPF and debts');
    expect(plan.verdict.reasoning).toContain('monthly debt commitments of $1,900');
  });

  it('keeps MSR and TDSR on gross income while the verdict uses spendable income', () => {
    const propertyGoal: GoalSpec = {
      kind: 'property_purchase',
      propertyType: 'hdb_resale',
      targetPriceSgd: 600_000,
      deadlineAge: 28,
      firstProperty: true,
    };
    const profile: UserProfile = { ...baseProfile, grossMonthlyIncome: 12_000, monthlyDebtCommitments: 1_500 };
    const plan = buildPlan(propertyGoal, profile, fillAssumptions(propertyGoal, profile));
    // MSR and TDSR ratios divide the installment by the 12,000 gross figure.
    expect(plan.debt?.msr.ratio).toBeCloseTo(
      (plan.debt?.concessionary.monthlyInstallment ?? 0) / 12_000,
      9
    );
    expect(plan.debt?.tdsr.ratio).toBeCloseTo(
      (plan.debt?.concessionary.monthlyInstallment ?? 0) / 12_000,
      9
    );
    // The verdict surplus instead nets off CPF (1,200 at the ceiling) and the
    // 1,500 debts from take-home: 12,000 - 1,200 - 2,500 - 1,500 = 6,800.
    expect(plan.verdict.headline).toContain('after CPF and debts');
    expect(plan.verdict.reasoning).toContain('$6,800');
    expect(plan.verdict.reasoning).toContain('monthly debt commitments of $1,500');
  });

  it('teaches the emergency reserve from the profile value without touching the math', () => {
    const plan = buildPlan(goal, baseProfile, fillAssumptions(goal, baseProfile));
    const cushioned: UserProfile = { ...baseProfile, emergencyReserveMonths: 6 };
    const plan6 = buildPlan(goal, cushioned, fillAssumptions(goal, cushioned));
    expect(plan.teaching[0]?.body).toContain('emergency reserve of 3 months of expenses');
    expect(plan6.teaching[0]?.body).toContain('emergency reserve of 6 months of expenses');
    expect(plan6.teaching).toHaveLength(plan.teaching.length);
    // Advisory only: the savings math is byte-identical.
    expect(plan6.requiredMonthlySavings).toBe(plan.requiredMonthlySavings);
    expect(plan6.savingsSchedule).toEqual(plan.savingsSchedule);
    expect(plan6.scenarioGrid).toEqual(plan.scenarioGrid);
  });
});

describe('buildCarPlan total cost of ownership', () => {
  it('exposes a tco block with a positive total and readable assumption strings', () => {
    const goal: GoalSpec = { kind: 'car_purchase', priceSgd: 100_000, deadlineAge: 30 };
    const plan = buildPlan(goal, baseProfile, fillAssumptions(goal, baseProfile));

    expect(plan.tco).toBeDefined();
    expect(plan.tco?.total).toBeGreaterThan(0);
    expect(plan.tco?.assumptions.length).toBeGreaterThanOrEqual(6);
    for (const line of plan.tco?.assumptions ?? []) {
      expect(line.length).toBeGreaterThan(0);
    }
    // Flat interest on the 60000 loan over the 5 year cap, spread over 10
    // ownership years, plus the snapshot running costs.
    expect(plan.tco?.yearly.loan).toBeCloseTo((60_000 * 0.027 * 5) / 10, 6);
    expect(plan.tco?.yearly.energy).toBeCloseTo(0.18 * 15_000, 6);
    expect(plan.tco?.total).toBeCloseTo((plan.tco?.yearly.total ?? 0) * 10, 6);
    const joined = plan.tco?.assumptions.join(' ') ?? '';
    expect(joined).toContain('Insurance');
    expect(joined).toContain('Road tax');
    expect(joined).toContain('Maintenance');
  });
});
