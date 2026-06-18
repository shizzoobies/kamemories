-- 0001_init: kamemories multi-tenant schema.
-- Mirrors schema.sql. Apply with: npx wrangler d1 migrations apply kamemories --remote
-- (or run schema.sql directly with: npm run db:init)

CREATE TABLE IF NOT EXISTS organizers (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  name        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizers_email ON organizers (email);

CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash   TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_org ON login_tokens (organizer_id);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash      TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions (organizer_id);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  tagline      TEXT,
  event_date   TEXT,
  venue        TEXT,
  theme        TEXT NOT NULL DEFAULT 'midnight-pearl',
  daily_limit  INTEGER NOT NULL DEFAULT 10,
  event_tz     TEXT NOT NULL DEFAULT 'America/New_York',
  rollover_h   INTEGER NOT NULL DEFAULT 2,
  status       TEXT NOT NULL DEFAULT 'active',
  plan         TEXT,
  paid_at      INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_slug ON events (slug);
CREATE INDEX IF NOT EXISTS idx_events_org ON events (organizer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS uploads (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL,
  gid          TEXT NOT NULL,
  day          TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  r2_key       TEXT NOT NULL,
  thumb_key    TEXT,
  kind         TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  caption      TEXT,
  guest_name   TEXT,
  approved     INTEGER NOT NULL DEFAULT 0,
  featured     INTEGER NOT NULL DEFAULT 0,
  approved_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_uploads_event_gid_day ON uploads (event_id, gid, day);
CREATE INDEX IF NOT EXISTS idx_uploads_event_created ON uploads (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_event_approved ON uploads (event_id, approved, approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_event_featured ON uploads (event_id, featured, approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_r2key ON uploads (r2_key);
