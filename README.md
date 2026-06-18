# Tristin & Cory

A premium wedding website and photo collector, on Cloudflare (Workers + D1 + R2).

## The site

- Landing: https://tandcknot.com . Hero, the couple's names, date and venue, a "from the weekend" featured strip, and a link to the gallery.
- Gallery: https://tandcknot.com/gallery . The approved photos, public.
- Curation console (couple only): https://tandcknot.com/curate?k=ALBUM_KEY . Approve, feature, and remove.
- Capture app (guests): https://pics.tandcknot.com . The QR code points here.
- QR card maker: https://tandcknot.com/qr .

## How it works

1. A guest scans the QR, lands on pics.tandcknot.com, and takes or picks a photo.
2. The photo uploads and lands pending. It is visible to no one public.
3. The couple opens the curation console, where every upload shows with a Pending, Approved, or Featured badge.
4. Approve sends a photo to the public gallery. Feature also puts it on the home page strip. Remove deletes it.

Nothing is public until the couple approves it.

## The hero photo

Drop a landscape photo of the couple at `public/assets/hero.jpg` and deploy. The landing detects it and shows it in the framed card under the names. No code change needed.

## Deploy and update

wrangler is set up. To deploy:

```
npm install
npm run deploy
```

Push to deploy is available through GitHub Actions once you add a Cloudflare API token as the repo secret `CLOUDFLARE_API_TOKEN` (Settings, then Secrets and variables, then Actions). After that, every push to main ships.

## Settings

- Daily limit and event name: `wrangler.toml` under `[vars]` (DAILY_LIMIT, EVENT_NAME).
- Owner key: set with `npx wrangler secret put ALBUM_KEY`. This is the curation password and the key in the console link.
- Capture subdomain: CAPTURE_HOST in `wrangler.toml` under `[vars]`, plus the matching `[[routes]]` entry.

## Rules and limits

- 10 posts per day per phone, best effort (anonymous device cookie). Change DAILY_LIMIT.
- The quota day rolls over at 2am Eastern, so a late night counts toward that night.
- Photos only.
- Built for about 40 guests over a 4 day weekend. Comfortably inside Cloudflare free tiers.

## Costs

For one wedding this sits inside Cloudflare's free tiers in almost every realistic case. R2 has a free storage allowance and no egress fees. D1 and Workers free tiers cover this volume easily.
