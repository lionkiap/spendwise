import { describe, expect, it } from 'vitest';

import { CARDS } from '../lib/data/cards';
import { buildPlan } from '../lib/planner/build';
import type { GoalSpec, UserProfile } from '../lib/planner/goalspec';
import { fillAssumptions, parseGoalFallback } from '../lib/planner/parse';
import { combineProfiles } from '../lib/planner/goalspec';
import { monthKeyDiff, type TrackedGoal } from '../lib/planner/progress';
import {
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
  assumptionLabel,
  buildBackup,
  buildSampleJourney,
  isAdvisorReply,
  isSaneStoredProfile,
  isTrackedGoal,
  parseBackup,
  profileFormFromRevised,
  promptFromGoalSpec,
} from '../app/components/shared';

/**
 * app-integration tests: the pure seams the UI wiring leans on. No DOM and no
 * network: buildBackup and parseBackup are pure, the label map is a constant
 * and the stretch-headline check runs the deterministic plan builder offline.
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
