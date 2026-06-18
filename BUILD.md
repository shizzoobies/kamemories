# BUILD.md

The finished source is in this repo and is deployed. To stand it up fresh or to verify, follow these steps. The full contract lives in `CLAUDE.md`. Honor every rule there, especially no em dashes.

## Deploy

1. `npm install`
2. `npx wrangler login` (or use an existing session)
3. `npx wrangler d1 create wedding-photos`, then paste the printed `database_id` into `wrangler.toml`.
4. `npx wrangler r2 bucket create wedding-photos`
5. Set `EVENT_NAME`, `DAILY_LIMIT`, and `CAPTURE_HOST` in `wrangler.toml` under `[vars]`.
6. `npx wrangler secret put ALBUM_KEY` (the owner and curation key).
7. `npm run db:init` to create the table on the remote D1.
8. Add both custom domains as `[[routes]]` with `custom_domain = true`: the apex and the capture subdomain.
9. `npm run deploy`.

## Acceptance checklist

Run all of these and confirm green before calling it done.

- A grep for the em and en dash characters across our files (excluding node_modules) returns nothing.
- `node --check` passes for `src/index.js` and every file in `public/`.
- `pics.tandcknot.com` root serves the capture app. The apex root serves the landing.
- An upload lands pending: it is absent from `/api/public/photos`, and its media returns 401 without the owner key.
- Approve makes a photo public (gallery and media). Feature also adds it to the home strip. Both require the owner key.
- The quota day key rolls at 2am Eastern: an upload at 1:59am Friday Eastern keys to Thursday, 2:00am Friday keys to Friday.
- Uploading more than `DAILY_LIMIT` times from one browser in one quota day returns 429.
- A non-image upload is rejected with 415.
- `npm run deploy` succeeds and the live capture page captures and uploads from a phone.
