# ARC — Connecting applications (Phase 5)

Each application gets **its own ARC key**, so its traffic, limits, routing policy and revocation
are separate. Apps never hold provider keys: ARC does.

| App                                | Repository                      | How it talks to ARC                                                                              | Status                   |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------ |
| Echo Phone                         | `E.C.H.O-Phone`                 | `lib/arc.js`: Gemini-shaped calls ↔ OpenAI chat completions, streaming, tools, embeddings        | Integrated, smoke-tested |
| Data Science Studio                | `DataScienceStudio-AskDeepakAI` | `arcClient.ts`: `@google/genai`-shaped calls ↔ OpenAI chat completions, JSON schema, agent tools | Integrated, smoke-tested |
| Aira, Echo Mac, Echo web extension | —                               | Later, the same way                                                                              | Not started              |

Both integrations are **opt-in**: with `ARC_BASE_URL` and `ARC_API_KEY` unset, the apps behave
exactly as before (Gemini directly). Users' own Gemini keys can now go through ARC too: the app
stores them with `PUT /v1/user-keys/gemini` and sends `x-arc-user` on that user's requests (see
[inference-api.md → Your users' own keys](inference-api.md#your-users-own-keys)). Switching Echo
and the Studio over is a change in those repos.

## 1. Prepare ARC (once)

On the ARC server, with the owner's login in the environment:

```bash
read -s ARC_OWNER_PASSWORD && export ARC_OWNER_PASSWORD ARC_OWNER_EMAIL=you@example.com
export ARC_URL=https://arc.example.com

# Provider keys — as many per provider as you have. The key is read from the environment.
read -s PROVIDER_API_KEY && export PROVIDER_API_KEY
node scripts/ops/arc-admin.mjs add-provider-key --provider gemini --label "Gemini 1"

# Classify and enable the models the apps need (evidence URL required).
node scripts/ops/arc-admin.mjs enable-model --provider gemini --model gemini-3.8-flash \
  --eligibility VERIFIED_FREE --evidence https://ai.google.dev/gemini-api/docs/pricing \
  --capabilities text,streaming,tools,structured_output,vision,audio_input
# Echo's saved memory is searched by meaning with this exact model — enable it:
node scripts/ops/arc-admin.mjs enable-model --provider gemini --model gemini-embedding-001 \
  --eligibility VERIFIED_FREE --evidence https://ai.google.dev/gemini-api/docs/pricing \
  --capabilities embeddings
```

## 2. Issue one key per app

```bash
node scripts/ops/arc-admin.mjs app-key --name "Echo Phone" --slug echo-phone
node scripts/ops/arc-admin.mjs app-key --name "Data Science Studio" --slug data-science-studio
```

Each prints the key **once**. Paste it straight into the app's hosting secrets (Render →
Environment). Rotate or revoke with the admin API (`/admin/v1/api-keys/:id/rotate`, `DELETE`).
Optional per-app policy, e.g. keep Echo off `CN` providers:
`PUT /admin/v1/applications/:appId/routing-policy`.

## 3. Configure the apps

| Variable          | Echo Phone                                      | Data Science Studio                     |
| ----------------- | ----------------------------------------------- | --------------------------------------- |
| `ARC_BASE_URL`    | `https://arc.example.com/v1`                    | same                                    |
| `ARC_API_KEY`     | Echo's key                                      | the studio's key                        |
| `ARC_MODEL`       | optional, default `auto`                        | optional, default `auto`                |
| `ARC_EMBED_MODEL` | optional, default `gemini/gemini-embedding-001` | —                                       |
| `GEMINI_API_KEY`  | not needed with ARC                             | optional: used only if ARC can't answer |

## 4. Smoke-test each app against the real ARC

```bash
# in E.C.H.O-Phone
ARC_BASE_URL=https://arc.example.com/v1 ARC_API_KEY=… node scripts/arc-smoke.mjs
# in DataScienceStudio-AskDeepakAI
ARC_BASE_URL=https://arc.example.com/v1 ARC_API_KEY=… npx tsx scripts/arc-smoke.ts
```

Echo's covers plain and streamed answers, a tool-call round, JSON output, embeddings and a real
phone chat turn through its relay. The studio's covers JSON-schema narratives, the ML agent's
forced tool call and follow-up, and its real server answering the AI status probe and the SQL
assistant through ARC.

ARC's CI runs both against a freshly built ARC stack on every push
(`scripts/ops/stack-smoke.sh`, job `stack`), once the apps' `scripts/arc-smoke.*` are on their
`main` branches.

## Behaviour worth knowing

- **Fallback lives in ARC.** Echo's own Gemini model rotation (agent, browse and overload models)
  is off through ARC; ARC retries other keys and compatible models instead.
- **Limits.** When every owner key is resting (`503 no_eligible_route`), Echo treats it like a
  used-up daily limit for a short rest (Retry-After, else 10 min), so users who added their own
  Gemini key switch to it; others are told to wait. The studio falls back to `GEMINI_API_KEY`,
  then a visitor's key, then its built-in non-AI versions.
- **Google Search grounding** exists only on Google's API. Through ARC, Echo refuses a
  grounding-only call instead of answering from memory; its own live web search is unaffected.
- **Embeddings.** `dimensions` reaches Gemini as `outputDimensionality` (verified on LiteLLM
  1.110.0). LiteLLM drops it for generic OpenAI-compatible providers, so pin an embedding model
  that supports the size you need.
- **Task types** (Gemini's `RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`) are not part of the
  OpenAI API and are not sent through ARC; vectors from the same model stay comparable.
