# BUILD.md

How to stand up kamemories fresh and verify it. The full contract lives in
`CLAUDE.md`. Honor every rule there, especially no em dashes.

## Provision (one time)

1. `npm install`
2. `npx wrangler login` (or use an existing session).
3. `npx wrangler d1 create kamemories`, then paste the printed `database_id`
   into `wrangler.toml` (replace `REPLACE_WITH_KAMEMORIES_D1_ID`).
4. `npx wrangler r2 bucket create kamemories`
5. `npm run db:init` to create the tables on the remote D1.
6. `npx wrangler secret put RESEND_API_KEY` (transactional email for magic-link
   login). Set `MAIL_FROM` in `wrangler.toml` to a verified sender.

## Domain and routing

7. Add `kamemories.com` to this Cloudflare account as a zone.
8. Create DNS records, both proxied (orange cloud):
   - the apex `kamemories.com` (and `www`).
   - a wildcard `*.kamemories.com`.
9. The routes in `wrangler.toml` bind the Worker to `kamemories.com/*` and
   `*.kamemories.com/*`. Confirm both attach on deploy.
10. `npm run deploy`.

## Local development

- `npm run dev`, then `http://localhost:8787` is the control plane.
- Create an event in the dashboard, then open `http://<slug>.localhost:8787`.
- Without `RESEND_API_KEY` in `.dev.vars`, the login request returns the magic
  link in its JSON response (and logs it), so you can sign in without email.

## Acceptance checklist

Run all of these and confirm green before calling it done.

- A grep for the em and en dash characters across our files (excluding
  node_modules and package-lock.json) returns nothing.
- `node --check` passes for `src/index.js` and every file in `public/`.
- Apex `/` serves the marketing home. `/login` requests a magic link. Clicking
  the link signs in and lands on `/app`.
- A signed-in organizer can create an event and see it at its subdomain.
- `{slug}.kamemories.com/` serves the event landing; `/add` serves the capture
  app; `/gallery` serves the public gallery.
- An unknown or non-active subdomain shows the event-not-found page (404).
- A guest upload lands pending: it is absent from `/api/public/photos` and its
  `/media` returns 401 on the event subdomain. The organizer sees it in the
  dashboard (served via `/owner-media`).
- Approve makes a photo public (gallery and media). Feature also adds it to the
  event home strip. Both require the organizer's session.
- One organizer cannot read or curate another organizer's events or photos
  (every owner query is scoped by `organizer_id`).
- The per-guest daily limit returns 429 when exceeded; a non-image upload is
  rejected with 415.
- The quota day key rolls at the event's `rollover_h` on its `event_tz`.

## Billing (later)

Stripe one-time per event is not built yet. The schema is ready
(`events.status`, `events.plan`, `events.paid_at`). When added: gate event
`status` behind a successful one-time Checkout, verify the webhook signature,
and set `paid_at`.
