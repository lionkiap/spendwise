/**
 * Tests for the adviser operations layer: src/lib/adviser/{ops,facts,limits,
 * conversation}. Every expected figure below is hand-derived from the input
 * data, and the goal-impact cases assert equality against monthsToTarget
 * itself. No test touches the network: the model path runs against injected
 * fetcher stubs with a test API key, mirroring advisor.test.ts.
 */
import { describe, expect, it } from 'vitest';

import type { LedgerEntry } from '../lib/cards/types';
import {
  classifyAdviserFallback,
  classifyAdviserTurn,
  type AdviserContext,
  type AdviserModelFetcher,
} from '../lib/adviser/conversation';
import { buildFactSheet, renderModelProse } from '../lib/adviser/facts';
import {
  buildAdviserContext,
  MAX_HISTORY_MESSAGES,
  MAX_MODEL_CALLS_PER_CONVERSATION,
  MAX_PAYLOAD_BYTES,
} from '../lib/adviser/limits';
import {
  goalImpactWithExtra,
  monthComparison,
  oneOffImpact,
  reducibleCategories,
  spendingByCategory,
} from '../lib/adviser/ops';
import { monthsToTarget, type TrackedGoal } from '../lib/planner/progress';
import type { AdvisorMessage } from '../lib/advisor/types';

const AUG = '2026-08';
const JUL = '2026-07';
const JUN = '2026-06';

function entry(category: LedgerEntry['category'], amountSgd: number, monthKey: string): LedgerEntry {
  return { cardId: 'uob-one', amountSgd, category, monthKey };
}

/**
 * Hand-computed fixture ledger.
 * August 2026: dining 320 + 180 = 500 (2 records), groceries 400 + 150 = 550
 * (2), entertainment 90 (1), transport 64.4 (1). 6 records, total 1204.4.
 * July 2026: 5 records (dining 300, groceries 300, transport 50,
 * entertainment 100, online_shopping 55), total 805.
 * June 2026: 2 records only (dining 100, groceries 90), total 190.
 */
const ledger: LedgerEntry[] = [
  entry('dining', 320, AUG),
  entry('dining', 180, AUG),
  entry('groceries', 400, AUG),
  entry('groceries', 150, AUG),
  entry('entertainment', 90, AUG),
  entry('transport', 64.4, AUG),
  entry('dining', 300, JUL),
  entry('groceries', 300, JUL),
  entry('transport', 50, JUL),
  entry('entertainment', 100, JUL),
  entry('online_shopping', 55, JUL),
  entry('dining', 100, JUN),
  entry('groceries', 90, JUN),
];

/** Flat goal for hand arithmetic: rate 0 means balance = 1000 + 100 * months. */
const flatGoal: TrackedGoal = {
  id: 'save-s-5k-by-35',
  name: 'Save S$5k by 35',
  goalSpec: { kind: 'savings_target', targetAmountSgd: 5000, deadlineAge: 35 },
  targetSgd: 5000,
  requiredMonthlySgd: 100,
  ratePa: 0,
  startAge: 30,
  startSavingsSgd: 1000,
  deadlineAge: 35,
  startMonthKey: '2026-01',
  logs: [],
};

/** Goal whose frozen pace (0 monthly at 0 rate) never reaches the target. */
const stalledGoal: TrackedGoal = {
  ...flatGoal,
  id: 'stalled',
  requiredMonthlySgd: 0,
  ratePa: 0,
  targetSgd: 5000,
};

const context: AdviserContext = {
  profile: {
    age: 26,
    grossMonthlyIncome: 5200,
    monthlyExpenses: 2800,
    liquidSavings: 48000,
    cpfOaBalance: 42000,
    milesValuationCents: 1.8,
  },
  walletNames: ['UOB One', 'DBS Live Fresh'],
  ledgerAvailable: {
    months: [
      { monthKey: JUN, recordCount: 2 },
      { monthKey: JUL, recordCount: 5 },
      { monthKey: AUG, recordCount: 6 },
    ],
  },
  goalSummaries: [{ id: 'save-s-100k-by-35', name: 'Save S$100k by 35', deadlineAge: 35 }],
  protectedCategories: ['insurance'],
};

describe('spendingByCategory', () => {
  it('sums and orders categories for a recorded month', () => {
    const summary = spendingByCategory(ledger, AUG);
    expect(summary.hasRecords).toBe(true);
    expect(summary.transactionCount).toBe(6);
    expect(summary.rows.map((row) => row.category)).toEqual([
      'groceries',
      'dining',
      'entertainment',
      'transport',
    ]);
    expect(summary.rows[0].total).toBeCloseTo(550, 8);
    expect(summary.rows[0].count).toBe(2);
    expect(summary.rows[1].total).toBeCloseTo(500, 8);
    expect(summary.monthTotal).toBeCloseTo(1204.4, 8);
    expect(summary.coverageNote).toContain('may not be all spending');
    expect(summary.coverageNote).toContain('6 records');
  });

  it('reports an empty month as unknown, never as zero spending', () => {
    const summary = spendingByCategory([], AUG);
    expect(summary.hasRecords).toBe(false);
    expect(summary.rows).toEqual([]);
    expect(summary.transactionCount).toBe(0);
    expect(summary.monthTotal).toBe(0);
    expect(summary.coverageNote).toContain('unknown, not zero');

    const outputs = [
      JSON.stringify(summary),
      JSON.stringify(reducibleCategories([], AUG, ['groceries'])),
      JSON.stringify(monthComparison([], JUL, AUG)),
    ];
    for (const output of outputs) {
      expect(output).not.toMatch(/S\$0\b/);
      expect(output).not.toMatch(/zero spending/i);
      expect(output).not.toMatch(/spent nothing/i);
      expect(output).not.toMatch(/no spending/i);
    }
  });
});

describe('monthComparison', () => {
  it('refuses under 3 records in either month, with a reason naming both counts', () => {
    const refusal = monthComparison(ledger, JUN, AUG);
    expect(refusal.comparable).toBe(false);
    if (!refusal.comparable) {
      expect(refusal.reason).toContain('Not enough history');
      expect(refusal.reason).toContain('at least 3');
      expect(refusal.reason).toContain('2026-06 has 2');
      expect(refusal.reason).toContain('2026-08 has 6');
      expect(refusal.countA).toBe(2);
      expect(refusal.countB).toBe(6);
    }

    const emptyRefusal = monthComparison([], JUL, AUG);
    expect(emptyRefusal.comparable).toBe(false);
  });

  it('compares two covered months with per-category deltas and the coverage caveat', () => {
    const result = monthComparison(ledger, JUL, AUG);
    expect(result.comparable).toBe(true);
    if (result.comparable) {
      // Hand arithmetic: delta is the later month (August) minus July.
      expect(result.caveat).toContain('may not be all spending');
      expect(result.totalA).toBeCloseTo(805, 8);
      expect(result.totalB).toBeCloseTo(1204.4, 8);
      expect(result.totalDelta).toBeCloseTo(399.4, 8);
      const byCategory = new Map(result.rows.map((row) => [row.category, row.delta]));
      expect(byCategory.get('groceries')).toBeCloseTo(250, 8);
      expect(byCategory.get('dining')).toBeCloseTo(200, 8);
      expect(byCategory.get('entertainment')).toBeCloseTo(-10, 8);
      expect(byCategory.get('transport')).toBeCloseTo(14.4, 8);
      expect(byCategory.get('online_shopping')).toBeCloseTo(-55, 8);
    }
  });
});

describe('reducibleCategories', () => {
  it('excludes protected categories and caps each cut at 25 percent rounded down to 10', () => {
    const result = reducibleCategories(ledger, AUG, ['groceries']);
    // Protected groceries (550) must not appear; reducible pool is
    // 500 + 90 + 64.4 = 654.4.
    expect(result.proposals.map((proposal) => proposal.category)).not.toContain('groceries');
    expect(result.reducibleTotal).toBeCloseTo(654.4, 8);
    // Hand arithmetic: dining floor(500 * 0.25 / 10) * 10 = 120,
    // entertainment floor(90 * 0.25 / 10) * 10 = 20,
    // transport floor(64.4 * 0.25 / 10) * 10 = 10.
    expect(result.proposals).toHaveLength(3);
    expect(result.proposals[0]).toMatchObject({ category: 'dining', monthTotal: 500, proposedCut: 120, freedMonthly: 120 });
    expect(result.proposals[1]).toMatchObject({ category: 'entertainment', monthTotal: 90, proposedCut: 20 });
    expect(result.proposals[2]).toMatchObject({ category: 'transport', monthTotal: 64.4, proposedCut: 10 });
    expect(result.totalProposedCut).toBe(150);
    for (const proposal of result.proposals) {
      expect(proposal.proposedCut % 10).toBe(0);
      expect(proposal.proposedCut).toBeLessThanOrEqual(0.25 * proposal.monthTotal + 1e-9);
      expect(proposal.rationale).toContain('logged records only');
    }
    expect(result.totalProposedCut).toBeLessThanOrEqual(result.reducibleTotal);
    expect(result.maxCutFraction).toBe(0.25);
  });

  it('honours a configurable fraction and never exceeds the recorded reducible total even at fraction 1', () => {
    const half = reducibleCategories(ledger, AUG, ['groceries'], { maxCutFraction: 0.5 });
    const dining = half.proposals.find((proposal) => proposal.category === 'dining');
    // Hand arithmetic: floor(500 * 0.5 / 10) * 10 = 250.
    expect(dining?.proposedCut).toBe(250);

    const everything = reducibleCategories(ledger, AUG, [], { maxCutFraction: 1 });
    // Cuts floor to 10: dining 500, groceries 550, entertainment 90,
    // transport 60 (floor(64.4 / 10) * 10). Sum 1200 <= recorded 1204.4.
    expect(everything.totalProposedCut).toBe(1200);
    expect(everything.totalProposedCut).toBeLessThanOrEqual(everything.reducibleTotal);
    expect(everything.reducibleTotal).toBeCloseTo(1204.4, 8);
  });

  it('falls back to the default fraction for invalid options', () => {
    for (const maxCutFraction of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = reducibleCategories(ledger, AUG, [], { maxCutFraction });
      expect(result.maxCutFraction).toBe(0.25);
    }
  });

  it('proposes nothing for a month without records and says why', () => {
    const result = reducibleCategories([], AUG, ['groceries']);
    expect(result.hasRecords).toBe(false);
    expect(result.proposals).toEqual([]);
    expect(result.coverageNote).toContain('unknown, not zero');
  });
});

describe('goalImpactWithExtra', () => {
  it('matches monthsToTarget directly for a flat and a growing goal', () => {
    // Flat goal hand arithmetic: 1000 + 100 * 40 = 5000, so 40 months;
    // doubling the pace to 200 halves it to 20 months.
    const flat = goalImpactWithExtra(flatGoal, 100);
    expect(flat.monthsBefore).toBe(40);
    expect(flat.monthsAfter).toBe(20);
    expect(flat.monthsBefore).toBe(monthsToTarget(1000, 0, 100, 5000));
    expect(flat.monthsAfter).toBe(monthsToTarget(1000, 0, 200, 5000));
    expect(flat.finishAgeBefore).toBeCloseTo(30 + 40 / 12, 10);
    expect(flat.finishAgeAfter).toBeCloseTo(30 + 20 / 12, 10);

    const growing: TrackedGoal = {
      ...flatGoal,
      requiredMonthlySgd: 800,
      ratePa: 0.018,
      startSavingsSgd: 15000,
      targetSgd: 100000,
    };
    const impact = goalImpactWithExtra(growing, 200);
    expect(impact.monthsBefore).toBe(monthsToTarget(15000, 0.018, 800, 100000));
    expect(impact.monthsAfter).toBe(monthsToTarget(15000, 0.018, 1000, 100000));
    expect(impact.finishAgeBefore).toBeCloseTo(30 + (impact.monthsBefore ?? 0) / 12, 10);
  });

  it('stays null-safe when the pace never lands, and recovers with extra', () => {
    const stalled = goalImpactWithExtra(stalledGoal, 0);
    expect(stalled.monthsBefore).toBeNull();
    expect(stalled.monthsAfter).toBeNull();
    expect(stalled.finishAgeBefore).toBeNull();
    expect(stalled.finishAgeAfter).toBeNull();

    // With 50 more a month the pace lands: 1000 + 50 * 80 = 5000, so 80 months.
    const rescued = goalImpactWithExtra(stalledGoal, 50);
    expect(rescued.monthsBefore).toBeNull();
    expect(rescued.monthsAfter).toBe(80);
    expect(rescued.finishAgeAfter).toBeCloseTo(30 + 80 / 12, 10);
  });
});

describe('oneOffImpact', () => {
  it('hand-verifies the delay: a 500 one-off on a flat goal costs 5 months', () => {
    const impact = oneOffImpact(flatGoal, 500);
    // Before: 1000 + 100 * 40 = 5000 at month 40. After paying 500 from the
    // pot: 500 + 100 * 45 = 5000 at month 45. Delay 45 - 40 = 5.
    expect(impact.monthsOfDelay).toBe(5);
    expect(impact.sharedPotWarning).toBe(false);
    expect(impact.note).toContain('S$500');
    expect(impact.note).toContain('5 months');
    expect(impact.note).toContain('approximation');
  });

  it('warns when more than one tracked goal shares the space pot', () => {
    const sibling: TrackedGoal = {
      ...flatGoal,
      id: 'car-at-s-150k-by-35',
      name: 'Car at S$150k by 35',
      space: 'you',
    };
    const impact = oneOffImpact(flatGoal, 500, [flatGoal, sibling]);
    expect(impact.sharedPotWarning).toBe(true);
    expect(impact.monthsOfDelay).toBe(5);
    expect(impact.note).toContain('cannot fund two goals at once');
    expect(impact.note).toContain('2 tracked goals');

    const otherSpace: TrackedGoal = { ...sibling, id: 'partner-goal', space: 'partner' };
    expect(oneOffImpact(flatGoal, 500, [flatGoal, otherSpace]).sharedPotWarning).toBe(false);
  });

  it('returns null delay and an honest note when the pace never lands', () => {
    const impact = oneOffImpact(stalledGoal, 100);
    expect(impact.monthsOfDelay).toBeNull();
    expect(impact.note).toContain('cannot be translated into a delay');
  });
});

describe('facts', () => {
  const sheet = buildFactSheet([
    { label: 'Dining total 2026-08', value: 500, format: 'money' },
    { label: 'Dining share of recorded spending', value: 41.5, format: 'percent' },
    { label: 'Months to goal at the frozen pace', value: 40, format: 'months' },
  ]);

  it('numbers facts and formats them deterministically', () => {
    expect(sheet.map((fact) => fact.id)).toEqual(['f1', 'f2', 'f3']);
    expect(sheet[0].formatted).toBe('S$500');
    expect(sheet[1].formatted).toBe('41.5%');
    expect(sheet[2].formatted).toBe('40 months');
  });

  it('substitutes [fact:ID] references with the formatted values', () => {
    const rendered = renderModelProse(
      'Dining came to [fact:f1] this month. That is [fact:f2] of recorded spending. The goal lands in [fact:f3].',
      sheet
    );
    expect(rendered.rejected).toEqual([]);
    expect(rendered.text).toBe(
      'Dining came to S$500 this month. That is 41.5% of recorded spending. The goal lands in 40 months.'
    );
  });

  it('rejects and strips invented literal figures', () => {
    const rendered = renderModelProse(
      'You spend S$9,999 on dining and could cut 75% fast.',
      sheet
    );
    expect(rendered.rejected).toEqual(['S$9,999', '75%']);
    expect(rendered.text).not.toContain('9,999');
    expect(rendered.text).not.toContain('75%');
  });

  it('allows literals within the 0.5 percent tolerance and rejects those outside it', () => {
    const nearSheet = buildFactSheet([{ label: 'Groceries total', value: 480, format: 'money' }]);
    const near = renderModelProse('Groceries were about S$481 this month.', nearSheet);
    expect(near.rejected).toEqual([]);
    const far = renderModelProse('Groceries were about S$500 this month.', nearSheet);
    expect(far.rejected).toEqual(['S$500']);
    expect(far.text).not.toContain('S$500');
  });

  it('rejects references to facts that do not exist', () => {
    const rendered = renderModelProse('You spent [fact:f9] on dining.', sheet);
    expect(rendered.rejected).toEqual(['[fact:f9] (no such fact)']);
    expect(rendered.text).not.toContain('[fact:');
  });
});

describe('classifyAdviserFallback', () => {
  it('maps a spending review to the latest recorded month', () => {
    const turn = classifyAdviserFallback('Where is my money going?', context);
    expect(turn).toEqual({
      op: 'spending_summary',
      params: { monthKey: AUG },
      engine: 'fallback',
    });
  });

  it('maps reduce CATEGORY by AMOUNT', () => {
    const turn = classifyAdviserFallback('reduce dining by 200', context);
    expect(turn.op).toBe('reduce');
    if (turn.op === 'reduce') {
      expect(turn.params.category).toBe('dining');
      expect(turn.params.cutSgd).toBe(200);
      expect(turn.params.monthKey).toBe(AUG);
      expect(turn.params.freeSgd).toBeUndefined();
    }
  });

  it('maps a one-off amount to the single tracked goal', () => {
    const turn = classifyAdviserFallback('what does a 3000 holiday do to my goal', context);
    expect(turn.op).toBe('one_off');
    if (turn.op === 'one_off') {
      expect(turn.params.amountSgd).toBe(3000);
      expect(turn.params.goalId).toBe('save-s-100k-by-35');
    }
  });

  it('delegates stop working N months to the RevisionPatch shape', () => {
    const turn = classifyAdviserFallback('What if I stop working for six months?', context);
    expect(turn.op).toBe('what_if');
    if (turn.op === 'what_if') {
      expect(turn.params.patch).toEqual({ incomeGap: { months: 6, who: 'you' } });
    }
  });

  it('delegates a delay to a deadlineAge patch built from the goal summary', () => {
    const turn = classifyAdviserFallback('What if I delay the goal by two years?', context);
    expect(turn.op).toBe('what_if');
    if (turn.op === 'what_if') {
      expect(turn.params.patch).toEqual({ deadlineAge: 37 });
    }
  });

  it('maps do-not-touch and protect phrasings to protect_category', () => {
    expect(classifyAdviserFallback('do not touch groceries', context)).toEqual({
      op: 'protect_category',
      params: { category: 'groceries' },
      engine: 'fallback',
    });
    expect(classifyAdviserFallback('please protect insurance from any cuts', context)).toEqual({
      op: 'protect_category',
      params: { category: 'insurance' },
      engine: 'fallback',
    });
  });

  it('maps how-can-I-save-another-AMOUNT-monthly to a reduce turn with freeSgd', () => {
    const turn = classifyAdviserFallback('how can I save another 300 monthly', context);
    expect(turn.op).toBe('reduce');
    if (turn.op === 'reduce') {
      expect(turn.params.freeSgd).toBe(300);
      expect(turn.params.cutSgd).toBeUndefined();
      expect(turn.params.monthKey).toBe(AUG);
    }
  });

  it('maps a month comparison request to the two latest recorded months', () => {
    const turn = classifyAdviserFallback('compare last month with this month', context);
    expect(turn).toEqual({
      op: 'month_compare',
      params: { monthKeyA: JUL, monthKeyB: AUG },
      engine: 'fallback',
    });
  });

  it('clarifies with a specific question when an amount is missing', () => {
    const trip = classifyAdviserFallback('we are planning a trip', context);
    expect(trip.op).toBe('clarify');
    if (trip.op === 'clarify') {
      expect(trip.params.question).toContain('trip');
      expect(trip.params.question).toContain('How much');
    }

    const saveMore = classifyAdviserFallback('how can I save more each month?', context);
    expect(saveMore.op).toBe('clarify');
    if (saveMore.op === 'clarify') {
      expect(saveMore.params.question).toContain('How much more per month');
    }

    const byNothing = classifyAdviserFallback('reduce dining by a bit', context);
    expect(byNothing.op).toBe('clarify');
    if (byNothing.op === 'clarify') {
      expect(byNothing.params.question).toContain('Dining');
    }
  });

  it('clarifies a comparison when the ledger has fewer than two recorded months', () => {
    const sparse: AdviserContext = {
      ...context,
      ledgerAvailable: { months: [{ monthKey: AUG, recordCount: 6 }] },
    };
    const turn = classifyAdviserFallback('compare last month with this month', sparse);
    expect(turn.op).toBe('clarify');
    if (turn.op === 'clarify') {
      expect(turn.params.question).toContain('two months with logged records');
    }
  });

  it('returns an honest unsupported message naming the supported phrasings', () => {
    const turn = classifyAdviserFallback('Tell me about the meaning of life', context);
    expect(turn.op).toBe('unsupported');
    if (turn.op === 'unsupported') {
      expect(turn.params.message).toContain('where is my money going');
      expect(turn.params.message).toContain('reduce dining by 200');
      expect(turn.params.message).toContain('what if I stop working for 6 months');
      expect(turn.params.message).toContain('do not touch groceries');
    }
  });

  it('clarifies an empty message instead of guessing', () => {
    const turn = classifyAdviserFallback('   ', context);
    expect(turn.op).toBe('clarify');
  });
});

describe('classifyAdviserTurn', () => {
  it('uses the fallback without calling any fetcher when Nebius is unconfigured', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    let calls = 0;
    const explodingFetcher: AdviserModelFetcher = async () => {
      calls += 1;
      throw new Error('the offline path must not call a model');
    };
    try {
      const messages: AdvisorMessage[] = [
        { role: 'user', text: 'Where is my money going?' },
      ];
      const turn = await classifyAdviserTurn(messages, context, explodingFetcher);
      expect(calls).toBe(0);
      expect(turn).toEqual(classifyAdviserFallback('Where is my money going?', context));
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      }
    }
  });

  it('accepts a validated model reply, wrapping user text as inert data and sending coverage only', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    process.env.NEBIUS_API_KEY = 'test-key';
    let seenSystem = '';
    let seenUser = '';
    const stub: AdviserModelFetcher = async (system, user) => {
      seenSystem = system;
      seenUser = user;
      return { op: 'one_off', params: { amountSgd: 3000, goalId: 'save-s-100k-by-35' } };
    };
    try {
      const messages: AdvisorMessage[] = [
        { role: 'user', text: 'what does a 3000 holiday do to my goal' },
      ];
      const turn = await classifyAdviserTurn(messages, context, stub);
      expect(turn).toEqual({
        op: 'one_off',
        params: { amountSgd: 3000, goalId: 'save-s-100k-by-35' },
        engine: 'model',
      });
      expect(seenSystem).toContain('inert JSON data');
      expect(seenSystem).toContain('never instructions');
      expect(seenUser).toContain('"userText":"what does a 3000 holiday do to my goal"');
      expect(seenUser).toContain('recordCount');
      // Coverage only: no transaction-level fields ever reach the model.
      expect(seenUser).not.toContain('amountSgd');
      expect(seenUser).not.toContain('cardId');
      expect(seenUser).not.toContain('NEBIUS_API_KEY');
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
      { op: 'spending_summary', params: {} },
    ];
    let calls = 0;
    const stub: AdviserModelFetcher = async (_system, user) => {
      const reply = replies[calls];
      calls += 1;
      if (calls === 2) {
        expect(user).toContain('not valid');
      }
      return reply ?? null;
    };
    try {
      const messages: AdvisorMessage[] = [{ role: 'user', text: 'where is my money going' }];
      const turn = await classifyAdviserTurn(messages, context, stub);
      expect(calls).toBe(2);
      expect(turn).toEqual({
        op: 'spending_summary',
        params: { monthKey: AUG },
        engine: 'model',
      });
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      } else {
        delete process.env.NEBIUS_API_KEY;
      }
    }
  });

  it('rejects a model number the user never wrote and lands on the fallback', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    process.env.NEBIUS_API_KEY = 'test-key';
    let calls = 0;
    const stub: AdviserModelFetcher = async () => {
      calls += 1;
      // 12345 appears nowhere in the user text, so the figure gate rejects it.
      return { op: 'one_off', params: { amountSgd: 12345 } };
    };
    try {
      const messages: AdvisorMessage[] = [
        { role: 'user', text: 'what does a 3000 holiday do to my goal' },
      ];
      const turn = await classifyAdviserTurn(messages, context, stub);
      expect(calls).toBe(2);
      expect(turn).toEqual(classifyAdviserFallback('what does a 3000 holiday do to my goal', context));
      expect(turn.engine).toBe('fallback');
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
    const stub: AdviserModelFetcher = async () => {
      throw new Error('network down');
    };
    try {
      const messages: AdvisorMessage[] = [
        { role: 'user', text: 'What if I stop working for six months?' },
      ];
      const turn = await classifyAdviserTurn(messages, context, stub);
      expect(turn.op).toBe('what_if');
      expect(turn.engine).toBe('fallback');
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      } else {
        delete process.env.NEBIUS_API_KEY;
      }
    }
  });
});

describe('buildAdviserContext', () => {
  it('exports the required limits', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(32768);
    expect(MAX_HISTORY_MESSAGES).toBe(12);
    expect(MAX_MODEL_CALLS_PER_CONVERSATION).toBe(30);
  });

  it('drops the oldest messages beyond 12 and keeps the newest in order', () => {
    const messages: AdvisorMessage[] = Array.from({ length: 15 }, (_, index) => ({
      role: 'user' as const,
      text: `message ${index + 1}`,
    }));
    const budget = buildAdviserContext(messages, context);
    expect(budget.messages).toHaveLength(12);
    expect(budget.messages[0].text).toBe('message 4');
    expect(budget.messages[11].text).toBe('message 15');
    expect(budget.dropped).toEqual(['history message #1', 'history message #2', 'history message #3']);
    expect(budget.payloadBytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(budget.context).toEqual(context);
  });

  it('trims further under the byte budget and never drops the last message silently', () => {
    const messages: AdvisorMessage[] = Array.from({ length: 14 }, (_, index) => ({
      role: 'user' as const,
      text: `${'x'.repeat(4000)} ${index + 1}`,
    }));
    const budget = buildAdviserContext(messages, context);
    expect(budget.payloadBytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(budget.messages.length).toBeLessThan(12);
    expect(budget.messages[budget.messages.length - 1].text).toBe(`${'x'.repeat(4000)} 14`);
    expect(budget.dropped.some((entry) => entry.includes('payload budget'))).toBe(true);
    expect(budget.dropped).toContain('history message #1');
  });
});
