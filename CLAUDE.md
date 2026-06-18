# CLAUDE.md

Project memory for Claude Code. Read this before changing anything.

## What this is

kamemories is a commercial, multi-tenant photo collection app for events, on
Cloudflare (Workers + D1 + R2). One Worker serves every host. Event organizers
sign up, create an event, and get their own subdomain with a QR code their
guests scan to share photos. The organizer curates which photos go public.

It grew out of tandcknot, a single wedding photo app (kept unaltered as a
reference at `D:\tandcknot`, repo https://github.com/shizzoobies/tandcknot).
kamemories generalizes that idea into a product you can sell access to.

### The two planes

- Control plane: `kamemories.com` and `www.kamemories.com`. The marketing site,
  magic-link login, and the organizer dashboard (create and manage events,
  curate photos). Everything here is the SaaS itself.
- Event plane: `{slug}.kamemories.com`. One event per subdomain. Serves that
  event's public landing, gallery, and the guest capture app the QR points to.

### Product decisions (locked unless asked)

- Tenancy by subdomain. Each event is `{slug}.kamemories.com`, resolved from the
  hostname. A single wildcard route serves them all.
- Organizer auth is a passwordless email magic link. No Cloudflare Access (that
  cannot self-serve customers). Sessions are cookies, hashed in the DB.
- Monetization is one-time payment per event, via Stripe. NOT YET BUILT. The
  schema is ready: `events.status`, `events.plan`, `events.paid_at`. New events
  are currently created `active` with no paywall. Billing is a later pass.
- Per event, two-tier curation: uploads land pending (approved = 0); approve
  sends a photo to the public gallery; feature also shows it on the event home
  strip and implies approval. Pending media is private.
- Photos only. Per-guest daily upload cap, server enforced via an anonymous
  device cookie (gid), scoped per event. Quota day rolls over at the event's
  `rollover_h` on its `event_tz`.
- Theme is Midnight Pearl (deep navy, brushed silver `--sheen`, warm ivory).
  Fonts Fraunces is not used; we use Playfair Display (display) and Hanken
  Grotesk (UI), with Caveat for handwritten captions.

## Hard rules

- No em dashes or en dashes. Ever. Not in code, UI copy, docs, or commit
  messages. Use periods, commas, parentheses, or restructure. Verify with a grep
  for the em and en dash characters across our files (not node_modules / not
  package-lock.json) and confirm it returns nothing.
- No frontend build step and no frontend dependencies. Plain HTML, CSS, and
  vanilla JS in `public/`. The only browser-loaded externals are Google Fonts
  and, on the dashboard only, a QR library from a CDN.
- No new backend dependencies beyond Wrangler. The Worker is a single file of
  plain JS using only the Workers runtime (D1, R2, assets, Intl, crypto, fetch).
  Email (Resend) and, later, Stripe are called over fetch, not via SDKs.
- Do not alter the tandcknot reference. It is a read-only source of ideas.

## Architecture and routing

One Worker (`src/index.js`). `wrangler.toml` sets `run_worker_first = true`, so
the Worker runs for every request and decides what to do from the hostname.
`hostInfo(url, env)` classifies a request as `control` or `event` (with a slug).
Reserved subdomain labels (`RESERVED_SUBDOMAINS`) and `www` are control plane.
Local dev maps `localhost` to control and `{slug}.localhost` to an event.

Static files in `public/` are served by the Worker through the ASSETS binding.
Clean URLs (`/`, `/login`, `/app`, `/gallery`, `/add`) are mapped to their
`.html` files in the router; other paths fall through to ASSETS.

## Stack and bindings

- DB to a D1 database named `kamemories`.
- BUCKET to an R2 bucket named `kamemories`.
- ASSETS to static files in `public/`.
- Vars: `ROOT_HOST`, `RESERVED_SUBDOMAINS`, `MAIL_FROM`.
- Secrets: `RESEND_API_KEY` (magic-link email; absent = dev mode that returns
  the link in the API response). Later: `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`.

## File map

```
wrangler.toml          bindings, vars, wildcard routes, run_worker_first, account_id
schema.sql             D1 tables and indexes (canonical, used by db:init)
migrations/0001_init.sql  same schema as a wrangler d1 migration
src/index.js           the Worker: host routing, auth, events, curation, media
public/home.html       marketing landing (apex)
public/login.html|js   magic-link request and "check your email" state
public/dashboard.html|js  organizer console: events list, create, curate, settings, QR
public/event.html|js   per-event public landing (subdomain), fills from /api/event
public/gallery.html|js public approved gallery (subdomain)
public/add.html        guest capture page (subdomain), the QR target
public/capture.js      camera, capture, downscale, thumbnail, upload, quota UI
public/event-404.html  shown on a subdomain with no active event
public/styles.css      Midnight Pearl theme plus the commercial layer
public/favicon.svg     navy and silver mark
```

## API contract

Control plane (kamemories.com), session via the `sid` cookie:
- POST `/api/auth/request` {email}. Creates the organizer if new, emails a magic
  link. Returns {ok:true}; in dev mode also {devLink}.
- GET `/auth/verify?token=` consumes a single-use token, sets the session
  cookie, and 302s to `/app`. On failure 302s to `/login?error=`.
- GET `/api/auth/me` returns {organizer:{email,name}} or 401.
- POST `/api/auth/logout` clears the session.
- GET `/api/events` lists the organizer's events with counts.
- POST `/api/events` {name, slug?, tagline?, event_date?, venue?, ...} creates one.
- GET|PATCH|DELETE `/api/events/:id` reads, updates, or deletes (owner only).
- GET `/api/events/:id/photos` returns {event, photos} for curation.
- POST `/api/photos/:id/(approve|feature|delete)` curate a photo (owner of its event).
- GET `/owner-media/:key` serves any of the organizer's media, pending included.

Event plane ({slug}.kamemories.com), scoped to the resolved event:
- GET `/api/event` public event info.
- GET `/api/quota` returns {used, limit, remaining, event}. Sets gid cookie.
- POST `/api/upload` (multipart) lands approved = 0. Errors 429/400/413/415.
- GET `/api/public/photos?scope=gallery|featured` approved (or featured) only.
- GET `/media/:key` public only for this event's approved photos, else 401.

A missing or non-active event returns 404 for API/media and the event-404 page
for navigations.

## D1 schema

`organizers`, `login_tokens` (token_hash), `sessions` (id_hash), `events`,
`uploads`. Tokens and session ids are stored as sha-256 hashes, never raw.
`uploads` is scoped by `event_id`; R2 key format is `{event_id}/{day}/{uuid}.{ext}`
and the thumbnail is the same with a `.t` before the extension. See `schema.sql`.

## Worker constants

`MAX_BYTES` = 50MB, `ALLOWED_PREFIXES` = ["image/"], login token TTL 15 min,
session TTL 30 days. Client `MAX_EDGE` = 2200, thumbnail long edge 480. Per-event
`daily_limit`, `event_tz`, and `rollover_h` live on the event row.

## Deploy and dev

See `BUILD.md`. In short: create the `kamemories` D1 and R2, paste the D1 id into
`wrangler.toml`, run `npm run db:init`, add the apex and wildcard routes plus a
proxied `*.kamemories.com` DNS record, set `RESEND_API_KEY`, then `npm run deploy`.
Local: `npm run dev`, then visit `http://localhost:8787` (control) and
`http://<slug>.localhost:8787` (event). Without `RESEND_API_KEY`, login returns
the magic link in the response.

## Conventions

Keep the Worker a single file with small named helpers. Keep the frontend
framework free and readable. UI copy is warm and short. Authoring and review are
separate passes: never self-approve curation logic or auth changes without a
second look.
