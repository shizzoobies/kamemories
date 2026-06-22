-- Cold-outreach email tracking (first-party). Open pixel, click redirect, and
-- unsubscribe, logged to D1 and surfaced in /admin. Sending stays in Gmail; the
-- Worker only registers each send and serves the /t/ endpoints. Epoch ms times,
-- to match the rest of the schema.

-- The leads list: vendors we reach out to. Email is unique so re-adding dedupes.
CREATE TABLE IF NOT EXISTS outreach_recipients (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  name            TEXT,                       -- vendor / business name
  business_type   TEXT,                       -- photographer, venue, planner, ...
  source          TEXT,                       -- where the lead came from
  status          TEXT NOT NULL DEFAULT 'cold', -- cold|opened|clicked|replied|claimed|signed|unsubscribed
  code_id         TEXT,                       -- joins vendor_codes.id once they sign on
  unsubscribed_at INTEGER,                     -- set on opt-out; suppresses future sends
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_recipients_email ON outreach_recipients (email);

-- One outreach campaign (a template blast).
CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  subject     TEXT,
  created_at  INTEGER NOT NULL
);

-- One row per recipient per campaign. id is the unguessable send token used in
-- the pixel and click URLs.
CREATE TABLE IF NOT EXISTS outreach_sends (
  id              TEXT PRIMARY KEY,           -- send_token (uuid)
  campaign_id     TEXT NOT NULL,              -- joins outreach_campaigns.id
  recipient_id    TEXT,                       -- joins outreach_recipients.id
  recipient_email TEXT NOT NULL,
  subject         TEXT,
  sent_at         INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outreach_sends_campaign ON outreach_sends (campaign_id);
CREATE INDEX IF NOT EXISTS idx_outreach_sends_recipient ON outreach_sends (recipient_id);

-- The links we rewrite to tracked click URLs, one set per campaign. A click's
-- destination is always read from here, never from the request, so the click
-- endpoint cannot be turned into an open redirect.
CREATE TABLE IF NOT EXISTS tracked_links (
  id              TEXT PRIMARY KEY,           -- short id used in /t/c/{token}/{id}
  campaign_id     TEXT NOT NULL,              -- joins outreach_campaigns.id
  label           TEXT,                       -- cta_claim, demo, footer_site, ...
  destination_url TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracked_links_campaign ON tracked_links (campaign_id);

-- Raw open/click/unsub events. Opens from known proxy/scanner user agents are
-- flagged so headline counts can exclude them; clicks are the reliable signal.
CREATE TABLE IF NOT EXISTS tracking_events (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  send_id              TEXT NOT NULL,         -- joins outreach_sends.id
  event_type           TEXT NOT NULL,         -- open|click|unsub
  link_id              TEXT,                  -- set for clicks
  user_agent           TEXT,
  ip                   TEXT,
  country              TEXT,
  is_probably_prefetch INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracking_events_send ON tracking_events (send_id);
CREATE INDEX IF NOT EXISTS idx_tracking_events_type ON tracking_events (event_type);
