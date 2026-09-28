/**
 * Card domain types for the deterministic reward routing engine.
 *
 * Rate units by rewardType:
 *  - cashback: `rate` is a decimal fraction of spend (0.06 means 6% cashback).
 *  - miles:    `rate` is miles per dollar (4 means 4 mpd), valued in SGD at
 *              a configurable miles valuation (see engine.routeExpense).
 * All caps are expressed in SGD of monthly card spend, not reward units.
 */

export type ExpenseCategory =
  | "groceries"
  | "dining"
  | "online_shopping"
  | "transport"
  | "petrol"
  | "travel"
  | "utilities"
  | "entertainment"
  | "insurance"
  | "education"
  | "medical"
  | "other";

export type RewardType = "cashback" | "miles";

/** One bonus row of a card's earn structure. */
export interface EarnTier {
  category: ExpenseCategory;
  /** Reward units earned per SGD spent, in the units of the card's rewardType. */
  rate: number;
  /** Monthly spend cap (SGD) for this bonus tier, when the issuer caps it. */
  capMonthlySgd?: number;
  /** Human-readable exclusion or eligibility note for the tier. */
  note?: string;
}

export interface CardSpec {
  id: string;
  issuer: string;
  name: string;
  rewardType: RewardType;
  /** Bonus tiers; categories not listed earn baseRate. */
  earnStructure: EarnTier[];
  /** Uncapped fall-back rate (same units as EarnTier.rate). */
  baseRate: number;
  /** Monthly minimum spend (SGD) below which bonus rates are withheld. */
  minMonthlySpendSgd?: number;
  minSpendNote?: string;
  /** Headline base earning in miles per dollar, for miles cards only. */
  milesPerDollar?: number;
  annualFeeSgd: number;
  /** One-line disclaimer: terms are illustrative as of 2025 and must be verified with the issuer. */
  sourceNote: string;
}

/** A single purchase the router scores. */
export interface SpendInput {
  amountSgd: number;
  category: ExpenseCategory;
  merchantText?: string;
}

/** One logged purchase, tagged with its calendar month ("YYYY-MM"). */
export interface LedgerEntry {
  cardId: string;
  amountSgd: number;
  category: ExpenseCategory;
  monthKey: string;
}

/** All logged purchases for one month. */
export interface MonthlyLedger {
  monthKey: string;
  entries: LedgerEntry[];
}
