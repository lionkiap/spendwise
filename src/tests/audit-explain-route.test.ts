import { describe, expect, it } from 'vitest';

import { POST } from '../app/api/audit/explain/route';

const URL = 'http://localhost/api/audit/explain';

function post(body: string): Promise<Response> {
  return POST(
    new Request(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  );
}

describe('POST /api/audit/explain', () => {
  it('returns 400 with a helpful message for a body missing required fields', async () => {
    const response = await post('{}');
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string; issues?: string[] };
    expect(payload.error).toContain('Invalid request body');
    expect(payload.issues?.join(' | ')).toContain('misses');
    expect(payload.issues?.join(' | ')).toContain('monthKey');
  });

  it('returns 400 for a non-JSON body', async () => {
    const response = await post('not json at all');
    expect(response.status).toBe(400);
  });

  it('returns 200 with the deterministic engine and null explanations when no key is configured', async () => {
    const previous = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    try {
      const response = await post(
        JSON.stringify({
          monthKey: '2025-03',
          cardNames: { 'uob-one': 'UOB One Card', 'hsbc-live-plus': 'HSBC Live+ Card' },
          misses: [
            {
              index: 0,
              usedCardId: 'uob-one',
              bestCardId: 'hsbc-live-plus',
              lostSgd: 7.0,
              why: 'S$100.00 on dining: UOB One Card earned S$1.00; best card hsbc-live-plus would have earned S$8.00',
            },
          ],
        })
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ engine: 'deterministic', explanations: null });
    } finally {
      if (previous !== undefined) {
        process.env.NEBIUS_API_KEY = previous;
      }
    }
  });
});
