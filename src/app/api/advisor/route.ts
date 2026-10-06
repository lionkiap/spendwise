/**
 * POST /api/advisor: the conversational what-if endpoint.
 *
 * Takes { messages, goalSpec, profile }, classifies the conversation with
 * classifyAdvisor (Nemotron when Nebius is configured, the deterministic
 * regex classifier otherwise and on any failure), and:
 * - clarify and answer turns pass straight through;
 * - a revise turn is applied with the pure applyRevision, then the before and
 *   after plans are both built through fillAssumptions and buildPlan so every
 *   returned number comes from the deterministic planner kernels, never the
 *   model. The comparison sentence is composed only from those kernel numbers.
 *
 * Valid input always gets 200; malformed JSON or a body failing zod gets 400
 * with issues that say what a usable request looks like.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { classifyAdvisor } from '../../../lib/advisor/classify';
import { applyRevision } from '../../../lib/advisor/engine';
import { buildPlan } from '../../../lib/planner/build';
import type { GoalSpec } from '../../../lib/planner/goalspec';
import { fillAssumptions } from '../../../lib/planner/parse';

/**
 * Local mirrors of the goalspec zod schemas. The frozen import contract for
 * the advisor allows only types and PLANNER_DEFAULTS from goalspec, so the
 * request schemas are re-declared here with identical fields and defaults
 * (firstProperty defaulting true, milesValuationCents defaulting 1.8).
 */
const advisorGoalSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('savings_target'),
    targetAmountSgd: z.number(),
    deadlineAge: z.number(),
    instrumentRatePa: z.number().optional(),
  }),
  z.object({
    kind: z.literal('property_purchase'),
    propertyType: z.enum(['hdb_resale', 'bto', 'condo']),
    targetPriceSgd: z.number(),
    deadlineAge: z.number(),
    firstProperty: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('car_purchase'),
    priceSgd: z.number(),
    deadlineAge: z.number(),
  }),
]);

const advisorProfileSchema = z.object({
  age: z.number(),
  grossMonthlyIncome: z.number(),
  monthlyExpenses: z.number(),
  liquidSavings: z.number(),
  cpfOaBalance: z.number(),
  milesValuationCents: z.number().default(1.8),
  investmentsSgd: z.number().optional(),
  investmentRatePa: z.number().optional(),
  /**
   * Passthrough for the optional profile debt field: applyRevision adds it to
   * the runway burn when present, and stripping it at the wire (zod's default
   * for unknown keys) would silently understate the burn.
   */
  monthlyDebtCommitments: z.number().optional(),
});

const advisorRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'advisor']),
        text: z.string({ invalid_type_error: 'each message text must be a string' }).min(1),
      })
    )
    .min(1, 'messages must hold at least one message'),
  goalSpec: advisorGoalSpecSchema,
  profile: advisorProfileSchema,
});

/** Before and after figures, every one computed by buildPlan. */
export interface AdvisorDelta {
  requiredMonthlySavingsBefore: number;
  requiredMonthlySavingsAfter: number;
  verdictBefore: 'achievable' | 'stretch' | 'not_achievable';
  verdictAfter: 'achievable' | 'stretch' | 'not_achievable';
  targetBefore: number;
  targetAfter: number;
}

/** The headline number of a goal spec, deterministic field pick by kind. */
function targetOf(goalSpec: GoalSpec): number {
  if (goalSpec.kind === 'property_purchase') {
    return goalSpec.targetPriceSgd;
  }
  if (goalSpec.kind === 'car_purchase') {
    return goalSpec.priceSgd;
  }
  return goalSpec.targetAmountSgd;
}

/** Deterministic money formatting with no locale dependence. */
function fmtSgd(amount: number): string {
  const rounded = Math.round(amount);
  const negative = rounded < 0;
  const digits = Math.abs(rounded).toString();
  let grouped = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) {
      grouped += ',';
    }
    grouped += digits[index];
  }
  return `${negative ? '-' : ''}$${grouped}`;
}

function verdictWords(status: 'achievable' | 'stretch' | 'not_achievable'): string {
  return status === 'not_achievable' ? 'not achievable' : status;
}

/** Comparison sentence composed only from the kernel-computed delta numbers. */
function comparisonSentence(delta: AdvisorDelta): string {
  const monthlyDiff = delta.requiredMonthlySavingsAfter - delta.requiredMonthlySavingsBefore;
  const monthlyPart =
    monthlyDiff === 0
      ? `the required monthly saving stays at ${fmtSgd(delta.requiredMonthlySavingsBefore)}`
      : `the required monthly saving moves from ${fmtSgd(delta.requiredMonthlySavingsBefore)} to ${fmtSgd(delta.requiredMonthlySavingsAfter)}, ${monthlyDiff > 0 ? 'up' : 'down'} ${fmtSgd(Math.abs(monthlyDiff))}`;
  const verdictPart =
    delta.verdictBefore === delta.verdictAfter
      ? `the verdict stays ${verdictWords(delta.verdictBefore)}`
      : `the verdict moves from ${verdictWords(delta.verdictBefore)} to ${verdictWords(delta.verdictAfter)}`;
  const targetDiff = delta.targetAfter - delta.targetBefore;
  const targetPart =
    targetDiff === 0
      ? `the target stays at ${fmtSgd(delta.targetBefore)}`
      : `the target moves from ${fmtSgd(delta.targetBefore)} to ${fmtSgd(delta.targetAfter)}, ${targetDiff > 0 ? 'up' : 'down'} ${fmtSgd(Math.abs(targetDiff))}`;
  const cap = monthlyPart.charAt(0).toUpperCase() + monthlyPart.slice(1);
  return `${cap}, ${verdictPart}, and ${targetPart}.`;
}

function badRequest(error: string, issues?: string[]): Response {
  return NextResponse.json({ error, issues: issues ?? [] }, { status: 400 });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest(
      'Request body must be JSON shaped like { "messages": AdvisorMessage[], "goalSpec": GoalSpec, "profile": UserProfile }.'
    );
  }

  const parsed = advisorRequestSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      'Invalid request body. Expected { "messages": [{ "role": "user" or "advisor", "text": non-empty string }], "goalSpec": a savings_target, property_purchase or car_purchase goal, "profile": { age, grossMonthlyIncome, monthlyExpenses, liquidSavings, cpfOaBalance } with every profile value a number }.',
      parsed.error.issues.map(
        (issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'body'}: ${issue.message}`
      )
    );
  }

  const { messages, goalSpec, profile } = parsed.data;

  try {
    const turn = await classifyAdvisor(messages, goalSpec, profile);

    if (turn.kind === 'clarify') {
      return NextResponse.json({ kind: 'clarify', questions: turn.questions });
    }
    if (turn.kind === 'answer') {
      return NextResponse.json({ kind: 'answer', summary: turn.summary });
    }

    const beforePlan = buildPlan(goalSpec, profile, fillAssumptions(goalSpec, profile));
    const revision = applyRevision(goalSpec, profile, turn.patch);
    const afterPlan = buildPlan(
      revision.goalSpec,
      revision.profile,
      fillAssumptions(revision.goalSpec, revision.profile)
    );
    const delta: AdvisorDelta = {
      requiredMonthlySavingsBefore: beforePlan.requiredMonthlySavings,
      requiredMonthlySavingsAfter: afterPlan.requiredMonthlySavings,
      verdictBefore: beforePlan.verdict.status,
      verdictAfter: afterPlan.verdict.status,
      targetBefore: targetOf(goalSpec),
      targetAfter: targetOf(revision.goalSpec),
    };
    return NextResponse.json({
      kind: 'revise',
      summary: turn.summary,
      note: revision.note,
      delta,
      comparison: comparisonSentence(delta),
      revisedGoalSpec: revision.goalSpec,
      revisedProfile: revision.profile,
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Advisor failed: ${error instanceof Error ? error.message : 'unknown error'}.` },
      { status: 500 }
    );
  }
}
