import { describe, expect, it } from 'vitest';
import { type Candidate, passesPolicy, selectCandidate } from '../src/inference/candidates.js';
import { litellmTarget } from '../src/inference/gateway.js';
import {
  chatPassthrough,
  chatRequestSchema,
  requiredChatCapabilities,
} from '../src/inference/schemas.js';

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
    ...over,
  };
}

describe('policy gate', () => {
  it('owner keys: free only', () => {
    expect(passesPolicy(cand({ eligibility: 'VERIFIED_FREE' }))).toBe(true);
    expect(passesPolicy(cand({ eligibility: 'RESTRICTED_FREE' }))).toBe(true);
    expect(passesPolicy(cand({ eligibility: 'PAID' }))).toBe(false);
    expect(passesPolicy(cand({ eligibility: 'UNKNOWN' }))).toBe(false);
  });
  it('customer BYOK keys: paid allowed, unknown never', () => {
    expect(passesPolicy(cand({ scope: 'tenant_byok', eligibility: 'PAID' }))).toBe(true);
    expect(passesPolicy(cand({ scope: 'tenant_byok', eligibility: 'UNKNOWN' }))).toBe(false);
  });
});

describe('selectCandidate', () => {
  const need = new Set(['text'] as const);

  it('resolves explicit provider/model names, including ids that contain "/"', () => {
    const c = cand({ providerId: 'openrouter', modelId: 'meta-llama/llama-3:free' });
    const sel = selectCandidate([c], 'openrouter/meta-llama/llama-3:free', need);
    expect('chosen' in sel && sel.chosen).toBe(c);
  });

  it('returns unknown_model for names it does not route', () => {
    expect(selectCandidate([cand()], 'groq/other', need)).toEqual({ reason: 'unknown_model' });
    expect(selectCandidate([cand()], 'no-provider-prefix', need)).toEqual({
      reason: 'unknown_model',
    });
  });

  it('prefers a healthy key over one with unknown or rate-limited health', () => {
    const a = cand({ accountId: 'a', health: 'rate_limited' });
    const b = cand({ accountId: 'b', health: 'unknown' });
    const c = cand({ accountId: 'c', health: 'healthy' });
    const sel = selectCandidate([a, b, c], 'groq/llama', need);
    expect('chosen' in sel && sel.chosen.accountId).toBe('c');
    expect('chosen' in sel && sel.alternatives).toBe(2);
  });

  it('never picks invalid keys or blocked models', () => {
    const sel = selectCandidate(
      [cand({ health: 'invalid_credentials' }), cand({ accountId: 'p', eligibility: 'PAID' })],
      'auto',
      need,
    );
    expect(sel).toMatchObject({ reason: 'no_eligible_key' });
  });

  it('matches required capabilities and reports what is missing', () => {
    const textOnly = cand({ capabilities: new Set(['text']) });
    const vision = cand({
      accountId: 'v',
      modelId: 'vision',
      capabilities: new Set(['text', 'vision']),
    });
    const sel = selectCandidate([textOnly, vision], 'auto', new Set(['text', 'vision'] as const));
    expect('chosen' in sel && sel.chosen.modelId).toBe('vision');
    expect(selectCandidate([textOnly], 'auto', new Set(['text', 'tools'] as const))).toEqual({
      reason: 'capability_missing',
      missing: ['tools'],
    });
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
    const out = chatPassthrough(body);
    expect(out).toEqual({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 });
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
