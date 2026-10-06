/**
 * Shared client-side types and pure helpers for the SpendWise UI.
 *
 * Everything here is deterministic: no clock reads, no randomness and no
 * locale-dependent formatting. The only impurity in src/app is Date inside
 * effects and handlers, plus the one deliberate exception below:
 * migrateLegacyStorage touches window.localStorage, because it must run once
 * before hydration reads any key. It is guarded for SSR and never called at
 * import time.
 */
import { CARDS } from '../../lib/data/cards';
import type { CardSpec, ExpenseCategory, LedgerEntry } from '../../lib/cards/types';
import { parseCustomCard } from '../../lib/cards/custom';
import { buildPlan, type PlanJSON, type VerdictStatus } from '../../lib/planner/build';
import { combineProfiles, goalSpecSchema, type GoalSpec, type UserProfile } from '../../lib/planner/goalspec';
import { fillAssumptions } from '../../lib/planner/parse';
import {
  goalNameFromSpec,
  goalSlug,
  monthKeyOffset,
  rateFromAssumptions,
  type TrackedGoal,
} from '../../lib/planner/progress';

/* ---------------------------------------------------------------------- */
/* localStorage keys. v4 splits storage into three spaces: you, partner   */
/* and us. The pre-couples keys sw_profile, sw_wallet and sw_ledger are    */
/* kept read-only as legacy inputs to migrateLegacyStorage and are never   */
/* written or deleted; sw_custom_cards (v2) and sw_goals (v3) keep their   */
/* shapes, sw_goals goals only gain the optional space and contributor     */
/* fields.                                                                 */
/* ---------------------------------------------------------------------- */

/** Pre-couples profile key; legacy input only, copied into sw_profile_you. */
export const LEGACY_PROFILE_KEY = 'sw_profile';
/** Pre-couples wallet key; legacy input only, copied into sw_wallet_you. */
export const LEGACY_WALLET_KEY = 'sw_wallet';
/** Pre-couples ledger key; legacy input only, copied into sw_ledger_you. */
export const LEGACY_LEDGER_KEY = 'sw_ledger';

export const SPACE_ACTIVE_KEY = 'sw_space_active';
export const PROFILE_YOU_KEY = 'sw_profile_you';
export const PROFILE_PARTNER_KEY = 'sw_profile_partner';
export const WALLET_YOU_KEY = 'sw_wallet_you';
export const WALLET_PARTNER_KEY = 'sw_wallet_partner';
export const WALLET_US_KEY = 'sw_wallet_us';
export const LEDGER_YOU_KEY = 'sw_ledger_you';
export const LEDGER_PARTNER_KEY = 'sw_ledger_partner';
export const LEDGER_US_KEY = 'sw_ledger_us';
export const CUSTOM_CARDS_KEY = 'sw_custom_cards';
export const GOALS_KEY = 'sw_goals';

/** The three spaces a plan, wallet or ledger can live in. */
export type SpaceId = 'you' | 'partner' | 'us';
/** Spaces that carry their own editable profile form. */
export type PersonSpace = Exclude<SpaceId, 'us'>;

export const SPACE_IDS: ReadonlyArray<SpaceId> = ['you', 'partner', 'us'];
export const PERSON_SPACE_IDS: ReadonlyArray<PersonSpace> = ['you', 'partner'];

/** Key holding a person's profile, by space. */
export function profileKeyFor(space: PersonSpace): string {
  return space === 'you' ? PROFILE_YOU_KEY : PROFILE_PARTNER_KEY;
}

/** Key holding a space's wallet. */
export function walletKeyFor(space: SpaceId): string {
  if (space === 'you') {
    return WALLET_YOU_KEY;
  }
  return space === 'partner' ? WALLET_PARTNER_KEY : WALLET_US_KEY;
}

/** Key holding a space's ledger. */
export function ledgerKeyFor(space: SpaceId): string {
  if (space === 'you') {
    return LEDGER_YOU_KEY;
  }
  return space === 'partner' ? LEDGER_PARTNER_KEY : LEDGER_US_KEY;
}

/** Small display label for a space: You, Partner or Us. */
export function spaceLabel(space: SpaceId): string {
  return space === 'you' ? 'You' : space === 'partner' ? 'Partner' : 'Us';
}

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
  /** Optional affordability fields; empty means "not provided". */
  takeHomeMonthlyIncome: string;
  monthlyDebtCommitments: string;
  emergencyReserveMonths: string;
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
  /**
   * Live connection truth from the server: 'verified' means a health check on
   * Nebius succeeded, 'configured' means a key exists but the check did not
   * complete, 'unconfigured' means no key exists.
   */
  connection: 'verified' | 'configured' | 'unconfigured';
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

/**
 * Friendly labels for the assumption chips, keyed by the raw field name the
 * planner emits. Unknown fields fall back to the raw name; the chips keep the
 * raw field as the title attribute so the technical name is always one hover
 * away.
 */
export const ASSUMPTION_LABELS: Readonly<Record<string, string>> = {
  instrumentRatePa: 'Savings growth rate',
  mortgageStressRatePa: 'Mortgage stress-test rate',
  hdbConcessionaryRatePa: 'HDB loan rate',
  renovationBufferSgd: 'Renovation buffer',
  inflationPa: 'Inflation',
  deadlineAge: 'Target age',
  investmentRatePa: 'Investment return',
  priceSgd: 'Assumed price',
};

/** Chip label for an assumption field: friendly when known, raw otherwise. */
export function assumptionLabel(field: string): string {
  return ASSUMPTION_LABELS[field] ?? field;
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
  const takeHomeMonthlyIncome = optionalNumberFrom(form.takeHomeMonthlyIncome);
  const monthlyDebtCommitments = optionalNumberFrom(form.monthlyDebtCommitments);
  const emergencyReserveMonths = optionalNumberFrom(form.emergencyReserveMonths);
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
    // Affordability fields: absent means the planner derives or defaults them.
    ...(takeHomeMonthlyIncome !== undefined ? { takeHomeMonthlyIncome } : {}),
    ...(monthlyDebtCommitments !== undefined ? { monthlyDebtCommitments } : {}),
    ...(emergencyReserveMonths !== undefined ? { emergencyReserveMonths } : {}),
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
    takeHomeMonthlyIncome: '',
    monthlyDebtCommitments: '',
    emergencyReserveMonths: '',
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
    (status.connection === 'verified' ||
      status.connection === 'configured' ||
      status.connection === 'unconfigured') &&
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

/** Profile fields that must be finite numbers when present at all. */
const PROFILE_REQUIRED_NUMBER_FIELDS: ReadonlyArray<string> = [
  'age',
  'grossMonthlyIncome',
  'monthlyExpenses',
  'liquidSavings',
  'cpfOaBalance',
  'milesValuationCents',
];

/** Optional UserProfile fields: absent is fine, present must be a finite number. */
const PROFILE_OPTIONAL_NUMBER_FIELDS: ReadonlyArray<string> = [
  'investmentsSgd',
  'investmentRatePa',
  'takeHomeMonthlyIncome',
  'monthlyDebtCommitments',
  'emergencyReserveMonths',
];

/**
 * Sane-shape guard for a stored profile payload (the JSON the app writes under
 * sw_profile_you / sw_profile_partner). Every required field must be a finite
 * number and every optional affordability or portfolio field, when present,
 * must be a finite number too. Extra keys are tolerated: the hydrate reader
 * ignores anything it does not know, and refusing them would break imports
 * from a future version.
 */
export function isSaneStoredProfile(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const profile = value as Record<string, unknown>;
  const finiteNumber = (key: string): boolean =>
    typeof profile[key] === 'number' && Number.isFinite(profile[key] as number);
  if (!PROFILE_REQUIRED_NUMBER_FIELDS.every(finiteNumber)) {
    return false;
  }
  return PROFILE_OPTIONAL_NUMBER_FIELDS.every(
    (key) => profile[key] === undefined || finiteNumber(key)
  );
}

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
    (goal.space === undefined ||
      goal.space === 'you' ||
      goal.space === 'partner' ||
      goal.space === 'us') &&
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
          typeof (log as Record<string, unknown>).note === 'string') &&
        ((log as Record<string, unknown>).contributor === undefined ||
          (log as Record<string, unknown>).contributor === 'you' ||
          (log as Record<string, unknown>).contributor === 'partner')
    )
  );
}

/**
 * One-time-per-install legacy storage migration, safe to call on every
 * hydrate. Nothing is ever deleted: when a pre-couples key exists and its
 * per-space successor does not, the value is copied into the you space
 * (sw_profile -> sw_profile_you, sw_wallet -> sw_wallet_you, sw_ledger ->
 * sw_ledger_you). sw_goals is then rewritten in place adding
 * space: goal.space ?? 'you' to every goal and contributor: 'you' to every
 * log that lacks one, but only when something is actually missing, so the
 * second call is always a no-op. Returns the names of the keys it wrote.
 */
export function migrateLegacyStorage(): string[] {
  if (typeof window === 'undefined') {
    return [];
  }
  const touched: string[] = [];
  try {
    const copies: ReadonlyArray<{ legacy: string; next: string }> = [
      { legacy: LEGACY_PROFILE_KEY, next: PROFILE_YOU_KEY },
      { legacy: LEGACY_WALLET_KEY, next: WALLET_YOU_KEY },
      { legacy: LEGACY_LEDGER_KEY, next: LEDGER_YOU_KEY },
    ];
    for (const { legacy, next } of copies) {
      const rawLegacy = window.localStorage.getItem(legacy);
      if (rawLegacy !== null && window.localStorage.getItem(next) === null) {
        window.localStorage.setItem(next, rawLegacy);
        touched.push(next);
      }
    }

    const rawGoals = window.localStorage.getItem(GOALS_KEY);
    if (rawGoals !== null) {
      const stored: unknown = JSON.parse(rawGoals);
      if (Array.isArray(stored)) {
        let changed = false;
        const rewritten = stored.map((goal) => {
          if (goal === null || typeof goal !== 'object') {
            return goal;
          }
          const record = goal as Record<string, unknown>;
          const needsSpace = record.space !== 'you' && record.space !== 'partner' && record.space !== 'us';
          let goalChanged = needsSpace;
          const nextGoal: Record<string, unknown> = { ...record };
          if (needsSpace) {
            nextGoal.space = 'you';
          }
          if (Array.isArray(record.logs)) {
            const nextLogs = record.logs.map((log) => {
              if (log === null || typeof log !== 'object') {
                return log;
              }
              const logRecord = log as Record<string, unknown>;
              if (logRecord.contributor !== 'you' && logRecord.contributor !== 'partner') {
                goalChanged = true;
                return { ...logRecord, contributor: 'you' };
              }
              return log;
            });
            if (goalChanged) {
              nextGoal.logs = nextLogs;
            }
          }
          if (goalChanged) {
            changed = true;
          }
          return goalChanged ? nextGoal : goal;
        });
        if (changed) {
          window.localStorage.setItem(GOALS_KEY, JSON.stringify(rewritten));
          touched.push(GOALS_KEY);
        }
      }
    }
  } catch {
    // Corrupt storage leaves the keys untouched; hydration falls back to
    // defaults exactly as it did before the spaces feature.
    return touched;
  }
  return touched;
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

/* ---------------------------------------------------------------------- */
/* Data protection: export every sw_ key to a spendwise-backup JSON file   */
/* and import it back, validating each payload with the storage guards.    */
/* Both helpers are pure: the caller supplies the clock (exportedAtIso)    */
/* and the raw strings, so tests need no DOM and no network.              */
/* ---------------------------------------------------------------------- */

/** Backup file format version; import refuses anything else. */
export const BACKUP_VERSION = 1;

/** The plain header plus raw localStorage payloads of every sw_ key. */
export interface BackupFile {
  app: 'spendwise';
  version: 1;
  /** ISO timestamp the caller captured at export time. */
  exportedAtIso: string;
  /** Raw localStorage values by key; only sw_ prefixed keys are kept. */
  data: Record<string, string>;
}

/** One key import validated and is ready to write back to localStorage. */
export interface BackupEntry {
  key: string;
  /** The payload exactly as exported; import writes it back verbatim. */
  value: string;
}

/** One key import refused, with a human-readable reason. */
export interface BackupSkip {
  key: string;
  reason: string;
}

/** Everything the importer needs after a successful parse. */
export interface BackupImportPlan {
  exportedAtIso: string;
  entries: BackupEntry[];
  skipped: BackupSkip[];
}

export type BackupParseResult =
  | { ok: true; plan: BackupImportPlan }
  | { ok: false; error: string };

/**
 * Wrap raw localStorage payloads in the spendwise-backup envelope. Only keys
 * prefixed sw_ are kept, so the file can never smuggle unrelated storage in.
 * Pure: the caller passes the ISO timestamp so tests stay deterministic.
 */
export function buildBackup(data: Record<string, string>, exportedAtIso: string): BackupFile {
  const filtered: Record<string, string> = {};
  for (const key of Object.keys(data)) {
    if (key.startsWith('sw_')) {
      filtered[key] = data[key];
    }
  }
  return { app: 'spendwise', version: BACKUP_VERSION, exportedAtIso, data: filtered };
}

/** Parse one JSON value, or null when the string is not valid JSON. */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Outcome of a per-key payload check: written whole, or skipped with a reason. */
type KeyOutcome = BackupEntry | BackupSkip;

function isSkip(outcome: KeyOutcome): outcome is BackupSkip {
  return 'reason' in outcome;
}

/**
 * Validate an array payload against a guard, all-or-nothing: the key validates
 * only when the value parses to a JSON array and every row passes. A single
 * bad row skips the whole key (reported with the count) rather than importing
 * a silently filtered subset.
 */
function validateArrayKey<T>(
  key: string,
  raw: string,
  guard: (value: unknown) => value is T,
  noun: string
): KeyOutcome {
  const parsed = tryParseJson(raw);
  if (parsed === null || !Array.isArray(parsed)) {
    return { key, reason: 'not a JSON array' };
  }
  const invalid = parsed.filter((row) => !guard(row)).length;
  if (invalid > 0) {
    return { key, reason: `${invalid} of ${parsed.length} ${noun} failed validation` };
  }
  return { key, value: raw };
}

/** Validate one sw_profile_* payload against the sane-profile shape. */
function validateProfile(key: string, raw: string): KeyOutcome {
  const parsed = tryParseJson(raw);
  if (!isSaneStoredProfile(parsed)) {
    return { key, reason: 'not a sane profile payload' };
  }
  return { key, value: raw };
}

/**
 * Parse and validate a spendwise-backup file. Structural failures (bad JSON,
 * wrong header, wrong version) return ok false with an error; payload problems
 * return ok true with the bad keys listed in skipped, so the importer can
 * write only the keys that fully validate and report exactly what it refused.
 * Values are written back verbatim: nothing invalid is ever re-serialised or
 * partially imported.
 */
export function parseBackup(raw: string): BackupParseResult {
  const parsed = tryParseJson(raw);
  if (parsed === null) {
    return { ok: false, error: 'the file is not valid JSON' };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'the backup must be a JSON object' };
  }
  const file = parsed as Record<string, unknown>;
  if (file.app !== 'spendwise') {
    return { ok: false, error: 'the file is not a SpendWise backup (app header missing)' };
  }
  if (file.version !== BACKUP_VERSION) {
    return { ok: false, error: `unsupported backup version ${String(file.version)}` };
  }
  if (typeof file.exportedAtIso !== 'string' || file.exportedAtIso === '') {
    return { ok: false, error: 'the backup header has no export timestamp' };
  }
  const data = file.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'the backup has no data object' };
  }

  const entries: BackupEntry[] = [];
  const skipped: BackupSkip[] = [];
  for (const key of Object.keys(data as Record<string, unknown>)) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value !== 'string') {
      skipped.push({ key, reason: 'value is not a string' });
      continue;
    }
    let outcome: KeyOutcome;
    if (key === GOALS_KEY) {
      outcome = validateArrayKey(key, value, isTrackedGoal, 'tracked goal(s)');
    } else if (key === CUSTOM_CARDS_KEY) {
      outcome = validateArrayKey(key, value, isCustomCardStored, 'custom card(s)');
    } else if (key === LEDGER_YOU_KEY || key === LEDGER_PARTNER_KEY || key === LEDGER_US_KEY) {
      outcome = validateArrayKey(key, value, isLedgerRow, 'ledger row(s)');
    } else if (key === WALLET_YOU_KEY || key === WALLET_PARTNER_KEY || key === WALLET_US_KEY) {
      outcome = validateArrayKey(
        key,
        value,
        (entry): entry is string => typeof entry === 'string',
        'wallet id(s)'
      );
    } else if (key === PROFILE_YOU_KEY || key === PROFILE_PARTNER_KEY) {
      outcome = validateProfile(key, value);
    } else if (key === SPACE_ACTIVE_KEY) {
      outcome =
        value === 'you' || value === 'partner' || value === 'us'
          ? { key, value }
          : { key, reason: 'not a space name' };
    } else {
      outcome = { key, reason: 'unrecognised key' };
    }
    if (isSkip(outcome)) {
      skipped.push(outcome);
    } else {
      entries.push(outcome);
    }
  }
  return { ok: true, plan: { exportedAtIso: file.exportedAtIso, entries, skipped } };
}

/* ---------------------------------------------------------------------- */
/* What-if advisor: prompt rebuilding, revision application and the wire   */
/* guard for POST /api/advisor replies.                                    */
/* ---------------------------------------------------------------------- */

/**
 * Prompt text rebuilt from a goal spec's summary fields, so applying an
 * advisor revision leaves the prompt consistent with the goal it produced.
 * Wording chosen so the offline regex parser reproduces the spec exactly:
 * money with a k suffix or an S$ prefix, deadline always "by age N".
 */
export function promptFromGoalSpec(goal: GoalSpec): string {
  const money = (amount: number): string =>
    amount >= 1000 && amount % 1000 === 0 ? `${amount / 1000}k` : `S$${Math.round(amount)}`;
  if (goal.kind === 'property_purchase') {
    const what = goal.propertyType === 'bto' ? 'BTO flat' : goal.propertyType === 'condo' ? 'condo' : 'HDB';
    return `I want to buy a ${what} worth about ${money(goal.targetPriceSgd)} by age ${goal.deadlineAge}`;
  }
  if (goal.kind === 'car_purchase') {
    return `I want to buy a car worth about ${money(goal.priceSgd)} by age ${goal.deadlineAge}`;
  }
  const rate =
    goal.instrumentRatePa !== undefined
      ? ` at ${Math.round(goal.instrumentRatePa * 1000) / 10} percent pa`
      : '';
  return `I want to save ${money(goal.targetAmountSgd)} by age ${goal.deadlineAge}${rate}`;
}

/**
 * Map a revised profile (from the advisor wire) onto the profile form of a
 * personal space. takeHomeMonthlyIncome and emergencyReserveMonths are kept
 * from the current form on purpose: the advisor request schema cannot carry
 * them, so a revision reply never states them and clearing them would
 * silently discard what the user typed. Fields the wire does carry round trip
 * verbatim; absent optional ones keep their current value.
 */
export function profileFormFromRevised(
  revised: UserProfile,
  current: ProfileFormState
): ProfileFormState {
  const optional = (value: number | undefined, fallback: string): string =>
    value !== undefined && Number.isFinite(value) ? String(value) : fallback;
  return {
    age: String(revised.age),
    grossMonthlyIncome: String(revised.grossMonthlyIncome),
    monthlyExpenses: String(revised.monthlyExpenses),
    liquidSavings: String(revised.liquidSavings),
    cpfOaBalance: String(revised.cpfOaBalance),
    investmentsSgd: optional(revised.investmentsSgd, current.investmentsSgd),
    investmentRatePct:
      revised.investmentRatePa !== undefined
        ? String(revised.investmentRatePa * 100)
        : current.investmentRatePct,
    takeHomeMonthlyIncome: current.takeHomeMonthlyIncome,
    monthlyDebtCommitments: optional(revised.monthlyDebtCommitments, current.monthlyDebtCommitments),
    emergencyReserveMonths: current.emergencyReserveMonths,
  };
}

/** Before and after figures of a revise turn, every number from buildPlan. */
export interface AdvisorDeltaWire {
  requiredMonthlySavingsBefore: number;
  requiredMonthlySavingsAfter: number;
  verdictBefore: VerdictStatus;
  verdictAfter: VerdictStatus;
  targetBefore: number;
  targetAfter: number;
}

/** One reply from POST /api/advisor, mirroring the route's three shapes. */
export type AdvisorReply =
  | { kind: 'clarify'; questions: string[] }
  | { kind: 'answer'; summary: string }
  | {
      kind: 'revise';
      summary: string;
      note: string;
      delta: AdvisorDeltaWire;
      comparison: string;
      revisedGoalSpec: GoalSpec;
      revisedProfile: UserProfile;
    };

/** Guard for /api/advisor payloads read back from fetch. */
export function isAdvisorReply(value: unknown): value is AdvisorReply {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const reply = value as Record<string, unknown>;
  if (reply.kind === 'clarify') {
    return (
      Array.isArray(reply.questions) &&
      reply.questions.length > 0 &&
      reply.questions.every((question) => typeof question === 'string' && question.length > 0)
    );
  }
  if (reply.kind === 'answer') {
    return typeof reply.summary === 'string' && reply.summary.length > 0;
  }
  if (reply.kind === 'revise') {
    const delta = reply.delta;
    const finite = (entry: unknown): boolean =>
      typeof entry === 'number' && Number.isFinite(entry);
    const verdict = (entry: unknown): boolean =>
      entry === 'achievable' || entry === 'stretch' || entry === 'not_achievable';
    const deltaRecord = delta === null || typeof delta !== 'object' ? null : (delta as Record<string, unknown>);
    return (
      typeof reply.summary === 'string' &&
      reply.summary.length > 0 &&
      typeof reply.note === 'string' &&
      typeof reply.comparison === 'string' &&
      deltaRecord !== null &&
      finite(deltaRecord.requiredMonthlySavingsBefore) &&
      finite(deltaRecord.requiredMonthlySavingsAfter) &&
      verdict(deltaRecord.verdictBefore) &&
      verdict(deltaRecord.verdictAfter) &&
      finite(deltaRecord.targetBefore) &&
      finite(deltaRecord.targetAfter) &&
      isGoalSpec(reply.revisedGoalSpec) &&
      isSaneStoredProfile(reply.revisedProfile)
    );
  }
  return false;
}

/* ---------------------------------------------------------------------- */
/* Guided sample journey: pure storage-key builders for the demo state.    */
/* ---------------------------------------------------------------------- */

/** The primary profile of the sample journey, 26 with a growing portfolio. */
const JOURNEY_YOU_PROFILE: UserProfile = {
  age: 26,
  grossMonthlyIncome: 5200,
  monthlyExpenses: 2800,
  liquidSavings: 48000,
  cpfOaBalance: 42000,
  milesValuationCents: 1.8,
  investmentsSgd: 12000,
  investmentRatePa: 0.045,
};

/** The partner profile of the sample journey, 27 and saving steadily. */
const JOURNEY_PARTNER_PROFILE: UserProfile = {
  age: 27,
  grossMonthlyIncome: 4600,
  monthlyExpenses: 2400,
  liquidSavings: 36000,
  cpfOaBalance: 30000,
  milesValuationCents: 1.8,
};

/**
 * Build the sample journey as raw localStorage payloads keyed by their sw_
 * names: two personal profiles, two wallets of built-in cards, one tracked Us
 * goal whose figures are frozen exactly the way Track this goal freezes them
 * (buildPlan over the combined household profile), with three months of logs
 * across both contributors, and the Us space selected. Pure: the caller
 * supplies the current "YYYY-MM" so the same key always builds the identical
 * payload. Nothing here touches window; the caller writes the keys.
 */
export function buildSampleJourney(nowMonthKey: string): Record<string, string> {
  const household = combineProfiles(JOURNEY_YOU_PROFILE, JOURNEY_PARTNER_PROFILE);
  const goalSpec: GoalSpec = {
    kind: 'property_purchase',
    propertyType: 'hdb_resale',
    targetPriceSgd: 600_000,
    deadlineAge: 30,
    firstProperty: true,
  };
  const plan = buildPlan(goalSpec, household, fillAssumptions(goalSpec, household));
  const lastBalance = plan.savingsSchedule[plan.savingsSchedule.length - 1]?.balance ?? 0;
  const name = goalNameFromSpec(goalSpec);
  const startMonthKey = monthKeyOffset(nowMonthKey, -3);
  const requiredMonthly = Math.max(0, plan.requiredMonthlySavings);
  // Sample contributions derive from the plan's own pace so the demo month
  // amounts can never drift from the required monthly saving.
  const youMonth = Math.round(requiredMonthly / 50) * 50;
  const partnerMonth = Math.round((requiredMonthly * 0.6) / 10) * 10;
  const goal: TrackedGoal = {
    id: goalSlug(name),
    name,
    goalSpec,
    targetSgd: lastBalance > 0 ? lastBalance : Math.max(0, requiredMonthly * 48),
    requiredMonthlySgd: requiredMonthly,
    ratePa: rateFromAssumptions(plan.assumptions),
    startAge: household.age,
    startSavingsSgd: Math.max(0, household.liquidSavings),
    deadlineAge: goalSpec.deadlineAge,
    startMonthKey,
    space: 'us',
    logs: [
      { monthKey: startMonthKey, contributedSgd: youMonth, contributor: 'you', note: 'salary transfer' },
      { monthKey: monthKeyOffset(startMonthKey, 1), contributedSgd: youMonth, contributor: 'you' },
      { monthKey: monthKeyOffset(startMonthKey, 1), contributedSgd: partnerMonth, contributor: 'partner', note: 'year-end bonus' },
      { monthKey: monthKeyOffset(startMonthKey, 2), contributedSgd: partnerMonth, contributor: 'partner' },
    ],
  };
  return {
    [PROFILE_YOU_KEY]: JSON.stringify(JOURNEY_YOU_PROFILE),
    [PROFILE_PARTNER_KEY]: JSON.stringify(JOURNEY_PARTNER_PROFILE),
    [WALLET_YOU_KEY]: JSON.stringify(['uob-one', 'dbs-live-fresh', 'citi-cash-back-plus']),
    [WALLET_PARTNER_KEY]: JSON.stringify(['hsbc-live-plus', 'sc-simply-cash']),
    [GOALS_KEY]: JSON.stringify([goal]),
    [SPACE_ACTIVE_KEY]: 'us',
  };
}
