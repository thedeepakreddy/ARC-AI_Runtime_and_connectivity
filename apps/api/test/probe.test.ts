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
    expect(r).toMatchObject({ status: 'healthy', models: ['a', 'b'] });
    expect(seen.url).toBe('https://api.example.test/v1/models');
    expect(seen.headers?.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('keeps what the listing says about each model (OpenRouter prices and inputs)', async () => {
    const listing = {
      data: [
        {
          id: 'meta/llama:free',
          pricing: { prompt: '0', completion: '0' },
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
          supported_parameters: ['tools', 'response_format'],
        },
      ],
    };
    const r = await new HttpProviderProbe(fakeFetch(200, listing)).probe(input());
    expect(r.hints?.['meta/llama:free']).toEqual({
      pricing: { prompt: '0', completion: '0' },
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      supportedParameters: ['tools', 'response_format'],
    });
  });

  it("checks a Cohere key with Cohere's model list and keeps what each model serves", async () => {
    const seen: { url?: string; headers?: Headers } = {};
    const listing = {
      models: [
        {
          name: 'command-a-03-2025',
          endpoints: ['generate', 'chat'],
          features: ['tool_use', 'json_schema'],
        },
        { name: 'command-a-vision-07-2025', endpoints: ['chat'], features: ['vision'] },
        { name: 'embed-v4.0', endpoints: ['embed'] },
        { name: 'rerank-v3.5', endpoints: ['rerank'] },
      ],
    };
    const r = await new HttpProviderProbe(fakeFetch(200, listing, seen)).probe(
      input({ providerId: 'cohere', adapter: 'litellm_native', baseUrl: null }),
    );
    expect(seen.url).toBe('https://api.cohere.com/v1/models?page_size=1000');
    expect(seen.headers?.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(r).toMatchObject({
      status: 'healthy',
      models: ['command-a-03-2025', 'command-a-vision-07-2025', 'embed-v4.0', 'rerank-v3.5'],
    });
    expect(r.hints?.['command-a-03-2025']).toMatchObject({
      methods: ['generate', 'chat'],
      supportedParameters: ['tools', 'response_format'],
    });
    expect(r.hints?.['command-a-vision-07-2025']?.inputModalities).toEqual(['text', 'image']);
  });

  it('a rejected Cohere key is reported as invalid', async () => {
    const r = await new HttpProviderProbe(fakeFetch(401, {})).probe(
      input({ providerId: 'cohere', adapter: 'litellm_native', baseUrl: null }),
    );
    expect(r.status).toBe('invalid_credentials');
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
      (await probe.probe(input({ providerId: 'elevenlabs', adapter: 'litellm_native' }))).status,
    ).toBe('unsupported');
  });
});
