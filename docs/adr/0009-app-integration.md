# ADR 0009 — Connecting the apps (Phase 5)

Status: Accepted · Phase 5

## Context

Echo Phone and Data Science Studio were written against Google's Gemini API: Echo with its own
REST client (`generateContent`, SSE streaming, function calling, embeddings), the studio with
`@google/genai` (`responseSchema`, an agent loop with forced tool calls). ARC speaks the OpenAI
API. Each app has many call sites and features built on Gemini-specific behaviour (quota-day
messages, users' own keys, model discovery).

## Decision

- **An adapter per app at its single choke point**, not a rewrite of call sites: Echo's
  `createArc()` has the same interface as `createGemini()`; the studio's ARC call sits inside
  `generateContentWithRetry`. Gemini-shaped requests are translated to OpenAI chat completions
  and the answers back (tool-call ids round-trip, schemas converted, streaming preserved).
- **Opt-in by environment** (`ARC_BASE_URL`, `ARC_API_KEY`): no flag day; unset means the old
  behaviour. One ARC key per app, issued with `scripts/ops/arc-admin.mjs`.
- **Fallback belongs to ARC.** Echo's own model rotation is off through ARC. The studio keeps its
  Gemini key and visitors' keys only as a fallback when ARC can't answer.
- **Users' own keys stay direct to Google** until ARC has BYOK (Phase 7).
- **Errors keep the apps' existing meanings**: ARC 401 → bad key, 429 → per-minute limit,
  `503 no_eligible_route` → a short "capacity used up" rest (lets Echo users with their own key
  continue), 5xx → busy.
- **Embeddings are pinned** to one model (`gemini/gemini-embedding-001`) so vectors already
  saved by Echo stay comparable; ARC never swaps an explicitly named model.
- **Grounding-only requests are refused** through ARC rather than answered from memory.

## Verification

`scripts/ops/stack-smoke.sh` builds the real stack, issues separate keys and runs each app's
`scripts/arc-smoke.*`: Echo (models, plain/streamed answers, tool round, JSON, embeddings, a
phone chat turn through its relay) and the studio (JSON-schema narrative, agent tool loop, its
real server answering the status probe and SQL assistant). All pass locally and run in CI.

## Consequences

- The adapters must track new Gemini request fields the apps start using; unknown fields are
  dropped, and unit tests pin the translation.
- Gemini task types for embeddings and Google Search grounding are not available through ARC.
