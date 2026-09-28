/**
 * GET /api/status: tells the client whether Nemotron on Nebius Token Factory
 * is reachable and which model ids the three tiers resolve to.
 *
 * Returns { nebiusConfigured, models: { ultra, super, nano } }. The API key
 * itself never leaves the server: only the boolean and the public model ids
 * are returned, so the response can never leak NEBIUS_API_KEY. Marked
 * force-dynamic so a build-time prerender can never freeze the answer.
 */
import { NextResponse } from 'next/server';

import { isConfigured, nanoModel, superModel, ultraModel } from '../../../lib/nebius';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return NextResponse.json({
    nebiusConfigured: isConfigured(),
    models: {
      ultra: ultraModel(),
      super: superModel(),
      nano: nanoModel(),
    },
  });
}
