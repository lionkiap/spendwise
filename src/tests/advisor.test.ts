import { describe, expect, it } from 'vitest';

import { POST } from '../app/api/advisor/route';
import { classifyAdvisor, type ModelJsonFetcher } from '../lib/advisor/classify';
import { applyRevision, classifyFallback } from '../lib/advisor/engine';
import type { RevisionPatch } from '../lib/advisor/types';
import { buildPlan } from '../lib/planner/build';
import type { GoalSpec, UserProfile } from '../lib/planner/goalspec';
import { fillAssumptions } from '../lib/planner/parse';

const URL = 'http://localhost/api/advisor';

const baseProfile: UserProfile = {
  age: 25,
  grossMonthlyIncome: 6000,
  monthlyExpenses: 4000,
  liquidSavings: 50_000,
  cpfOaBalance: 15_000,
  milesValuationCents: 1.8,
};

const savingsGoal: GoalSpec = {
  kind: 'savings_target',
  targetAmountSgd: 100_000,
  deadlineAge: 35,
};

const propertyGoal: GoalSpec = {
  kind: 'property_purchase',
  propertyType: 'hdb_resale',
  targetPriceSgd: 600_000,
  deadlineAge: 35,
  firstProperty: true,
};

const carGoal: GoalSpec = {
  kind: 'car_purchase',
  priceSgd: 150_000,
  deadlineAge: 35,
};

function post(body: string): Promise<Response> {
  return POST(
    new Request(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  );
}

describe('classifyFallback', () => {
  it('maps a six-month stop to an incomeGap for you', () => {
    const turn = classifyFallback('What if I stop working for six months?', savingsGoal);
    expect(turn.kind).toBe('revise');
    if (turn.kind === 'revise') {
      expect(turn.patch.incomeGap).toEqual({ months: 6, who: 'you' });
      expect(turn.summary.length).toBeGreaterThan(0);
    }
  });

  it('maps a partner quitting for 3 months to an incomeGap for the partner', () => {
    const turn = classifyFallback('What if my partner quits her job for 3 months?', savingsGoal);
    expect(turn.kind).toBe('revise');
    if (turn.kind === 'revise') {
      expect(turn.patch.incomeGap).toEqual({ months: 3, who: 'partner' });
    }
  });

  it('maps both losing jobs for eight months to an incomeGap for both', () => {
    const turn = classifyFallback('What if we both lose our jobs for eight months?', savingsGoal);
    expect(turn.kind).toBe('revise');
    if (turn.kind === 'revise') {
      expect(turn.patch.incomeGap).toEqual({ months: 8, who: 'both' });
    }
  });

  it('maps a two year delay to deadlineAge plus two', () => {
    const turn = classifyFallback('What if I delay the goal by two years?', savingsGoal);
    expect(turn.kind).toBe('revise');
    if (turn.kind === 'revise') {
      expect(turn.patch.deadlineAge).toBe(37);
      expect(turn.patch.incomeGap).toBeUndefined();
    }
  });

  it('maps pushing the plan back 2 years to deadlineAge plus two', () => {
    const turn = classifyFallback('What if we push the plan back 2 years?', carGoal);
    expect(turn.kind).toBe('revise');
    if (turn.kind === 'revise') {
      expect(turn.patch.deadlineAge).toBe(37);
    }
  });

  it('maps cheaper to the goal price reduced by 10 percent, per goal kind', () => {
    const property = classifyFallback('What if I aim for a cheaper flat?', propertyGoal);
    expect(property.kind).toBe('revise');
    if (property.kind === 'revise') {
      expect(property.patch.targetPriceSgd).toBeCloseTo(540_000, 6);
    }

    const car = classifyFallback('What if I go for a cheaper car?', carGoal);
    expect(car.kind).toBe('revise');
    if (car.kind === 'revise') {
      expect(car.patch.priceSgd).toBeCloseTo(135_000, 6);
    }

    const savings = classifyFallback('What if I set a smaller target?', savingsGoal);
    expect(savings.kind).toBe('revise');
    if (savings.kind === 'revise') {
      expect(savings.patch.targetAmountSgd).toBeCloseTo(90_000, 6);
    }
  });

  it('answers unrecognized messages with honestly labelled offline guidance', () => {
    const turn = classifyFallback('Tell me about the meaning of life', savingsGoal);
    expect(turn.kind).toBe('answer');
    if (turn.kind === 'answer') {
      expect(turn.summary).toContain('offline advisor parser');
      expect(turn.summary).toContain('what if I stop working for 6 months');
    }
  });
});

describe('applyRevision', () => {
  it('replaces deadlineAge for any goal kind and leaves the profile untouched', () => {
    const revision = applyRevision(savingsGoal, baseProfile, { deadlineAge: 40 });
    expect(revision.goalSpec).toEqual({ ...savingsGoal, deadlineAge: 40 });
    expect(revision.profile).toEqual(baseProfile);
    expect(revision.note).toContain('age 35');
    expect(revision.note).toContain('age 40');
  });

  it('replaces targetPriceSgd on a property goal', () => {
    const revision = applyRevision(propertyGoal, baseProfile, { targetPriceSgd: 500_000 });
    expect(revision.goalSpec).toEqual({ ...propertyGoal, targetPriceSgd: 500_000 });
    expect(revision.note).toContain('$600,000');
    expect(revision.note).toContain('$500,000');
  });

  it('replaces priceSgd on a car goal', () => {
    const revision = applyRevision(carGoal, baseProfile, { priceSgd: 120_000 });
    expect(revision.goalSpec).toEqual({ ...carGoal, priceSgd: 120_000 });
  });

  it('replaces targetAmountSgd on a savings goal', () => {
    const revision = applyRevision(savingsGoal, baseProfile, { targetAmountSgd: 120_000 });
    expect(revision.goalSpec).toEqual({ ...savingsGoal, targetAmountSgd: 120_000 });
  });

  it('burns runway for an income gap: 6 months at 4000 outgoings cuts savings by 24000', () => {
    // Hand arithmetic: 6 * (4000 + 0 debt) = 24000, so 50000 becomes 26000.
    const revision = applyRevision(savingsGoal, baseProfile, {
      incomeGap: { months: 6, who: 'you' },
    });
    expect(revision.goalSpec).toEqual(savingsGoal);
    expect(revision.profile.liquidSavings).toBe(26_000);
    expect(revision.profile.monthlyExpenses).toBe(4000);
    expect(revision.note).toContain('Approximation');
    expect(revision.note).toContain('$24,000');
    expect(revision.note).toContain('$26,000');
  });

  it('burns half the runway for both at the combined level: 24000 halved is 12000', () => {
    // Hand arithmetic: (6 * 4000) / 2 = 12000, so 50000 becomes 38000.
    const revision = applyRevision(savingsGoal, baseProfile, {
      incomeGap: { months: 6, who: 'both' },
    });
    expect(revision.profile.liquidSavings).toBe(38_000);
    expect(revision.note).toContain('half and half');
  });

  it('burns the full runway when the partner is the affected person', () => {
    // Hand arithmetic: one profile is in scope, so 6 * 4000 = 24000 again.
    const revision = applyRevision(savingsGoal, baseProfile, {
      incomeGap: { months: 6, who: 'partner' },
    });
    expect(revision.profile.liquidSavings).toBe(26_000);
    expect(revision.note).toContain('the partner');
  });

  it('adds monthly debt commitments to the monthly burn when the profile states them', () => {
    // Hand arithmetic: 6 * (4000 + 1000) = 30000, so 50000 becomes 20000.
    // The cast keeps the test source-compatible whether or not UserProfile
    // declares the optional debt field yet.
    const withDebt = { ...baseProfile, monthlyDebtCommitments: 1000 } as UserProfile;
    const revision = applyRevision(savingsGoal, withDebt, {
      incomeGap: { months: 6, who: 'you' },
    });
    expect(revision.profile.liquidSavings).toBe(20_000);
    expect(revision.note).toContain('$5,000 of monthly outgoings');
    expect(revision.note).toContain('$30,000');
  });

  it('ignores price fields the goal kind does not carry and says so', () => {
    const patch: RevisionPatch = { priceSgd: 999 };
    const revision = applyRevision(savingsGoal, baseProfile, patch);
    expect(revision.goalSpec).toEqual(savingsGoal);
    expect(revision.profile).toEqual(baseProfile);
    expect(revision.note).toContain('Ignored priceSgd');
  });

  it('applies an empty patch as no change', () => {
    const revision = applyRevision(propertyGoal, baseProfile, {});
    expect(revision.goalSpec).toEqual(propertyGoal);
    expect(revision.profile).toEqual(baseProfile);
    expect(revision.note).toContain('No change applied');
  });

  it('never mutates its inputs', () => {
    const goalBefore = JSON.stringify(propertyGoal);
    const profileBefore = JSON.stringify(baseProfile);
    applyRevision(propertyGoal, baseProfile, {
      deadlineAge: 40,
      targetPriceSgd: 500_000,
      incomeGap: { months: 6, who: 'both' },
    });
    expect(JSON.stringify(propertyGoal)).toBe(goalBefore);
    expect(JSON.stringify(baseProfile)).toBe(profileBefore);
  });
});

describe('classifyAdvisor', () => {
  it('uses the fallback without calling any fetcher when Nebius is unconfigured', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    let calls = 0;
    const explodingFetcher: ModelJsonFetcher = async () => {
      calls += 1;
      throw new Error('the offline path must not call a model');
    };
    try {
      const messages = [{ role: 'user' as const, text: 'What if I stop working for six months?' }];
      const turn = await classifyAdvisor(messages, savingsGoal, baseProfile, explodingFetcher);
      expect(calls).toBe(0);
      expect(turn).toEqual(classifyFallback('What if I stop working for six months?', savingsGoal));
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      }
    }
  });

  it('returns a model turn that passes the zod schema', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    process.env.NEBIUS_API_KEY = 'test-key';
    let calls = 0;
    const stub: ModelJsonFetcher = async (system) => {
      calls += 1;
      expect(system).toContain('what-if advisor');
      return { kind: 'revise', summary: 'Later deadline', patch: { deadlineAge: 40 } };
    };
    try {
      const messages = [{ role: 'user' as const, text: 'what if I wait a bit' }];
      const turn = await classifyAdvisor(messages, savingsGoal, baseProfile, stub);
      expect(calls).toBe(1);
      expect(turn).toEqual({ kind: 'revise', summary: 'Later deadline', patch: { deadlineAge: 40 } });
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      } else {
        delete process.env.NEBIUS_API_KEY;
      }
    }
  });

  it('retries once on an invalid reply and accepts the correction', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    process.env.NEBIUS_API_KEY = 'test-key';
    const replies: Array<Record<string, unknown> | null> = [
      { nonsense: true },
      { kind: 'answer', summary: 'Fine as is.' },
    ];
    let calls = 0;
    const stub: ModelJsonFetcher = async (_system, user) => {
      const reply = replies[calls];
      calls += 1;
      if (calls === 2) {
        expect(user).toContain('not a valid advisor turn');
      }
      return reply ?? null;
    };
    try {
      const messages = [{ role: 'user' as const, text: 'is my plan ok' }];
      const turn = await classifyAdvisor(messages, savingsGoal, baseProfile, stub);
      expect(calls).toBe(2);
      expect(turn).toEqual({ kind: 'answer', summary: 'Fine as is.' });
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      } else {
        delete process.env.NEBIUS_API_KEY;
      }
    }
  });

  it('falls back to the classifier when both model replies are invalid', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    process.env.NEBIUS_API_KEY = 'test-key';
    let calls = 0;
    const stub: ModelJsonFetcher = async () => {
      calls += 1;
      // A string where the schema demands a number, so zod rejects it.
      return { kind: 'revise', summary: 'bad patch', patch: { deadlineAge: 'forty' } };
    };
    try {
      const messages = [{ role: 'user' as const, text: 'What if I delay the goal by two years?' }];
      const turn = await classifyAdvisor(messages, savingsGoal, baseProfile, stub);
      expect(calls).toBe(2);
      expect(turn).toEqual(classifyFallback('What if I delay the goal by two years?', savingsGoal));
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      } else {
        delete process.env.NEBIUS_API_KEY;
      }
    }
  });

  it('falls back instead of throwing when the fetcher rejects', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    process.env.NEBIUS_API_KEY = 'test-key';
    const stub: ModelJsonFetcher = async () => {
      throw new Error('network down');
    };
    try {
      const messages = [{ role: 'user' as const, text: 'What if I stop working for six months?' }];
      const turn = await classifyAdvisor(messages, savingsGoal, baseProfile, stub);
      expect(turn.kind).toBe('revise');
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      } else {
        delete process.env.NEBIUS_API_KEY;
      }
    }
  });
});

describe('POST /api/advisor', () => {
  it('returns a fallback-classified 200 with a full revise delta when no key is configured', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    try {
      const response = await post(
        JSON.stringify({
          messages: [{ role: 'user', text: 'What if I aim for a cheaper flat?' }],
          goalSpec: propertyGoal,
          profile: baseProfile,
        })
      );
      expect(response.status).toBe(200);
      const expectedTurn = classifyFallback('What if I aim for a cheaper flat?', propertyGoal);
      const payload = (await response.json()) as {
        kind?: string;
        summary?: string;
        note?: string;
        delta?: {
          requiredMonthlySavingsBefore: number;
          requiredMonthlySavingsAfter: number;
          verdictBefore: string;
          verdictAfter: string;
          targetBefore: number;
          targetAfter: number;
        };
        comparison?: string;
        revisedGoalSpec?: GoalSpec;
        revisedProfile?: UserProfile;
      };
      expect(payload.kind).toBe('revise');
      if (expectedTurn.kind === 'revise') {
        expect(payload.summary).toBe(expectedTurn.summary);
      }
      expect(payload.revisedGoalSpec?.kind).toBe('property_purchase');
      if (payload.revisedGoalSpec?.kind === 'property_purchase') {
        expect(payload.revisedGoalSpec.targetPriceSgd).toBeCloseTo(540_000, 6);
      }
      const delta = payload.delta;
      expect(delta).toBeDefined();
      if (delta !== undefined) {
        expect(delta.targetBefore).toBe(600_000);
        expect(delta.targetAfter).toBeCloseTo(540_000, 6);
        expect(['achievable', 'stretch', 'not_achievable']).toContain(delta.verdictBefore);
        expect(['achievable', 'stretch', 'not_achievable']).toContain(delta.verdictAfter);
        // A 10 percent cheaper price shrinks the cash stack the kernels must
        // fund, so the required monthly saving cannot rise.
        expect(delta.requiredMonthlySavingsAfter).toBeLessThanOrEqual(
          delta.requiredMonthlySavingsBefore
        );
        // The before figure is exactly what fillAssumptions plus buildPlan
        // produce on the original inputs: the route recomputes, never guesses.
        const beforePlan = buildPlan(
          propertyGoal,
          baseProfile,
          fillAssumptions(propertyGoal, baseProfile)
        );
        expect(delta.requiredMonthlySavingsBefore).toBe(beforePlan.requiredMonthlySavings);
      }
      expect(payload.comparison).toContain('$600,000');
      expect(payload.comparison).toContain('$540,000');
      expect(payload.note).toContain('Target price moved');
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      }
    }
  });

  it('carries monthly debt commitments through the wire into the runway burn', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    try {
      const response = await post(
        JSON.stringify({
          messages: [{ role: 'user', text: 'What if I stop working for six months?' }],
          goalSpec: savingsGoal,
          profile: { ...baseProfile, monthlyDebtCommitments: 1000 },
        })
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        kind?: string;
        revisedProfile?: UserProfile & { monthlyDebtCommitments?: number };
      };
      expect(payload.kind).toBe('revise');
      // Hand arithmetic: 50000 - 6 * (4000 + 1000) = 20000.
      expect(payload.revisedProfile?.liquidSavings).toBe(20_000);
      expect(payload.revisedProfile?.monthlyDebtCommitments).toBe(1000);
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      }
    }
  });

  it('returns a fallback answer 200 for unrecognized messages when no key is configured', async () => {    const previous = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    try {
      const response = await post(
        JSON.stringify({
          messages: [{ role: 'user', text: 'Tell me about the meaning of life' }],
          goalSpec: savingsGoal,
          profile: baseProfile,
        })
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { kind?: string; summary?: string };
      expect(payload.kind).toBe('answer');
      expect(payload.summary).toContain('offline advisor parser');
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      }
    }
  });

  it('returns 400 with helpful issues for a body missing required fields', async () => {
    const response = await post('{}');
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string; issues?: string[] };
    expect(payload.error).toContain('Invalid request body');
    expect(payload.issues?.join(' | ')).toContain('messages');
    expect(payload.issues?.join(' | ')).toContain('goalSpec');
    expect(payload.issues?.join(' | ')).toContain('profile');
  });

  it('returns 400 for a non-JSON body', async () => {
    const response = await post('not json at all');
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain('Request body must be JSON');
  });

  it('returns 400 when the goal spec kind is unknown', async () => {
    const response = await post(
      JSON.stringify({
        messages: [{ role: 'user', text: 'hello' }],
        goalSpec: { kind: 'yacht_purchase', priceSgd: 1, deadlineAge: 30 },
        profile: baseProfile,
      })
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { issues?: string[] };
    expect(payload.issues?.join(' | ')).toContain('goalSpec');
  });
});
