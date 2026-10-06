/**
 * Types for the what-if advisor, the conversational layer over the planner.
 *
 * The advisor never computes a financial number. It only decides, from the
 * conversation, which revision the user is asking about (a AdvisorTurn), and
 * hands the arithmetic to the pure engine (applyRevision) and the planner
 * kernels. Every type here is wire-facing: /api/advisor validates request
 * bodies against zod schemas that mirror these shapes.
 */

/**
 * A change the user asked to explore. Only the fields present are applied;
 * each numeric field matches exactly one goal kind, so a patch can never edit
 * a price the goal does not carry.
 */
export interface RevisionPatch {
  /** New deadline age, in years, for any goal kind. */
  deadlineAge?: number;
  /** New price for a property_purchase goal. */
  targetPriceSgd?: number;
  /** New price for a car_purchase goal. */
  priceSgd?: number;
  /** New amount for a savings_target goal. */
  targetAmountSgd?: number;
  /**
   * A stretch of months without income, modelled deterministically as runway
   * burn on liquid savings (see applyRevision). who names the affected
   * person; the note always labels this an approximation.
   */
  incomeGap?: { months: number; who: 'you' | 'partner' | 'both' };
}

/** One advisor reply: ask for more detail, revise the plan, or just answer. */
export type AdvisorTurn =
  | { kind: 'clarify'; questions: string[] }
  | { kind: 'revise'; summary: string; patch: RevisionPatch }
  | { kind: 'answer'; summary: string };

/** One chat message in the advisor conversation. */
export interface AdvisorMessage {
  role: 'user' | 'advisor';
  text: string;
}
