-- ARC control plane: tenants, identity, provider registry, credential vault, model catalogue.
-- Every tenant-owned row carries tenant_id; queries must always filter on it.

CREATE TABLE tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('platform', 'personal', 'organization')),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  suspended_at timestamptz
);
-- Exactly one platform (owner) tenant.
CREATE UNIQUE INDEX tenants_one_platform ON tenants (kind) WHERE kind = 'platform';

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  password_hash text NOT NULL,
  is_superadmin boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  disabled_at   timestamptz
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE memberships (
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE applications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  first_party boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  UNIQUE (tenant_id, slug)
);

-- Global provider catalogue (synced from code). Metadata only, never secrets.
CREATE TABLE providers (
  id               text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name     text NOT NULL,
  provider_group   text NOT NULL
                   CHECK (provider_group IN ('core', 'international', 'chinese', 'local', 'speech_embeddings')),
  jurisdiction     text NOT NULL CHECK (jurisdiction IN ('US', 'EU', 'UK', 'CA', 'CN', 'SELF_HOSTED')),
  adapter          text NOT NULL CHECK (adapter IN ('litellm_native', 'openai_compatible')),
  litellm_provider text,
  default_base_url text,
  docs_url         text,
  verified_at      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Envelope-encrypted secrets. The data key is wrapped by a versioned key-encryption key
-- held outside the database. Blobs are iv(12) | tag(16) | ciphertext.
CREATE TABLE credentials (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kek_version integer NOT NULL CHECK (kek_version > 0),
  wrapped_dek bytea NOT NULL,
  ciphertext  bytea NOT NULL,
  secret_hint text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credentials_tenant ON credentials (tenant_id);

-- Any number of keys per provider per tenant.
CREATE TABLE provider_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider_id           text NOT NULL REFERENCES providers (id),
  label                 text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  scope                 text NOT NULL CHECK (scope IN ('owner_private', 'tenant_byok')),
  credential_id         uuid NOT NULL REFERENCES credentials (id),
  base_url              text,
  enabled               boolean NOT NULL DEFAULT true,
  health_status         text NOT NULL DEFAULT 'unknown'
                        CHECK (health_status IN ('unknown', 'healthy', 'rate_limited',
                                                 'invalid_credentials', 'unreachable', 'unsupported')),
  last_validated_at     timestamptz,
  last_validation_error text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_id, label)
);
CREATE INDEX provider_accounts_tenant_provider ON provider_accounts (tenant_id, provider_id);

-- Global model catalogue. Eligibility is evidence-based; UNKNOWN can never be enabled.
CREATE TABLE models (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id              text NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  model_id                 text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 300),
  display_name             text,
  capabilities             text[] NOT NULL DEFAULT '{}'
                           CHECK (capabilities <@ ARRAY['text', 'vision', 'audio_input', 'transcription',
                                  'audio_output', 'embeddings', 'video', 'documents', 'streaming',
                                  'structured_output', 'tools']::text[]),
  eligibility              text NOT NULL DEFAULT 'UNKNOWN'
                           CHECK (eligibility IN ('VERIFIED_FREE', 'RESTRICTED_FREE', 'PAID', 'UNKNOWN')),
  eligibility_evidence_url text,
  eligibility_checked_at   timestamptz,
  enabled                  boolean NOT NULL DEFAULT false,
  source                   text NOT NULL CHECK (source IN ('discovered', 'manual')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_id),
  CONSTRAINT models_eligibility_has_evidence CHECK (
    eligibility = 'UNKNOWN'
    OR (eligibility_evidence_url IS NOT NULL AND eligibility_checked_at IS NOT NULL)
  ),
  CONSTRAINT models_unknown_not_enabled CHECK (NOT enabled OR eligibility <> 'UNKNOWN')
);

-- Which models each key has been observed to serve.
CREATE TABLE account_models (
  account_id uuid NOT NULL REFERENCES provider_accounts (id) ON DELETE CASCADE,
  model_id   uuid NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, model_id)
);

CREATE TABLE audit_events (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid REFERENCES tenants (id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_time ON audit_events (tenant_id, created_at DESC);
