import { describe, expect, it } from 'vitest';
import { nanoModel, pingNebius } from '../lib/nebius';
import { buildPlan } from '../lib/planner/build';
import type { GoalSpec, UserProfile } from '../lib/planner/goalspec';
import {
  allowedPlanFigures,
  enrichPlanNarrative,
  extractFigureClaims,
  narrativeFiguresValid,
} from '../lib/planner/narrative';
import { fillAssumptions } from '../lib/planner/parse';

const baseProfile: UserProfile = {
  age: 25,
  grossMonthlyIncome: 6000,
  monthlyExpenses: 2500,
  liquidSavings: 20000,
  cpfOaBalance: 15000,
  milesValuationCents: 1.8,
};

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

describe('extractFigureClaims', () => {
  it('pulls dollar amounts, percentages and standalone ages', () => {
    const claims = extractFigureClaims(
      'Save $100,000 by age 28 at 2.5 percent; your partner added S$1,200 (13.7% of it) aged 30.'
    );
    expect(claims.filter((claim) => claim.kind === 'amount').map((claim) => claim.value)).toEqual([
      100_000, 1_200,
    ]);
    expect(claims.filter((claim) => claim.kind === 'percent').map((claim) => claim.value)).toEqual([
      2.5, 13.7,
    ]);
    expect(claims.filter((claim) => claim.kind === 'age').map((claim) => claim.value)).toEqual([28, 30]);
  });

  it('strips grouping commas and reads decimals', () => {
    const claims = extractFigureClaims('$1,200,000 grows to $2,045.50 at 1.8 percent.');
    expect(claims.map((claim) => claim.value)).toEqual([1_200_000, 2_045.5, 1.8]);
  });

  it('makes no claim from bare numbers that are not amounts, percents or ages', () => {
    // Years, months, row counts and the word age without a number stay
    // unclaimed so honest prose about durations never trips the gate.
    expect(extractFigureClaims('Over 10 years and 60 months, row 3, month 12.')).toEqual([]);
    expect(extractFigureClaims('An emergency reserve of 3 months of expenses.')).toEqual([]);
  });
});

describe('narrativeFiguresValid', () => {
  // 2.5 is the percent-point variant of the 0.025 rate field; the variant
  // construction itself is covered by the allowedPlanFigures tests below.
  const allowed = new Set([100_000, 0.025, 2.5, 28]);

  it('accepts verbatim figures and their formatted variants', () => {
    // 2.5 percent matches the 0.025 rate through the percent-point variant.
    expect(narrativeFiguresValid('$100,000 by age 28 at 2.5 percent', allowed)).toBe(true);
    expect(narrativeFiguresValid('Nothing numeric here at all.', allowed)).toBe(true);
  });

  it('rejects figures outside the allowed set', () => {
    expect(narrativeFiguresValid('$101,000 by age 28', allowed)).toBe(false);
    expect(narrativeFiguresValid('$100,000 by age 35', allowed)).toBe(false);
    expect(narrativeFiguresValid('$100,000 at 3.5 percent', allowed)).toBe(false);
    expect(narrativeFiguresValid('S$555,555 is needed', allowed)).toBe(false);
  });

  it('accepts arrays as the allowed set and applies the given tolerance', () => {
    expect(narrativeFiguresValid('$100,000', [100_000])).toBe(true);
    // Default tolerance 0.005 rejects a 1 percent deviation...
    expect(narrativeFiguresValid('$101,000', [100_000])).toBe(false);
    // ...but an explicitly looser tolerance accepts it.
    expect(narrativeFiguresValid('$101,000', [100_000], 0.02)).toBe(true);
  });
});

describe('enrichPlanNarrative figure gate', () => {
  const goal: GoalSpec = { kind: 'savings_target', targetAmountSgd: 100_000, deadlineAge: 35 };
  const plan = buildPlan(goal, baseProfile, fillAssumptions(goal, baseProfile));

  it('treats the deterministic plan text itself as fully allowed', () => {
    const allowed = allowedPlanFigures(plan);
    expect(narrativeFiguresValid(plan.verdict.reasoning, allowed)).toBe(true);
    for (const point of plan.teaching) {
      expect(narrativeFiguresValid(point.body, allowed)).toBe(true);
    }
    // Formatted variants are in the set: the raw rate, its percent-point form
    // (1.8 percent for the 0.018 field) and the rounded required monthly.
    expect(allowed.has(plan.requiredMonthlySavings)).toBe(true);
    expect(allowed.has(0.018 * 100)).toBe(true);
    expect(allowed.has(Math.round(plan.requiredMonthlySavings))).toBe(true);
    expect(allowed.has(100_000)).toBe(true);
  });

  it('accepts a rewrite whose figures are verbatim plan figures', async () => {
    await withFakeKeyEnv(async () => {
      const enriched = await enrichPlanNarrative(plan, async () => ({
        verdictReasoning: plan.verdict.reasoning,
        teachingBodies: plan.teaching.map((point) => point.body),
      }));
      expect(enriched.narrativeEngine).toBe('ultra');
      expect(enriched.verdict.reasoning).toBe(plan.verdict.reasoning);
      expect(enriched.teaching).toEqual(plan.teaching);
    });
  });

  it('accepts a reworded sentence that keeps plan figures verbatim', async () => {
    await withFakeKeyEnv(async () => {
      const enriched = await enrichPlanNarrative(plan, async () => ({
        verdictReasoning: 'Plainly: the kernels ask for $579 a month, and CPF contributions of $1,200 are already netted off.',
        teachingBodies: plan.teaching.map((point) => point.body),
      }));
      expect(enriched.narrativeEngine).toBe('ultra');
      expect(enriched.verdict.reasoning).toBe(
        'Plainly: the kernels ask for $579 a month, and CPF contributions of $1,200 are already netted off.'
      );
    });
  });

  it('falls back to deterministic when the verdict reasoning invents a figure', async () => {
    await withFakeKeyEnv(async () => {
      const enriched = await enrichPlanNarrative(plan, async () => ({
        verdictReasoning: `${plan.verdict.reasoning} Consider saving S$555,555 instead.`,
        teachingBodies: plan.teaching.map((point) => point.body),
      }));
      expect(enriched.narrativeEngine).toBe('deterministic');
      expect(enriched.verdict.reasoning).toBe(plan.verdict.reasoning);
      expect(enriched.teaching).toEqual(plan.teaching);
    });
  });

  it('falls back to deterministic when one teaching body invents a percentage', async () => {
    await withFakeKeyEnv(async () => {
      const bodies = plan.teaching.map((point) => point.body);
      bodies[0] = `${bodies[0]} At rates near 13.7 percent everything changes.`;
      const enriched = await enrichPlanNarrative(plan, async () => ({
        verdictReasoning: plan.verdict.reasoning,
        teachingBodies: bodies,
      }));
      expect(enriched.narrativeEngine).toBe('deterministic');
      expect(enriched.teaching.map((point) => point.body)).toEqual(plan.teaching.map((point) => point.body));
    });
  });

  it('falls back to deterministic when a rewrite invents an age', async () => {
    await withFakeKeyEnv(async () => {
      const enriched = await enrichPlanNarrative(plan, async () => ({
        verdictReasoning: 'Reaching it by age 64 needs the same monthly saving.',
        teachingBodies: plan.teaching.map((point) => point.body),
      }));
      expect(enriched.narrativeEngine).toBe('deterministic');
    });
  });
});

describe('pingNebius', () => {
  it('reports unconfigured without a key and never calls the fetcher', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    try {
      let called = false;
      const health = await pingNebius(async () => {
        called = true;
        return { ok: true };
      });
      expect(health).toBe('unconfigured');
      expect(called).toBe(false);
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      }
    }
  });

  it('maps stub outcomes to verified and configured under a key', async () => {
    await withFakeKeyEnv(async () => {
      expect(await pingNebius(async () => ({ ok: true }))).toBe('verified');
      expect(await pingNebius(async () => null)).toBe('configured');
      await expect(
        pingNebius(async () => {
          throw new Error('endpoint down');
        })
      ).resolves.toBe('configured');
    });
  });

  it('pings the nano model on the chatJson call shape', async () => {
    await withFakeKeyEnv(async () => {
      const seen: Array<{ system: string; user: string; model: string }> = [];
      const health = await pingNebius(async (system, user, model) => {
        seen.push({ system, user, model });
        return { ok: true };
      });
      expect(health).toBe('verified');
      expect(seen).toHaveLength(1);
      expect(seen[0]?.model).toBe(nanoModel());
      expect(seen[0]?.system.length).toBeGreaterThan(0);
      expect(seen[0]?.user.length).toBeGreaterThan(0);
    });
  });
});
