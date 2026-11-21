/**
 * Credential probes: check a provider key works and list the models it can see.
 * Probes run on explicit validation (and later from the worker), never on the inference path.
 * Errors never include the key.
 */
import type { ModelHints } from '../catalogue/classify.js';

export type ProbeStatus =
  'healthy' | 'rate_limited' | 'invalid_credentials' | 'unreachable' | 'unsupported';

export interface ProbeInput {
  providerId: string;
  adapter: 'litellm_native' | 'openai_compatible';
  baseUrl: string | null;
  apiKey: string;
  signal: AbortSignal;
}

interface OpenAiModelEntry {
  id?: unknown;
  pricing?: { prompt?: string | number | null; completion?: string | number | null };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
}

export interface ProbeResult {
  status: ProbeStatus;
  models: string[];
  /** What the provider's listing says about each model (prices, inputs, parameters). */
  hints?: Record<string, ModelHints>;
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
      if (input.providerId === 'cohere') return await this.cohere(input);
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
    const body = (await res.json()) as { data?: OpenAiModelEntry[] };
    const entries = (body.data ?? [])
      .filter((m): m is OpenAiModelEntry & { id: string } => typeof m?.id === 'string')
      .slice(0, MAX_MODELS);
    const hints: Record<string, ModelHints> = {};
    for (const m of entries) {
      // OpenRouter (and some others) publish prices and what each model accepts.
      hints[m.id] = {
        pricing: m.pricing ?? null,
        inputModalities: m.architecture?.input_modalities ?? null,
        outputModalities: m.architecture?.output_modalities ?? null,
        supportedParameters: m.supported_parameters ?? null,
      };
    }
    return { status: 'healthy', models: entries.map((m) => m.id), hints };
  }

  /**
   * Cohere's own model list: which endpoints each model serves (chat, embed, rerank) and its
   * features (tool use, JSON output, vision). Paged.
   */
  private async cohere(input: ProbeInput): Promise<ProbeResult> {
    const base = trimBase(input.baseUrl ?? 'https://api.cohere.com');
    const hints: Record<string, ModelHints> = {};
    const models: string[] = [];
    let page: string | undefined;
    for (let i = 0; i < 10 && models.length < MAX_MODELS; i++) {
      const url = `${base}/v1/models?page_size=1000${page ? `&page_token=${encodeURIComponent(page)}` : ''}`;
      const res = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${input.apiKey}`, accept: 'application/json' },
        signal: input.signal,
      });
      const failure = classifyHttp(res.status);
      if (failure) {
        await res.body?.cancel();
        return failure;
      }
      const body = (await res.json()) as {
        models?: Array<{
          name?: unknown;
          endpoints?: string[];
          features?: string[];
          supports_vision?: boolean;
        }>;
        next_page_token?: string;
      };
      for (const m of body.models ?? []) {
        if (typeof m.name !== 'string' || models.length >= MAX_MODELS) continue;
        const features = (m.features ?? []).map((f) => f.toLowerCase());
        models.push(m.name);
        hints[m.name] = {
          methods: m.endpoints ?? null,
          supportedParameters: [
            ...(features.some((f) => f.includes('tool')) ? ['tools'] : []),
            ...(features.some((f) => f.startsWith('json')) ? ['response_format'] : []),
          ],
          inputModalities:
            m.supports_vision || features.includes('vision') ? ['text', 'image'] : ['text'],
        };
      }
      page = body.next_page_token || undefined;
      if (!page) break;
    }
    return { status: 'healthy', models, hints };
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
    const body = (await res.json()) as {
      models?: Array<{ name?: unknown; supportedGenerationMethods?: string[] }>;
    };
    const entries = (body.models ?? [])
      .filter(
        (m): m is { name: string; supportedGenerationMethods?: string[] } =>
          typeof m.name === 'string',
      )
      .slice(0, MAX_MODELS);
    const hints: Record<string, ModelHints> = {};
    const models = entries.map((m) => {
      const id = m.name.replace(/^models\//, '');
      hints[id] = { methods: m.supportedGenerationMethods ?? null };
      return id;
    });
    return { status: 'healthy', models, hints };
  }
}
