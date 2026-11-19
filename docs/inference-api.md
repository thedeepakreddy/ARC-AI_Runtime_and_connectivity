# ARC — Inference API for applications

ARC speaks the OpenAI API. Point any OpenAI SDK at ARC and use an ARC key:

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://<arc-domain>/v1',
  apiKey: process.env.ARC_API_KEY, // ARC_DEE_…_PAK_…
});

const stream = await client.chat.completions.create({
  model: 'auto',
  stream: true,
  messages: [{ role: 'user', content: 'Hello' }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
```

## Endpoints

| Method | Path                   | Scope         |
| ------ | ---------------------- | ------------- |
| GET    | `/v1/models`           | `models:read` |
| POST   | `/v1/chat/completions` | `inference`   |
| POST   | `/v1/embeddings`       | `inference`   |

## Model names

- `auto` — ARC chooses an eligible model and key.
- `arc/fast`, `arc/balanced`, `arc/deep` — execution modes. **All currently behave as FAST**;
  BALANCED/DEEP arrive later.
- `<provider>/<model id>` — a specific model, e.g. `groq/llama-3.1-8b-instant`. `GET /v1/models`
  lists what your key can use, with capabilities.

ARC picks the provider key. Apps never send provider keys, account IDs or base URLs — such fields
are ignored.

## Optional headers

| Header              | Meaning                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `x-arc-deadline-ms` | Overall deadline for this request (min 100, capped by the server) |
| `x-request-id`      | Your correlation ID (8–128 chars `[A-Za-z0-9._-]`), echoed back   |
| `x-arc-explain`     | `true` → response includes `x-arc-route-explain` (why this route) |

## Fallback

If a provider key fails in a way another key could fix (auth failure, rate limit, server error,
timeout), ARC retries on the same model's other keys and — for `auto`/`arc/*` only — on other
compatible models. At most 3 attempts, never past your deadline, and only before any output has
been sent. A specific `<provider>/<model>` request never switches model. Errors about the request
itself (e.g. context too long) come back immediately.

## Response headers

`x-arc-route-provider`, `x-arc-route-model`, `x-arc-route-account`, `x-arc-route-alternatives`,
`x-arc-route-attempts`, `x-arc-mode`, `x-arc-overhead-ms` (time ARC spent before calling the
provider), `x-request-id`. After a fallback: `x-arc-fallback` (comma-separated reasons) and
`x-arc-fallback-ms` (time spent on failed attempts).

## Errors

```json
{ "error": { "type": "rate_limit_error", "code": "provider_rate_limited", "message": "…" } }
```

| Status | Code                                         | Meaning                                           |
| ------ | -------------------------------------------- | ------------------------------------------------- |
| 400    | `invalid_request`                            | Body failed validation (`details` lists fields)   |
| 400    | `capability_not_supported`                   | No eligible model supports e.g. tools or vision   |
| 400    | `provider_rejected_request`                  | The provider rejected the request (message shown) |
| 401    | `missing_api_key` / `invalid_api_key`        | Missing, malformed, revoked or expired ARC key    |
| 403    | `insufficient_scope`                         | Key lacks the scope for this endpoint             |
| 404    | `model_not_found`                            | The model is not available to this key            |
| 429    | `arc_rate_limited` / `provider_rate_limited` | ARC's per-key limit, or the provider's            |
| 502    | `provider_auth_failed` / `provider_error`    | Upstream problem; not your request                |
| 503    | `no_eligible_route`                          | No key currently passes policy and health checks  |
| 504    | `deadline_exceeded` / `provider_timeout`     | Ran out of time                                   |
