-- Revenue ledger and operator package links.
--
-- payments: one row per completed Stripe checkout (event purchase or package
-- link), recorded by the webhook, so the console can total money in by package.
CREATE TABLE IF NOT EXISTS payments (
  id             TEXT PRIMARY KEY,
  stripe_session TEXT,
  event_id       TEXT,
  source         TEXT,
  plan           TEXT,
  label          TEXT,
  amount_cents   INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_session ON payments (stripe_session);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments (created_at DESC);

-- package_links: operator-made Stripe Payment Links for selling a package
-- (standard plan or custom name + price). Paying one auto-creates a draft event.
CREATE TABLE IF NOT EXISTS package_links (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  plan          TEXT,
  amount_cents  INTEGER NOT NULL,
  stripe_price  TEXT,
  stripe_link   TEXT,
  url           TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_package_links_link ON package_links (stripe_link);

-- Backfill historical revenue from events already paid through checkout, netting
-- out any vendor-code discount on that same session. Idempotent on the session.
INSERT OR IGNORE INTO payments (id, stripe_session, event_id, source, plan, label, amount_cents, discount_cents, created_at)
SELECT lower(hex(randomblob(16))), e.stripe_session, e.id, 'event', e.plan,
  CASE e.plan WHEN 'intimate' THEN 'Intimate' WHEN 'signature' THEN 'Signature' WHEN 'grand' THEN 'Grand' ELSE 'Event' END,
  (CASE e.plan WHEN 'intimate' THEN 4900 WHEN 'signature' THEN 9900 WHEN 'grand' THEN 14900 ELSE 0 END)
    - COALESCE((SELECT SUM(vr.discount_cents) FROM vendor_redemptions vr WHERE vr.stripe_session = e.stripe_session), 0),
  COALESCE((SELECT SUM(vr.discount_cents) FROM vendor_redemptions vr WHERE vr.stripe_session = e.stripe_session), 0),
  e.paid_at
FROM events e
WHERE e.paid_at IS NOT NULL AND e.plan IS NOT NULL AND e.stripe_session IS NOT NULL;
