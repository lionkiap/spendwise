/**
 * Ultra narrative enrichment with offline fallback.
 *
 * enrichPlanNarrative asks the largest Nemotron model on Nebius Token Factory
 * to rewrite only the words of an already computed plan: the verdict reasoning
 * and the teaching point bodies. Every figure stays exactly what the
 * deterministic kernels produced; the system prompt forbids computing or
 * altering numbers and the code enforces it in two gates instead of trusting
 * the model: the reply shape (nonempty strings, one body per teaching point)
 * and the reply figures (every dollar amount, percentage and age the model
 * wrote must match a figure the deterministic plan already contains). Any
 * failure (no API key, a null reply, an invalid shape, an unlisted figure)
 * returns the plan unchanged with narrativeEngine 'deterministic', so the
 * planner always produces a complete plan with no network and no key.
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

/** One figure the extractor pulled out of a narrative text. */
export interface FigureClaim {
  kind: 'amount' | 'percent' | 'age';
  /** Numeric value: SGD for amounts, percentage points for percents, years for ages. */
  value: number;
  /** The exact substring the claim was read from, for tests and debugging. */
  raw: string;
}

/**
 * Dollar amounts: an S$ or $ sign (the deterministic fmtSgd writes "$4,393",
 * goal names write "S$600k") followed by digits with optional grouping commas
 * and decimals. Bare numbers without a sign are deliberately NOT claims: they
 * are years, months and counts the plan prose legitimately contains.
 */
const AMOUNT_PATTERN = /(?:S\$|\$)\s?(\d[\d,]*(?:\.\d+)?)/g;
/** Percentages: digits (optionally decimal) before %, "percent" or "per cent". */
const PERCENT_PATTERN = /(\d+(?:\.\d+)?)\s*(?:%|percent|per\s?cent)/g;
/** Standalone ages: the word "age" or "aged" followed by the number. */
const AGE_PATTERN = /\bage[d]?\s+(\d{1,3})\b/g;

/**
 * Every figure claim in a text: dollar amounts, percentages and standalone
 * ages. Formula: union of the three pattern matches above, each parsed with
 * grouping commas stripped. A text with none of the three patterns makes no
 * claims and is trivially valid.
 */
export function extractFigureClaims(text: string): FigureClaim[] {
  const claims: FigureClaim[] = [];
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const value = Number.parseFloat(match[1].replace(/,/g, ''));
    if (Number.isFinite(value)) {
      claims.push({ kind: 'amount', value, raw: match[0] });
    }
  }
  for (const match of text.matchAll(PERCENT_PATTERN)) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value)) {
      claims.push({ kind: 'percent', value, raw: match[0] });
    }
  }
  for (const match of text.matchAll(AGE_PATTERN)) {
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value)) {
      claims.push({ kind: 'age', value, raw: match[0] });
    }
  }
  return claims;
}

/**
 * True when every figure claim in text is covered by the allowed set.
 * Formula: valid = for every claim c there is an allowed a with
 * |c.value - a| <= tolerance * max(|a|, 1), where tolerance is relative with
 * an absolute floor of one unit so near-zero allowed values still match. The
 * floor keeps the check strict: a figure must be within tolerance of a real
 * plan figure, never merely small.
 */
export function narrativeFiguresValid(
  text: string,
  allowed: ReadonlySet<number> | ReadonlyArray<number>,
  tolerance = 0.005
): boolean {
  const values = [...allowed];
  return extractFigureClaims(text).every((claim) =>
    values.some((value) => Math.abs(claim.value - value) <= tolerance * Math.max(Math.abs(value), 1))
  );
}

/**
 * Recursively collects every finite number reachable in a value into the set,
 * together with its formatted variants: the rounded integer, the two-decimal
 * form, the percent-point form (value * 100) and the ratio form (value / 100)
 * so "1.8 percent" matches a 0.018 rate field whichever way it was written.
 */
function collectNumbers(value: unknown, into: Set<number>): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    into.add(value);
    into.add(Math.round(value));
    into.add(Number(value.toFixed(2)));
    into.add(value * 100);
    into.add(value / 100);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNumbers(item, into);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectNumbers(entry, into);
    }
  }
}

/** Every string field of a plan, joined for figure-claim harvesting. */
function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, into);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStrings(entry, into);
    }
  }
}

/**
 * The allowed figure set for one plan: every numeric field of the plan (rates,
 * ratios, dollar amounts, ages, scenario deltas and assumption values) with
 * formatted variants, plus every figure already written in the plan's own
 * deterministic strings. Those strings are themselves deterministic engine
 * output: figures like the summed contributions or the CPF deduction appear
 * in the prose the model is asked to rewrite, so they are plan figures by
 * construction and must be copyable verbatim. Anything the model writes that
 * matches neither set is an invented figure.
 */
export function allowedPlanFigures(plan: PlanJSON): Set<number> {
  const allowed = new Set<number>();
  collectNumbers(plan, allowed);
  const strings: string[] = [];
  collectStrings(plan, strings);
  for (const claim of extractFigureClaims(strings.join('\n'))) {
    allowed.add(claim.value);
  }
  return allowed;
}

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
 * Nebius is unconfigured, the fetcher fails, the reply does not validate, or
 * the reply contains a figure the deterministic plan never produced;
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
  const allowed = allowedPlanFigures(plan);
  const figuresValid =
    narrativeFiguresValid(reply.verdictReasoning, allowed) &&
    reply.teachingBodies.every((body) => narrativeFiguresValid(body, allowed));
  if (!figuresValid) {
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
