-- kamemories multi-tenant schema (Cloudflare D1 / SQLite)
--
-- One Worker serves many events. The control plane (kamemories.com) owns
-- organizers, login, and the dashboard. Each event is a subdomain
-- ({slug}.kamemories.com) and all of its guest uploads are scoped by event_id.

-- Paying customers who create and run events.
CREATE TABLE IF NOT EXISTS organizers (
  id          TEXT PRIMARY KEY,        -- uuid
  email       TEXT NOT NULL,           -- login identity
  name        TEXT,
  created_at  INTEGER NOT NULL         -- epoch ms
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizers_email ON organizers (email);

-- Magic-link login tokens. We store only a hash of the token, never the raw value.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash   TEXT PRIMARY KEY,       -- sha-256 of the raw token sent by email
  organizer_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER                 -- set once redeemed, single use
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_org ON login_tokens (organizer_id);

-- Logged-in sessions. We store only a hash of the session id, never the raw cookie.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash      TEXT PRIMARY KEY,       -- sha-256 of the raw sid cookie value
  organizer_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions (organizer_id);

-- Events (tenants). Each maps to one subdomain: {slug}.kamemories.com
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,       -- uuid, used as the R2 key prefix
  organizer_id TEXT NOT NULL,          -- owner
  slug         TEXT NOT NULL,          -- subdomain label, e.g. tristin-cory
  name         TEXT NOT NULL,          -- display name, e.g. "Tristin & Cory"
  tagline      TEXT,                   -- hero eyebrow, e.g. "Together with their families"
  event_date   TEXT,                   -- free text, e.g. "July 9-12, 2026"
  venue        TEXT,                   -- free text, e.g. "Orlando, Florida"
  theme        TEXT NOT NULL DEFAULT 'midnight-pearl',
  daily_limit  INTEGER NOT NULL DEFAULT 10,    -- uploads per guest device per day
  event_tz     TEXT NOT NULL DEFAULT 'America/New_York',
  rollover_h   INTEGER NOT NULL DEFAULT 2,     -- quota day rolls over at this local hour
  auto_approve INTEGER NOT NULL DEFAULT 0,     -- 1 = guest uploads go straight to the public gallery, no manual approval
  status       TEXT NOT NULL DEFAULT 'active', -- active | draft | archived (billing gates this later)
  plan         TEXT,                   -- billing tier (intimate | signature | grand), set on payment
  paid_at      INTEGER,                -- epoch ms of the one-time payment
  stripe_session TEXT,                 -- Checkout Session id that paid for this event
  created_at   INTEGER NOT NULL,
  reviewed_at  INTEGER                 -- epoch ms an operator reviewed this booking; NULL = a new booking awaiting confirmation
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_slug ON events (slug);
CREATE INDEX IF NOT EXISTS idx_events_org ON events (organizer_id, created_at DESC);

-- Guest uploads, scoped to an event. Every upload lands pending (approved = 0).
CREATE TABLE IF NOT EXISTS uploads (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL,          -- tenant scope, joins events.id
  gid          TEXT NOT NULL,          -- anonymous guest device token (cookie), for the per-day cap
  day          TEXT NOT NULL,          -- YYYY-MM-DD event day key, rolls over at rollover_h venue time
  created_at   INTEGER NOT NULL,       -- epoch ms
  r2_key       TEXT NOT NULL,          -- object key in R2 (full size): {event_id}/{day}/{uuid}.{ext}
  thumb_key    TEXT,                   -- object key for the small thumbnail, if one was made
  kind         TEXT NOT NULL,          -- 'photo'
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  caption      TEXT,
  guest_name   TEXT,
  approved     INTEGER NOT NULL DEFAULT 0,  -- 1 once the organizer approves it for the public gallery
  featured     INTEGER NOT NULL DEFAULT 0,  -- 1 to also show it on the event home strip (implies approved)
  approved_at  INTEGER                 -- epoch ms when first approved, used to order public views
);
CREATE INDEX IF NOT EXISTS idx_uploads_event_gid_day ON uploads (event_id, gid, day);
CREATE INDEX IF NOT EXISTS idx_uploads_event_created ON uploads (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_event_approved ON uploads (event_id, approved, approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_event_featured ON uploads (event_id, featured, approved_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_r2key ON uploads (r2_key);

-- Guest likes ("votes") on public photos. One like per anonymous device (gid)
-- per photo: the composite primary key makes a like idempotent and toggleable.
-- A public gallery sorts by COUNT(*) of these per upload.
CREATE TABLE IF NOT EXISTS likes (
  upload_id  TEXT NOT NULL,          -- joins uploads.id
  event_id   TEXT NOT NULL,          -- tenant scope, joins events.id
  gid        TEXT NOT NULL,          -- anonymous guest device token (cookie)
  created_at INTEGER NOT NULL,       -- epoch ms
  PRIMARY KEY (upload_id, gid)
);
CREATE INDEX IF NOT EXISTS idx_likes_upload ON likes (upload_id);
CREATE INDEX IF NOT EXISTS idx_likes_event ON likes (event_id);
