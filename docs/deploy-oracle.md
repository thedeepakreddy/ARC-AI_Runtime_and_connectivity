# Deploying ARC on Oracle Cloud Always Free ($0, 24/7)

One Always Free Arm VM runs the whole stack with Docker Compose: Postgres, Redis, LiteLLM, the
ARC API and worker, Caddy (HTTPS), Prometheus and Alertmanager. ARC needs about 2.3 GB of memory
with two LiteLLM workers (measured); Oracle's free Arm VM has 12–24 GB. CI builds every ARC image
for `linux/arm64` and checks every third-party image has an Arm build, so what passes CI runs
here. Allow about an hour. (Paid alternative: [deploy-gcp.md](deploy-gcp.md).)

## What you need first

- [ ] An Oracle Cloud account (Always Free; a card is asked for identity, nothing is charged).
      Then **Billing → Budgets: a $1 budget alert.**
- [ ] A domain or free subdomain (e.g. `arc-you.duckdns.org`) you can point at the VM.
- [ ] An email for Let's Encrypt notices, and a Gmail App Password (Google Account → Security →
      2-Step Verification on → App passwords) for alerts and account emails.
- [ ] Optional: an Object Storage bucket `arc-backups` (20 GB free) for off-site backups.

## 1. The VM

1. Compute → Instances → Create: image **Canonical Ubuntu 24.04**, shape
   **VM.Standard.A1.Flex** (Ampere). Take what the Always Free allowance offers (4 OCPU / 24 GB,
   or 2 OCPU / 12 GB). Add your SSH key. "Out of capacity" is common for free Arm VMs: try
   another availability domain, or retry later.
2. Networking → the VM's subnet → Security List → add **ingress** TCP 80 and 443 from
   `0.0.0.0/0` (and UDP 443 for HTTP/3). Leave 8080 closed: ARC listens on loopback only.
3. Networking → IP management → Reserved public IPs: reserve one (free) and attach it to the VM,
   so the address never changes. Point your domain's A record at it.
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
cd /opt/arc && cp .env.example .env && mkdir -p secrets
```

Edit `.env`:

- real `POSTGRES_PASSWORD` and `LITELLM_MASTER_KEY` (`openssl rand -hex 24`; the LiteLLM key
  must start with `sk-`);
- `ARC_DOMAIN`, `ACME_EMAIL`, `PUBLIC_URL=https://<ARC_DOMAIN>`, `TRUST_PROXY=true`;
- `LITELLM_NUM_WORKERS=2` on 2 OCPU (4 on 4 OCPU);
- the `ALERT_*` settings, with the Gmail App Password in `secrets/smtp-password` (alerts,
  password-reset and confirmation emails);
- optionally `GOOGLE_CLIENT_ID` and the AdSense settings
  ([operations.md → Accounts](operations.md#accounts-two-step-sign-in-password-reset-email-google),
  [operations.md → Ads](operations.md#ads-in-the-customer-dashboard)).

Then follow [operations.md → First-time setup](operations.md#first-time-setup-pilot-server)
(vault key, owner), starting the stack with HTTPS and monitoring:

```bash
docker compose --profile https --profile monitoring up -d --build
```

Caddy fetches the certificate on first start. Check:

- `https://<ARC_DOMAIN>/console`: sign in as the owner, then Account → Security → turn on
  two-step sign-in and keep the recovery codes in your password manager.
- `https://<ARC_DOMAIN>/dashboard`: the customer dashboard (sign-up is by invitation unless
  `SIGNUP_MODE=open`).
- `curl https://<ARC_DOMAIN>/readyz`: `"ready": true`.

Every service restarts by itself (`restart: unless-stopped`), and Docker starts on boot, so ARC
comes back on its own after a reboot.

## 3. Backups, verification, apps

1. Backups: passphrase and nightly cron —
   [operations.md → Backups and restore](operations.md#backups-and-restore). For the off-site
   copy to Oracle Object Storage, create a Customer Secret Key (Profile → Customer secret keys)
   and use rclone's S3 type in `secrets/rclone.conf`:

```ini
[oci]
type = s3
provider = Other
access_key_id = <customer secret key id>
secret_access_key = <customer secret key>
endpoint = https://<namespace>.compat.objectstorage.<region>.oraclecloud.com
region = <region>
```

with `BACKUP_RCLONE_REMOTE=oci:arc-backups` in `.env`. Copy `secrets/vault-keys.json` and
`secrets/backup-passphrase` somewhere off the VM. 2. Run `scripts/ops/vps-verify.sh` and keep the report it writes (restore drill, RTO/RPO, load). 3. In the console, add your provider keys, classify models, and issue one ARC key per app. Set
`ARC_BASE_URL=https://<ARC_DOMAIN>/v1` and `ARC_API_KEY` on Render for Echo and the Studio. 4. Invite customers from Console → Customers.

## Updates

```bash
cd /opt/arc && git fetch && scripts/ops/deploy.sh origin/main            # dry run
scripts/ops/deploy.sh origin/main --approve                             # roll out, auto-rollback
```

## Keeping it 24/7 and free

- Oracle may reclaim an Always Free VM it finds idle for 7 days (CPU, network and memory all
  under 20%). **Upgrade the account to Pay-As-You-Go** (Billing → Upgrade): Always Free resources
  stay free, idle reclamation stops, and the $1 budget alert catches anything paid.
- Stay inside the Always Free allowance: one A1 VM within the free OCPU/GB, ≤ 200 GB block
  storage, the reserved IP, 20 GB Object Storage.
