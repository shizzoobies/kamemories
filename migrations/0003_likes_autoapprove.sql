-- Auto-approve and guest likes.
--
-- auto_approve: when 1, guest uploads for that event land already approved, so
-- they appear in the public gallery immediately with no manual curation.
ALTER TABLE events ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0;

-- Guest likes ("votes") on public photos. One like per anonymous device (gid)
-- per photo, enforced by the composite primary key so a like is idempotent and
-- can be toggled off. The gallery can sort by COUNT(*) of these per upload.
CREATE TABLE IF NOT EXISTS likes (
  upload_id  TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  gid        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (upload_id, gid)
);
CREATE INDEX IF NOT EXISTS idx_likes_upload ON likes (upload_id);
CREATE INDEX IF NOT EXISTS idx_likes_event ON likes (event_id);
