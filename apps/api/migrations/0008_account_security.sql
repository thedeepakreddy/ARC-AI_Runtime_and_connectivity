-- Phase 7 (account security). Expand-only: safe with the previous release still running.

ALTER TABLE users
  ADD COLUMN email_verified_at timestamptz,
  -- Google account id ("sub"), when the user signs in with Google.
  ADD COLUMN google_sub text UNIQUE,
  -- TOTP secret, sealed with the vault key like provider keys (envelope encryption).
  ADD COLUMN mfa_kek_version integer,
  ADD COLUMN mfa_wrapped_dek bytea,
  ADD COLUMN mfa_ciphertext bytea,
  -- Set once the user has confirmed a code; until then the secret is a pending setup.
  ADD COLUMN mfa_enabled_at timestamptz,
  -- Last TOTP time step accepted: a code can't be used twice.
  ADD COLUMN mfa_last_step bigint;

-- Everyone so far was created by the owner (create-owner) or joined through an invitation for
-- that exact address, so their email is vouched for. New users are too, by default; only an
-- open sign-up (no invitation) starts unverified, explicitly, and confirms by email.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
ALTER TABLE users ALTER COLUMN email_verified_at SET DEFAULT now();

-- One-time tokens: password reset, email verification, the second sign-in step (MFA), and
-- Google sign-in state. Only the SHA-256 of a token is stored.
CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users (id) ON DELETE CASCADE,
  purpose     text NOT NULL
              CHECK (purpose IN ('password_reset', 'email_verify', 'mfa_login', 'oauth_state')),
  token_hash  bytea NOT NULL UNIQUE,
  data        jsonb NOT NULL DEFAULT '{}',
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX auth_tokens_user ON auth_tokens (user_id, purpose);
CREATE INDEX auth_tokens_expiry ON auth_tokens (expires_at);

-- MFA recovery codes: shown once, stored as SHA-256, each usable once.
CREATE TABLE mfa_recovery_codes (
  user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash bytea NOT NULL,
  used_at   timestamptz,
  PRIMARY KEY (user_id, code_hash)
);
