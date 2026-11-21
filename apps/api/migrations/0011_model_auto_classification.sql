-- Automatic model classification. Expand-only: the previous release ignores both columns.

-- Who classified the model: 'auto' (from the provider's own listing, re-applied when a key is
-- validated) or 'owner' (changed by hand; never overwritten). NULL: never classified.
ALTER TABLE models ADD COLUMN classified_by text CHECK (classified_by IN ('auto', 'owner'));
-- The latest automatic suggestion, kept so the owner can see it and go back to it.
ALTER TABLE models ADD COLUMN suggestion jsonb;

-- Models the owner has already classified stay theirs.
UPDATE models SET classified_by = 'owner' WHERE eligibility <> 'UNKNOWN' OR enabled;
