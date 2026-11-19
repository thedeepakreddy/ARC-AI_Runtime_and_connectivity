-- ARC API keys issued to applications. Format: ARC_DEE_<key_id>_PAK_<secret>.
-- key_id is a non-secret lookup handle; only SHA-256(secret) is stored.
CREATE TABLE api_keys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  key_id         text NOT NULL UNIQUE CHECK (key_id ~ '^[0-9A-Za-z]{17}$'),
  secret_hash    bytea NOT NULL CHECK (length(secret_hash) = 32),
  display_prefix text NOT NULL,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  scopes         text[] NOT NULL DEFAULT ARRAY['inference', 'models:read']::text[]
                 CHECK (scopes <@ ARRAY['inference', 'models:read']::text[] AND cardinality(scopes) > 0),
  created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  expires_at     timestamptz,
  revoked_at     timestamptz
);
CREATE INDEX api_keys_application ON api_keys (application_id);
CREATE INDEX api_keys_tenant ON api_keys (tenant_id);
