# kamemories

Photo sharing for events, on Cloudflare (Workers + D1 + R2). Organizers create an
event, get their own subdomain and QR code, and curate a beautiful gallery from
the photos their guests share. Multi-tenant: one Worker serves every event.

It started as tandcknot, a single wedding photo app. kamemories turns that into a
product you can sell access to, one event at a time.

## How it works

1. An organizer signs in with a one-time email link and creates an event. The
   event gets its own address, `yourname.kamemories.com`, and a printable QR.
2. Guests scan the QR, land on the event subdomain, and post photos from their
   phones. No app, no account. Every upload lands pending.
3. The organizer opens the dashboard, where each photo shows Pending, Approved,
   or Featured. Approve sends it to the public gallery; feature also puts it on
   the event home page.

Nothing is public until the organizer approves it.

## The two planes

- `kamemories.com` and `www`: marketing, login, and the dashboard.
- `{slug}.kamemories.com`: one event's landing, gallery, and guest capture page.

## Status

The multi-tenant core is built: signup and magic-link login, the organizer
dashboard, event creation, tenant-scoped curation, and the guest-facing event
pages. Billing (Stripe, one-time per event) is the next pass and is not wired up
yet; new events are created live with no paywall.

## Run it

See `BUILD.md` for the full stand-up. Quick local dev:

```
npm install
npm run dev
```

Then open `http://localhost:8787` for the control plane. After you create an
event with slug `demo`, open `http://demo.localhost:8787`. Without an email
provider configured, the login endpoint returns the magic link directly so you
can sign in locally.

## Settings

- Root domain, reserved subdomains, and the mail-from address: `wrangler.toml`
  under `[vars]` (`ROOT_HOST`, `RESERVED_SUBDOMAINS`, `MAIL_FROM`).
- Email provider for magic links: `npx wrangler secret put RESEND_API_KEY`.
- Per-event name, date, venue, daily limit, time zone, and status are edited in
  the dashboard.

## Costs

Cloudflare Workers, D1, and R2 free tiers cover a large number of small events.
R2 has a free storage allowance and no egress fees.

## Reference

The original single-tenant app, kept unaltered for reference, lives at
`D:\tandcknot` (https://github.com/shizzoobies/tandcknot). Do not change it.
