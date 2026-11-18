# ADR 0002 — LiteLLM as the execution gateway only

Status: Accepted · Phase 0

## Decision

- LiteLLM **executes provider calls**. ARC owns identity, tenants, ARC API keys, the
  provider/account registry, credential vault, policy, eligibility and routing intelligence.
- ARC decides provider + model + key, then dispatches through LiteLLM. Applications never talk to
  LiteLLM directly; it sits on the private `backend` network.
- LiteLLM uses its **own database** (`litellm`) inside the same Postgres server, so ARC tables
  never mix with LiteLLM internal tables.
- LiteLLM message logging is off (`turn_off_message_logging`) — metadata-only logging.
- The image must be pinned to a tested version/digest before production.

## Consequences

Provider adapters come mostly from LiteLLM (native or OpenAI-compatible). The ARC → LiteLLM hop
adds latency, so both run on the same host with persistent connections, and Phase 4 measures ARC
overhead separately from provider time.
