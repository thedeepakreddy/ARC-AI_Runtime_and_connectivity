-- Workers report liveness here; the API exposes the age as a metric so an alert can fire
-- when background jobs (scoring, key health checks) silently stop.
CREATE TABLE worker_heartbeats (
  worker_id  text PRIMARY KEY,
  hostname   text NOT NULL,
  started_at timestamptz NOT NULL,
  last_seen  timestamptz NOT NULL DEFAULT now(),
  jobs       jsonb NOT NULL DEFAULT '{}'
);
