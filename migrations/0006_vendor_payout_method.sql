-- How the operator pays a vendor their commission: the platform they chose
-- (venmo | paypal | applepay) and their handle/email/phone on it. Shown in the
-- payout flow so the operator knows where to send the money.
ALTER TABLE vendor_codes ADD COLUMN payout_method TEXT;
ALTER TABLE vendor_codes ADD COLUMN payout_id TEXT;
