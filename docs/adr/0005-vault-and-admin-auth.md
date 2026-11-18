# ADR 0005 — Credential vault and owner/admin authentication

Status: Accepted · Phase 1

## Vault

- **Envelope encryption:** each secret gets a random 256-bit data key; the secret is sealed with
  AES-256-GCM under that key, and the data key is sealed with AES-256-GCM under a versioned
  key-encryption key (KEK).
- **KEKs live in a key file mounted from outside Postgres** (approved pilot choice); the path is
  `ARC_VAULT_KEY_FILE`. Move to a KMS later without a schema change.
- **AAD binds each ciphertext to `tenant:credential`**, so ciphertext copied to another row or
  tenant does not decrypt.
- **Rotation:** add a KEK version, then re-wrap data keys (`vault-rewrap`). Ciphertexts do not
  change.
- Only `CredentialService` holds the key ring. Plaintext is used for provider calls and never
  returned by the API; UIs get a `****last4` hint.

## Owner/admin authentication

- Passwords: scrypt (N=2^15, r=8, p=1), 12–256 characters, timing-safe comparison, dummy hash for
  unknown emails to avoid enumeration by timing.
- Sessions: 256-bit opaque tokens, only SHA-256 stored, HttpOnly + Secure + SameSite=Strict
  cookie scoped to `/admin`, 12h default TTL, revocable.
- Login throttling: per email and per IP, in memory. **Move to Redis before running more than one
  API instance.**
- The platform owner is created once by CLI (`create-owner`); there is no public signup yet.

## Deferred (tracked in the plan)

Owner MFA, email verification, password reset, Google sign-in, invitations and customer signup
arrive with full customer auth (Phase 7). Until then the admin API should only be exposed over
HTTPS, ideally restricted by network/firewall.
