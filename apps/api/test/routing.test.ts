import { describe, expect, it } from 'vitest';
import {
  type Candidate,
  DEFAULT_POLICY,
  type RankInput,
  passesPolicy,
  rankCandidates,
} from '../src/inference/candidates.js';
import { Cooldowns, parseRetryAfter } from '../src/inference/cooldowns.js';
import { litellmTarget } from '../src/inference/gateway.js';
import { ObservationRecorder } from '../src/inference/observations.js';
import {
  chatPassthrough,
  chatRequestSchema,
  requiredChatCapabilities,
} from '../src/inference/schemas.js';
import { NEUTRAL_EXPECTED_MS, scoreRoute } from '../src/inference/scoring.js';
import type { Db } from '../src/db/pool.js';

function cand(over: Partial<Candidate> = {}): Candidate {
  return {
    modelUuid: 'm1',
    providerId: 'groq',
    modelId: 'llama',
    capabilities: new Set(['text', 'streaming']),
    eligibility: 'VERIFIED_FREE',
    accountId: 'a1',
    scope: 'owner_private',
    health: 'healthy',
    baseUrl: null,
    defaultBaseUrl: 'https://api.groq.example/v1',
    litellmProvider: 'groq',
    jurisdiction: 'US',
    credentialId: 'c1',
    sealed: { kekVersion: 1, wrappedDek: Buffer.alloc(0), ciphertext: Buffer.alloc(0) },
    expectedMs: NEUTRAL_EXPECTED_MS,
    samples: 0,
    ...over,
  };
}

const input = (over: Partial<RankInput> = {}): RankInput => ({
  requested: 'auto',
  need: new Set(['text']),
  policy: DEFAULT_POLICY,
  cooldown: () => null,
  ...over,
});

const planIds = (r: ReturnType<typeof rankCandidates>) =>
  'plan' in r ? r.plan.map((c) => c.accountId) : r;

describe('policy gate', () => {
  it('owner keys: free only, unless the owner allowed paid', () => {
    expect(passesPolicy(cand({ eligibility: 'VERIFIED_FREE' }))).toBe(true);
    expect(passesPolicy(cand({ eligibility: 'RESTRICTED_FREE' }))).toBe(true);
    expect(passesPolicy(cand({ eligibility: 'PAID' }))).toBe(false);
    expect(
      passesPolicy(cand({ eligibility: 'PAID' }), { ...DEFAULT_POLICY, allowPaidOwnerKeys: true }),
    ).toBe(true);
    expect(
      passesPolicy(cand({ eligibility: 'UNKNOWN' }), {
        ...DEFAULT_POLICY,
        allowPaidOwnerKeys: true,
      }),
    ).toBe(false);
  });
  it('customer BYOK keys: paid allowed, unknown never', () => {
    expect(passesPolicy(cand({ scope: 'tenant_byok', eligibility: 'PAID' }))).toBe(true);
    expect(passesPolicy(cand({ scope: 'tenant_byok', eligibility: 'UNKNOWN' }))).toBe(false);
  });
});

describe('rankCandidates', () => {
  it('resolves explicit provider/model names, including ids that contain "/"', () => {
    const c = cand({ providerId: 'openrouter', modelId: 'meta-llama/llama-3:free' });
    expect(
      planIds(rankCandidates([c], input({ requested: 'openrouter/meta-llama/llama-3:free' }))),
    ).toEqual(['a1']);
  });

  it('returns unknown_model for names it does not route', () => {
    expect(rankCandidates([cand()], input({ requested: 'groq/other' }))).toMatchObject({
      reason: 'unknown_model',
    });
    expect(rankCandidates([cand()], input({ requested: 'no-prefix' }))).toMatchObject({
      reason: 'unknown_model',
    });
  });

  it('orders by health, then free before paid, then measured expected latency', () => {
    const r = rankCandidates(
      [
        cand({ accountId: 'unknown-fast', health: 'unknown', expectedMs: 50 }),
        cand({ accountId: 'paid-fast', scope: 'tenant_byok', eligibility: 'PAID', expectedMs: 10 }),
        cand({ accountId: 'free-slow', expectedMs: 900 }),
        cand({ accountId: 'free-fast', expectedMs: 100 }),
      ],
      input(),
    );
    expect(planIds(r)).toEqual(['free-fast', 'free-slow', 'paid-fast', 'unknown-fast']);
  });

  it('plans fallback: same model on other keys first, then other compatible models', () => {
    const r = rankCandidates(
      [
        cand({ accountId: 'b-model2', modelUuid: 'm2', modelId: 'mixtral', expectedMs: 200 }),
        cand({ accountId: 'a-best', expectedMs: 100 }),
        cand({ accountId: 'c-same-slow', expectedMs: 900 }),
      ],
      input(),
    );
    expect(planIds(r)).toEqual(['a-best', 'c-same-slow', 'b-model2']);
  });

  it('rejects by jurisdiction policy and explains why', () => {
    const r = rankCandidates(
      [cand({ accountId: 'cn', jurisdiction: 'CN' }), cand({ accountId: 'us' })],
      input({ policy: { allowedJurisdictions: new Set(['US']), allowPaidOwnerKeys: false } }),
    );
    expect(planIds(r)).toEqual(['us']);
    expect('plan' in r && r.rejected).toEqual({ rejected_jurisdiction: 1 });
    expect('plan' in r && r.verdicts.find((v) => v.accountId === 'cn')).toMatchObject({
      verdict: 'rejected_jurisdiction',
      detail: 'CN',
    });
  });

  it('skips keys in cooldown and invalid keys', () => {
    const r = rankCandidates(
      [
        cand({ accountId: 'cool' }),
        cand({ accountId: 'bad', health: 'invalid_credentials' }),
        cand({ accountId: 'ok' }),
      ],
      input({ cooldown: (id) => (id === 'cool' ? 'rate_limited' : null) }),
    );
    expect(planIds(r)).toEqual(['ok']);
    expect('plan' in r && r.rejected).toEqual({ rejected_cooldown: 1, rejected_health: 1 });
  });

  it('reports missing capabilities, or no eligible key when other gates also failed', () => {
    expect(rankCandidates([cand()], input({ need: new Set(['text', 'tools']) }))).toMatchObject({
      reason: 'capability_missing',
      missing: ['tools'],
    });
    expect(rankCandidates([cand({ eligibility: 'PAID' })], input())).toMatchObject({
      reason: 'no_eligible_key',
    });
  });
});

describe('scoring', () => {
  it('treats an unmeasured route as neutral and rewards speed and reliability', () => {
    const none = scoreRoute({ requests: 0, successes: 0, ttfbMsSum: 0, ttfbSamples: 0 });
    expect(none.expectedMs).toBeCloseTo(NEUTRAL_EXPECTED_MS);
    const fast = scoreRoute({
      requests: 100,
      successes: 100,
      ttfbMsSum: 100 * 200,
      ttfbSamples: 100,
    });
    const slow = scoreRoute({
      requests: 100,
      successes: 100,
      ttfbMsSum: 100 * 800,
      ttfbSamples: 100,
    });
    const flaky = scoreRoute({
      requests: 100,
      successes: 60,
      ttfbMsSum: 60 * 200,
      ttfbSamples: 60,
    });
    expect(fast.expectedMs).toBeLessThan(slow.expectedMs);
    expect(fast.expectedMs).toBeLessThan(flaky.expectedMs);
    expect(fast.expectedMs).toBeLessThan(none.expectedMs);
  });
  it('does not let a couple of samples dominate', () => {
    const lucky = scoreRoute({ requests: 2, successes: 2, ttfbMsSum: 20, ttfbSamples: 2 });
    expect(lucky.avgTtfbMs).toBeGreaterThan(1000);
  });
});

describe('cooldowns', () => {
  it('respects Retry-After, capped, and recovers', () => {
    let now = 0;
    const c = new Cooldowns(() => now);
    c.rateLimited('k', 10);
    expect(c.get('k')).toBe('rate_limited');
    now = 11_000;
    expect(c.get('k')).toBeNull();
    c.rateLimited('k', 99_999);
    now += 301_000;
    expect(c.get('k')).toBeNull();
  });
  it('cools a key down only after repeated transient failures', () => {
    const c = new Cooldowns(() => 0);
    c.failed('k');
    c.failed('k');
    expect(c.get('k')).toBeNull();
    c.failed('k');
    expect(c.get('k')).toBe('failing');
    c.succeeded('j');
  });
  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('7')).toBe(7);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('ObservationRecorder', () => {
  it('aggregates in memory and writes one batch; never throws when the database fails', async () => {
    const queries: unknown[][] = [];
    let fail = false;
    const db = {
      query: async (_sql: string, params: unknown[]) => {
        if (fail) throw new Error('db down');
        queries.push(params);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Db;
    const rec = new ObservationRecorder(db, 60_000);
    rec.record('acct', 'model', 'success', 100);
    rec.record('acct', 'model', 'success', 300);
    rec.record('acct', 'model', 'rate_limited');
    await rec.flush();
    expect(queries).toHaveLength(1);
    const [, , , requests, successes, rateLimited, , , ttfbSum, ttfbSamples] =
      queries[0] as number[][];
    expect([requests![0], successes![0], rateLimited![0], ttfbSum![0], ttfbSamples![0]]).toEqual([
      3, 2, 1, 400, 2,
    ]);

    fail = true;
    rec.record('acct', 'model', 'error');
    await expect(rec.flush()).resolves.toBeUndefined();
    expect(rec.dropped).toBe(1);
  });
});

describe('request handling', () => {
  it('strips credential and routing fields a client tries to inject', () => {
    const body = chatRequestSchema.parse({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      api_key: 'stolen',
      api_base: 'https://evil.example',
      base_url: 'https://evil.example',
      metadata: { x: 1 },
      temperature: 0.2,
    });
    expect(chatPassthrough(body)).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
    });
  });

  it('derives required capabilities from the request shape', () => {
    const body = chatRequestSchema.parse({
      model: 'auto',
      stream: true,
      tools: [{ type: 'function', function: { name: 'f' } }],
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'x' },
            { type: 'image_url', image_url: { url: 'data:' } },
          ],
        },
      ],
    });
    expect([...requiredChatCapabilities(body)].sort()).toEqual([
      'streaming',
      'structured_output',
      'text',
      'tools',
      'vision',
    ]);
  });

  it('maps candidates to LiteLLM model strings and base URLs', () => {
    expect(litellmTarget(cand())).toEqual({ model: 'groq/llama', apiBase: undefined });
    expect(litellmTarget(cand({ baseUrl: 'https://own.example/v1' }))).toEqual({
      model: 'groq/llama',
      apiBase: 'https://own.example/v1',
    });
    expect(
      litellmTarget(
        cand({
          litellmProvider: null,
          providerId: 'siliconflow',
          defaultBaseUrl: 'https://sf.example/v1',
        }),
      ),
    ).toEqual({
      model: 'openai/llama',
      apiBase: 'https://sf.example/v1',
    });
  });
});

describe('LiteLLMGateway', () => {
  it('disables LiteLLM retries and sends the chosen key and base URL', async () => {
    const { LiteLLMGateway } = await import('../src/inference/gateway.js');
    let sent: Record<string, unknown> = {};
    let auth = '';
    const gw = new LiteLLMGateway('http://litellm.test/', 'sk-master', (async (
      _url: string,
      init: RequestInit,
    ) => {
      sent = JSON.parse(String(init.body));
      auth = new Headers(init.headers).get('authorization') ?? '';
      return new Response('{}');
    }) as typeof fetch);
    await gw.dispatch({
      endpoint: 'chat/completions',
      candidate: cand({ litellmProvider: null, defaultBaseUrl: 'https://p.example/v1' }),
      apiKey: 'provider-key',
      body: { messages: [] },
      stream: true,
      signal: new AbortController().signal,
    });
    expect(sent).toMatchObject({
      model: 'openai/llama',
      api_key: 'provider-key',
      api_base: 'https://p.example/v1',
      num_retries: 0,
      stream: true,
    });
    expect(auth).toBe('Bearer sk-master');
  });
});
