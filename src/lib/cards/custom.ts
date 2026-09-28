/**
 * User-defined cards: zod-validated parsing, deterministic slugging and
 * merging into the built-in deck.
 *
 * A custom card is typed by the same CardSpec the engine already scores, so
 * routeExpense and walletAudit need no changes to consider it. Everything here
 * is pure: no clock, no randomness, no locale-dependent formatting, and the
 * sourceNote is always forced to the fixed user-entry disclaimer so a custom
 * card can never present itself as verified issuer data.
 */
import { z } from 'zod';

import type { CardSpec, EarnTier, ExpenseCategory, RewardType } from './types';

/** Exact disclaimer every custom card carries, regardless of what was typed in. */
export const CUSTOM_CARD_SOURCE_NOTE =
  'User-entered terms. Not verified against any issuer.';

/** Maximum number of bonus tier rows a user may enter for one card. */
export const MAX_CUSTOM_TIERS = 8;

/** Default issuer for a card the user typed in themselves. */
export const DEFAULT_CUSTOM_ISSUER = 'Personal';

/** Fallback slug when a name contains nothing slugifiable, for example '!!!'. */
const EMPTY_SLUG_FALLBACK = 'custom-card';

const EXPENSE_CATEGORIES = [
  'groceries',
  'dining',
  'online_shopping',
  'transport',
  'petrol',
  'travel',
  'utilities',
  'entertainment',
  'insurance',
  'education',
  'medical',
  'other',
] as const satisfies readonly ExpenseCategory[];

const expenseCategorySchema = z.enum(EXPENSE_CATEGORIES, {
  errorMap: () => ({
    message: `category must be one of: ${EXPENSE_CATEGORIES.join(', ')}`,
  }),
});

/**
 * Rate bound shared by baseRate and tier rates, in the units the engine
 * scores. Cashback rates are decimals where 0.2 means 20 percent cashback;
 * miles rates are miles per dollar and run to 10, matching the built-in
 * deck. The tighter cashback ceiling is enforced per reward type in the
 * card-level refine, so its message can name the right limit.
 */
const rateSchema = z
  .number({ invalid_type_error: 'rate must be a number' })
  .min(0, 'rate must be between 0 and 10')
  .max(10, 'rate must be between 0 and 10');

/** Highest cashback rate a user-entered card may claim (20 percent). */
const CASHBACK_RATE_MAX = 0.2;

export const customEarnTierSchema = z.object({
  category: expenseCategorySchema,
  rate: rateSchema,
  capMonthlySgd: z
    .number({ invalid_type_error: 'capMonthlySgd must be a number' })
    .positive('capMonthlySgd must be greater than 0 when provided')
    .optional(),
});

export type CustomEarnTier = z.infer<typeof customEarnTierSchema>;

/**
 * The custom card form. Fields a user never sees (id, sourceNote) are derived
 * rather than accepted, and unknown input keys are stripped by zod, so a
 * caller cannot smuggle in its own disclaimer.
 */
export const customCardSchema = z
  .object({
    name: z
      .string({ invalid_type_error: 'name must be a string' })
      .trim()
      .min(1, 'name must be between 1 and 60 characters')
      .max(60, 'name must be between 1 and 60 characters'),
    issuer: z
      .string({ invalid_type_error: 'issuer must be a string' })
      .trim()
      .optional()
      .transform((value) => (value && value.length > 0 ? value : DEFAULT_CUSTOM_ISSUER)),
    rewardType: z.enum(['cashback', 'miles'], {
      errorMap: () => ({ message: 'rewardType must be either cashback or miles' }),
    }),
    baseRate: rateSchema,
    earnStructure: z
      .array(customEarnTierSchema, {
        invalid_type_error: 'earnStructure must be a list of bonus tiers',
      })
      .max(MAX_CUSTOM_TIERS, `a custom card can have at most ${MAX_CUSTOM_TIERS} bonus tiers`)
      .superRefine((tiers, ctx) => {
        const seen = new Map<ExpenseCategory, number>();
        tiers.forEach((tier, index) => {
          const firstIndex = seen.get(tier.category);
          if (firstIndex === undefined) {
            seen.set(tier.category, index);
            return;
          }
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'category'],
            message: `category "${tier.category}" is already used by bonus tier ${firstIndex + 1}; each tier needs a different category`,
          });
        });
      }),
    minMonthlySpendSgd: z
      .number({ invalid_type_error: 'minMonthlySpendSgd must be a number' })
      .min(0, 'minMonthlySpendSgd must be 0 or more')
      .optional(),
    milesPerDollar: z
      .number({ invalid_type_error: 'milesPerDollar must be a number' })
      .min(0.5, 'milesPerDollar must be between 0.5 and 10')
      .max(10, 'milesPerDollar must be between 0.5 and 10')
      .optional(),
    annualFeeSgd: z
      .number({ invalid_type_error: 'annualFeeSgd must be a number' })
      .min(0, 'annualFeeSgd must be 0 or more'),
  })
  .superRefine((card, ctx) => {
    if (card.rewardType === 'miles' && card.milesPerDollar === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['milesPerDollar'],
        message: 'milesPerDollar is required for a miles card and must be between 0.5 and 10',
      });
    }
    if (card.rewardType === 'cashback') {
      if (card.baseRate > CASHBACK_RATE_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseRate'],
          message: `baseRate for a cashback card must be between 0 and ${CASHBACK_RATE_MAX} (20 percent)`,
        });
      }
      card.earnStructure.forEach((tier, index) => {
        if (tier.rate > CASHBACK_RATE_MAX) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['earnStructure', index, 'rate'],
            message: `earnStructure.${index}.rate for a cashback card must be between 0 and ${CASHBACK_RATE_MAX} (20 percent)`,
          });
        }
      });
    }
  });

export type CustomCardDraft = z.input<typeof customCardSchema>;

export type ParseCustomCardResult =
  | { ok: true; card: CardSpec }
  | { ok: false; errors: string[] };

/** Deterministic slug of a card name: lowercase, hyphen separated. */
export function slugifyCardName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : EMPTY_SLUG_FALLBACK;
}

const pct = (rate: number): string => `${(rate * 100).toFixed(2)}%`;

const money = (sgd: number): string => `S$${sgd.toFixed(2)}`;

/** Deterministic tier note so the UI never needs the model to describe terms. */
function describeTier(tier: CustomEarnTier, rewardType: RewardType): string {
  const rate =
    rewardType === 'miles'
      ? `${tier.rate.toFixed(2)} miles per dollar`
      : `${pct(tier.rate)} cashback`;
  const cap =
    tier.capMonthlySgd !== undefined
      ? ` on up to ${money(tier.capMonthlySgd)} of monthly spend`
      : ' with no monthly cap';
  return `${rate} on ${tier.category}${cap}, as entered by you`;
}

function formatError(issue: z.ZodIssue): string {
  const at = issue.path.length > 0 ? issue.path.join('.') : 'card';
  return `${at}: ${issue.message}`;
}

/**
 * Parse untrusted user input into a CardSpec. Returns every validation problem
 * as a human-readable string on failure; on success the id is a slug of the
 * trimmed name, the issuer defaults to Personal and the sourceNote is always
 * the forced user-entry disclaimer. A cashback input's milesPerDollar, if any,
 * is dropped because the engine only reads it for miles cards.
 */
export function parseCustomCard(input: unknown): ParseCustomCardResult {
  const parsed = customCardSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map(formatError) };
  }

  const data = parsed.data;
  const earnStructure: EarnTier[] = data.earnStructure.map((tier) => ({
    category: tier.category,
    rate: tier.rate,
    ...(tier.capMonthlySgd !== undefined ? { capMonthlySgd: tier.capMonthlySgd } : {}),
    note: describeTier(tier, data.rewardType),
  }));

  const card: CardSpec = {
    id: slugifyCardName(data.name),
    issuer: data.issuer,
    name: data.name,
    rewardType: data.rewardType,
    earnStructure,
    baseRate: data.baseRate,
    ...(data.minMonthlySpendSgd !== undefined
      ? {
          minMonthlySpendSgd: data.minMonthlySpendSgd,
          minSpendNote: `S$${data.minMonthlySpendSgd.toFixed(0)} monthly spend required, as entered by you`,
        }
      : {}),
    ...(data.rewardType === 'miles' && data.milesPerDollar !== undefined
      ? { milesPerDollar: data.milesPerDollar }
      : {}),
    annualFeeSgd: data.annualFeeSgd,
    sourceNote: CUSTOM_CARD_SOURCE_NOTE,
  };
  return { ok: true, card };
}

/** Sensible empty defaults for the custom card form. */
export function blankCustomCardDraft(): CustomCardDraft {
  return {
    name: '',
    issuer: '',
    rewardType: 'cashback',
    baseRate: 0.01,
    earnStructure: [],
    annualFeeSgd: 0,
  };
}

/**
 * Append custom cards after the built-ins, keeping the given order. A custom id
 * that collides with an id already claimed (a built-in or an earlier custom
 * card) is suffixed -2; if even that is taken the suffix keeps counting up so
 * the merged deck never contains a duplicate id. Inputs are not mutated.
 */
export function mergeCards(builtIn: CardSpec[], custom: CardSpec[]): CardSpec[] {
  const taken = new Set(builtIn.map((card) => card.id));
  const merged: CardSpec[] = [...builtIn];

  for (const card of custom) {
    if (taken.has(card.id)) {
      let suffix = 2;
      while (taken.has(`${card.id}-${suffix}`)) {
        suffix += 1;
      }
      const renamed = `${card.id}-${suffix}`;
      taken.add(renamed);
      merged.push({
        ...card,
        id: renamed,
        earnStructure: card.earnStructure.map((tier) => ({ ...tier })),
      });
      continue;
    }
    taken.add(card.id);
    merged.push(card);
  }

  return merged;
}
