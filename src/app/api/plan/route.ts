/**
 * POST /api/plan: the only server endpoint in SpendWise.
 *
 * Takes { prompt, profile }, runs the planner pipeline
 * parseGoal -> missingFields -> fillAssumptions -> buildPlan and returns
 * { plan, goalSpec, parser }. The LLM (Nemotron on Nebius Token Factory) is
 * used only to parse the prompt into a GoalSpec; every number in the returned
 * plan comes from the deterministic kernels in src/lib/kernels. Invalid input
 * returns 400 with a message that says what a usable request looks like.
 *
 * `missingFields` is returned as an additive fourth field so clients can see
 * which GoalSpec fields the prompt left unstated before assumptions filled
 * them; the plan itself already carries the matching assumption chips.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { isConfigured } from '../../../lib/nebius';
import { buildPlan } from '../../../lib/planner/build';
import {
  userProfileSchema,
  type GoalSpec,
  type UserProfile,
} from '../../../lib/planner/goalspec';
import {
  fillAssumptions,
  missingFields,
  parseGoal,
  parseGoalFallback,
} from '../../../lib/planner/parse';

export type PlanParser = 'nemotron' | 'local-fallback';

const planRequestSchema = z.object({
  prompt: z
    .string({ required_error: 'prompt is required', invalid_type_error: 'prompt must be a string' })
    .min(1, 'prompt must not be empty'),
  profile: userProfileSchema,
});

/**
 * Canonical JSON with recursively sorted object keys, so two GoalSpec values
 * built with different key orders still compare equal.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Conservative parser attribution. When Nebius is configured, parseGoal tries
 * Nemotron first and silently falls back offline, so the route re-runs the
 * exported offline parser as a witness: an output that differs from the
 * witness can only be Nemotron's, while an exact match is credited to the
 * offline parser so the label never claims an LLM parse it cannot prove.
 * When both parsers agree the spec is byte-identical anyway, so the plan and
 * every figure in it are unaffected by the attribution.
 */
function detectParser(prompt: string, profile: UserProfile, goal: GoalSpec): PlanParser {
  if (!isConfigured()) {
    return 'local-fallback';
  }
  const witness = parseGoalFallback(prompt, profile);
  if (witness === null) {
    return 'nemotron';
  }
  return canonicalJson(witness) === canonicalJson(goal) ? 'local-fallback' : 'nemotron';
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
      'Request body must be JSON shaped like { "prompt": string, "profile": UserProfile }.'
    );
  }

  const parsed = planRequestSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      'Invalid request body. Expected { "prompt": string, "profile": { age, grossMonthlyIncome, monthlyExpenses, liquidSavings, cpfOaBalance, milesValuationCents } } where every profile value is a number.',
      parsed.error.issues.map(
        (issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'body'}: ${issue.message}`
      )
    );
  }

  const { prompt, profile } = parsed.data;

  try {
    const goal = await parseGoal(prompt, profile);
    if (goal === null) {
      return badRequest(
        'Could not read a financial goal from that prompt. State what you want, the amount and the deadline, for example "buy a HDB worth 600k by age 28", "buy a car for 150k by 30" or "save 1 million by 50".'
      );
    }

    // The full deterministic pipeline: what is missing, what gets assumed,
    // and the plan itself. All three are pure functions.
    const missing = missingFields(goal, profile);
    const assumptions = fillAssumptions(goal, profile);
    const plan = buildPlan(goal, profile, assumptions);
    const parser = detectParser(prompt.trim(), profile, goal);

    return NextResponse.json({ plan, goalSpec: goal, parser, missingFields: missing });
  } catch (error) {
    return NextResponse.json(
      { error: `Planner failed: ${error instanceof Error ? error.message : 'unknown error'}.` },
      { status: 500 }
    );
  }
}
