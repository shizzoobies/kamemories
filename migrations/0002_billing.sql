-- 0002_billing: record which Stripe Checkout Session paid for an event.
-- (plan, paid_at, and status already exist from 0001.)
ALTER TABLE events ADD COLUMN stripe_session TEXT;
