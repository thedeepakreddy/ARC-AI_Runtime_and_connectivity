import {
  type DispatchInput,
  type InferenceGateway,
  litellmTarget,
} from '../../src/inference/gateway.js';

/** Stand-in for LiteLLM: forwards to an OpenAI-compatible provider the way LiteLLM does. */
export class DirectGateway implements InferenceGateway {
  dispatch(input: DispatchInput): Promise<Response> {
    const t = litellmTarget(input.candidate);
    return fetch(`${t.apiBase}/${input.endpoint}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...input.body,
        model: t.model.replace(/^openai\//, ''),
        stream: input.stream,
      }),
      signal: input.signal,
    });
  }
}
