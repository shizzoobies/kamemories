-- Adds curation flags and a thumbnail key to an existing uploads table.
-- Safe to run once on a database created before the curation feature.
ALTER TABLE uploads ADD COLUMN thumb_key TEXT;
ALTER TABLE uploads ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN approved_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_uploads_approved ON uploads (approved, approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_featured ON uploads (featured, approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_r2key ON uploads (r2_key);
