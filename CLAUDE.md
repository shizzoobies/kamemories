# CLAUDE.md

Project memory for Claude Code. Read this before changing anything.

## What this is

A premium wedding website and photo collector for Tristin & Cory, running entirely on Cloudflare (Workers + D1 + R2). One Worker serves two domains:

- tandcknot.com: the public site. A landing page (hero, the couple's names, date, and venue, a "from the weekend" featured strip, and a link to the gallery), a public approved gallery at /gallery, and the couple's curation console at /curate.
- pics.tandcknot.com: the guest capture app. This is where the QR code points.

Guests take or pick a photo on pics.tandcknot.com. Every upload lands pending, visible to no one public. The couple approves photos into the public gallery from /curate, and can feature a subset on the home page. Nothing is public until they approve it.

Built by Alex for the couple. Wedding is July 9 to 12, 2026 in Orlando.

## Hard rules

- No em dashes. Ever. Not in code comments, UI copy, docs, or commit messages. Use periods, commas, parentheses, or restructure. Verify with a grep for the em and en dash characters across our files (not node_modules) and confirm it returns nothing.
- No frontend build step and no frontend dependencies. Plain HTML, CSS, and vanilla JS in public/. The only browser-loaded externals are Google Fonts and, on qr.html only, a QR library from a CDN.
- No new backend dependencies beyond Wrangler. The Worker is a single file of plain JS using only the Workers runtime (D1, R2, assets, Intl, crypto).

## Locked product decisions

Do not reverse these without being asked.

- Two-tier curation. Uploads land pending (approved = 0). Approve sends a photo to the public gallery. Feature also shows it on the home page strip, and implies approval. Owner only, via ALBUM_KEY.
- Pending photos are private. They never appear in any public API, and their media returns 401 without the owner key. Approved media is public.
- Photos only. No video. The client and the Worker both reject non-images.
- 10 posts per day per phone, server enforced, anonymous device cookie (gid). Best effort by design.
- The quota day rolls over at 2am Eastern (Orlando is Eastern). Controlled by EVENT_TZ and DAY_ROLLOVER_HOURS in src/index.js.
- Palette is Midnight Pearl: deep navy base, brushed silver accent (the --sheen gradient), warm ivory, slate. Fonts Fraunces (display) and Hanken Grotesk (UI). Do not reintroduce the old warm dusk gold.
- The capture app lives on pics.tandcknot.com. The apex is the landing.

## Architecture and routing

One Worker (src/index.js) bound to two custom domains. The Worker handles /api/* and /media/*; everything else is a static asset from public/.

The root path is special. `[assets] run_worker_first = ["/"]` in wrangler.toml makes the Worker run before assets for "/", so it can serve the capture page on pics (it fetches the extensionless /capture, not /capture.html, to avoid the assets redirect) and the landing on the apex.

## Stack and bindings

- DB to a D1 database named wedding-photos
- BUCKET to an R2 bucket named wedding-photos
- ASSETS to static files in public/
- Vars: EVENT_NAME, DAILY_LIMIT, CAPTURE_HOST
- Secret: ALBUM_KEY (the owner and curation key)

## File map

```
wrangler.toml          bindings, vars, routes, run_worker_first, account_id
schema.sql             D1 table and indexes
migrations/            additive D1 migrations (0001 adds curation columns)
src/index.js           the Worker: routing, quota, upload, public and owner photos, approve, feature, media
public/index.html      landing (loads index.js)
public/index.js        landing: hero photo, featured strip
public/capture.html    guest capture app, served on pics, loads app.js
public/app.js          camera, capture, downscale, thumbnail, upload, quota UI
public/gallery.html    public approved gallery, loads gallery.js
public/gallery.js      gallery grid, infinite scroll, lightbox, download
public/curate.html     owner curation console, loads curate.js
public/curate.js       approve, feature, remove, filter by status
public/qr.html         printable QR card, points to pics
public/styles.css      Midnight Pearl theme for all pages
public/favicon.svg     navy and silver mark
public/assets/hero.jpg landing hero photo, optional, auto-detected
```

## API contract

- GET /api/quota returns {used, limit, remaining, event}. Sets the gid cookie if missing.
- POST /api/upload (multipart: file, optional thumb, kind, caption, name) returns {ok, id, remaining, limit}. Lands approved = 0. Errors: 429 limit, 400 bad or no file, 413 over MAX_BYTES, 415 non-image.
- GET /api/public/photos?scope=gallery|featured is public and returns approved (or featured) photos only.
- GET /api/photos (owner key) returns all photos with curation state.
- POST /api/photos/approve (owner, JSON {id, approved}). Unapproving also unfeatures.
- POST /api/photos/feature (owner, JSON {id, featured}). Featuring implies approval.
- POST /api/photos/delete (owner, JSON {id}) deletes the row and both R2 objects.
- GET /media/:key is public when the photo is approved, otherwise the owner key is required. Thumbnail keys (uuid.t.ext) map back to the full row for the check.

## D1 schema

uploads(id, gid, day, created_at, r2_key, thumb_key, kind, content_type, size, caption, guest_name, approved, featured, approved_at), with indexes on (gid, day), (created_at desc), (approved, approved_at desc), (featured, approved_at desc), and (r2_key). R2 key format: {eventSlug}/{day}/{uuid}.{ext}; the thumbnail is the same with a .t before the extension.

## Worker constants

MAX_BYTES = 50MB, ALLOWED_PREFIXES = ["image/"], EVENT_TZ = America/New_York, DAY_ROLLOVER_HOURS = 2. Client MAX_EDGE = 2200, thumbnail long edge 480.

## Deploy and dev

wrangler is authed. Deploy with `npm run deploy`. A GitHub Actions workflow deploys on push to main once the CLOUDFLARE_API_TOKEN repo secret is set. D1 changes go in migrations/ and run with `npx wrangler d1 execute wedding-photos --remote --file=...`.

Owner console: tandcknot.com/curate?k=ALBUM_KEY (the key is remembered and stripped from the URL). QR card: tandcknot.com/qr. Hero photo: drop a landscape image at public/assets/hero.jpg.

## Conventions

Keep the Worker a single file with small named helpers. Keep the frontend framework free and readable. UI copy is warm and short. The theme is Midnight Pearl in styles.css.
