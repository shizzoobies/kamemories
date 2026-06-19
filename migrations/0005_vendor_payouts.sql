-- Vendor payouts: money the operator has actually paid a vendor against the
-- commission owed. Commission owed for a code = SUM(redemption commission) minus
-- SUM(payout amount), so recording a payout for the owed amount zeroes it out. An
-- optional receipt (PDF or image) is stored in R2 under payouts/{code_id}/{uuid}.
CREATE TABLE IF NOT EXISTS vendor_payouts (
  id           TEXT PRIMARY KEY,
  code_id      TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  note         TEXT,
  receipt_key  TEXT,
  receipt_type TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendor_payouts_code ON vendor_payouts (code_id);
