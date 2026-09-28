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

/** One number the plan fills in because the prompt left it unknown. */
export interface Assumption {
  field: string;
  value: number;
  reason: string;
}
