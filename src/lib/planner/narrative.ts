/**
 * Ultra narrative enrichment with offline fallback.
 *
 * enrichPlanNarrative asks the largest Nemotron model on Nebius Token Factory
 * to rewrite only the words of an already computed plan: the verdict reasoning
 * and the teaching point bodies. Every figure stays exactly what the
 * deterministic kernels produced; the system prompt forbids computing or
 * altering numbers and the code enforces the reply shape instead of trusting
 * the model. Any failure (no API key, a null reply, an invalid shape) returns
 * the plan unchanged with narrativeEngine 'deterministic', so the planner
 * always produces a complete plan with no network and no key.
 */
import { z } from 'zod';
import { chatJson, isConfigured, ultraModel } from '../nebius';
import type { PlanJSON } from './build';

/**
 * Injectable model access so tests stub the network boundary. The default is a
 * thin wrapper over one chatJson call on the ultra model.
 */
export type NarrativeFetcher = (
  system: string,
  user: string
) => Promise<Record<string, unknown> | null>;

const defaultFetcher: NarrativeFetcher = (system, user) => chatJson(system, user, ultraModel());

const narrativeReplySchema = z.object({
  verdictReasoning: z.string().min(1),
  teachingBodies: z.array(z.string().min(1)),
});

type NarrativeReply = z.infer<typeof narrativeReplySchema>;

/**
 * Shape gate on the model reply: verdictReasoning must be a nonempty string
 * and teachingBodies must hold exactly one nonempty string per teaching point.
 */
function validateReply(raw: Record<string, unknown>, teachingCount: number): NarrativeReply | null {
  const parsed = narrativeReplySchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  if (parsed.data.teachingBodies.length !== teachingCount) {
    return null;
  }
  return parsed.data;
}

function systemPrompt(teachingCount: number): string {
  return [
    'You are the narrative writer of SpendWise, a Singapore financial goal planner.',
    'You rewrite the verdict reasoning and the teaching point bodies of a plan whose every number was already computed by a deterministic engine.',
    'Reply with ONLY one JSON object and no other text, shaped exactly like:',
    `{"verdictReasoning":"one rewritten paragraph","teachingBodies":[${Array.from(
      { length: teachingCount },
      () => '"one rewritten paragraph"'
    ).join(', ')}]}`,
    'Rules:',
    '- Copy every figure (dollar amounts, percentages, rates, ages, years, counts) VERBATIM from the provided plan. Never compute, round, convert, estimate or invent any number.',
    '- Keep every statement of fact identical in meaning; improve only the wording, flow and clarity.',
    `- Return exactly ${teachingCount} teaching bodies, in the same order as the teaching points given.`,
    '- Keep each rewritten paragraph at most 4 sentences.',
    '- Never wrap the JSON in markdown fences and never add commentary.',
  ].join('\n');
}

function userPrompt(plan: PlanJSON): string {
  const context = {
    goalSummary: plan.goalSummary,
    verdictHeadline: plan.verdict.headline,
    verdictReasoning: plan.verdict.reasoning,
    teaching: plan.teaching.map((point) => ({ title: point.title, body: point.body })),
  };
  return [
    'Rewrite the verdict reasoning and every teaching body of this plan.',
    'Every figure in it is final and must appear unchanged in your reply.',
    JSON.stringify(context, null, 2),
  ].join('\n');
}

/**
 * Rewrites verdict.reasoning and each teaching body with the ultra model.
 * Returns the plan untouched, with narrativeEngine 'deterministic', whenever
 * Nebius is unconfigured, the fetcher fails, or the reply does not validate;
 * otherwise returns the plan with the strings replaced and narrativeEngine
 * 'ultra'. No figure ever changes on either path.
 */
export async function enrichPlanNarrative(
  plan: PlanJSON,
  fetcher: NarrativeFetcher = defaultFetcher
): Promise<PlanJSON> {
  if (!isConfigured()) {
    return { ...plan, narrativeEngine: 'deterministic' };
  }
  let raw: Record<string, unknown> | null = null;
  try {
    raw = await fetcher(systemPrompt(plan.teaching.length), userPrompt(plan));
  } catch {
    raw = null;
  }
  if (raw === null) {
    return { ...plan, narrativeEngine: 'deterministic' };
  }
  const reply = validateReply(raw, plan.teaching.length);
  if (reply === null) {
    return { ...plan, narrativeEngine: 'deterministic' };
  }
  return {
    ...plan,
    verdict: { ...plan.verdict, reasoning: reply.verdictReasoning },
    teaching: plan.teaching.map((point, index) => ({
      ...point,
      body: reply.teachingBodies[index],
    })),
    narrativeEngine: 'ultra',
  };
}
