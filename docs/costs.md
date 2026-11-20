# ARC — Running costs

**Short answer: $0/month, 24/7, on Oracle Cloud's Always Free tier** (the owner's choice; see
[deploy-oracle.md](deploy-oracle.md)): one free Arm VM with 12–24 GB of memory runs the whole
stack, with free model-provider tiers and a free email account. The only optional cost is a
domain (≈ $10/year); a free subdomain (e.g. DuckDNS) works too. Keep a $1 budget alert on.

Google Cloud is the paid alternative ([deploy-gcp.md](deploy-gcp.md)): one small VM, roughly
$12–25 a month (e2-small or e2-medium, on-demand, plus its static IPv4 address and disk). New
accounts get a $300 credit for 90 days. Prices change and vary by region: check the provider's
pricing calculator before relying on a number below (checked November 2026).

## Why not the free e2-micro

ARC's stack needs about **0.9 GB of memory with one LiteLLM worker** and about **2.3 GB with
two** (measured on the full stack; LiteLLM is almost all of it). The Always Free e2-micro has
1 GB for everything, including the OS and Docker, and building the images needs more. It also
isn't free in practice: its external IPv4 address is billed (about $3.65/month).

| Piece            | Choice                                                                                                               | What it covers                                                | Watch out for                                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server           | Compute Engine **e2-medium** (4 GB, ~$25/month) or **e2-small** (2 GB, ~$12/month, one LiteLLM worker + swap)        | Postgres, Redis, LiteLLM, ARC API + worker, Caddy, monitoring | Set a **budget alert**. Sustained-use discounts apply automatically; a 1-year commitment lowers it further once the pilot is proven. See [deploy-gcp.md](deploy-gcp.md).                                                                                                                                      |
| IP address       | Static external IPv4                                                                                                 | Your domain points at it                                      | About $3.65/month while in use.                                                                                                                                                                                                                                                                               |
| Disk             | 30 GB standard or balanced persistent disk                                                                           | OS, Docker images, database, local backups                    | A few dollars a month.                                                                                                                                                                                                                                                                                        |
| Off-site backups | Cloud Storage (Standard), same region                                                                                | Encrypted nightly dumps (`BACKUP_RCLONE_REMOTE`)              | ARC's dumps are KBs–MBs: cents a month. The free 5 GB-months apply in us-central1, us-east1 and us-west1.                                                                                                                                                                                                     |
| Models           | Free tiers: Gemini (AI Studio), Groq, Cerebras, OpenRouter `:free` models, Mistral, … ([providers.md](providers.md)) | All app traffic                                               | Free tiers have per-minute and per-day limits. ARC's answer: add **several keys** per provider and several providers; ARC rotates, cools down and falls back between them. ARC never uses a model whose pricing is unknown, and never a paid owner key without your explicit approval (`allowPaidOwnerKeys`). |
| Alert emails     | Gmail with an App Password (or any free SMTP, e.g. Brevo's free plan)                                                | Alerts, password reset and email confirmation                 | A Gmail App Password needs 2-Step Verification on the account.                                                                                                                                                                                                                                                |
| HTTPS            | Caddy + Let's Encrypt                                                                                                | TLS in front of ARC                                           | Needs a domain or free subdomain pointing at the VM.                                                                                                                                                                                                                                                          |
| Apps             | Render free web services (Echo Phone, Data Science Studio)                                                           | The apps themselves                                           | Free Render services sleep when idle; the first request after a sleep is slow.                                                                                                                                                                                                                                |

## What could cost more

- **A paid model**: only if you mark a model `PAID` _and_ turn on `allowPaidOwnerKeys` for a
  tenant or app. Off by default. Customers' and end users' paid models bill their own keys.
- **Network egress**: traffic leaving Google Cloud is billed per GB beyond small free amounts.
  ARC's requests and responses are text, so a pilot stays in the cents to low dollars; heavy
  image or audio traffic would add up.
- **A bigger machine** as traffic grows: LiteLLM workers are the thing to scale (measured:
  ~0.65 GB for one worker, ~2 GB for two).

Ads in the customer dashboard (Google AdSense) can offset these costs; see
[operations.md → Ads](operations.md#ads-in-the-customer-dashboard).
