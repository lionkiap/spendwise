/**
 * Nebius Token Factory client wrapper.
 *
 * The openai SDK speaks the OpenAI wire protocol, which the Nebius Token
 * Factory endpoint implements. Everything here fails soft: callers receive
 * null instead of an exception so the planner can fall back to its offline
 * heuristic parser and the demo never dies.
 */
import OpenAI from 'openai';

const DEFAULT_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';

/** Illustrative model ids mirroring .env.example; override them by env. */
const DEFAULT_ULTRA_MODEL = 'nvidia/llama-3.1-nemotron-ultra-253b-v1';
const DEFAULT_SUPER_MODEL = 'nvidia/llama-3.3-nemotron-super-49b-v1.5';
const DEFAULT_NANO_MODEL = 'nvidia/nemotron-nano-9b-v2';

function envValue(key: string): string | undefined {
  const raw = process.env[key];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** True when a Nebius API key is present, so an LLM call is worth attempting. */
export function isConfigured(): boolean {
  return envValue('NEBIUS_API_KEY') !== undefined;
}

/** Largest reasoning model, for the hardest planning calls. */
export function ultraModel(): string {
  return envValue('NEMOTRON_ULTRA_MODEL') ?? DEFAULT_ULTRA_MODEL;
}

/** Mid size model, the default workhorse for structured parsing. */
export function superModel(): string {
  return envValue('NEMOTRON_SUPER_MODEL') ?? DEFAULT_SUPER_MODEL;
}

/** Small fast model, for cheap calls on the happy path. */
export function nanoModel(): string {
  return envValue('NEMOTRON_NANO_MODEL') ?? DEFAULT_NANO_MODEL;
}

/** Outcome of a Nebius health check. */
export type NebiusHealth = 'verified' | 'configured' | 'unconfigured';

/**
 * Injectable model access for pingNebius so tests stub the network boundary.
 * Same shape as chatJson.
 */
export type NebiusPingFetcher = (
  system: string,
  user: string,
  model: string
) => Promise<Record<string, unknown> | null>;

/**
 * Health check on the Nebius Token Factory endpoint with the smallest model.
 * Formula: 'unconfigured' when no API key exists; otherwise one tiny chatJson
 * call on the nano model, 'verified' when it returns a parsable JSON object
 * and 'configured' when it returns null or throws. Never throws: every
 * failure mode collapses to 'configured', meaning the key is present but the
 * endpoint is not currently answering.
 */
export async function pingNebius(fetcher: NebiusPingFetcher = chatJson): Promise<NebiusHealth> {
  if (!isConfigured()) {
    return 'unconfigured';
  }
  try {
    const reply = await fetcher(
      'Reply with ONLY the JSON object {"ok":true} and no other text.',
      'Health check. Reply with {"ok":true}.',
      nanoModel()
    );
    return reply !== null ? 'verified' : 'configured';
  } catch {
    return 'configured';
  }
}

function client(): OpenAI | null {
  const apiKey = envValue('NEBIUS_API_KEY');
  if (!apiKey) {
    return null;
  }
  return new OpenAI({
    apiKey,
    baseURL: envValue('NEBIUS_BASE_URL') ?? DEFAULT_BASE_URL,
    maxRetries: 1,
    timeout: 20_000,
  });
}

/**
 * Pulls the first JSON object out of a model reply, tolerating markdown
 * fences and reasoning prefixes such as think tags. Returns null when
 * nothing parseable remains.
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const candidates = [trimmed, unfenced];
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(unfenced.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to the next candidate
    }
  }
  return null;
}

/**
 * One chat turn that must answer with a JSON object.
 *
 * Requests strict JSON first (response_format json_object) and retries once
 * without it when the endpoint rejects the option. Returns null on any
 * failure instead of throwing, so callers can always fall back offline.
 */
export async function chatJson(
  system: string,
  user: string,
  model: string
): Promise<Record<string, unknown> | null> {
  const nebius = client();
  if (!nebius) {
    return null;
  }
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  try {
    const completion = await nebius.chat.completions.create({
      model,
      messages,
      temperature: 0,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
    });
    return extractJsonObject(completion.choices[0]?.message?.content ?? '');
  } catch {
    try {
      const completion = await nebius.chat.completions.create({
        model,
        messages,
        temperature: 0,
        max_tokens: 1200,
      });
      return extractJsonObject(completion.choices[0]?.message?.content ?? '');
    } catch {
      return null;
    }
  }
}
