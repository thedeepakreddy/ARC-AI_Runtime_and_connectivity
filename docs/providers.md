# ARC — Provider & Model Candidate List

Status: **planning list, nothing implemented yet.** Every entry must be verified against the
provider's official documentation before it is enabled. Free-tier terms change often.

## Rules that apply to every provider

- **Multiple API keys per provider** for every user/tenant (label, owner, encrypted secret,
  enabled state, supported models, per-key health/latency/rate-limit history).
- Routing picks the best healthy key; a rate-limited key enters cooldown. Never hammer all keys
  to get around a provider's limits — the key owner is responsible for the provider's terms.
- Eligibility class per model: `VERIFIED_FREE`, `RESTRICTED_FREE`, `PAID`, `UNKNOWN`.
  Record evidence URL + last-checked date. **Unknown is not free** and is blocked.
- One-time signup credits are **not** `VERIFIED_FREE` (use `RESTRICTED_FREE` or `PAID`).
- Every provider carries a **jurisdiction tag** (e.g. `US`, `EU`, `CN`); apps/tenants can
  allow or exclude regions in routing policy.
- Prefer LiteLLM native adapters; otherwise the generic OpenAI-compatible adapter.

## 1. Original providers (from blueprint)

| Provider                  | Free access (to verify)         | Jurisdiction |
| ------------------------- | ------------------------------- | ------------ |
| Google Gemini (AI Studio) | Ongoing free tier, rate-limited | US           |
| Groq                      | Ongoing free tier, rate-limited | US           |
| OpenRouter                | `:free` models                  | US           |
| Cloudflare Workers AI     | Daily free allowance            | US           |
| Mistral (La Plateforme)   | Free/experiment tier            | EU           |
| Ollama                    | Local, free                     | Self-hosted  |

## 2. Additional international providers

| Provider                         | Free access (to verify)                           | Expected class         | Jurisdiction |
| -------------------------------- | ------------------------------------------------- | ---------------------- | ------------ |
| Cerebras                         | Ongoing free tier; very fast (good for FAST mode) | VERIFIED_FREE?         | US           |
| SambaNova Cloud                  | Ongoing free tier                                 | VERIFIED_FREE?         | US           |
| GitHub Models                    | Free prototyping, strict limits                   | RESTRICTED_FREE?       | US           |
| Hugging Face Inference Providers | Small monthly free allowance                      | RESTRICTED_FREE?       | US/EU        |
| NVIDIA NIM (build.nvidia.com)    | Free developer access                             | RESTRICTED_FREE?       | US           |
| Cohere                           | Trial key, non-commercial only                    | RESTRICTED_FREE        | US/CA        |
| Together AI                      | Credits                                           | RESTRICTED_FREE / PAID | US           |
| Fireworks                        | Credits                                           | RESTRICTED_FREE / PAID | US           |
| Nebius                           | Credits                                           | RESTRICTED_FREE / PAID | EU           |
| DeepInfra                        | Credits                                           | RESTRICTED_FREE / PAID | US           |

## 3. Chinese AI providers

| Provider                               | Models                                | Free access (to verify)                                 | Signup notes                     |
| -------------------------------------- | ------------------------------------- | ------------------------------------------------------- | -------------------------------- |
| Alibaba Cloud Model Studio (DashScope) | Qwen (chat, coding, vision, audio)    | Free quota for new users                                | International endpoint available |
| ModelScope (Alibaba)                   | Open-model hub API                    | Daily free calls                                        | —                                |
| DeepSeek                               | DeepSeek V / R series                 | Low-cost, not free direct; free variants via OpenRouter | International                    |
| Moonshot AI                            | Kimi                                  | Starter credits                                         | International platform           |
| Zhipu AI / Z.ai                        | GLM (Flash models free)               | Ongoing free models                                     | International (Z.ai)             |
| MiniMax                                | Text, speech, video                   | Credits                                                 | International platform           |
| Baidu Qianfan                          | ERNIE (Speed/Lite free)               | Free models                                             | Likely CN phone / real-name      |
| Tencent Hunyuan                        | Hunyuan-lite                          | Free model                                              | Likely CN phone / real-name      |
| ByteDance Volcengine Ark               | Doubao                                | Free token allowance                                    | Likely CN phone / real-name      |
| iFlytek Spark                          | Spark Lite                            | Free model                                              | Likely CN phone / real-name      |
| StepFun                                | Step models                           | Credits                                                 | —                                |
| SiliconFlow                            | Aggregator: Qwen, DeepSeek, GLM, etc. | Several permanently free models                         | International                    |

All tagged jurisdiction `CN`. Start with international-signup providers (Alibaba, Zhipu/Z.ai,
Moonshot, MiniMax, SiliconFlow, DeepSeek).

## 4. Local / self-hosted

LM Studio, vLLM, llama.cpp (plus Ollama). OpenAI-compatible; free, limited by hardware.

## 5. Speech & embeddings

| Provider   | Use                    | Free access (to verify) |
| ---------- | ---------------------- | ----------------------- |
| Deepgram   | Speech-to-text / TTS   | Credits                 |
| AssemblyAI | Speech-to-text         | Credits                 |
| ElevenLabs | Text-to-speech         | Free tier               |
| Jina       | Embeddings / reranking | Free token allowance    |
| Voyage     | Embeddings             | Free token allowance    |

## Build placement

- Phase 1 — provider/account registry supports unlimited keys per provider.
- Phase 3 — jurisdiction tag + region policy in eligibility gates.
- Provider packs (3–4 PRs, after core gateway works): international, Chinese, local,
  speech/embeddings. Each provider = config entry + eligibility classification with evidence
  link + mocked contract test.
