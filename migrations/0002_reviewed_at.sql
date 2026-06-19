-- Adds reviewed_at: epoch ms an operator reviewed a paid booking in the console.
-- NULL means a new booking awaiting confirmation. The Stripe webhook leaves it
-- NULL on a customer payment (so it shows as a new booking); operator-created
-- events set it on insert. Existing rows are backfilled as already reviewed so
-- they do not flood the new-bookings inbox.
ALTER TABLE events ADD COLUMN reviewed_at INTEGER;
UPDATE events SET reviewed_at = COALESCE(paid_at, created_at) WHERE reviewed_at IS NULL;
