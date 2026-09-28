/**
 * Plain-language explanations for wallet audit misses.
 *
 * The deterministic engine already explains every miss (AuditMiss.why), so the
 * LLM here is polish, never a dependency: explainMisses asks Nemotron Ultra on
 * Nebius Token Factory to rephrase the misses and falls straight back to the
 * deterministic result whenever the model is unconfigured, unreachable or
 * replies with anything other than exactly one explanation per miss. It never
 * throws and never produces a number of its own; every figure comes verbatim
 * from the deterministic context it was handed.
 */
import { z } from 'zod';

import { chatJson, ultraModel } from '../nebius';
import type { AuditMiss } from './engine';

/** Injectable model call, so tests stub it and no test ever touches the network. */
export type ExplanationFetcher = (
  system: string,
  user: string,
  model: string
) => Promise<Record<string, unknown> | null>;

export interface ExplainMissesContext {
  monthKey: string;
  cardNames: Record<string, string>;
}

export interface ExplainMissesResult {
  engine: 'ultra' | 'deterministic';
  /** null means "no LLM wording available; render AuditMiss.why instead". */
  explanations: string[] | null;
}

/** The model reply contract: nothing but a list of explanations. */
const explanationReplySchema = z.object({
  explanations: z
    .array(z.string({ invalid_type_error: 'each explanation must be a string' }).trim().min(1))
    .min(1, 'explanations must not be empty'),
});

const SYSTEM_PROMPT = [
  'You are the wallet auditor of SpendWise, a Singapore credit card rewards app.',
  'You receive one JSON object describing purchases that earned less than the best available card would have paid.',
  'Explain each miss in plain language a non-finance user can act on.',
  'Rules:',
  '- Reply with ONLY one JSON object of the shape {"explanations": [string, ...]} and no other text.',
  '- explanations must contain exactly one entry per input miss, in the same order as the input.',
  '- Copy every figure (amounts, rates, caps and lost value) verbatim from the provided data. Never round, never invent or recompute a number.',
  '- Name the cards by the provided card names, keep each explanation to at most two sentences and never recommend products.',
].join('\n');

function nameOf(context: ExplainMissesContext, cardId: string): string {
  return context.cardNames[cardId] ?? cardId;
}

/** Compact JSON context of the misses and card names, in stable insertion order. */
function buildUserPrompt(misses: AuditMiss[], context: ExplainMissesContext): string {
  return JSON.stringify({
    monthKey: context.monthKey,
    cardNames: context.cardNames,
    misses: misses.map((miss) => ({
      index: miss.index,
      usedCardId: miss.usedCardId,
      usedCardName: nameOf(context, miss.usedCardId),
      bestCardId: miss.bestCardId,
      bestCardName: nameOf(context, miss.bestCardId),
      lostSgd: miss.lostSgd,
      engineNote: miss.why,
    })),
  });
}

function deterministic(): ExplainMissesResult {
  return { engine: 'deterministic', explanations: null };
}

/**
 * Try to rephrase the audit misses with Nemotron Ultra. The fetcher defaults to
 * the real chatJson, which returns null on its own when no NEBIUS_API_KEY is
 * configured, so an unconfigured environment degrades to the deterministic
 * result with no network attempt. Shape and length are validated before the
 * reply is trusted: anything short of exactly one nonempty explanation per
 * miss, and any thrown error, returns the deterministic result. Never throws.
 */
export async function explainMisses(
  misses: AuditMiss[],
  context: { monthKey: string; cardNames: Record<string, string> },
  fetcher: ExplanationFetcher = chatJson
): Promise<ExplainMissesResult> {
  if (misses.length === 0) {
    return deterministic();
  }

  try {
    const raw = await fetcher(SYSTEM_PROMPT, buildUserPrompt(misses, context), ultraModel());
    if (raw === null) {
      return deterministic();
    }
    const reply = explanationReplySchema.safeParse(raw);
    if (!reply.success || reply.data.explanations.length !== misses.length) {
      return deterministic();
    }
    return { engine: 'ultra', explanations: reply.data.explanations };
  } catch {
    return deterministic();
  }
}
