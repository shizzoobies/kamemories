// Wedding photo collection - Cloudflare Worker
// Handles /api/* and /media/*. Everything else is served from the static assets binding.
//
// Curation model: every guest upload starts pending (approved = 0) and is visible to
// nobody public. An owner (holds ALBUM_KEY) approves photos into the public gallery and
// can feature a subset on the home page. Featuring implies approval.

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB hard ceiling per upload
const ALLOWED_PREFIXES = ["image/"];

// Quota day boundary. A new day starts at 02:00 on the venue clock, so a photo
// dump after a late night still counts toward that night, not the next morning.
const EVENT_TZ = "America/New_York"; // follows Eastern clock time, daylight time included
const DAY_ROLLOVER_HOURS = 2;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function eventDayKey(date = new Date()) {
  // A new quota day starts at DAY_ROLLOVER_HOURS local time, so late-night
  // uploads count toward the night they belong to. Uses the venue's wall clock
  // (EVENT_TZ), which tracks daylight time on its own.
  const shifted = new Date(date.getTime() - DAY_ROLLOVER_HOURS * 3600 * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EVENT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function eventSlug(env) {
  return (env.EVENT_NAME || "our-wedding")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "event";
}

function dailyLimit(env) {
  const n = parseInt(env.DAILY_LIMIT || "5", 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function coupleAuthed(request, env) {
  const key = env.ALBUM_KEY;
  if (!key) return false;
  const url = new URL(request.url);
  const provided = request.headers.get("x-album-key") || url.searchParams.get("k");
  return provided && provided === key;
}

// Cloudflare Access identity. Only trusted on the protected host (not the capture
// subdomain), where Access has authenticated the request and Cloudflare sets this
// header. Any request that reaches an Access-gated path has already passed the login.
function accessEmail(request, env) {
  const url = new URL(request.url);
  if (env.CAPTURE_HOST && url.hostname === env.CAPTURE_HOST) return null;
  const email = request.headers.get("cf-access-authenticated-user-email");
  return email || null;
}

// An owner is anyone signed in through Cloudflare Access, or holding the album key.
function ownerAuthed(request, env) {
  return !!accessEmail(request, env) || coupleAuthed(request, env);
}

function extFor(contentType) {
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/gif": "gif",
  };
  return map[contentType] || "bin";
}

async function ensureGid(request) {
  let gid = getCookie(request, "gid");
  let setCookie = null;
  if (!gid) {
    gid = crypto.randomUUID();
    setCookie =
      `gid=${gid}; Path=/; Max-Age=${60 * 60 * 24 * 60}; SameSite=Lax; HttpOnly; Secure`;
  }
  return { gid, setCookie };
}

async function handleQuota(request, env) {
  const { gid, setCookie } = await ensureGid(request);
  const day = eventDayKey();
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM uploads WHERE gid = ? AND day = ?"
  ).bind(gid, day).first();
  const used = row ? row.count : 0;
  const limit = dailyLimit(env);
  const body = {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    event: env.EVENT_NAME || "Our Wedding",
  };
  const headers = {};
  if (setCookie) headers["set-cookie"] = setCookie;
  return json(body, 200, headers);
}

async function handleUpload(request, env) {
  const { gid, setCookie } = await ensureGid(request);
  const day = eventDayKey();
  const limit = dailyLimit(env);

  const used = (await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM uploads WHERE gid = ? AND day = ?"
  ).bind(gid, day).first()).count;

  if (used >= limit) {
    return json(
      { error: "limit", message: `You have reached today's limit of ${limit} posts. Come back tomorrow and keep them coming.` },
      429,
      setCookie ? { "set-cookie": setCookie } : {}
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "bad_form", message: "That upload did not come through. Try again." }, 400);
  }

  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return json({ error: "no_file", message: "No photo was attached." }, 400);
  }

  const contentType = file.type || "application/octet-stream";
  if (!ALLOWED_PREFIXES.some((p) => contentType.startsWith(p))) {
    return json({ error: "type", message: "Only photos can be posted." }, 415);
  }
  if (file.size > MAX_BYTES) {
    return json({ error: "size", message: "That file is too large. Try a smaller photo." }, 413);
  }

  const kind = (form.get("kind") || "photo").toString().slice(0, 16);
  const caption = (form.get("caption") || "").toString().slice(0, 280);
  const guestName = (form.get("name") || "").toString().slice(0, 60);

  const id = crypto.randomUUID();
  const ext = extFor(contentType);
  const key = `${eventSlug(env)}/${day}/${id}.${ext}`;

  await env.BUCKET.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType },
  });

  // Optional client-generated thumbnail. Stored next to the full image so the public
  // gallery can load something light. Falls back to the full image when absent.
  let thumbKey = null;
  const thumb = form.get("thumb");
  if (thumb && typeof thumb.arrayBuffer === "function" && thumb.size > 0 && thumb.size <= MAX_BYTES) {
    const thumbType = thumb.type && thumb.type.startsWith("image/") ? thumb.type : "image/jpeg";
    thumbKey = `${eventSlug(env)}/${day}/${id}.t.${extFor(thumbType)}`;
    await env.BUCKET.put(thumbKey, await thumb.arrayBuffer(), { httpMetadata: { contentType: thumbType } });
  }

  await env.DB.prepare(
    `INSERT INTO uploads (id, gid, day, created_at, r2_key, thumb_key, kind, content_type, size, caption, guest_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, gid, day, Date.now(), key, thumbKey, kind, contentType, file.size, caption, guestName).run();

  const remaining = Math.max(0, limit - (used + 1));
  const headers = {};
  if (setCookie) headers["set-cookie"] = setCookie;
  return json({ ok: true, id, remaining, limit }, 200, headers);
}

// Public, no key. Only ever returns approved (or featured) rows, so pending photos
// never leak. scope=featured returns the home page strip, otherwise the full gallery.
async function handlePublicPhotos(request, env) {
  const url = new URL(request.url);
  const featuredOnly = url.searchParams.get("scope") === "featured";
  const where = featuredOnly ? "featured = 1" : "approved = 1";
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, approved_at, r2_key, thumb_key, content_type, caption, guest_name
     FROM uploads WHERE ${where} ORDER BY COALESCE(approved_at, created_at) DESC LIMIT 1000`
  ).all();
  return json({ photos: results || [] });
}

// Owner only. Returns everything with its curation state for the console.
async function handlePhotos(request, env) {
  if (!ownerAuthed(request, env)) {
    return json({ error: "auth", message: "Sign in required." }, 401);
  }
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, approved_at, r2_key, thumb_key, kind, content_type, caption, guest_name, approved, featured, day
     FROM uploads ORDER BY created_at DESC LIMIT 3000`
  ).all();
  return json({ photos: results || [] });
}

async function handleApprove(request, env) {
  if (!ownerAuthed(request, env)) return json({ error: "auth", message: "Sign in required." }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad", message: "Bad request." }, 400); }
  const id = (body.id || "").toString();
  if (!id) return json({ error: "bad", message: "Missing id." }, 400);
  const approved = body.approved ? 1 : 0;

  if (approved) {
    await env.DB.prepare(
      "UPDATE uploads SET approved = 1, approved_at = COALESCE(approved_at, ?) WHERE id = ?"
    ).bind(Date.now(), id).run();
    return json({ ok: true, id, approved: 1 });
  }
  // Unapproving also pulls it from the featured strip.
  await env.DB.prepare(
    "UPDATE uploads SET approved = 0, featured = 0, approved_at = NULL WHERE id = ?"
  ).bind(id).run();
  return json({ ok: true, id, approved: 0, featured: 0 });
}

async function handleFeature(request, env) {
  if (!ownerAuthed(request, env)) return json({ error: "auth", message: "Sign in required." }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad", message: "Bad request." }, 400); }
  const id = (body.id || "").toString();
  if (!id) return json({ error: "bad", message: "Missing id." }, 400);
  const featured = body.featured ? 1 : 0;

  if (featured) {
    // Featuring implies approval.
    await env.DB.prepare(
      "UPDATE uploads SET featured = 1, approved = 1, approved_at = COALESCE(approved_at, ?) WHERE id = ?"
    ).bind(Date.now(), id).run();
    return json({ ok: true, id, featured: 1, approved: 1 });
  }
  await env.DB.prepare("UPDATE uploads SET featured = 0 WHERE id = ?").bind(id).run();
  return json({ ok: true, id, featured: 0 });
}

async function handleDelete(request, env) {
  if (!ownerAuthed(request, env)) {
    return json({ error: "auth", message: "Sign in required." }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad", message: "Bad request." }, 400);
  }
  const id = (body.id || "").toString();
  if (!id) return json({ error: "bad", message: "Missing id." }, 400);

  const row = await env.DB.prepare("SELECT r2_key, thumb_key FROM uploads WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "missing", message: "Already gone." }, 404);

  await env.BUCKET.delete(row.r2_key);
  if (row.thumb_key) await env.BUCKET.delete(row.thumb_key);
  await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// Owner-only media, served from a path behind Cloudflare Access so an authenticated
// owner can view any photo here, including pending ones. Approved media stays public
// on /media for the gallery and the landing.
async function handleOwnerMedia(request, env, key) {
  if (!ownerAuthed(request, env)) {
    return new Response("Not authorized.", { status: 401 });
  }
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found.", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  headers.set("accept-ranges", "bytes");
  return new Response(obj.body, { headers });
}

// Media is public once a photo is approved, and owner-only while it is still pending.
// A thumbnail key (uuid.t.ext) maps back to its full-size row for the approval check.
function baseKeyOf(key) {
  return key.replace(/\.t\.([a-z0-9]+)$/i, ".$1");
}

async function handleMedia(request, env, key) {
  const baseKey = baseKeyOf(key);
  const row = await env.DB.prepare("SELECT approved FROM uploads WHERE r2_key = ?").bind(baseKey).first();
  const isApproved = !!(row && row.approved === 1);

  if (!isApproved && !coupleAuthed(request, env)) {
    return new Response("Not authorized.", { status: 401 });
  }

  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found.", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", isApproved ? "public, max-age=86400" : "private, max-age=3600");
  headers.set("accept-ranges", "bytes");
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/api/quota" && method === "GET") return handleQuota(request, env);
      if (path === "/api/upload" && method === "POST") return handleUpload(request, env);
      if (path === "/api/public/photos" && method === "GET") return handlePublicPhotos(request, env);
      if (path === "/api/photos" && method === "GET") return handlePhotos(request, env);
      if (path === "/api/photos/approve" && method === "POST") return handleApprove(request, env);
      if (path === "/api/photos/feature" && method === "POST") return handleFeature(request, env);
      if (path === "/api/photos/delete" && method === "POST") return handleDelete(request, env);

      if (path.startsWith("/owner-media/")) {
        const key = decodeURIComponent(path.slice("/owner-media/".length));
        return handleOwnerMedia(request, env, key);
      }

      if (path.startsWith("/media/")) {
        const key = decodeURIComponent(path.slice("/media/".length));
        return handleMedia(request, env, key);
      }

      // On the capture subdomain, the root serves the photo-taking app instead of the
      // landing page. Other static paths fall through to the assets binding as usual.
      if (path === "/" && env.CAPTURE_HOST && url.hostname === env.CAPTURE_HOST && env.ASSETS) {
        return env.ASSETS.fetch(new Request(new URL("/capture", url), request));
      }

      // Not an API or media route. Fall through to static assets.
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found.", { status: 404 });
    } catch (err) {
      return json({ error: "server", message: "Something broke on our end. Try again." }, 500);
    }
  },
};
