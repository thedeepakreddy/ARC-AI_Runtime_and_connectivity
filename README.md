<p align="center">
  <img src="docs/assets/arc-header.jpg" alt="ARC — AI Runtime &amp; Connectivity: one unified, intelligent runtime to connect, route and manage AI models, APIs and providers" width="100%">
</p>

<p align="center">
  <strong>One API in front of every AI provider. ARC picks the model, the key and the fallback, for every request.</strong>
</p>

<p align="center">
  <a href="https://arc-ai.run.place">Live</a> ·
  <a href="docs/inference-api.md">API</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="docs/deploy-oracle.md">Deploy for $0</a> ·
  <a href="docs/plan.md">Roadmap</a>
</p>

<p align="center">
  <img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue">
  <img alt="OpenAI-compatible" src="https://img.shields.io/badge/API-OpenAI--compatible-6e56cf">
  <img alt="Self-hosted on OCI" src="https://img.shields.io/badge/hosted%20on-Oracle%20Cloud%20(Arm)-c74634">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6">
  <img alt="Docker Compose" src="https://img.shields.io/badge/deploy-Docker%20Compose-2496ed">
</p>

---

## Why ARC

Every AI application ends up rebuilding the same plumbing: one SDK per provider, API keys
pasted into environment variables, a retry loop, a hand-written fallback, and no idea which key
hit its limit or why a request failed. One rate-limited key, and the app goes quiet.

**ARC (AI Runtime & Connectivity) moves all of that into one runtime.** Applications send a
request to a single OpenAI-compatible endpoint with `model: "auto"`. They never name a
provider, never hold a provider key, and never write fallback logic. ARC decides, in a few
milliseconds and without asking an LLM:

- **which models can serve this request**: text, tools, JSON output, images, audio, speech;
- **which keys may be used**: healthy, not resting after a rate limit, inside the allowed regions;
- **which route is best**: free before paid, general-purpose before specialised, then the fastest
  as measured by real traffic;
- **what happens when it fails**: the next key, or a different model, within the request's
  deadline.

Then it streams the answer back and records what happened, without ever logging the prompt
or the response.

```bash
curl https://arc-ai.run.place/v1/chat/completions \
  -H "Authorization: Bearer $ARC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello"}]}'
```

```text
x-arc-route-provider: groq
x-arc-route-model:    groq/llama-3.3-70b-versatile
x-arc-route-attempts: 1
x-arc-overhead-ms:    4
```

ARC already runs the AI of real products: **E.C.H.O Phone** (a voice assistant) and **Data
Science Studio** send all their model traffic through it. In production, Echo answered every
request with **about 25 ms of routing overhead**.

---

## Contents

- [What makes ARC different](#what-makes-arc-different)
- [Features](#features)
- [Architecture](#architecture)
- [How routing works](#how-routing-works)
- [Tech stack](#tech-stack)
- [Hosting: Oracle Cloud Infrastructure, for $0](#hosting-oracle-cloud-infrastructure-for-0)
- [Security](#security)
- [Quick start](#quick-start)
- [Using ARC from an app](#using-arc-from-an-app)
- [Development](#development)
- [Documentation](#documentation)
- [Status and roadmap](#status-and-roadmap)

---

## What makes ARC different

There are good tools in this space: hosted routers and marketplaces, gateway proxies, and
provider SDKs. ARC is built around a different set of priorities.

|                                   | **ARC**                                                                                            | Typical hosted router           | Typical gateway proxy |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------- |
| Who holds the provider keys       | **You.** Encrypted in your own vault, on your own server                                           | The service, or credits you buy | You, in config files  |
| Several keys per provider, pooled | **Yes.** Each key is routed, rate-limited and health-checked on its own                            | Usually one account             | Possible, by hand     |
| Free tiers first, honestly        | **Yes.** A model counts as free only with evidence: the provider's own price, or a link you record | Priced per token                | Not a concept         |
| Fallback                          | **Across keys and models**, inside the request's deadline, never replaying work already done       | Varies                          | Configured per route  |
| Routing decision                  | **In memory, no LLM call**, about a millisecond. Learning happens in a background worker           | Varies                          | Static rules          |
| Multi-tenant with BYOK            | **Yes.** Customers bring their own keys; their traffic never touches yours                         | Shared credits                  | Not built in          |
| Your app's end users' keys        | **Yes.** An app can register a user's own key, and that user's requests use only it                | No                              | No                    |
| Data residency                    | **Per tenant and per app**: allowed provider regions                                               | Limited                         | By hand               |
| Logging                           | **Metadata only.** Never prompts, responses, files or secrets                                      | Varies                          | Often full payloads   |
| Where it runs                     | **Your infrastructure.** One Arm VM, $0 on Oracle's free tier                                      | Their cloud                     | Yours                 |

In one line: **ARC is an operator-grade runtime you own.** It routes like a hosted service,
pools free tiers like nothing else, and stays in your infrastructure.

---

## Features

### Unified, OpenAI-compatible API

- `POST /v1/chat/completions`: streaming (SSE), tools, JSON schema output, images, audio and
  file inputs.
- `POST /v1/embeddings`.
- `POST /v1/audio/transcriptions`: speech to text, multipart upload.
- `POST /v1/audio/speech`: text to speech; audio passed through byte for byte.
- `POST /v1/images/generations`.
- `GET /v1/models`: the models this key can use, with their capabilities.
- Any OpenAI SDK works by changing the base URL and the key.

### Intelligent routing

- **`auto`**, plus `arc/fast`, `arc/balanced` and `arc/deep` execution modes, or a specific
  `provider/model`.
- **Capability gating:** ARC reads what a request needs (tools, JSON output, vision, audio) and
  only considers models that can do it.
- **Ranking:** health, then free before paid, then model class (general before small before
  language-specific or narrow), then expected latency from real traffic.
- **Fallback:** the same model on another key first, then other models. A provider saying "this
  model can't serve this" (for example OpenRouter's "No endpoints found that support tool use")
  moves straight to a different model; a key that is out of credits rests.
- **Cooldowns:** rate-limited keys rest for as long as the provider asks; failing keys back off.
- **Deadlines:** every request carries a deadline (`x-arc-deadline-ms`), and ARC never starts an
  attempt it can't finish.
- **Route explanation:** `x-arc-explain: true` returns why each candidate was chosen or
  rejected.

### Providers and models

- **36 providers in the catalogue**, from global to Chinese to local runtimes: Google Gemini, Groq,
  OpenRouter, Mistral, Cerebras, SambaNova, Cloudflare Workers AI, GitHub Models, Hugging Face,
  NVIDIA NIM, Cohere, Together, Fireworks, DeepInfra, DeepSeek, Moonshot (Kimi), Zhipu (GLM),
  Alibaba (Qwen), Baidu, Tencent, ByteDance, Deepgram, AssemblyAI, ElevenLabs, Jina, Voyage,
  Ollama, vLLM, LM Studio, llama.cpp and more. See [docs/providers.md](docs/providers.md).
- **OpenAI, Anthropic, Meta and hundreds of other models** through OpenRouter, plus any
  OpenAI-compatible endpoint.
- **Automatic model classification:** when a key is checked, ARC reads the provider's own
  listing (OpenRouter's prices, inputs and supported parameters; Gemini's methods) and
  classifies every model:
  - free models with evidence are switched on;
  - priced models are marked paid and stay off;
  - language-specific and safety models are left off, with a note saying why.

  You can change any of it, and a change you make is never overwritten.

### Website

- **The load page:** the opening plays in the sky with the ARC name above Earth's limb and waits
  there until the visitor clicks **Get started** (no timeout; scrolling and keys don't end it).
- **The front door at `/`** (`apps/site`): the opening is drawn in a three.js sky over a real
  Earth (4K day, night-lights and cloud maps from Solar System Scope, CC BY 4.0, from NASA
  imagery): the night side with its city lights, a sunlit crescent at the limb. Earth's limb
  ignites in horizon blue, the sun crests, the provider stations light, and requests fly as
  comets under gravity, steering for the station ARC chose and re-routing when one rests after
  a rate limit. Scroll speed stretches the stars into a warp; the pointer bends the comets'
  paths and a click scatters them.
- **A real sky:** the sun sits far away, so Earth is lit from behind: a sunlit crescent that
  reddens at the terminator, ocean glints, cloud shadows, city lights under the clouds, and an
  arc of sunlit air around the limb. Behind it are the real stars (Hipparcos positions,
  magnitudes and colours) and the Milky Way, its core rising behind the planet, built from the
  Milky Way Outline Catalog by `apps/site/scripts/build-sky.py` (credits in
  `apps/site/public/site-assets/sky/CREDITS.txt`). A space station orbits with its solar wings
  turned to the sun, and a train of broadband satellites glints across the sky and goes dark in
  Earth's shadow.
- **The sky, explained:** a section near the end of the page explains the physics behind the
  scene with the real numbers: parallel sunlight, Rayleigh blue, the twilight band, the forward-
  scattering arc, ocean glint, orbits and Earth's shadow, the catalogue stars and the Milky Way,
  and what is enlarged (objects in orbit) or a metaphor (requests as comets).
- **4K on every screen, within the device's memory:** every device with a real GPU loads the 4K
  maps once (never a 2K set and a 4K set together, which made Safari drop the canvas); software
  renderers get 2K. iOS renders at a slightly lower pixel density. The opening holds in its warp
  until the Earth is ready (9 s at most on a first visit), the planet fades in, and the sky's files
  are named after their contents and cached for a year (immutable), so after the first visit they
  come from the device, across deploys, until a picture itself changes. The planet shows as soon as its day and night maps arrive; the clouds and
  relief map fills in when it lands. Caddy serves HTTP/1.1 and HTTP/2 only (no HTTP/3), so a
  firewall that drops UDP can't stall the page's later files. A frame that throws on some device is recorded and skipped, never stops
  the sky; the canvas is re-measured every frame, so a home-screen app or a hiding address bar
  can't stretch the Earth into an oval. Built for every browser with WebGL 2 (Safari/iOS 15+, Chrome, Edge, Firefox). Add
  `?debug=1` to the address for an on-page diagnostics panel (GPU, tier, maps loaded or failed,
  frames, lost context, errors).
- **One continuous flight:** the camera flies a single path around the planet as you scroll,
  each section taking it to its own shot. Headlines rise word by word from behind a mask and
  lean with scroll speed, cards drift at different depths, and an orbit along the top shows how
  far down the page you are.
- **How ARC works:** a pinned walkthrough of one request through the seven steps below, in the
  console's own style. The sky acts it out: routes reach out to every candidate station, the
  gates cut theirs in red, the ranked routes brighten, the request travels the best one, that
  station rests and the request falls back to the next, and the record ring pulses.
- **Type:** the landing page has its own: Instrument Serif for headlines and figures, Geist for
  text and controls, Geist Mono for keys (`apps/site/src/fonts.ts`). The console and dashboard
  keep ARC's Mona Sans, Hubot Sans and Martian Mono (`@arc/ui`). All self-hosted, SIL OFL.
- **Try now** leads to the customer dashboard's sign-in: the page warps out while the sign-in
  loads. Coming back (Back, or a swipe) shows the page as it was, without the warp, and the
  opening plays once per visit, not again on return. Reduced motion shows a still frame.

### Multi-tenant platform

- **Owner console** (`/console`):
  - provider keys and their health;
  - the model catalogue and classification;
  - apps and their ARC keys;
  - routing policies;
  - traffic, latency, fallbacks and errors;
  - customers and the audit log.
- **Customer dashboard** (`/dashboard`):
  - sign up with email or Google;
  - bring your own provider keys;
  - choose models;
  - create apps and issue ARC keys;
  - usage, team and roles;
  - per-app regions;
  - a **Playground** to try chat, speech, transcription and images.
- **End users' own keys:** an app can register its users' own provider keys
  (`PUT /v1/user-keys/:provider` plus an `x-arc-user` header). Those users' requests use only
  their keys, with full routing and fallback.

### Operations

- **Health and readiness:** `/healthz` and `/readyz` (Postgres, Redis, LiteLLM).
- **Metrics:** Prometheus covers overhead, provider time to first byte, fallbacks, attempts,
  errors and rate limits.
- **Alerts:** Alertmanager emails when overhead, error rate or fallbacks go wrong, and again
  when they recover.
- **Backups:** nightly encrypted backups with an off-site copy, and a scripted restore drill
  that measures recovery time.
- **Deploys:** controlled deploys with a dry run and automatic rollback.
- **Testing:** a load test and regression gate (ARC overhead p95 ≤ 30 ms, errors ≤ 1%), and a
  full-stack smoke test in CI.

---

## Architecture

```mermaid
flowchart LR
    subgraph Apps["Your applications"]
        E["E.C.H.O Phone"]
        S["Data Science Studio"]
        X["Any OpenAI SDK"]
    end

    subgraph ARC["ARC runtime (one Arm VM on OCI)"]
        C["Caddy<br/>HTTPS · HTTP/3"]
        A["ARC API<br/>Fastify · /v1 · console · dashboard"]
        W["Worker<br/>route scores · key health"]
        L["LiteLLM<br/>provider execution"]
        P[("PostgreSQL 17<br/>catalogue · vault · usage")]
        R[("Redis 7<br/>cooldowns · rate limits · events")]
        M["Prometheus +<br/>Alertmanager"]
    end

    subgraph Providers["AI providers"]
        G["Gemini"]
        Q["Groq"]
        O["OpenRouter<br/>OpenAI · Anthropic · Meta …"]
        Z["30+ more"]
    end

    E & S & X -->|"OpenAI-compatible /v1<br/>model: auto"| C --> A
    A -->|"one chosen route"| L --> G & Q & O & Z
    A <--> P
    A <--> R
    W --> P
    W --> R
    M -.->|scrapes| A
    M -.->|email| Owner(("Owner"))
```

**The decision and the execution are separate.** The ARC API decides the route in memory,
with no network call and no LLM call. [LiteLLM](https://github.com/BerriAI/litellm) executes
the call to the provider. The worker keeps everything ARC learns (route scores, key health) up
to date in the background, off the request path. See
[ADR 0002](docs/adr/0002-litellm-execution-boundary.md) and
[ADR 0003](docs/adr/0003-latency-first-routing.md).

### Repository layout

```text
apps/api          Fastify + Zod: /v1 inference, control plane, the worker (src/worker)
apps/console      Owner console (React 19 + Vite), served at /console
apps/dashboard    Customer dashboard (React 19 + Vite), served at /dashboard
apps/site         Public website (React 19 + Vite + three.js + GSAP), served at /
packages/ui       ARC's design system, shared by both apps (see DESIGN.md)
packages/shared   Config validation and log redaction shared by services
apps/api/bench    Load test and regression gate
infra/            LiteLLM, Caddy, Prometheus alerts, Alertmanager, Postgres init
scripts/ops/      Backup, restore, restore drill, deploy, server verification, smoke test
docs/             Plan, ADRs, threat model, API references, deployment guides
```

---

## How routing works

```text
request ─► authenticate ARC key ─► rate limit (per key, shared via Redis)
        ─► what does it need?   text · streaming · tools · JSON · vision · audio · …
        ─► candidates           every (model, key) this tenant / app / end user may use
        ─► gates                enabled · eligibility · region · health · cooldown · capability
        ─► rank                 health → free before paid → model class → expected latency
        ─► execute              best route via LiteLLM, streamed back as it arrives
        ─► on failure           next key, or a different model, within the deadline
        ─► record               metadata only: route, timings, outcome (never the content)
```

- **No LLM in the routing path.** Ranking uses precomputed scores held in memory: microseconds
  of work, and a few milliseconds end to end, including authentication.
- **Free-first, honestly.** A model is free only with evidence: the provider's published price,
  or a pricing link the owner recorded with a date. An unknown price is never treated as free.
- **Owner keys and customer keys never mix.** A customer's traffic uses only that customer's
  keys, and an end user's only theirs.

---

## Tech stack

| Layer              | Technology                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Language           | TypeScript (strict), Node.js 22, pnpm workspaces                                                                         |
| API and worker     | Fastify 5, Zod 4, `pg`, `ioredis`                                                                                        |
| Provider execution | LiteLLM 1.110 (pinned by digest), private network only                                                                   |
| Data               | PostgreSQL 17 (catalogue, encrypted vault, usage rollups), Redis 7 (cooldowns, rate limits, events)                      |
| Frontend           | React 19, Vite, React Router; ARC's own design system (`packages/ui`, [DESIGN.md](DESIGN.md))                            |
| Edge               | Caddy 2: automatic HTTPS (Let's Encrypt or ZeroSSL), HTTP/3, security headers                                            |
| Observability      | Prometheus, Alertmanager (email), structured JSON logs with redaction                                                    |
| Security           | Envelope encryption (AES-256-GCM, versioned key ring), scrypt passwords, TOTP two-step sign-in, Google OAuth (PKCE)      |
| Packaging          | Docker Compose with profiles (`https`, `monitoring`, `ops`); multi-arch images (`linux/amd64`, `linux/arm64`)            |
| Quality            | Vitest (200+ tests, against real PostgreSQL and Redis), ESLint, Prettier, axe-core accessibility checks                  |
| CI                 | GitHub Actions: checks, a full-stack smoke test, the inference suite through **real LiteLLM**, Arm64 builds, ops scripts |

---

## Hosting: Oracle Cloud Infrastructure, for $0

ARC's production instance runs on **Oracle Cloud Infrastructure (OCI)**, entirely inside the
**Always Free** tier. It runs 24/7 and costs nothing.

|            |                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compute    | **VM.Standard.A1.Flex**, Ampere Arm64: 4 OCPU, 24 GB RAM                                                                                                              |
| Region     | Netherlands Northwest (Amsterdam), `eu-amsterdam-1`                                                                                                                   |
| OS         | Canonical Ubuntu 22.04, automatic security updates                                                                                                                    |
| Storage    | 100 GB boot volume (in-transit encryption on)                                                                                                                         |
| Network    | Its own VCN and public subnet; **reserved public IP**; Security List ingress limited to 22, 80, 443 (TCP) and 443 (UDP for HTTP/3); host firewall (iptables) to match |
| Runtime    | Docker Engine and Compose; the full stack as containers with `restart: unless-stopped`                                                                                |
| TLS        | Caddy obtains and renews certificates automatically                                                                                                                   |
| Exposure   | Only Caddy is public; the API, Postgres, Redis and LiteLLM are on private Docker networks or loopback                                                                 |
| Monitoring | Prometheus and Alertmanager on the same VM, alerts by email                                                                                                           |
| Cost       | **$0**, guarded by a $1 budget alert                                                                                                                                  |

Why this works: ARC needs about 2–3 GB of memory with two LiteLLM workers. Oracle's free Arm
VM has 24 GB, so the whole stack (including monitoring) fits with plenty of headroom. CI builds
and tests every image for `linux/arm64`, so what passes CI runs on this machine.

Deploy your own in about an hour: [docs/deploy-oracle.md](docs/deploy-oracle.md). A paid
alternative on Google Cloud is in [docs/deploy-gcp.md](docs/deploy-gcp.md), and the cost
comparison is in [docs/costs.md](docs/costs.md).

---

## Security

- **Provider keys are encrypted at rest** with envelope encryption. The key file lives outside
  the database, so a database backup alone can't reveal them. Keys are never returned by any
  API; the console shows a short hint (`****d87d`) only.
- **ARC API keys** (`ARC_DEE_…_PAK_…`) are stored as hashes, scoped (`inference`,
  `models:read`), rotatable with an overlap window, and revocable instantly across instances.
- **Accounts:**
  - two-step sign-in (TOTP) with one-use recovery codes;
  - Google sign-in (OAuth with PKCE);
  - email confirmation and password reset;
  - sign-in throttling shared across instances;
  - `Secure`, `HttpOnly`, `SameSite=Strict` session cookies.
- **Tenant isolation:** customers see only their own keys, apps, models and usage. Customer
  base URLs are guarded against internal addresses (SSRF).
- **Metadata-only logging:** prompts, responses, files and secrets never reach a log, and query
  strings are stripped from request logs.
- **Strict security headers:** a same-origin Content Security Policy (nonce-based when ads are
  on), HSTS, `nosniff` and `frame-ancestors 'none'`.
- Threat model: [docs/threat-model.md](docs/threat-model.md).

---

## Quick start

**Requirements:** Docker with Compose v2. For development: Node 22+ and pnpm 10
(`corepack enable`).

```bash
git clone https://github.com/thedeepakreddy/ARC-AI_Runtime_and_connectivity.git arc
cd arc && cp .env.example .env && mkdir -p secrets   # then set real secrets in .env

# 1. The vault key, kept outside the database (keep a copy off the server)
docker compose run --rm --no-deps -T api node dist/cli/vault-keygen.js > secrets/vault-keys.json

# 2. Start everything (add --profile https --profile monitoring on a server with a domain)
docker compose up -d --build

# 3. Create the owner
read -s ARC_OWNER_PASSWORD && export ARC_OWNER_PASSWORD
docker compose exec -e ARC_OWNER_EMAIL=you@example.com -e ARC_OWNER_PASSWORD api \
  node dist/cli/create-owner.js
```

Then:

1. Open `http://localhost:8080/console` and add a provider key (a free Gemini or Groq key works).
2. Press **Check now**: ARC discovers and classifies the models.
3. Create an app and issue an ARC key.

Full details: [docs/operations.md](docs/operations.md).

---

## Using ARC from an app

Any OpenAI SDK works. Point it at ARC and use the app's ARC key:

```ts
import OpenAI from 'openai';

const arc = new OpenAI({
  baseURL: 'https://arc-ai.run.place/v1',
  apiKey: process.env.ARC_API_KEY, // ARC_DEE_…_PAK_…
});

const stream = await arc.chat.completions.create({
  model: 'auto', // ARC chooses the provider, model and key
  stream: true,
  messages: [{ role: 'user', content: 'Summarise this in one line: …' }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
```

- **Your users' own keys:**
  1. Register a user's key once with `PUT /v1/user-keys/gemini`, sending `x-arc-user: <your user id>`.
  2. Send the same header on that user's requests; they then run on that user's key only.
- **More:** audio, images, embeddings, headers and errors are in
  [docs/inference-api.md](docs/inference-api.md); app integration is in
  [docs/app-integration.md](docs/app-integration.md).

---

## Development

```bash
pnpm install
pnpm check                      # format, lint, typecheck, tests
scripts/ops/stack-smoke.sh      # the whole stack end to end, isolated from your .env
```

Integration tests need PostgreSQL (and Redis for the shared-coordination suite):

```bash
TEST_DATABASE_URL=postgres://arc:arc@127.0.0.1:5432/postgres \
TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm test
```

Add `LITELLM_TEST_URL=http://127.0.0.1:4000` (and `LITELLM_TEST_MASTER_KEY`) to run the
inference suite through a real LiteLLM proxy instead of the built-in stand-in.

Run the API on the host against containerised dependencies:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis litellm
DATABASE_URL=postgres://arc:<password>@127.0.0.1:5432/arc \
REDIS_URL=redis://127.0.0.1:6379 \
LITELLM_BASE_URL=http://127.0.0.1:4000 \
LITELLM_MASTER_KEY=<from .env> \
ARC_VAULT_KEY_FILE=./secrets/vault-keys.json COOKIE_SECURE=false \
pnpm dev
```

### Principles

- **Latency first:** no extra LLM call to route ordinary requests; stream immediately; provider
  intelligence is maintained asynchronously by the worker.
- **Free-first, honest:** an unknown price or quota is never treated as free.
- **Metadata-only logging:** no secrets, prompts, responses or file contents in logs.
- **Owner's choice wins:** automatic classification suggests, and the owner decides.

---

## Documentation

| Document                                           | What it covers                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| [docs/inference-api.md](docs/inference-api.md)     | The `/v1` API for applications: endpoints, models, headers, audio, images, errors |
| [docs/admin-api.md](docs/admin-api.md)             | The console and dashboard API                                                     |
| [docs/app-integration.md](docs/app-integration.md) | Connecting an application                                                         |
| [docs/deploy-oracle.md](docs/deploy-oracle.md)     | Deploying on OCI Always Free, step by step                                        |
| [docs/operations.md](docs/operations.md)           | Setup, secrets, accounts, alerts, backups, restores, deploys                      |
| [docs/costs.md](docs/costs.md)                     | What it costs to run (nothing, on free tiers)                                     |
| [docs/providers.md](docs/providers.md)             | Supported providers                                                               |
| [docs/threat-model.md](docs/threat-model.md)       | Security model                                                                    |
| [docs/adr/](docs/adr)                              | Architecture decision records                                                     |
| [DESIGN.md](DESIGN.md)                             | ARC's design system                                                               |
| [docs/plan.md](docs/plan.md)                       | Plan, status and decisions                                                        |

---

## Status and roadmap

**Live in production** at [arc-ai.run.place](https://arc-ai.run.place), serving E.C.H.O Phone
and Data Science Studio.

- [x] Unified OpenAI-compatible API: chat, embeddings, speech to text, text to speech, images
- [x] Latency-first routing with capability gating, model classes, multi-key and multi-model fallback
- [x] Automatic model classification from providers' own data
- [x] Owner console, customer dashboard, Playground, BYOK, end users' own keys
- [x] Two-step sign-in, Google sign-in, email confirmation and password reset
- [x] Monitoring, email alerts, encrypted backups, controlled deploys
- [x] Production deployment on OCI Always Free (Arm64)
- [ ] `arc/balanced` and `arc/deep` execution modes (today they behave like `arc/fast`)
- [ ] Evaluation-driven routing (quality, not just speed and price)
- [ ] Usage-based billing
- [ ] Multi-server high availability

---

## License

[Apache License 2.0](LICENSE)

<p align="center"><sub>Built by <a href="https://github.com/thedeepakreddy">@thedeepakreddy</a>, one runtime for every AI application.</sub></p>
