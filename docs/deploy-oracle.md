# Deploying ARC on Oracle Cloud Always Free

One Arm VM runs the whole stack at $0/month (see [costs.md](costs.md)). CI builds every ARC image
for `linux/arm64` and checks that each third-party image has an Arm build, so the same commit
that passes CI runs on the VM. Allow about an hour.

## What you need first

- [ ] An Oracle Cloud account (Always Free), with a **$1 budget alert** (Billing → Budgets).
- [ ] A domain or free subdomain (e.g. `arc-you.duckdns.org`) you can point at the VM.
- [ ] An email for Let's Encrypt notices, and a Gmail App Password for alert emails
      ([operations.md](operations.md#alerts-by-email)).
- [ ] An Object Storage bucket `arc-backups` and a Customer Secret Key, for off-site backups.

## 1. The VM

1. Compute → Instances → Create: image **Canonical Ubuntu 24.04**, shape **VM.Standard.A1.Flex**
   (Ampere). Take what the Always Free allowance offers (4 OCPU / 24 GB, or 2 OCPU / 12 GB after
   Oracle's 2026 change); ARC fits either. Add your SSH key.
2. Networking → the VM's subnet → Security List → add **ingress** TCP 80 and 443 from
   `0.0.0.0/0` (and UDP 443 for HTTP/3). Leave 8080 closed: ARC listens on loopback only.
3. Point your domain's A record at the VM's public IP.
4. On the VM, Oracle's Ubuntu image also firewalls with iptables. Open 80 and 443 there too:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

5. Install Docker (Engine + Compose plugin) from Docker's apt repository
   (docs.docker.com/engine/install/ubuntu), then `sudo usermod -aG docker $USER` and log in again.

## 2. ARC

```bash
sudo mkdir -p /opt/arc && sudo chown $USER /opt/arc
git clone https://github.com/thedeepakreddy/ARC-AI_Runtime_and_connectivity.git /opt/arc
cd /opt/arc && cp .env.example .env
```

Edit `.env`: real `POSTGRES_PASSWORD` and `LITELLM_MASTER_KEY` (`openssl rand -hex 24`),
`ARC_DOMAIN`, `ACME_EMAIL`, `PUBLIC_URL=https://<ARC_DOMAIN>`, `TRUST_PROXY=true`, the `ALERT_*`
settings (also used for password-reset emails), on 2 OCPU `LITELLM_NUM_WORKERS=2`, and
optionally `GOOGLE_CLIENT_ID` ([operations.md → Accounts](operations.md#accounts-two-step-sign-in-password-reset-email-google)). Then follow [operations.md → First-time setup](operations.md#first-time-setup-pilot-server)
(vault key, owner), starting the stack with HTTPS and monitoring:

```bash
docker compose --profile https --profile monitoring up -d --build
```

Caddy fetches the certificate on first start. Check:

- `https://<ARC_DOMAIN>/console` — sign in as the owner, then Account → Security → turn on
  two-step sign-in and keep the recovery codes in your password manager.
- `https://<ARC_DOMAIN>/dashboard` — the customer dashboard (sign-up is by invitation unless
  `SIGNUP_MODE=open`).
- `curl https://<ARC_DOMAIN>/readyz` — `"ready": true`.

## 3. Backups, verification, apps

1. Backups: passphrase, nightly cron and the off-site copy —
   [operations.md → Backups and restore](operations.md#backups-and-restore). Copy
   `secrets/vault-keys.json` and `secrets/backup-passphrase` somewhere off the VM.
2. Run `scripts/ops/vps-verify.sh` and keep the report it writes (restore drill, RTO/RPO, load).
3. In the console, add your provider keys, classify models, and issue one ARC key per app. Set
   `ARC_BASE_URL=https://<ARC_DOMAIN>/v1` and `ARC_API_KEY` on Render for Echo and the Studio.
4. Invite customers from Console → Customers.

## Updates

```bash
cd /opt/arc && git fetch && scripts/ops/deploy.sh origin/main            # dry run
scripts/ops/deploy.sh origin/main --approve                             # roll out, auto-rollback
```

## Keeping the VM

Oracle may reclaim an Always Free VM it finds idle for 7 days (CPU, network and memory all under
20%). ARC's background jobs alone may not be enough. Upgrading the account to Pay-As-You-Go stops
reclamation while Always Free resources stay free; keep the $1 budget alert.
