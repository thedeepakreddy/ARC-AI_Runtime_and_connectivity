import {
  type DispatchInput,
  type InferenceGateway,
  litellmTarget,
  toFormData,
} from '../../src/inference/gateway.js';

/** Stand-in for LiteLLM: forwards to an OpenAI-compatible provider the way LiteLLM does. */
export class DirectGateway implements InferenceGateway {
  dispatch(input: DispatchInput): Promise<Response> {
    const t = litellmTarget(input.candidate);
    const model = t.model.replace(/^openai\//, '');
    const url = `${t.apiBase}/${input.endpoint}`;
    if (input.form) {
      return fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${input.apiKey}` },
        body: toFormData({ ...input.body, model }, input.form.file, input.form.filename),
        signal: input.signal,
      });
    }
    return fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...input.body,
        model,
        ...(input.endpoint === 'chat/completions' ? { stream: input.stream } : {}),
      }),
      signal: input.signal,
    });
  }
}
