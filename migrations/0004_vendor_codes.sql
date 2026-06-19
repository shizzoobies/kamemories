-- Vendor referral discount codes and their redemptions.
--
-- A vendor gets a code worth up to a 50% pool. They pick the discount_pct passed
-- to the customer; the rest of the pool (pool_pct - discount_pct) is commission we
-- owe the vendor, and we keep the remaining 50%. Each code is backed by a Stripe
-- coupon + promotion code so it works at checkout; every paid redemption is logged
-- so the operator console can show commission owed per vendor.
CREATE TABLE IF NOT EXISTS vendor_codes (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL,
  vendor_name    TEXT NOT NULL,
  vendor_email   TEXT,
  discount_pct   INTEGER NOT NULL,
  pool_pct       INTEGER NOT NULL DEFAULT 50,
  stripe_coupon  TEXT,
  stripe_promo   TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_codes_code ON vendor_codes (code);
CREATE INDEX IF NOT EXISTS idx_vendor_codes_promo ON vendor_codes (stripe_promo);

CREATE TABLE IF NOT EXISTS vendor_redemptions (
  id               TEXT PRIMARY KEY,
  code_id          TEXT NOT NULL,
  event_id         TEXT,
  gross_cents      INTEGER NOT NULL,
  discount_cents   INTEGER NOT NULL,
  commission_cents INTEGER NOT NULL,
  stripe_session   TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendor_redemptions_code ON vendor_redemptions (code_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_redemptions_session ON vendor_redemptions (stripe_session);
