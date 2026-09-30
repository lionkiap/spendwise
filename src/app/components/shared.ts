/**
 * Shared client-side types and pure helpers for the SpendWise UI.
 *
 * Everything here is deterministic: no clock reads, no randomness and no
 * locale-dependent formatting. The only impurity allowed in src/app is Date
 * inside effects and handlers, which this file never touches.
 */
import { CARDS } from '../../lib/data/cards';
import type { CardSpec, ExpenseCategory, LedgerEntry } from '../../lib/cards/types';
import { parseCustomCard } from '../../lib/cards/custom';
import type { PlanJSON } from '../../lib/planner/build';
import { goalSpecSchema, type GoalSpec, type UserProfile } from '../../lib/planner/goalspec';
import type { TrackedGoal } from '../../lib/planner/progress';

/* ---------------------------------------------------------------------- */
/* localStorage keys. sw_profile, sw_wallet and sw_ledger keep their       */
/* existing shapes; sw_custom_cards is new in v2; sw_goals in v3.          */
/* ---------------------------------------------------------------------- */

export const PROFILE_KEY = 'sw_profile';
export const WALLET_KEY = 'sw_wallet';
export const LEDGER_KEY = 'sw_ledger';
export const CUSTOM_CARDS_KEY = 'sw_custom_cards';
export const GOALS_KEY = 'sw_goals';

export type PlanParser = 'nemotron' | 'local-fallback';
export type TabId = 'planner' | 'progress' | 'cards';

export const MILES_VALUATION_MIN = 1.4;
export const MILES_VALUATION_MAX = 2.4;

export const DEFAULT_PROFILE: UserProfile = {
  age: 24,
  grossMonthlyIncome: 4800,
  monthlyExpenses: 2600,
  liquidSavings: 15000,
  cpfOaBalance: 12000,
  milesValuationCents: 1.8,
};

export const DEFAULT_PROMPT = 'I want to buy a HDB worth about 600k by age 28';
export const SAVINGS_EXAMPLE_PROMPT =
  'I wish to save up 1mil by 50 years old with my savings account at 1.8 percent pa';

export const CATEGORIES: ReadonlyArray<{ value: ExpenseCategory; label: string }> = [
  { value: 'groceries', label: 'Groceries' },
  { value: 'dining', label: 'Dining' },
  { value: 'online_shopping', label: 'Online shopping' },
  { value: 'transport', label: 'Transport' },
  { value: 'petrol', label: 'Petrol' },
  { value: 'travel', label: 'Travel' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'entertainment', label: 'Entertainment' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'education', label: 'Education' },
  { value: 'medical', label: 'Medical' },
  { value: 'other', label: 'Other' },
];

const CATEGORY_VALUES: ReadonlyArray<string> = CATEGORIES.map((entry) => entry.value);

/* ---------------------------------------------------------------------- */
/* Client form state. Strings because inputs are strings; empty optional   */
/* fields mean "not provided".                                             */
/* ---------------------------------------------------------------------- */

export interface ProfileFormState {
  age: string;
  grossMonthlyIncome: string;
  monthlyExpenses: string;
  liquidSavings: string;
  cpfOaBalance: string;
  investmentsSgd: string;
  investmentRatePct: string;
}

export interface PlanResult {
  plan: PlanJSON;
  parser: PlanParser;
  /** The validated goal spec, present when the API returned one. */
  goalSpec?: GoalSpec;
}

/** Shape of GET /api/status. */
export interface StatusJson {
  nebiusConfigured: boolean;
  models: { ultra: string; super: string; nano: string };
}

/**
 * A ledger entry with the optional merchant label the table shows. The field
 * is additive: the engine types accept LedgerEntry and ignore the extra key.
 */
export interface LedgerRow extends LedgerEntry {
  merchant?: string;
}

/**
 * A validated custom card draft as stored in localStorage. Only drafts that
 * already passed parseCustomCard are persisted, so hydrating can re-validate
 * without ever failing on data the app itself wrote.
 */
export interface CustomCardStored {
  name: string;
  issuer: string;
  rewardType: 'cashback' | 'miles';
  baseRate: number;
  earnStructure: Array<{ category: ExpenseCategory; rate: number; capMonthlySgd?: number }>;
  minMonthlySpendSgd?: number;
  milesPerDollar?: number;
  annualFeeSgd: number;
}

/* ---------------------------------------------------------------------- */
/* Pure formatting helpers: deterministic, no locale or clock dependence.  */
/* ---------------------------------------------------------------------- */

export function fmtMoney(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const negative = rounded < 0;
  const fixed = Math.abs(rounded).toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  let grouped = '';
  for (let index = 0; index < intPart.length; index += 1) {
    if (index > 0 && (intPart.length - index) % 3 === 0) {
      grouped += ',';
    }
    grouped += intPart[index];
  }
  const decimals = decPart === '00' ? '' : `.${decPart}`;
  return `${negative ? '-' : ''}S$${grouped}${decimals}`;
}

export function fmtPct(ratio: number, digits = 2): string {
  const fixed = (ratio * 100).toFixed(digits);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return `${trimmed}%`;
}

export function fmtAssumptionValue(field: string, value: number): string {
  if (field === 'deadlineAge') {
    return `age ${value}`;
  }
  if (field.endsWith('Pa')) {
    return `${fmtPct(value, 1)} a year`;
  }
  return fmtMoney(value);
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function numberFrom(raw: string): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Finite non-negative number or undefined for an empty optional field. */
export function optionalNumberFrom(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function profileFromForm(
  form: ProfileFormState,
  milesValuationCents: number
): UserProfile {
  const investmentsSgd = optionalNumberFrom(form.investmentsSgd);
  const investmentRatePa = optionalNumberFrom(form.investmentRatePct);
  return {
    age: numberFrom(form.age),
    grossMonthlyIncome: numberFrom(form.grossMonthlyIncome),
    monthlyExpenses: numberFrom(form.monthlyExpenses),
    liquidSavings: numberFrom(form.liquidSavings),
    cpfOaBalance: numberFrom(form.cpfOaBalance),
    milesValuationCents,
    ...(investmentsSgd !== undefined ? { investmentsSgd } : {}),
    // The form speaks percent per year; the planner wants the decimal ratio.
    ...(investmentRatePa !== undefined ? { investmentRatePa: investmentRatePa / 100 } : {}),
  };
}

export function defaultProfileForm(): ProfileFormState {
  return {
    age: String(DEFAULT_PROFILE.age),
    grossMonthlyIncome: String(DEFAULT_PROFILE.grossMonthlyIncome),
    monthlyExpenses: String(DEFAULT_PROFILE.monthlyExpenses),
    liquidSavings: String(DEFAULT_PROFILE.liquidSavings),
    cpfOaBalance: String(DEFAULT_PROFILE.cpfOaBalance),
    investmentsSgd: '',
    investmentRatePct: '',
  };
}

/** Current calendar month from the client clock, "YYYY-MM" UTC based. */
export function currentMonthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export function isLedgerRow(value: unknown): value is LedgerRow {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.cardId === 'string' &&
    typeof entry.amountSgd === 'number' &&
    Number.isFinite(entry.amountSgd) &&
    typeof entry.category === 'string' &&
    CATEGORY_VALUES.includes(entry.category) &&
    typeof entry.monthKey === 'string' &&
    /^\d{4}-\d{2}$/.test(entry.monthKey) &&
    (entry.merchant === undefined || typeof entry.merchant === 'string')
  );
}

/** Defensive guard for sw_custom_cards contents read back from storage. */
export function isCustomCardStored(value: unknown): value is CustomCardStored {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.name === 'string' &&
    typeof draft.issuer === 'string' &&
    (draft.rewardType === 'cashback' || draft.rewardType === 'miles') &&
    typeof draft.baseRate === 'number' &&
    Array.isArray(draft.earnStructure) &&
    draft.earnStructure.every(
      (tier) =>
        tier !== null &&
        typeof tier === 'object' &&
        typeof (tier as Record<string, unknown>).category === 'string' &&
        typeof (tier as Record<string, unknown>).rate === 'number'
    ) &&
    typeof draft.annualFeeSgd === 'number'
  );
}

export function isStatusJson(value: unknown): value is StatusJson {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const status = value as Record<string, unknown>;
  const models = status.models;
  return (
    typeof status.nebiusConfigured === 'boolean' &&
    models !== null &&
    typeof models === 'object' &&
    typeof (models as Record<string, unknown>).ultra === 'string' &&
    typeof (models as Record<string, unknown>).super === 'string' &&
    typeof (models as Record<string, unknown>).nano === 'string'
  );
}

/** Guard for the goal spec read back from /api/plan payloads. */
export function isGoalSpec(value: unknown): value is GoalSpec {
  return goalSpecSchema.safeParse(value).success;
}

const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

/** Defensive guard for sw_goals contents read back from storage. */
export function isTrackedGoal(value: unknown): value is TrackedGoal {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const goal = value as Record<string, unknown>;
  const numberField = (key: string): boolean =>
    typeof goal[key] === 'number' && Number.isFinite(goal[key] as number);
  return (
    typeof goal.id === 'string' &&
    typeof goal.name === 'string' &&
    isGoalSpec(goal.goalSpec) &&
    numberField('targetSgd') &&
    numberField('requiredMonthlySgd') &&
    numberField('ratePa') &&
    numberField('startAge') &&
    numberField('startSavingsSgd') &&
    numberField('deadlineAge') &&
    typeof goal.startMonthKey === 'string' &&
    MONTH_KEY_PATTERN.test(goal.startMonthKey) &&
    Array.isArray(goal.logs) &&
    goal.logs.every(
      (log) =>
        log !== null &&
        typeof log === 'object' &&
        typeof (log as Record<string, unknown>).monthKey === 'string' &&
        MONTH_KEY_PATTERN.test((log as Record<string, unknown>).monthKey as string) &&
        typeof (log as Record<string, unknown>).contributedSgd === 'number' &&
        Number.isFinite((log as Record<string, unknown>).contributedSgd as number) &&
        ((log as Record<string, unknown>).note === undefined ||
          typeof (log as Record<string, unknown>).note === 'string')
    )
  );
}

/** Re-validate stored drafts; anything that no longer parses is dropped. */
export function customCardsFromStored(stored: CustomCardStored[]): CardSpec[] {
  const cards: CardSpec[] = [];
  for (const draft of stored) {
    const parsed = parseCustomCard(draft);
    if (parsed.ok) {
      cards.push(parsed.card);
    }
  }
  return cards;
}

/** True when the card id is not one of the built-in deck ids. */
export function isCustomCard(card: CardSpec): boolean {
  return !CARDS.some((builtIn) => builtIn.id === card.id);
}
