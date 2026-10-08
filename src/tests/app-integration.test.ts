import { describe, expect, it } from 'vitest';

import { CARDS } from '../lib/data/cards';
import { buildPlan } from '../lib/planner/build';
import type { GoalSpec, UserProfile } from '../lib/planner/goalspec';
import { fillAssumptions, parseGoalFallback } from '../lib/planner/parse';
import { combineProfiles } from '../lib/planner/goalspec';
import { monthKeyDiff, type TrackedGoal } from '../lib/planner/progress';
import {
  ADVISER_PREFS_PARTNER_KEY,
  ADVISER_PREFS_US_KEY,
  ADVISER_PREFS_YOU_KEY,
  ASSUMPTION_LABELS,
  BACKUP_VERSION,
  CUSTOM_CARDS_KEY,
  GOALS_KEY,
  LEDGER_US_KEY,
  LEDGER_YOU_KEY,
  PROFILE_PARTNER_KEY,
  PROFILE_YOU_KEY,
  SPACE_ACTIVE_KEY,
  WALLET_PARTNER_KEY,
  WALLET_US_KEY,
  WALLET_YOU_KEY,
  adviserPrefsKeyFor,
  applyAdviserGoalRevision,
  applyAdviserProfileAdjustment,
  assumptionLabel,
  buildBackup,
  buildSampleJourney,
  buildUndoSnapshot,
  defaultProfileForm,
  epochMatches,
  isAdviserPrefsPayload,
  isAdvisorReply,
  isSaneStoredProfile,
  isTrackedGoal,
  parseAdviserPrefs,
  parseBackup,
  previewReduceEffect,
  profileFormFromRevised,
  promptFromGoalSpec,
  serializeAdviserPrefs,
  snapshotsEqual,
  toggleProtectedCategory,
} from '../app/components/shared';
import { POST as adviserChatPost } from '../app/api/adviser/chat/route';
import { MAX_MODEL_CALLS_PER_CONVERSATION, MAX_PAYLOAD_BYTES } from '../lib/adviser/limits';

/**
 * app-integration tests: the pure seams the UI wiring leans on. No DOM and no
 * network: buildBackup and parseBackup are pure, the label map is a constant
 * and the stretch-headline check runs the deterministic plan builder offline.
 * The adviser-chat route tests call POST directly with no API key configured,
 * so classification lands on the deterministic fallback without any fetch.
 */

/* ---------------------------------------------------------------------- */
/* Fixtures                                                               */
/* ---------------------------------------------------------------------- */

const EXPORTED_AT = '2026-10-06T08:00:00.000Z';

const STORED_PROFILE_YOU = {
  age: 24,
  grossMonthlyIncome: 4800,
  monthlyExpenses: 2600,
  liquidSavings: 15000,
  cpfOaBalance: 12000,
  milesValuationCents: 1.8,
  investmentsSgd: 5000,
  investmentRatePa: 0.045,
  takeHomeMonthlyIncome: 4000,
  monthlyDebtCommitments: 500,
  emergencyReserveMonths: 6,
};

const STORED_PROFILE_PARTNER = {
  age: 25,
  grossMonthlyIncome: 4200,
  monthlyExpenses: 2400,
  liquidSavings: 9000,
  cpfOaBalance: 8000,
  milesValuationCents: 1.8,
};

const LEDGER_ROW = {
  cardId: 'dbs-live-fresh',
  amountSgd: 120.5,
  category: 'groceries',
  monthKey: '2026-09',
  merchant: 'FairPrice',
};

const CUSTOM_CARD = {
  name: 'Neighbourhood Card',
  issuer: 'Local Bank',
  rewardType: 'cashback',
  baseRate: 0.003,
  earnStructure: [{ category: 'groceries', rate: 0.05, capMonthlySgd: 500 }],
  annualFeeSgd: 0,
};

const TRACKED_GOAL = {
  id: 'hdb-resale-by-28',
  name: 'HDB resale at S$600k by age 28',
  goalSpec: { kind: 'property_purchase', propertyType: 'hdb_resale', targetPriceSgd: 600000, deadlineAge: 28 },
  targetSgd: 182139,
  requiredMonthlySgd: 350,
  ratePa: 0.018,
  startAge: 24,
  startSavingsSgd: 4000,
  deadlineAge: 28,
  startMonthKey: '2026-01',
  space: 'us',
  logs: [
    { monthKey: '2026-01', contributedSgd: 500, contributor: 'you' },
    { monthKey: '2026-01', contributedSgd: 300, contributor: 'partner' },
  ],
};

const VALID_DATA: Record<string, string> = {
  [PROFILE_YOU_KEY]: JSON.stringify(STORED_PROFILE_YOU),
  [PROFILE_PARTNER_KEY]: JSON.stringify(STORED_PROFILE_PARTNER),
  [WALLET_YOU_KEY]: JSON.stringify(['dbs-live-fresh', 'uob-one']),
  [WALLET_US_KEY]: JSON.stringify([]),
  [LEDGER_US_KEY]: JSON.stringify([LEDGER_ROW]),
  [CUSTOM_CARDS_KEY]: JSON.stringify([CUSTOM_CARD]),
  [GOALS_KEY]: JSON.stringify([TRACKED_GOAL]),
  [SPACE_ACTIVE_KEY]: 'us',
};

/* ---------------------------------------------------------------------- */
/* Assumption label map                                                   */
/* ---------------------------------------------------------------------- */

describe('ASSUMPTION_LABELS', () => {
  it('carries the friendly label for every planner assumption field', () => {
    expect(ASSUMPTION_LABELS).toEqual({
      instrumentRatePa: 'Savings growth rate',
      mortgageStressRatePa: 'Mortgage stress-test rate',
      hdbConcessionaryRatePa: 'HDB loan rate',
      renovationBufferSgd: 'Renovation buffer',
      inflationPa: 'Inflation',
      deadlineAge: 'Target age',
      investmentRatePa: 'Investment return',
      priceSgd: 'Assumed price',
    });
  });

  it('falls back to the raw field name for unknown fields', () => {
    expect(assumptionLabel('targetPriceSgd')).toBe('targetPriceSgd');
    expect(assumptionLabel('instrumentRatePa')).toBe('Savings growth rate');
  });
});

/* ---------------------------------------------------------------------- */
/* Backup round trip                                                      */
/* ---------------------------------------------------------------------- */

describe('buildBackup and parseBackup round trip', () => {
  it('wraps every sw_ key with the plain header and imports it back whole', () => {
    const file = buildBackup({ ...VALID_DATA, not_ours: 'x' }, EXPORTED_AT);
    expect(file.app).toBe('spendwise');
    expect(file.version).toBe(BACKUP_VERSION);
    expect(file.exportedAtIso).toBe(EXPORTED_AT);
    // Non sw_ keys never make it into a backup.
    expect(Object.keys(file.data).sort()).toEqual(Object.keys(VALID_DATA).sort());

    const result = parseBackup(JSON.stringify(file));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plan.exportedAtIso).toBe(EXPORTED_AT);
    expect(result.plan.skipped).toEqual([]);
    const byKey: Record<string, string> = {};
    for (const entry of result.plan.entries) {
      byKey[entry.key] = entry.value;
    }
    expect(Object.keys(byKey).sort()).toEqual(Object.keys(VALID_DATA).sort());
    // Values survive verbatim, exactly what export read out of localStorage.
    expect(byKey[PROFILE_YOU_KEY]).toBe(VALID_DATA[PROFILE_YOU_KEY]);
    expect(byKey[PROFILE_PARTNER_KEY]).toBe(VALID_DATA[PROFILE_PARTNER_KEY]);
    expect(byKey[WALLET_YOU_KEY]).toBe(VALID_DATA[WALLET_YOU_KEY]);
    expect(byKey[WALLET_US_KEY]).toBe(VALID_DATA[WALLET_US_KEY]);
    expect(byKey[LEDGER_US_KEY]).toBe(VALID_DATA[LEDGER_US_KEY]);
    expect(byKey[CUSTOM_CARDS_KEY]).toBe(VALID_DATA[CUSTOM_CARDS_KEY]);
    expect(byKey[GOALS_KEY]).toBe(VALID_DATA[GOALS_KEY]);
    expect(byKey[SPACE_ACTIVE_KEY]).toBe('us');
  });

  it('rejects a corrupt file with an error and imports nothing', () => {
    const corrupt = JSON.stringify(buildBackup(VALID_DATA, EXPORTED_AT)).slice(0, 40);
    const result = parseBackup(corrupt);
    expect(result).toEqual({ ok: false, error: 'the file is not valid JSON' });
  });

  it('rejects files with the wrong header or version', () => {
    expect(parseBackup('[]')).toEqual({ ok: false, error: 'the backup must be a JSON object' });
    expect(parseBackup(JSON.stringify({ app: 'other', version: 1, exportedAtIso: EXPORTED_AT, data: {} }))).toEqual({
      ok: false,
      error: 'the file is not a SpendWise backup (app header missing)',
    });
    expect(
      parseBackup(JSON.stringify({ app: 'spendwise', version: 99, exportedAtIso: EXPORTED_AT, data: {} }))
    ).toEqual({ ok: false, error: 'unsupported backup version 99' });
    expect(parseBackup(JSON.stringify({ app: 'spendwise', version: 1, data: {} }))).toEqual({
      ok: false,
      error: 'the backup header has no export timestamp',
    });
  });

  it('skips keys whose payload fails the storage guards and reports why', () => {
    const file = buildBackup(
      {
        [GOALS_KEY]: JSON.stringify([TRACKED_GOAL, { id: 42 }]),
        [LEDGER_YOU_KEY]: JSON.stringify([LEDGER_ROW, { cardId: 'nope' }]),
        [PROFILE_YOU_KEY]: JSON.stringify({ age: 'twenty four' }),
        [WALLET_YOU_KEY]: JSON.stringify(['uob-one', 7]),
        [SPACE_ACTIVE_KEY]: 'moon',
        sw_mystery: '"zzz"',
        [CUSTOM_CARDS_KEY]: JSON.stringify([CUSTOM_CARD]),
      },
      EXPORTED_AT
    );
    const result = parseBackup(JSON.stringify(file));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plan.entries).toEqual([{ key: CUSTOM_CARDS_KEY, value: JSON.stringify([CUSTOM_CARD]) }]);
    expect(result.plan.skipped).toEqual([
      { key: GOALS_KEY, reason: '1 of 2 tracked goal(s) failed validation' },
      { key: LEDGER_YOU_KEY, reason: '1 of 2 ledger row(s) failed validation' },
      { key: PROFILE_YOU_KEY, reason: 'not a sane profile payload' },
      { key: WALLET_YOU_KEY, reason: '1 of 2 wallet id(s) failed validation' },
      { key: SPACE_ACTIVE_KEY, reason: 'not a space name' },
      { key: 'sw_mystery', reason: 'unrecognised key' },
    ]);
  });
});

describe('isSaneStoredProfile', () => {
  it('accepts profiles with and without the optional affordability fields', () => {
    expect(isSaneStoredProfile(STORED_PROFILE_YOU)).toBe(true);
    expect(isSaneStoredProfile(STORED_PROFILE_PARTNER)).toBe(true);
  });

  it('refuses payloads missing required numbers or carrying non-numeric optionals', () => {
    expect(isSaneStoredProfile({ ...STORED_PROFILE_YOU, age: 'twenty four' })).toBe(false);
    expect(isSaneStoredProfile({ ...STORED_PROFILE_PARTNER, cpfOaBalance: undefined })).toBe(false);
    expect(isSaneStoredProfile({ ...STORED_PROFILE_PARTNER, takeHomeMonthlyIncome: 'lots' })).toBe(false);
    expect(isSaneStoredProfile(null)).toBe(false);
    expect(isSaneStoredProfile([STORED_PROFILE_PARTNER])).toBe(false);
  });
});

/* ---------------------------------------------------------------------- */
/* Verdict hero wording with the affordability fields                     */
/* ---------------------------------------------------------------------- */

describe('verdict wording with affordability fields', () => {
  const profile: UserProfile = {
    age: 24,
    grossMonthlyIncome: 4800,
    monthlyExpenses: 2600,
    liquidSavings: 15000,
    cpfOaBalance: 12000,
    milesValuationCents: 1.8,
  };
  const goal: GoalSpec = { kind: 'savings_target', targetAmountSgd: 100_000, deadlineAge: 29 };

  it('reads sensibly on a stretch: surplus named with its CPF deduction', () => {
    // No take-home stated: surplus = 4800 - 960 CPF - 2600 expenses = 1240 and
    // the required monthly (about 1332) lands inside (1240, 1612], so stretch.
    const plan = buildPlan(goal, profile, []);
    expect(plan.verdict.status).toBe('stretch');
    expect(plan.verdict.headline).toBe(
      'Stretch: $1,332 a month is within 30 percent above your $1,240 surplus after CPF.'
    );
    expect(plan.verdict.reasoning).toContain(
      'The surplus already nets off CPF contributions of $960 a month.'
    );
  });

  it('drops the CPF clause once a take-home figure is stated', () => {
    const plan = buildPlan(goal, { ...profile, takeHomeMonthlyIncome: 4000, monthlyDebtCommitments: 300 }, []);
    // Stated take-home: surplus = 4000 - 2600 - 300 = 1100 and the required
    // 1332 still fits inside 1100 * 1.3, so stretch. The CPF clause is gone
    // because the stated figure already accounts for it; only debts remain.
    expect(plan.verdict.status).toBe('stretch');
    expect(plan.verdict.headline).toContain('your $1,100 surplus after debts.');
    expect(plan.verdict.reasoning).toContain('monthly debt commitments of $300');
    expect(plan.verdict.reasoning).not.toContain('nets off CPF contributions');
  });
});

/* ---------------------------------------------------------------------- */
/* Advisor wiring: prompt rebuild, wire guard and profile form mapping     */
/* ---------------------------------------------------------------------- */

describe('promptFromGoalSpec', () => {
  const profile: UserProfile = {
    age: 26,
    grossMonthlyIncome: 5200,
    monthlyExpenses: 2800,
    liquidSavings: 48000,
    cpfOaBalance: 42000,
    milesValuationCents: 1.8,
  };

  it('round trips every goal kind through the offline parser', () => {
    const specs: GoalSpec[] = [
      { kind: 'property_purchase', propertyType: 'hdb_resale', targetPriceSgd: 600_000, deadlineAge: 30, firstProperty: true },
      { kind: 'property_purchase', propertyType: 'bto', targetPriceSgd: 500_000, deadlineAge: 32, firstProperty: true },
      { kind: 'property_purchase', propertyType: 'condo', targetPriceSgd: 545_000, deadlineAge: 33, firstProperty: true },
      { kind: 'car_purchase', priceSgd: 150_000, deadlineAge: 29 },
      { kind: 'savings_target', targetAmountSgd: 1_000_000, deadlineAge: 50, instrumentRatePa: 0.018 },
    ];
    for (const spec of specs) {
      const parsed = parseGoalFallback(promptFromGoalSpec(spec), profile);
      // The parser computes percent / 100, so the rate only round trips to
      // floating-point precision; every other field is exact.
      if (spec.kind === 'savings_target' && parsed !== null && parsed.kind === 'savings_target') {
        expect({ ...parsed, instrumentRatePa: undefined }).toEqual({ ...spec, instrumentRatePa: undefined });
        expect(parsed.instrumentRatePa).toBeCloseTo(spec.instrumentRatePa ?? 0, 12);
      } else {
        expect(parsed).toEqual(spec);
      }
    }
  });
});

describe('isAdvisorReply', () => {
  it('accepts the three reply shapes of POST /api/advisor', () => {
    expect(isAdvisorReply({ kind: 'clarify', questions: ['Which flat price?'] })).toBe(true);
    expect(isAdvisorReply({ kind: 'answer', summary: 'Yes, comfortably.' })).toBe(true);
    expect(
      isAdvisorReply({
        kind: 'revise',
        summary: 'Pushing the deadline back.',
        note: 'Deadline moved from age 30 to age 32.',
        delta: {
          requiredMonthlySavingsBefore: 1332,
          requiredMonthlySavingsAfter: 1100,
          verdictBefore: 'stretch',
          verdictAfter: 'achievable',
          targetBefore: 600_000,
          targetAfter: 600_000,
        },
        comparison: 'The required monthly saving moves from $1,332 to $1,100, down $232.',
        revisedGoalSpec: { kind: 'property_purchase', propertyType: 'hdb_resale', targetPriceSgd: 600_000, deadlineAge: 32 },
        revisedProfile: { age: 26, grossMonthlyIncome: 5200, monthlyExpenses: 2800, liquidSavings: 48000, cpfOaBalance: 42000, milesValuationCents: 1.8 },
      })
    ).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(isAdvisorReply(null)).toBe(false);
    expect(isAdvisorReply({ kind: 'wonder' })).toBe(false);
    expect(isAdvisorReply({ kind: 'clarify', questions: [] })).toBe(false);
    expect(isAdvisorReply({ kind: 'answer', summary: '' })).toBe(false);
    expect(isAdvisorReply({ kind: 'revise', summary: 's', note: 'n', comparison: 'c', delta: { requiredMonthlySavingsBefore: 'lots' }, revisedGoalSpec: {}, revisedProfile: {} })).toBe(false);
  });
});

describe('profileFormFromRevised', () => {
  it('maps the wire profile onto the form and keeps fields the wire cannot carry', () => {
    const current = {
      age: '26',
      grossMonthlyIncome: '5200',
      monthlyExpenses: '2800',
      liquidSavings: '48000',
      cpfOaBalance: '42000',
      investmentsSgd: '12000',
      investmentRatePct: '4.5',
      takeHomeMonthlyIncome: '4400',
      monthlyDebtCommitments: '300',
      emergencyReserveMonths: '6',
    };
    const form = profileFormFromRevised(
      {
        age: 26,
        grossMonthlyIncome: 5200,
        monthlyExpenses: 2800,
        liquidSavings: 31300,
        cpfOaBalance: 42000,
        milesValuationCents: 1.8,
        investmentsSgd: 12000,
        investmentRatePa: 0.045,
      },
      current
    );
    expect(form.liquidSavings).toBe('31300');
    expect(form.investmentsSgd).toBe('12000');
    expect(form.investmentRatePct).toBe('4.5');
    // The advisor request schema cannot carry these, so the form keeps them.
    expect(form.takeHomeMonthlyIncome).toBe('4400');
    expect(form.monthlyDebtCommitments).toBe('300');
    expect(form.emergencyReserveMonths).toBe('6');
  });
});

/* ---------------------------------------------------------------------- */
/* Guided sample journey                                                   */
/* ---------------------------------------------------------------------- */

describe('buildSampleJourney', () => {
  it('seeds exactly the journey storage keys, all passing the hydrate guards', () => {
    const data = buildSampleJourney('2026-10');
    expect(Object.keys(data).sort()).toEqual(
      [
        GOALS_KEY,
        PROFILE_PARTNER_KEY,
        PROFILE_YOU_KEY,
        SPACE_ACTIVE_KEY,
        WALLET_PARTNER_KEY,
        WALLET_YOU_KEY,
      ].sort()
    );
    expect(isSaneStoredProfile(JSON.parse(data[PROFILE_YOU_KEY]))).toBe(true);
    expect(isSaneStoredProfile(JSON.parse(data[PROFILE_PARTNER_KEY]))).toBe(true);
    const goals: unknown = JSON.parse(data[GOALS_KEY]);
    expect(Array.isArray(goals) && goals.every((goal) => isTrackedGoal(goal))).toBe(true);
    expect(data[SPACE_ACTIVE_KEY]).toBe('us');
    const walletIds = [
      ...(JSON.parse(data[WALLET_YOU_KEY]) as string[]),
      ...(JSON.parse(data[WALLET_PARTNER_KEY]) as string[]),
    ];
    expect(new Set(walletIds).size).toBe(walletIds.length);
    for (const id of walletIds) {
      expect(CARDS.some((card) => card.id === id)).toBe(true);
    }
  });

  it('tracks a Us goal with three months of logs across both contributors', () => {
    const goal = JSON.parse(buildSampleJourney('2026-10')[GOALS_KEY])[0] as TrackedGoal;
    expect(goal.space).toBe('us');
    expect(goal.goalSpec.kind).toBe('property_purchase');
    const months = goal.logs.map((log) => log.monthKey);
    expect([...new Set(months)].sort()).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(goal.logs.some((log) => log.contributor === 'you')).toBe(true);
    expect(goal.logs.some((log) => log.contributor === 'partner')).toBe(true);
    // One you entry and one partner entry share the middle month.
    const middle = goal.logs.filter((log) => log.monthKey === '2026-08');
    expect(middle.map((log) => log.contributor ?? 'you').sort()).toEqual(['partner', 'you']);
    // The clock starts three months before the supplied now.
    expect(monthKeyDiff(goal.startMonthKey, '2026-10')).toBe(3);
  });

  it('freezes the goal figures the way Track this goal freezes them', () => {
    const data = buildSampleJourney('2026-10');
    const goal = JSON.parse(data[GOALS_KEY])[0] as TrackedGoal;
    const you = JSON.parse(data[PROFILE_YOU_KEY]) as UserProfile;
    const partner = JSON.parse(data[PROFILE_PARTNER_KEY]) as UserProfile;
    const household = combineProfiles(you, partner);
    const plan = buildPlan(goal.goalSpec, household, fillAssumptions(goal.goalSpec, household));
    expect(goal.requiredMonthlySgd).toBe(Math.max(0, plan.requiredMonthlySavings));
    expect(goal.targetSgd).toBe(plan.savingsSchedule[plan.savingsSchedule.length - 1]?.balance);
    expect(goal.startAge).toBe(household.age);
    expect(goal.startSavingsSgd).toBe(Math.max(0, household.liquidSavings));
  });

  it('is deterministic per month key and shifts with the calendar', () => {
    expect(buildSampleJourney('2026-10')).toEqual(buildSampleJourney('2026-10'));
    const later = JSON.parse(buildSampleJourney('2026-12')[GOALS_KEY])[0] as TrackedGoal;
    expect(later.startMonthKey).toBe('2026-09');
    expect(later.logs.some((log) => log.monthKey === '2026-11')).toBe(true);
  });
});

/* ---------------------------------------------------------------------- */
/* Space epoch race guard                                                  */
/* ---------------------------------------------------------------------- */

describe('epochMatches', () => {
  it('accepts an exact match and rejects every other epoch', () => {
    expect(epochMatches(0, 0)).toBe(true);
    expect(epochMatches(3, 3)).toBe(true);
    expect(epochMatches(0, 1)).toBe(false);
    expect(epochMatches(3, 4)).toBe(false);
    expect(epochMatches(4, 3)).toBe(false);
  });

  it('models the handlePlan race: a selectSpace bump mid-flight drops the reply', () => {
    const captured = 7;
    let current = 7;
    // The plan request is still in flight, so the captured epoch matches.
    expect(epochMatches(captured, current)).toBe(true);
    // The user switches space; selectSpace increments the epoch.
    current += 1;
    // The late reply must be dropped instead of rendered in the new space.
    expect(epochMatches(captured, current)).toBe(false);
  });
});

/* ---------------------------------------------------------------------- */
/* POST /api/adviser/chat                                                  */
/* ---------------------------------------------------------------------- */

const ADVISER_CHAT_URL = 'http://localhost/api/adviser/chat';

function postAdviserChat(body: string): Promise<Response> {
  return adviserChatPost(
    new Request(ADVISER_CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  );
}

/** August 2026 ledger fixture: 6 records, dining 500, groceries 550, fun 90, transport 64.4. */
const CHAT_LEDGER = [
  { cardId: 'uob-one', amountSgd: 320, category: 'dining', monthKey: '2026-08' },
  { cardId: 'uob-one', amountSgd: 180, category: 'dining', monthKey: '2026-08' },
  { cardId: 'dbs-live-fresh', amountSgd: 400, category: 'groceries', monthKey: '2026-08' },
  { cardId: 'dbs-live-fresh', amountSgd: 150, category: 'groceries', monthKey: '2026-08' },
  { cardId: 'citi-cash-back-plus', amountSgd: 90, category: 'entertainment', monthKey: '2026-08' },
  { cardId: 'uob-one', amountSgd: 64.4, category: 'transport', monthKey: '2026-08' },
  { cardId: 'uob-one', amountSgd: 300, category: 'dining', monthKey: '2026-07' },
  { cardId: 'uob-one', amountSgd: 300, category: 'groceries', monthKey: '2026-07' },
  { cardId: 'uob-one', amountSgd: 50, category: 'transport', monthKey: '2026-07' },
  { cardId: 'uob-one', amountSgd: 100, category: 'entertainment', monthKey: '2026-07' },
  { cardId: 'uob-one', amountSgd: 55, category: 'online_shopping', monthKey: '2026-07' },
];

const CHAT_GOAL = {
  id: 'save-s-100k-by-35',
  name: 'Save S$100k by 35',
  goalSpec: { kind: 'savings_target', targetAmountSgd: 100_000, deadlineAge: 35 },
  targetSgd: 100_000,
  requiredMonthlySgd: 800,
  ratePa: 0,
  startAge: 26,
  startSavingsSgd: 1_000,
  deadlineAge: 35,
  startMonthKey: '2026-01',
  space: 'you',
  logs: [],
};

const CHAT_CONTEXT = {
  profile: {
    age: 26,
    grossMonthlyIncome: 5_200,
    monthlyExpenses: 2_800,
    liquidSavings: 48_000,
    cpfOaBalance: 42_000,
    milesValuationCents: 1.8,
  },
  walletNames: ['UOB One', 'DBS Live Fresh'],
  ledgerAvailable: {
    months: [
      { monthKey: '2026-07', recordCount: 5 },
      { monthKey: '2026-08', recordCount: 6 },
    ],
  },
  goalSummaries: [{ id: 'save-s-100k-by-35', name: 'Save S$100k by 35', deadlineAge: 35 }],
  protectedCategories: ['insurance'],
  ledger: CHAT_LEDGER,
  goals: [CHAT_GOAL],
  selectedGoalId: 'save-s-100k-by-35',
};

describe('POST /api/adviser/chat', () => {
  it('classifies on the deterministic fallback with no key and renders the five points', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    try {
      const response = await postAdviserChat(
        JSON.stringify({
          messages: [{ role: 'user', text: 'Where is my money going?' }],
          context: CHAT_CONTEXT,
        })
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        reply: string;
        points: Array<{ label: string; body: string }>;
        op: string;
        engine: string;
        meta: { modelCallsUsed: number; budgetRemaining: number };
      };
      // The fallback classifier resolved a spending review of the latest month.
      expect(payload.op).toBe('spending_summary');
      expect(payload.engine).toBe('fallback');
      // No key means zero model calls and a full budget left to report.
      expect(payload.meta).toEqual({
        modelCallsUsed: 0,
        budgetRemaining: MAX_MODEL_CALLS_PER_CONVERSATION,
      });
      // The five deterministic points, in the fixed order.
      expect(payload.points.map((point) => point.label)).toEqual([
        'Data used',
        'Change proposed',
        'Monthly cash freed',
        'Effect on the selected goal',
        'Assumptions and missing information',
      ]);
      // Every figure comes from the ops layer over the sent ledger.
      expect(payload.reply).toContain('Data used: The 6 records you logged for 2026-08');
      expect(payload.reply).toContain('Groceries S$550 (2 records)');
      expect(payload.reply).toContain('Dining S$500 (2 records)');
      expect(payload.reply).toContain('Change proposed: None: a spending review is read-only.');
      expect(payload.reply).toContain('Monthly cash freed: None: nothing was proposed.');
      expect(payload.reply).toContain(
        'Figures cover the 6 records logged for 2026-08. Logged records may not be all spending.'
      );
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      }
    }
  });

  it('rejects a payload over the limits byte cap with 413', async () => {
    const response = await postAdviserChat(
      JSON.stringify({
        messages: [{ role: 'user', text: `Where is my money going? ${'x'.repeat(MAX_PAYLOAD_BYTES)}` }],
        context: CHAT_CONTEXT,
      })
    );
    expect(response.status).toBe(413);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain('Payload too large');
    expect(payload.error).toContain(String(MAX_PAYLOAD_BYTES));
  });

  it('rejects a body missing the required shape with 400', async () => {
    const response = await postAdviserChat('{}');
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string; issues?: string[] };
    expect(payload.error).toContain('Invalid request body');
    expect(payload.issues?.join(' | ')).toContain('messages');
    expect(payload.issues?.join(' | ')).toContain('context');
  });
});

/* ---------------------------------------------------------------------- */
/* Adviser tab: protected preferences, previews and apply/undo             */
/* ---------------------------------------------------------------------- */

class MemoryStorage {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const adviserStorage = new MemoryStorage();

function installAdviserWindow(): void {
  (globalThis as { window?: unknown }).window = { localStorage: adviserStorage };
}

function removeAdviserWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}

/** Byte snapshot of every key the stub storage holds, for identity checks. */
function storageBytes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [PROFILE_YOU_KEY, GOALS_KEY, ADVISER_PREFS_YOU_KEY]) {
    out[key] = adviserStorage.getItem(key) ?? '';
  }
  return out;
}

describe('adviser protected preferences per space', () => {
  it('maps each space to its own sw_adviser_prefs_ key', () => {
    expect(adviserPrefsKeyFor('you')).toBe('sw_adviser_prefs_you');
    expect(adviserPrefsKeyFor('partner')).toBe('sw_adviser_prefs_partner');
    expect(adviserPrefsKeyFor('us')).toBe('sw_adviser_prefs_us');
    expect([ADVISER_PREFS_YOU_KEY, ADVISER_PREFS_PARTNER_KEY, ADVISER_PREFS_US_KEY]).toEqual([
      'sw_adviser_prefs_you',
      'sw_adviser_prefs_partner',
      'sw_adviser_prefs_us',
    ]);
  });

  it('round trips protected categories per space preserving order', () => {
    const you = ['dining', 'insurance'];
    const partner = ['groceries'];
    const us: string[] = [];
    const rawYou = serializeAdviserPrefs(you);
    const rawPartner = serializeAdviserPrefs(partner);
    const rawUs = serializeAdviserPrefs(us);
    expect(rawYou).toBe('{"protectedCategories":["dining","insurance"]}');
    expect(parseAdviserPrefs(rawYou)).toEqual(['dining', 'insurance']);
    expect(parseAdviserPrefs(rawPartner)).toEqual(['groceries']);
    expect(parseAdviserPrefs(rawUs)).toEqual([]);
    // The spaces never share one list: each key holds its own payload.
    expect(parseAdviserPrefs(rawYou)).not.toEqual(parseAdviserPrefs(rawPartner));
  });

  it('collapses invalid payloads to a clean list and drops unknown or duplicate entries', () => {
    expect(parseAdviserPrefs(null)).toEqual([]);
    expect(parseAdviserPrefs('not json')).toEqual([]);
    expect(parseAdviserPrefs('[]')).toEqual([]);
    expect(parseAdviserPrefs('{"nope":[]}')).toEqual([]);
    expect(parseAdviserPrefs('{"protectedCategories":"dining"}')).toEqual([]);
    expect(parseAdviserPrefs('{"protectedCategories":["dining","moonrock","dining","petrol"]}')).toEqual([
      'dining',
      'petrol',
    ]);
  });

  it('toggles a category on and off purely', () => {
    expect(toggleProtectedCategory([], 'groceries')).toEqual(['groceries']);
    expect(toggleProtectedCategory(['groceries', 'dining'], 'groceries')).toEqual(['dining']);
    expect(toggleProtectedCategory(['dining'], 'petrol')).toEqual(['dining', 'petrol']);
  });

  it('validates prefs payloads for backup import', () => {
    expect(isAdviserPrefsPayload(serializeAdviserPrefs(['dining']))).toBe(true);
    expect(isAdviserPrefsPayload(serializeAdviserPrefs([]))).toBe(true);
    expect(isAdviserPrefsPayload('{"protectedCategories":["moonrock"]}')).toBe(false);
    expect(isAdviserPrefsPayload('nope')).toBe(false);
  });
});

describe('adviser preview leaves storage untouched', () => {
  it('computes preview figures without changing any storage key by one byte', () => {
    installAdviserWindow();
    try {
      adviserStorage.setItem(PROFILE_YOU_KEY, JSON.stringify(STORED_PROFILE_YOU));
      adviserStorage.setItem(GOALS_KEY, JSON.stringify([TRACKED_GOAL]));
      adviserStorage.setItem(
        ADVISER_PREFS_YOU_KEY,
        serializeAdviserPrefs(['insurance', 'education'])
      );
      const before = storageBytes();

      // Exactly what the PreviewPanel runs: the pure projection helper over
      // the goal data. Previews never write forms, goals or preferences.
      const figures = previewReduceEffect(TRACKED_GOAL, 200);
      const snapshotPeek = buildUndoSnapshot(
        { you: defaultProfileForm(), partner: defaultProfileForm() },
        [TRACKED_GOAL]
      );
      expect(figures.monthsBefore).not.toBeNull();
      expect(figures.monthsAfter).not.toBeNull();
      expect(figures.monthsAfter !== null && figures.monthsBefore !== null
        ? figures.monthsAfter
        : null).toBeLessThan(
        figures.monthsBefore === null ? Number.POSITIVE_INFINITY : figures.monthsBefore
      );
      expect(snapshotPeek.goals).toEqual([TRACKED_GOAL]);

      const after = storageBytes();
      expect(after).toEqual(before);
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    } finally {
      removeAdviserWindow();
      adviserStorage.removeItem(PROFILE_YOU_KEY);
      adviserStorage.removeItem(GOALS_KEY);
      adviserStorage.removeItem(ADVISER_PREFS_YOU_KEY);
    }
  });
});

describe('adviser apply and undo', () => {
  const forms = {
    you: { ...defaultProfileForm(), monthlyExpenses: '2800', liquidSavings: '48000' },
    partner: defaultProfileForm(),
  };
  /** Same slug in two spaces: identity is id plus space. */
  const youGoal: TrackedGoal = {
    ...(TRACKED_GOAL as TrackedGoal),
    space: 'you',
    logs: [{ monthKey: '2026-01', contributedSgd: 500, contributor: 'you' }],
  };
  const usGoal = TRACKED_GOAL as TrackedGoal;

  it('applies a goal revision scoped to one space, preserving id, space and logs', () => {
    const revised: GoalSpec = {
      ...(usGoal.goalSpec as GoalSpec),
      deadlineAge: usGoal.deadlineAge + 2,
    };
    const next = applyAdviserGoalRevision([youGoal, usGoal], usGoal.id, 'us', revised);
    const changedUs = next.find((goal) => goal.id === usGoal.id && goal.space === 'us');
    const untouchedYou = next.find((goal) => goal.id === youGoal.id && goal.space === 'you');
    expect(changedUs?.deadlineAge).toBe(usGoal.deadlineAge + 2);
    expect(changedUs?.goalSpec).toEqual(revised);
    expect(changedUs?.name).not.toBe(usGoal.name);
    // Contribution history survives the revision byte for byte.
    expect(changedUs?.logs).toEqual(usGoal.logs);
    // The same slug in another space is a different goal and never moves.
    expect(untouchedYou?.deadlineAge).toBe(youGoal.deadlineAge);
    expect(untouchedYou?.goalSpec).toEqual(youGoal.goalSpec);
  });

  it('applies profile adjustments immutably and clamps at zero', () => {
    const trimmed = applyAdviserProfileAdjustment(forms.you, 'monthlyExpenses', 1200);
    expect(trimmed.monthlyExpenses).toBe('1200');
    expect(trimmed.liquidSavings).toBe(forms.you.liquidSavings);
    expect(forms.you.monthlyExpenses).toBe('2800');
    expect(applyAdviserProfileAdjustment(forms.you, 'liquidSavings', -50).liquidSavings).toBe('0');
  });

  it('undo restores the pre-apply snapshot exactly, one apply deep', () => {
    const snapshot = buildUndoSnapshot(forms, [youGoal, usGoal]);
    // A deep copy taken before any apply, like a second snapshot would see.
    const snapshotCopy = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;

    // The apply path runs against the snapshot's data without mutating it.
    const revised: GoalSpec = { ...(usGoal.goalSpec as GoalSpec), deadlineAge: 99 };
    const changedGoals = applyAdviserGoalRevision(snapshot.goals, usGoal.id, 'us', revised);
    const changedForms = {
      ...snapshot.profileForms,
      you: applyAdviserProfileAdjustment(snapshot.profileForms.you, 'monthlyExpenses', 1200),
    };
    expect(changedGoals.some((goal) => goal.deadlineAge === 99)).toBe(true);
    expect(changedForms.you.monthlyExpenses).toBe('1200');
    // The applied state is genuinely different from the snapshot.
    expect(snapshotsEqual(buildUndoSnapshot(changedForms, changedGoals), snapshot)).toBe(false);

    // Applying never reached into the snapshot: it is byte-identical to the
    // copy taken before, so the page's one-step Undo restores it exactly.
    expect(snapshot).toEqual(snapshotCopy);
    expect(snapshotsEqual(snapshot, snapshotCopy)).toBe(true);
    const restored = buildUndoSnapshot(snapshot.profileForms, snapshot.goals);
    expect(snapshotsEqual(restored, snapshot)).toBe(true);
    expect(restored.goals.every((goal) => goal.logs.every((log) => log.contributedSgd >= 0))).toBe(
      true
    );
  });
});
