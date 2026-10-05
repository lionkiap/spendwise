/**
 * Zod schemas and inferred types for the goal planner.
 *
 * GoalSpec is a discriminated union on `kind`. Both the Nemotron output and
 * the offline heuristic parser produce it, and everything downstream
 * (buildPlan) consumes only validated GoalSpec values.
 */
import { z } from 'zod';

/**
 * Snapshot defaults the planner uses whenever the prompt leaves a number
 * unstated. Shared by the assumption filler and the plan builder so the two
 * can never drift apart.
 */
export const PLANNER_DEFAULTS = {
  /** MAS style mortgage stress test rate: 4.0 percent a year. */
  mortgageStressRatePa: 0.04,
  /** HDB concessionary mortgage rate snapshot: 2.6 percent a year. */
  hdbConcessionaryRatePa: 0.026,
  /** Long run inflation assumption: 2.5 percent a year. */
  inflationPa: 0.025,
  /** Renovation buffer carried for a resale flat. */
  renovationBufferSgd: 30_000,
  /** Savings instrument rate when the prompt states none: 1.8 percent a year. */
  instrumentRatePa: 0.018,
  /** Investment portfolio growth when the profile states none: 4.5 percent a year. */
  investmentRatePa: 0.045,
} as const;

/**
 * Illustrative placeholder prices used only when neither the prompt nor the
 * profile states one, so the demo can always produce a plan. Verify against
 * current listings before believing them.
 */
export const ILLUSTRATIVE_PROPERTY_PRICE_SGD: Record<PropertyType, number> = {
  hdb_resale: 600_000,
  bto: 500_000,
  condo: 1_200_000,
};

export const ILLUSTRATIVE_CAR_PRICE_SGD = 150_000;

export const propertyTypeSchema = z.enum(['hdb_resale', 'bto', 'condo']);
export type PropertyType = z.infer<typeof propertyTypeSchema>;

export const savingsTargetGoalSchema = z.object({
  kind: z.literal('savings_target'),
  targetAmountSgd: z.number(),
  deadlineAge: z.number(),
  instrumentRatePa: z.number().optional(),
});

export const propertyPurchaseGoalSchema = z.object({
  kind: z.literal('property_purchase'),
  propertyType: propertyTypeSchema,
  targetPriceSgd: z.number(),
  deadlineAge: z.number(),
  firstProperty: z.boolean().default(true),
});

export const carPurchaseGoalSchema = z.object({
  kind: z.literal('car_purchase'),
  priceSgd: z.number(),
  deadlineAge: z.number(),
});

export const goalSpecSchema = z.discriminatedUnion('kind', [
  savingsTargetGoalSchema,
  propertyPurchaseGoalSchema,
  carPurchaseGoalSchema,
]);

export type SavingsTargetGoal = z.infer<typeof savingsTargetGoalSchema>;
export type PropertyPurchaseGoal = z.infer<typeof propertyPurchaseGoalSchema>;
export type CarPurchaseGoal = z.infer<typeof carPurchaseGoalSchema>;
export type GoalSpec = z.infer<typeof goalSpecSchema>;

export const userProfileSchema = z.object({
  age: z.number(),
  grossMonthlyIncome: z.number(),
  monthlyExpenses: z.number(),
  liquidSavings: z.number(),
  cpfOaBalance: z.number(),
  milesValuationCents: z.number().default(1.8),
  /** Existing investment portfolio value; absent means 0 and behaves exactly like today. */
  investmentsSgd: z.number().optional(),
  /** Portfolio growth rate; when unstated the planner assumes the default and shows a chip. */
  investmentRatePa: z.number().optional(),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

/**
 * Combine two profiles into one household profile for shared ("us") planning.
 *
 * Field rules, all pure arithmetic, no rounding:
 * - grossMonthlyIncome, monthlyExpenses, liquidSavings and cpfOaBalance add:
 *   combined = you.field + partner.field.
 * - investmentsSgd adds treating undefined as 0. The result is omitted whenever
 *   the sum is exactly 0: zero-sum collapses to undefined-on-both, so a
 *   household where neither partner states a portfolio (0 + 0) or where stated
 *   portfolios cancel exactly (for example 5,000 + -5,000) reports no
 *   portfolio at all rather than a misleading investmentsSgd of 0, matching the
 *   "absent means 0 and behaves exactly like today" convention on the field.
 *   Any nonzero sum is kept as the plain sum.
 * - milesValuationCents comes from you: the household values miles at the
 *   primary profile's cents-per-mile, so card math stays on one valuation.
 * - investmentRatePa takes you's when set, else partner's, else is omitted so
 *   downstream code falls back to PLANNER_DEFAULTS.investmentRatePa and shows
 *   the unstated-rate chip.
 * - age comes from you: the combined profile stays anchored on the primary
 *   timeline so deadline ages keep meaning "your age" in every plan built from
 *   it. (The only field the couples feature deliberately does not sum.)
 */
export function combineProfiles(you: UserProfile, partner: UserProfile): UserProfile {
  const combined: UserProfile = {
    age: you.age,
    grossMonthlyIncome: you.grossMonthlyIncome + partner.grossMonthlyIncome,
    monthlyExpenses: you.monthlyExpenses + partner.monthlyExpenses,
    liquidSavings: you.liquidSavings + partner.liquidSavings,
    cpfOaBalance: you.cpfOaBalance + partner.cpfOaBalance,
    milesValuationCents: you.milesValuationCents,
  };
  const investments = (you.investmentsSgd ?? 0) + (partner.investmentsSgd ?? 0);
  if (investments !== 0) {
    combined.investmentsSgd = investments;
  }
  const rate = you.investmentRatePa ?? partner.investmentRatePa;
  if (rate !== undefined) {
    combined.investmentRatePa = rate;
  }
  return combined;
}

/** One number the plan fills in because the prompt left it unknown. */
export interface Assumption {
  field: string;
  value: number;
  reason: string;
}
