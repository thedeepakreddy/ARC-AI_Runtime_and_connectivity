import type { Candidate } from './candidates.js';

export type Endpoint = 'chat/completions' | 'embeddings';

export interface DispatchInput {
  endpoint: Endpoint;
  candidate: Candidate;
  apiKey: string;
  /** Allow-listed client fields (no model/credential fields). */
  body: Record<string, unknown>;
  stream: boolean;
  signal: AbortSignal;
}

/** Executes provider calls. ARC decides what to call; the gateway only carries it out. */
export interface InferenceGateway {
  dispatch(input: DispatchInput): Promise<Response>;
}

/** Build the LiteLLM model string and optional api_base for a candidate. */
export function litellmTarget(c: Candidate): { model: string; apiBase: string | undefined } {
  if (c.litellmProvider) {
    // Native LiteLLM provider: only override the base URL when the key has its own.
    return { model: `${c.litellmProvider}/${c.modelId}`, apiBase: c.baseUrl ?? undefined };
  }
  // Generic OpenAI-compatible provider.
  return { model: `openai/${c.modelId}`, apiBase: c.baseUrl ?? c.defaultBaseUrl ?? undefined };
}

/**
 * LiteLLM proxy client. Node's fetch keeps connections alive and pooled. Provider keys go in
 * the request body (LiteLLM `allow_client_side_credentials`); LiteLLM is only reachable on
 * the private network with its master key, and ARC forwards allow-listed fields only.
 */
export class LiteLLMGateway implements InferenceGateway {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly masterKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  dispatch(input: DispatchInput): Promise<Response> {
    const target = litellmTarget(input.candidate);
    const body: Record<string, unknown> = {
      ...input.body,
      model: target.model,
      api_key: input.apiKey,
      ...(target.apiBase ? { api_base: target.apiBase } : {}),
      ...(input.endpoint === 'chat/completions' ? { stream: input.stream } : {}),
    };
    return this.fetchImpl(`${this.base}/v1/${input.endpoint}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.masterKey}`,
        'content-type': 'application/json',
        accept: input.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  }
}
