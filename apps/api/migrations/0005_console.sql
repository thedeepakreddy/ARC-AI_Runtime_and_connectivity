-- Phase 6 (console). Expand-only: safe with the previous release still running.

-- Restricted-free models keep the provider's terms in view (e.g. "50 requests/day, no commercial use").
ALTER TABLE models ADD COLUMN terms_note text CHECK (length(terms_note) <= 500);

-- Per-app traffic, one row per minute, app, route and outcome. Written in batches off the request
-- path; metadata only (no prompts or responses). Pruned by the worker.
CREATE TABLE request_rollups (
  bucket          timestamptz NOT NULL,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  application_id  uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  endpoint        text NOT NULL,
  -- Empty when no route was chosen (e.g. no eligible model).
  provider_id     text NOT NULL DEFAULT '',
  model_name      text NOT NULL DEFAULT '',
  account_id      text NOT NULL DEFAULT '',
  requests        integer NOT NULL DEFAULT 0,
  errors          integer NOT NULL DEFAULT 0,
  fallbacks       integer NOT NULL DEFAULT 0,
  overhead_ms_sum double precision NOT NULL DEFAULT 0,
  overhead_n      integer NOT NULL DEFAULT 0,
  duration_ms_sum double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, application_id, endpoint, provider_id, model_name, account_id)
);
CREATE INDEX request_rollups_tenant_bucket ON request_rollups (tenant_id, bucket);
