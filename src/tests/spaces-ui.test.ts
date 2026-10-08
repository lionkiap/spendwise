import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GOALS_KEY,
  LEDGER_PARTNER_KEY,
  LEDGER_US_KEY,
  LEDGER_YOU_KEY,
  LEGACY_LEDGER_KEY,
  LEGACY_PROFILE_KEY,
  LEGACY_WALLET_KEY,
  PROFILE_PARTNER_KEY,
  PROFILE_YOU_KEY,
  SPACE_ACTIVE_KEY,
  WALLET_PARTNER_KEY,
  WALLET_US_KEY,
  WALLET_YOU_KEY,
  isTrackedGoal,
  ledgerKeyFor,
  migrateLegacyStorage,
  profileKeyFor,
  spaceLabel,
  walletKeyFor,
} from '../app/components/shared';

/**
 * spaces-ui tests: the storage key map, the space-aware sw_goals guard and
 * the legacy migration. Migration runs against an in-memory localStorage
 * stub installed on globalThis.window, because the node test environment has
 * no window; the SSR guard in migrateLegacyStorage returns [] without one.
 */

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

const storage = new MemoryStorage();

function installWindow(): void {
  (globalThis as { window?: unknown }).window = { localStorage: storage };
}

function removeWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}

/** Valid pre-couples tracked goal: no space, no contributor on the log. */
function legacyGoalJson(): string {
  return JSON.stringify([
    {
      id: 'save-30k-by-30',
      name: 'Save S$30k by age 30',
      goalSpec: { kind: 'savings_target', targetAmountSgd: 30000, deadlineAge: 30 },
      targetSgd: 30000,
      requiredMonthlySgd: 350,
      ratePa: 0.018,
      startAge: 25,
      startSavingsSgd: 4000,
      deadlineAge: 30,
      startMonthKey: '2026-01',
      logs: [
        { monthKey: '2026-01', contributedSgd: 500 },
        { monthKey: '2026-02', contributedSgd: 250, note: 'bonus' },
      ],
    },
  ]);
}

beforeEach(() => {
  storage.removeItem(LEGACY_PROFILE_KEY);
  storage.removeItem(LEGACY_WALLET_KEY);
  storage.removeItem(LEGACY_LEDGER_KEY);
  storage.removeItem(PROFILE_YOU_KEY);
  storage.removeItem(WALLET_YOU_KEY);
  storage.removeItem(LEDGER_YOU_KEY);
  storage.removeItem(GOALS_KEY);
  installWindow();
});

afterEach(() => {
  removeWindow();
});

describe('space key map and labels', () => {
  it('labels the three spaces You, Partner and Us', () => {
    expect(spaceLabel('you')).toBe('You');
    expect(spaceLabel('partner')).toBe('Partner');
    expect(spaceLabel('us')).toBe('Us');
  });

  it('maps every space to its storage key', () => {
    expect(profileKeyFor('you')).toBe('sw_profile_you');
    expect(profileKeyFor('partner')).toBe('sw_profile_partner');
    expect(walletKeyFor('you')).toBe(WALLET_YOU_KEY);
    expect(walletKeyFor('partner')).toBe(WALLET_PARTNER_KEY);
    expect(walletKeyFor('us')).toBe(WALLET_US_KEY);
    expect(ledgerKeyFor('you')).toBe(LEDGER_YOU_KEY);
    expect(ledgerKeyFor('partner')).toBe(LEDGER_PARTNER_KEY);
    expect(ledgerKeyFor('us')).toBe(LEDGER_US_KEY);
    expect([
      PROFILE_YOU_KEY,
      PROFILE_PARTNER_KEY,
      WALLET_YOU_KEY,
      WALLET_PARTNER_KEY,
      WALLET_US_KEY,
      LEDGER_YOU_KEY,
      LEDGER_PARTNER_KEY,
      LEDGER_US_KEY,
      SPACE_ACTIVE_KEY,
    ]).toEqual([
      'sw_profile_you',
      'sw_profile_partner',
      'sw_wallet_you',
      'sw_wallet_partner',
      'sw_wallet_us',
      'sw_ledger_you',
      'sw_ledger_partner',
      'sw_ledger_us',
      'sw_space_active',
    ]);
    expect(LEGACY_PROFILE_KEY).toBe('sw_profile');
    expect(LEGACY_WALLET_KEY).toBe('sw_wallet');
    expect(LEGACY_LEDGER_KEY).toBe('sw_ledger');
  });
});

describe('isTrackedGoal space and contributor fields', () => {
  it('accepts the optional space and contributor fields', () => {
    const goal = {
      id: 'g',
      name: 'Save S$30k by age 30',
      goalSpec: { kind: 'savings_target', targetAmountSgd: 30000, deadlineAge: 30 },
      targetSgd: 30000,
      requiredMonthlySgd: 350,
      ratePa: 0,
      startAge: 25,
      startSavingsSgd: 4000,
      deadlineAge: 30,
      startMonthKey: '2026-01',
      space: 'us',
      logs: [
        { monthKey: '2026-01', contributedSgd: 500, contributor: 'you' },
        { monthKey: '2026-02', contributedSgd: 300, contributor: 'partner' },
        { monthKey: '2026-03', contributedSgd: 100 },
      ],
    };
    expect(isTrackedGoal(goal)).toBe(true);
  });

  it('still accepts goals and logs without them', () => {
    expect(isTrackedGoal(JSON.parse(legacyGoalJson())[0])).toBe(true);
  });

  it('rejects unknown space or contributor values', () => {
    const base = JSON.parse(legacyGoalJson())[0] as Record<string, unknown>;
    expect(isTrackedGoal({ ...base, space: 'moon' })).toBe(false);
    expect(isTrackedGoal({ ...base, logs: [{ monthKey: '2026-01', contributedSgd: 5, contributor: 'dog' }] })).toBe(false);
  });
});

describe('migrateLegacyStorage', () => {
  it('copies legacy keys into the you space and tags sw_goals, returning what it touched', () => {
    storage.setItem(LEGACY_PROFILE_KEY, '{"age":28}');
    storage.setItem(LEGACY_WALLET_KEY, '["uob-one"]');
    storage.setItem(LEGACY_LEDGER_KEY, '[]');
    storage.setItem(GOALS_KEY, legacyGoalJson());

    const touched = migrateLegacyStorage();

    expect(touched).toEqual([
      PROFILE_YOU_KEY,
      WALLET_YOU_KEY,
      LEDGER_YOU_KEY,
      GOALS_KEY,
    ]);
    expect(storage.getItem(PROFILE_YOU_KEY)).toBe('{"age":28}');
    expect(storage.getItem(WALLET_YOU_KEY)).toBe('["uob-one"]');
    expect(storage.getItem(LEDGER_YOU_KEY)).toBe('[]');
    // Nothing is ever deleted.
    expect(storage.getItem(LEGACY_PROFILE_KEY)).toBe('{"age":28}');
    expect(storage.getItem(LEGACY_WALLET_KEY)).toBe('["uob-one"]');
    expect(storage.getItem(LEGACY_LEDGER_KEY)).toBe('[]');

    const goals = JSON.parse(storage.getItem(GOALS_KEY) as string) as Array<{
      space?: string;
      logs: Array<{ contributor?: string; note?: string }>;
    }>;
    expect(goals[0]?.space).toBe('you');
    expect(goals[0]?.logs[0]?.contributor).toBe('you');
    expect(goals[0]?.logs[1]?.contributor).toBe('you');
    // The note field survives untouched.
    expect(goals[0]?.logs[1]?.note).toBe('bonus');
    // And the rewritten goals still pass the hydrate guard.
    expect(goals.every(isTrackedGoal)).toBe(true);
  });

  it('is idempotent: the second call touches nothing', () => {
    storage.setItem(LEGACY_PROFILE_KEY, '{"age":28}');
    storage.setItem(GOALS_KEY, legacyGoalJson());
    expect(migrateLegacyStorage().length).toBe(2);
    const afterFirst = storage.getItem(GOALS_KEY);
    expect(migrateLegacyStorage()).toEqual([]);
    expect(storage.getItem(GOALS_KEY)).toBe(afterFirst);
  });

  it('never overwrites an existing per-space key', () => {
    storage.setItem(LEGACY_PROFILE_KEY, '{"age":28}');
    storage.setItem(PROFILE_YOU_KEY, '{"age":40}');
    expect(migrateLegacyStorage()).toEqual([]);
    expect(storage.getItem(PROFILE_YOU_KEY)).toBe('{"age":40}');
  });

  it('preserves existing space and contributor tags and skips the rewrite', () => {
    storage.setItem(
      GOALS_KEY,
      JSON.stringify([
        {
          id: 'g',
          name: 'Save S$30k by age 30',
          goalSpec: { kind: 'savings_target', targetAmountSgd: 30000, deadlineAge: 30 },
          targetSgd: 30000,
          requiredMonthlySgd: 350,
          ratePa: 0,
          startAge: 25,
          startSavingsSgd: 4000,
          deadlineAge: 30,
          startMonthKey: '2026-01',
          space: 'us',
          logs: [{ monthKey: '2026-01', contributedSgd: 300, contributor: 'partner' }],
        },
      ])
    );
    const before = storage.getItem(GOALS_KEY);
    expect(migrateLegacyStorage()).toEqual([]);
    expect(storage.getItem(GOALS_KEY)).toBe(before);
  });

  it('leaves corrupt goals JSON alone without throwing', () => {
    storage.setItem(LEGACY_WALLET_KEY, '["uob-one"]');
    storage.setItem(GOALS_KEY, 'not json');
    expect(migrateLegacyStorage()).toEqual([WALLET_YOU_KEY]);
    expect(storage.getItem(GOALS_KEY)).toBe('not json');
  });

  it('returns empty without a window (SSR guard)', () => {
    removeWindow();
    storage.setItem(LEGACY_PROFILE_KEY, '{"age":28}');
    expect(migrateLegacyStorage()).toEqual([]);
  });
});
