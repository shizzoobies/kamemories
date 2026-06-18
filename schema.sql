-- Wedding photo collection schema
CREATE TABLE IF NOT EXISTS uploads (
  id           TEXT PRIMARY KEY,
  gid          TEXT NOT NULL,        -- anonymous device token (cookie), used for the per-day cap
  day          TEXT NOT NULL,        -- YYYY-MM-DD event day key, rolls over at 2am venue time
  created_at   INTEGER NOT NULL,     -- epoch ms
  r2_key       TEXT NOT NULL,        -- object key in R2 (full size)
  thumb_key    TEXT,                 -- object key in R2 for the small thumbnail, if one was made
  kind         TEXT NOT NULL,        -- 'photo' or 'motion'
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  caption      TEXT,
  guest_name   TEXT,
  approved     INTEGER NOT NULL DEFAULT 0,  -- 1 once an owner approves it for the public gallery
  featured     INTEGER NOT NULL DEFAULT 0,  -- 1 to also show it on the home page strip (implies approved)
  approved_at  INTEGER               -- epoch ms when first approved, used to order public views
);

CREATE INDEX IF NOT EXISTS idx_uploads_gid_day ON uploads (gid, day);
CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_approved ON uploads (approved, approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_featured ON uploads (featured, approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_r2key ON uploads (r2_key);
