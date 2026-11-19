-- Phase 3: routing policy, performance observations and precomputed route scores.

-- Policy per tenant (application_id NULL) or per application (overrides the tenant row).
CREATE TABLE routing_policies (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  application_id         uuid REFERENCES applications (id) ON DELETE CASCADE,
  -- NULL = every jurisdiction allowed.
  allowed_jurisdictions  text[]
                         CHECK (allowed_jurisdictions IS NULL OR
                                allowed_jurisdictions <@ ARRAY['US', 'EU', 'UK', 'CA', 'CN', 'SELF_HOSTED']::text[]),
  -- Owner keys are free-only unless the platform owner explicitly allows paid models.
  allow_paid_owner_keys  boolean NOT NULL DEFAULT false,
  updated_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX routing_policies_scope
  ON routing_policies (tenant_id, COALESCE(application_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Per-minute outcome counters per (key, model), written in batches off the request path.
CREATE TABLE route_observations (
  account_id   uuid NOT NULL REFERENCES provider_accounts (id) ON DELETE CASCADE,
  model_id     uuid NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  bucket       timestamptz NOT NULL,
  requests     integer NOT NULL DEFAULT 0,
  successes    integer NOT NULL DEFAULT 0,
  rate_limited integer NOT NULL DEFAULT 0,
  errors       integer NOT NULL DEFAULT 0,
  timeouts     integer NOT NULL DEFAULT 0,
  ttfb_ms_sum  double precision NOT NULL DEFAULT 0,
  ttfb_samples integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, model_id, bucket)
);
CREATE INDEX route_observations_bucket ON route_observations (bucket);

-- Rankings computed by the worker. The request path only reads these (never waits on them).
CREATE TABLE route_scores (
  account_id      uuid NOT NULL REFERENCES provider_accounts (id) ON DELETE CASCADE,
  model_id        uuid NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  samples         integer NOT NULL,
  success_rate    double precision NOT NULL,
  avg_ttfb_ms     double precision NOT NULL,
  expected_ms     double precision NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, model_id)
);
