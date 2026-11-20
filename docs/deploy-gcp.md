# Deploying ARC on Google Cloud

One Compute Engine VM runs the whole stack with Docker Compose: Postgres, Redis, LiteLLM, the
ARC API and worker, Caddy (HTTPS) and, optionally, Prometheus and Alertmanager. Costs and the
reasoning behind the machine size are in [costs.md](costs.md). Allow about an hour.

## Which machine

Measured on the full stack (November 2026): **about 0.9 GB with one LiteLLM worker, about 2.3 GB
with two**. LiteLLM is almost all of it; Postgres ~90 MB, the API ~45 MB, the worker ~25 MB.

| Machine                     | Memory | Fits?                                                                        |
| --------------------------- | ------ | ---------------------------------------------------------------------------- |
| e2-micro (Always Free)      | 1 GB   | No. The OS and Docker need ~300 MB, and building the images needs more.      |
| **e2-small**                | 2 GB   | Yes, with `LITELLM_NUM_WORKERS=1` and a 2 GB swap file. The cheapest option. |
| **e2-medium** (recommended) | 4 GB   | Yes, with `LITELLM_NUM_WORKERS=2`: room for builds, deploys and traffic.     |

New Google Cloud accounts get a **$300 credit for 90 days**, which covers an e2-medium for the
whole trial. Check current prices in the Google Cloud pricing calculator for your region.

## What you need first

- [ ] A Google Cloud project with billing, and a **budget alert** (Billing → Budgets & alerts).
- [ ] A domain or free subdomain (e.g. `arc-you.duckdns.org`) you can point at the VM.
- [ ] An email for Let's Encrypt notices, and a Gmail App Password for alert and account emails
      ([operations.md](operations.md#alerts-by-email)).
- [ ] Optional: a Cloud Storage bucket `arc-backups` for off-site backups (below).

## 1. The VM

1. Compute Engine → VM instances → Create: **e2-medium** (or e2-small), region near your users
   (us-central1, us-east1 and us-west1 are among the cheapest), **Ubuntu 24.04 LTS**, boot disk
   **30 GB** (standard or balanced).
2. Firewall: tick **Allow HTTP traffic** and **Allow HTTPS traffic**. Leave everything else
   closed: ARC's API listens on the VM's loopback only, Caddy is the way in.
3. VPC network → IP addresses → reserve the VM's external IPv4 as **static**, so it survives
   restarts. Point your domain's A record at it.
4. On the VM, install Docker (Engine + Compose plugin) from Docker's apt repository
   (docs.docker.com/engine/install/ubuntu), then `sudo usermod -aG docker $USER` and log in again.
5. On e2-small only, add swap:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile
sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. ARC

```bash
sudo mkdir -p /opt/arc && sudo chown $USER /opt/arc
git clone https://github.com/thedeepakreddy/ARC-AI_Runtime_and_connectivity.git /opt/arc
cd /opt/arc && cp .env.example .env
```

Edit `.env`:

- real `POSTGRES_PASSWORD` and `LITELLM_MASTER_KEY` (`openssl rand -hex 24`);
- `ARC_DOMAIN`, `ACME_EMAIL`, `PUBLIC_URL=https://<ARC_DOMAIN>`, `TRUST_PROXY=true`;
- `LITELLM_NUM_WORKERS=2` on e2-medium, `1` on e2-small;
- the `ALERT_*` settings (alerts, password-reset and confirmation emails);
- optionally `GOOGLE_CLIENT_ID` and the AdSense settings
  ([operations.md → Accounts](operations.md#accounts-two-step-sign-in-password-reset-email-google),
  [operations.md → Ads](operations.md#ads-in-the-customer-dashboard)).

Then follow [operations.md → First-time setup](operations.md#first-time-setup-pilot-server)
(vault key, owner), starting the stack with HTTPS (add `--profile monitoring` on e2-medium):

```bash
docker compose --profile https up -d --build
```

Caddy fetches the certificate on first start. Check:

- `https://<ARC_DOMAIN>/console`: sign in as the owner, then Account → Security → turn on
  two-step sign-in and keep the recovery codes in your password manager.
- `https://<ARC_DOMAIN>/dashboard`: the customer dashboard (sign-up is by invitation unless
  `SIGNUP_MODE=open`).
- `curl https://<ARC_DOMAIN>/readyz`: `"ready": true`.

## 3. Backups, verification, apps

1. Backups: passphrase and nightly cron —
   [operations.md → Backups and restore](operations.md#backups-and-restore). For the off-site
   copy, a Cloud Storage bucket (Standard class, same region) with a service account that can
   write objects to it; see the rclone example there. Copy `secrets/vault-keys.json` and
   `secrets/backup-passphrase` somewhere off the VM.
2. Run `scripts/ops/vps-verify.sh` and keep the report it writes (restore drill, RTO/RPO, load).
3. In the console, add your provider keys, classify models, and issue one ARC key per app. Set
   `ARC_BASE_URL=https://<ARC_DOMAIN>/v1` and `ARC_API_KEY` on Render for Echo and the Studio.
4. Invite customers from Console → Customers.

## Updates

```bash
cd /opt/arc && git fetch && scripts/ops/deploy.sh origin/main            # dry run
scripts/ops/deploy.sh origin/main --approve                             # roll out, auto-rollback
```

## Arm instead of x86

Google's Arm machines (T2A, C4A) work too: CI builds every ARC image for `linux/arm64` and checks
that every third-party image has an Arm build.
