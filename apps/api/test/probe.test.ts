import { describe, expect, it } from 'vitest';
import { HttpProviderProbe, type ProbeInput } from '../src/providers/probe.js';

const KEY = 'sk-test-secret-value-123';

function fakeFetch(status: number, body: unknown, seen: { url?: string; headers?: Headers } = {}) {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.url = String(url);
    seen.headers = new Headers(init?.headers);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

const input = (over: Partial<ProbeInput> = {}): ProbeInput => ({
  providerId: 'groq',
  adapter: 'openai_compatible',
  baseUrl: 'https://api.example.test/v1/',
  apiKey: KEY,
  signal: new AbortController().signal,
  ...over,
});

describe('HttpProviderProbe', () => {
  it('lists models from an OpenAI-compatible /models endpoint', async () => {
    const seen: { url?: string; headers?: Headers } = {};
    const probe = new HttpProviderProbe(fakeFetch(200, { data: [{ id: 'a' }, { id: 'b' }] }, seen));
    const r = await probe.probe(input());
    expect(r).toEqual({ status: 'healthy', models: ['a', 'b'] });
    expect(seen.url).toBe('https://api.example.test/v1/models');
    expect(seen.headers?.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it.each([
    [401, 'invalid_credentials'],
    [403, 'invalid_credentials'],
    [429, 'rate_limited'],
    [500, 'unreachable'],
  ])('classifies HTTP %i as %s and never leaks the key', async (status, expected) => {
    const r = await new HttpProviderProbe(fakeFetch(status, {})).probe(input());
    expect(r.status).toBe(expected);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('reports network failures as unreachable', async () => {
    const failing = (async () => {
      throw new TypeError(`fetch failed for ${KEY}`);
    }) as typeof fetch;
    const r = await new HttpProviderProbe(failing).probe(input());
    expect(r.status).toBe('unreachable');
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('uses the Gemini models API with the key in a header', async () => {
    const seen: { url?: string; headers?: Headers } = {};
    const probe = new HttpProviderProbe(
      fakeFetch(200, { models: [{ name: 'models/gemini-x' }] }, seen),
    );
    const r = await probe.probe(
      input({ providerId: 'gemini', adapter: 'litellm_native', baseUrl: null }),
    );
    expect(r.models).toEqual(['gemini-x']);
    expect(seen.url).not.toContain(KEY);
    expect(seen.headers?.get('x-goog-api-key')).toBe(KEY);
  });

  it('is unsupported without a base URL or adapter', async () => {
    const probe = new HttpProviderProbe(fakeFetch(200, {}));
    expect((await probe.probe(input({ baseUrl: null }))).status).toBe('unsupported');
    expect(
      (await probe.probe(input({ providerId: 'cohere', adapter: 'litellm_native' }))).status,
    ).toBe('unsupported');
  });
});
