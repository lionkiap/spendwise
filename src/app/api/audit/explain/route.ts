/**
 * POST /api/audit/explain: optional LLM rephrasing of wallet audit misses.
 *
 * Takes { misses: AuditMiss[], monthKey, cardNames } and returns
 * { engine, explanations }. The engine field says which path produced the
 * wording: "ultra" when Nemotron Ultra on Nebius Token Factory returned a
 * validated explanation per miss, "deterministic" when it did not, in which
 * case explanations is null and the client falls back to the miss.why it
 * already holds. Every figure in any explanation originates from the
 * deterministic audit the caller posted, never from the model. Invalid bodies
 * get a 400 that says what a usable request looks like.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { explainMisses } from '../../../../lib/cards/explain';

const auditMissSchema = z.object({
  index: z
    .number({ invalid_type_error: 'index must be a number' })
    .int('index must be a whole number')
    .min(0, 'index must be 0 or more'),
  usedCardId: z.string({ invalid_type_error: 'usedCardId must be a string' }).min(1, 'usedCardId must not be empty'),
  bestCardId: z.string({ invalid_type_error: 'bestCardId must be a string' }).min(1, 'bestCardId must not be empty'),
  lostSgd: z.number({ invalid_type_error: 'lostSgd must be a number' }),
  why: z.string({ invalid_type_error: 'why must be a string' }).min(1, 'why must not be empty'),
});

const explainRequestSchema = z.object({
  misses: z.array(auditMissSchema, {
    invalid_type_error: 'misses must be a list of audit misses',
  }),
  monthKey: z
    .string({ invalid_type_error: 'monthKey must be a string' })
    .regex(/^\d{4}-\d{2}$/, 'monthKey must look like "YYYY-MM", for example 2025-03'),
  cardNames: z.record(
    z.string({ invalid_type_error: 'cardNames keys must be card id strings' }),
    z.string({ invalid_type_error: 'cardNames values must be display name strings' })
  ),
});

function badRequest(error: string, issues?: string[]): Response {
  return NextResponse.json({ error, issues: issues ?? [] }, { status: 400 });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest(
      'Request body must be JSON shaped like { "misses": AuditMiss[], "monthKey": "YYYY-MM", "cardNames": Record<string, string> }.'
    );
  }

  const parsed = explainRequestSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      'Invalid request body. Expected { "misses": [{ index, usedCardId, bestCardId, lostSgd, why }], "monthKey": "YYYY-MM", "cardNames": { "card-id": "display name" } }.',
      parsed.error.issues.map(
        (issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'body'}: ${issue.message}`
      )
    );
  }

  const { misses, monthKey, cardNames } = parsed.data;

  try {
    const result = await explainMisses(misses, { monthKey, cardNames });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: `Explain failed: ${error instanceof Error ? error.message : 'unknown error'}.` },
      { status: 500 }
    );
  }
}
