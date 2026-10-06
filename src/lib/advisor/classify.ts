/**
 * Advisor turn classification: Nemotron on Nebius Token Factory first, the
 * deterministic regex classifier as the floor.
 *
 * The model only ever chooses the SHAPE of the reply (clarify, revise or
 * answer) and which numbers from the provided context to copy. Zod validates
 * every reply against the AdvisorTurn schema, one corrective retry is allowed,
 * and any failure path lands on classifyFallback. This function never throws
 * and never computes a financial number.
 */
import { z } from 'zod';

import { chatJson, isConfigured, superModel } from '../nebius';
import type { GoalSpec, UserProfile } from '../planner/goalspec';
import { classifyFallback } from './engine';
import type { AdvisorMessage, AdvisorTurn } from './types';

/**
 * Signature of chatJson from src/lib/nebius, also the seam tests use to stub
 * the model without touching the network.
 */
export type ModelJsonFetcher = (
  system: string,
  user: string,
  model: string
) => Promise<Record<string, unknown> | null>;

const incomeGapSchema = z.object({
  months: z.number(),
  who: z.enum(['you', 'partner', 'both']),
});

const revisionPatchSchema = z.object({
  deadlineAge: z.number().optional(),
  targetPriceSgd: z.number().optional(),
  priceSgd: z.number().optional(),
  targetAmountSgd: z.number().optional(),
  incomeGap: incomeGapSchema.optional(),
});

/** Zod mirror of the AdvisorTurn union; the model reply must match exactly. */
export const advisorTurnSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('clarify'),
    questions: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('revise'),
    summary: z.string().min(1),
    patch: revisionPatchSchema,
  }),
  z.object({
    kind: z.literal('answer'),
    summary: z.string().min(1),
  }),
]);

function systemPrompt(): string {
  return [
    'You are the what-if advisor of SpendWise, a Singapore financial goal planner.',
    'Reply with ONLY one JSON object and no other text. Choose exactly one shape:',
    '{"kind":"clarify","questions":["..."]} when the message is a what-if but a number you would need is missing; ask only for the missing numbers.',
    '{"kind":"revise","summary":"one short sentence","patch":{...}} when the message asks to change the plan. patch may set: "deadlineAge" (an absolute age at the goal, never a count of years), "targetPriceSgd" (property goals only), "priceSgd" (car goals only), "targetAmountSgd" (savings goals only), "incomeGap" {"months": number, "who": "you" or "partner" or "both"}.',
    '{"kind":"answer","summary":"..."} when the message neither changes the plan nor needs a missing number.',
    'Rules:',
    '- Copy every number VERBATIM from the context you are given. Never invent, estimate, compute or round any number.',
    '- Only set price fields that match the goal kind shown in the context.',
    '- A stretch without income is incomeGap, not a hand-written savings edit.',
    '- Never wrap the JSON in markdown fences and never add commentary.',
  ].join('\n');
}

function userPrompt(
  messages: ReadonlyArray<AdvisorMessage>,
  goalSpec: GoalSpec,
  profile: UserProfile
): string {
  const transcript = messages.map((message) => `${message.role}: ${message.text}`).join('\n');
  return [
    'Conversation so far:',
    transcript,
    `Current goal (GoalSpec): ${JSON.stringify(goalSpec)}`,
    `User profile: ${JSON.stringify(profile)}`,
    'Classify the last user message into exactly one AdvisorTurn JSON object.',
  ].join('\n');
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'root'}: ${issue.message}`)
    .join('; ');
}

/** Up to two model calls (one corrective retry). Null when neither validates. */
async function turnFromModel(
  call: ModelJsonFetcher,
  system: string,
  user: string
): Promise<AdvisorTurn | null> {
  const first = await call(system, user, superModel());
  const firstCheck = advisorTurnSchema.safeParse(first);
  if (firstCheck.success) {
    return firstCheck.data;
  }
  const retryUser = `${user}\n\nThat reply was not a valid advisor turn: ${describeIssues(firstCheck.error)}. Reply again with ONLY one corrected JSON object.`;
  const second = await call(system, retryUser, superModel());
  const secondCheck = advisorTurnSchema.safeParse(second);
  return secondCheck.success ? secondCheck.data : null;
}

/**
 * Classifies the conversation into the next advisor turn.
 *
 * With Nebius unconfigured this is classifyFallback on the last user message
 * and nothing else runs. With Nebius configured the super model is asked for
 * strict JSON validated against advisorTurnSchema, with one corrective retry;
 * an unconfigured key, a rejected reply or even a throwing fetcher all land
 * on the deterministic fallback, so this never throws. Tests inject a
 * ModelJsonFetcher so the model path runs without any network.
 */
export async function classifyAdvisor(
  messages: ReadonlyArray<AdvisorMessage>,
  goalSpec: GoalSpec,
  profile: UserProfile,
  fetcher?: ModelJsonFetcher
): Promise<AdvisorTurn> {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.text ?? '';
  if (!isConfigured()) {
    return classifyFallback(lastUser, goalSpec);
  }
  const call: ModelJsonFetcher = fetcher ?? chatJson;
  try {
    const turn = await turnFromModel(call, systemPrompt(), userPrompt(messages, goalSpec, profile));
    if (turn !== null) {
      return turn;
    }
  } catch {
    // chatJson never throws, but an injected fetcher might; fall through.
  }
  return classifyFallback(lastUser, goalSpec);
}
