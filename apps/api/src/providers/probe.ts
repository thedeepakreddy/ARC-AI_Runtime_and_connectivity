/**
 * Credential probes: check a provider key works and list the models it can see.
 * Probes run on explicit validation (and later from the worker), never on the inference path.
 * Errors never include the key.
 */
export type ProbeStatus =
  'healthy' | 'rate_limited' | 'invalid_credentials' | 'unreachable' | 'unsupported';

export interface ProbeInput {
  providerId: string;
  adapter: 'litellm_native' | 'openai_compatible';
  baseUrl: string | null;
  apiKey: string;
  signal: AbortSignal;
}

export interface ProbeResult {
  status: ProbeStatus;
  models: string[];
  error?: string;
}

export interface ProviderProbe {
  probe(input: ProbeInput): Promise<ProbeResult>;
}

const MAX_MODELS = 2000;

function classifyHttp(status: number): ProbeResult | null {
  if (status === 401 || status === 403) {
    return { status: 'invalid_credentials', models: [], error: `provider responded ${status}` };
  }
  if (status === 429)
    return { status: 'rate_limited', models: [], error: 'provider responded 429' };
  if (status >= 400)
    return { status: 'unreachable', models: [], error: `provider responded ${status}` };
  return null;
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

export class HttpProviderProbe implements ProviderProbe {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async probe(input: ProbeInput): Promise<ProbeResult> {
    try {
      if (input.providerId === 'gemini') return await this.gemini(input);
      if (input.adapter === 'openai_compatible') {
        if (!input.baseUrl) {
          return {
            status: 'unsupported',
            models: [],
            error: 'no base URL configured for this key',
          };
        }
        return await this.openAiCompatible(input, input.baseUrl);
      }
      return {
        status: 'unsupported',
        models: [],
        error: 'no validation adapter for this provider yet',
      };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return { status: 'unreachable', models: [], error: aborted ? 'timed out' : 'network error' };
    }
  }

  private async openAiCompatible(input: ProbeInput, baseUrl: string): Promise<ProbeResult> {
    const res = await this.fetchImpl(`${trimBase(baseUrl)}/models`, {
      headers: { authorization: `Bearer ${input.apiKey}`, accept: 'application/json' },
      signal: input.signal,
    });
    const failure = classifyHttp(res.status);
    if (failure) {
      await res.body?.cancel();
      return failure;
    }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const models = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string');
    return { status: 'healthy', models: models.slice(0, MAX_MODELS) };
  }

  private async gemini(input: ProbeInput): Promise<ProbeResult> {
    const base = trimBase(input.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta');
    const res = await this.fetchImpl(`${base}/models?pageSize=1000`, {
      headers: { 'x-goog-api-key': input.apiKey, accept: 'application/json' },
      signal: input.signal,
    });
    const failure = classifyHttp(res.status === 400 ? 401 : res.status);
    if (failure) {
      await res.body?.cancel();
      return failure;
    }
    const body = (await res.json()) as { models?: Array<{ name?: unknown }> };
    const models = (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string')
      .map((n) => n.replace(/^models\//, ''));
    return { status: 'healthy', models: models.slice(0, MAX_MODELS) };
  }
}
