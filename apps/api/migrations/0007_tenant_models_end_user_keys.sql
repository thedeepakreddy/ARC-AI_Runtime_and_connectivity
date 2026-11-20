-- Phase 6 (increment 3). Expand-only: safe with the previous release still running (it never
-- reads the new columns or table, and only ever writes the two existing scopes).

-- Customers decide which models their own keys may use. A row overrides the platform owner's
-- classification for that customer's keys only; no row = follow the owner's choice. Owner keys
-- always follow the owner's classification.
CREATE TABLE tenant_models (
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  model_id   uuid NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  enabled    boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, model_id)
);

-- End users' own provider keys, registered by an app that vouches for the user (X-ARC-User).
-- Stored like any other key (encrypted in the vault, under the app's tenant), scoped to one app
-- and one user. The user id itself is never stored: only SHA-256 of "<app id>:<user id>".
ALTER TABLE provider_accounts DROP CONSTRAINT provider_accounts_scope_check;
ALTER TABLE provider_accounts
  ADD CONSTRAINT provider_accounts_scope_check
  CHECK (scope IN ('owner_private', 'tenant_byok', 'end_user'));
ALTER TABLE provider_accounts
  ADD COLUMN application_id uuid REFERENCES applications (id) ON DELETE CASCADE,
  ADD COLUMN end_user_hash  text CHECK (end_user_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE provider_accounts
  ADD CONSTRAINT provider_accounts_end_user_scope
  CHECK ((scope = 'end_user') = (application_id IS NOT NULL AND end_user_hash IS NOT NULL));
CREATE UNIQUE INDEX provider_accounts_end_user_unique
  ON provider_accounts (application_id, end_user_hash, provider_id) WHERE scope = 'end_user';
