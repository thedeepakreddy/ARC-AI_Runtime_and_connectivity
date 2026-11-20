-- Phase 6 (customer dashboard). Expand-only: safe with the previous release still running.

-- Invitations. With tenant_id NULL, the platform owner invites a new customer: accepting creates
-- their organization (role owner). Otherwise a tenant admin invites someone to that tenant.
-- Only the token's SHA-256 is stored; the link is shown once to the person who invites.
CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants (id) ON DELETE CASCADE,
  email       text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  token_hash  bytea NOT NULL UNIQUE,
  invited_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX invitations_tenant ON invitations (tenant_id, created_at DESC);
