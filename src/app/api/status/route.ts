/**
 * GET /api/status: tells the client whether Nemotron on Nebius Token Factory
 * is configured and actually answering, plus which model ids the three tiers
 * resolve to.
 *
 * Returns { nebiusConfigured, connection, models: { ultra, super, nano } }
 * where connection is 'verified' (a live health check on the nano model
 * returned parsable JSON), 'configured' (a key exists but the check failed or
 * did not complete in time) or 'unconfigured' (no key). The health check runs
 * under a short timeout so a slow or unreachable endpoint can never block the
 * page: the race falls back to 'configured' and the header pill says the
 * connection is unverified. The API key itself never leaves the server; only
 * the boolean, the connection word and the public model ids are returned.
 * Marked force-dynamic so a build-time prerender can never freeze the answer.
 */
import { NextResponse } from 'next/server';

import {
  isConfigured,
  nanoModel,
  pingNebius,
  superModel,
  ultraModel,
  type NebiusHealth,
} from '../../../lib/nebius';

export const dynamic = 'force-dynamic';

/** The ping must answer within this window or the pill stays at 'configured'. */
const PING_TIMEOUT_MS = 2_500;

export async function GET(): Promise<Response> {
  const models = {
    ultra: ultraModel(),
    super: superModel(),
    nano: nanoModel(),
  };
  if (!isConfigured()) {
    return NextResponse.json({
      nebiusConfigured: false,
      connection: 'unconfigured' as NebiusHealth,
      models,
    });
  }
  // Never block the page on a slow endpoint: the timeout resolves to the
  // 'configured' fallback, meaning the key is set but unverified.
  const connection = await Promise.race([
    pingNebius(),
    new Promise<NebiusHealth>((resolve) => {
      setTimeout(() => resolve('configured'), PING_TIMEOUT_MS);
    }),
  ]);
  return NextResponse.json({
    nebiusConfigured: true,
    connection,
    models,
  });
}
