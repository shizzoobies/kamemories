// kamemories - Cloudflare Worker (multi-tenant event photo collection)
//
// One Worker serves every host and decides what to do from the hostname:
//   kamemories.com / www.kamemories.com  -> control plane: marketing, magic-link
//     login, and the organizer dashboard (create events, curate photos).
//   {slug}.kamemories.com                -> event plane: that event's public
//     landing, gallery, and the guest capture app the QR code points to.
//
// Curation model (per event): every guest upload starts pending (approved = 0)
// and is visible to nobody public. The organizer approves photos into the public
// gallery and can feature a subset on the event home page. Featuring implies
// approval. Pending media is never public.
//
// Auth: organizers sign in with a one-time magic link emailed to them. We store
// only hashes of login tokens and session ids. The session cookie is host-only on
// the control plane, so it never travels to event subdomains.

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB hard ceiling per upload
const ALLOWED_PREFIXES = ["image/"];
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000; // magic link valid for 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // session valid for 30 days
const GID_MAX_AGE = 60 * 60 * 24 * 60; // guest device cookie, 60 days

// One-time pricing tiers. amount is in US cents. guests = 0 means unlimited.
// daily is the per-guest daily upload cap. Amounts are always read from here on
// the server, never trusted from the client.
const PLANS = {
  intimate:  { label: "Intimate",  amount: 4900,  guests: 75,  daily: 10, video: false, download: false, badge: true,  priority: false },
  signature: { label: "Signature", amount: 9900,  guests: 200, daily: 20, video: true,  download: true,  badge: false, priority: false },
  grand:     { label: "Grand",     amount: 14900, guests: 0,   daily: 30, video: true,  download: true,  badge: false, priority: true  },
};
function planFor(event) {
  return event && event.plan && PLANS[event.plan] ? PLANS[event.plan] : null;
}
function billingOn(env) {
  return !!env.STRIPE_SECRET_KEY;
}
// Per-guest daily cap in force: the plan's cap, never above what the organizer
// set in settings. Free events (no plan) use their own daily_limit.
function effectiveDailyLimit(event) {
  const plan = planFor(event);
  if (!plan) return event.daily_limit;
  return Math.min(event.daily_limit || plan.daily, plan.daily);
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

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

// A thumbnail key (uuid.t.ext) maps back to its full-size key (uuid.ext).
function baseKeyOf(key) {
  return key.replace(/\.t\.([a-z0-9]+)$/i, ".$1");
}

async function sha256hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isEmail(s) {
  return typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function slugify(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function validSlug(s) {
  return typeof s === "string" && s.length >= 2 && s.length <= 40 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s);
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// Host and plane resolution
// ---------------------------------------------------------------------------

function reservedSet(env) {
  return new Set(
    (env.RESERVED_SUBDOMAINS || "www,app,api")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

// Classify a request by host. Returns { plane: 'control' | 'event', slug }.
// The control plane is the apex, www, any reserved label, and unknown hosts
// (so the *.workers.dev preview lands on the dashboard). Anything else that ends
// in the root domain is an event whose subdomain label is the event slug.
function hostInfo(url, env) {
  const host = url.hostname.toLowerCase();
  const root = (env.ROOT_HOST || "kamemories.com").toLowerCase();
  const reserved = reservedSet(env);

  // Local development: localhost, 127.0.0.1, and {slug}.localhost.
  if (host === "localhost" || host === "127.0.0.1") return { plane: "control", slug: null };
  if (host.endsWith(".localhost")) {
    const label = host.slice(0, -".localhost".length);
    if (!label || label.includes(".") || reserved.has(label)) return { plane: "control", slug: null };
    return { plane: "event", slug: label };
  }

  if (host === root || host === "www." + root) return { plane: "control", slug: null };
  if (host.endsWith("." + root)) {
    const label = host.slice(0, host.length - ("." + root).length);
    if (!label || label.includes(".") || reserved.has(label)) return { plane: "control", slug: null };
    return { plane: "event", slug: label };
  }
  return { plane: "control", slug: null };
}

// Absolute origin to build links on: the live root host in production, or the
// current origin in local development.
function baseOf(url, env) {
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "127.0.0.1") {
    return `${url.protocol}//${url.host}`;
  }
  return `https://${env.ROOT_HOST || url.hostname}`;
}

// ---------------------------------------------------------------------------
// Sessions and magic-link email
// ---------------------------------------------------------------------------

async function ensureGid(request) {
  let gid = getCookie(request, "gid");
  let setCookie = null;
  if (!gid) {
    gid = crypto.randomUUID();
    setCookie = `gid=${gid}; Path=/; Max-Age=${GID_MAX_AGE}; SameSite=Lax; HttpOnly; Secure`;
  }
  return { gid, setCookie };
}

function sessionCookie(raw) {
  // Host-only (no Domain attribute) so the session stays on the control plane.
  return `sid=${raw}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie() {
  return "sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
}

// Resolve the signed-in organizer from the session cookie, or null.
async function getOrganizer(request, env) {
  const sid = getCookie(request, "sid");
  if (!sid) return null;
  const idHash = await sha256hex(sid);
  const row = await env.DB.prepare(
    `SELECT o.id AS id, o.email AS email, o.name AS name, s.expires_at AS expires_at
     FROM sessions s JOIN organizers o ON o.id = s.organizer_id
     WHERE s.id_hash = ?`
  ).bind(idHash).first();
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
    return null;
  }
  return { id: row.id, email: row.email, name: row.name };
}

// Branded HTML for the sign-in email. A real HTML message with a button and a
// text fallback lands in inboxes far better than a bare plain-text link.
function magicLinkHtml(link) {
  return `<div style="background:#f4f2ec;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:440px;margin:0 auto;background:#ffffff;border-radius:14px;padding:36px 32px;border:1px solid #e7e3d8;">
    <div style="font-family:Georgia,serif;font-size:22px;color:#0a1322;margin:0 0 16px;">KA Memories</div>
    <p style="font-size:16px;line-height:1.5;color:#2b3344;margin:0 0 24px;">Tap the button to sign in. This link works once and expires in 15 minutes.</p>
    <a href="${link}" style="display:inline-block;background:#0a1322;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;padding:13px 28px;border-radius:999px;">Sign in</a>
    <p style="font-size:13px;line-height:1.5;color:#6b7280;margin:24px 0 0;">If the button does not work, paste this link into your browser:<br><a href="${link}" style="color:#0a1322;word-break:break-all;">${link}</a></p>
    <p style="font-size:12px;color:#9aa0ab;margin:20px 0 0;">If you did not request this, you can ignore this email.</p>
  </div>
</div>`;
}

// Send the magic link. With RESEND_API_KEY set, email it through Resend.
// Without a provider, return the link so local development can use it.
async function sendMagicLink(env, email, link) {
  if (!env.RESEND_API_KEY) {
    console.log(`[dev] magic link for ${email}: ${link}`);
    return { sent: false, devLink: link };
  }
  const from = env.MAIL_FROM || "KA Memories <login@kamemories.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Your KA Memories sign-in link",
      text: `Sign in to KA Memories.\n\n${link}\n\nThis link works once and expires in 15 minutes. If you did not request it, you can ignore this email.`,
      html: magicLinkHtml(link),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.log(`[mail] resend failed ${res.status}: ${detail}`);
    throw new Error("mail_failed");
  }
  return { sent: true };
}

// Public contact form. Emails the inquiry to the operators via Resend, with the
// sender as reply-to so a reply goes straight to the customer. A hidden honeypot
// field silently drops bots. Without a mail provider it logs (dev mode).
async function handleContact(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad", message: "Bad request." }, 400); }
  if ((body.company || "").toString().trim()) return json({ ok: true }); // honeypot
  const name = (body.name || "").toString().trim().slice(0, 120);
  const email = (body.email || "").toString().trim().slice(0, 200);
  const phone = (body.phone || "").toString().trim().slice(0, 60);
  const date = (body.event_date || "").toString().trim().slice(0, 120);
  const message = (body.message || "").toString().trim().slice(0, 4000);
  if (!name) return json({ error: "name", message: "Tell us your name." }, 400);
  if (!isEmail(email)) return json({ error: "email", message: "Add a valid email so we can reply." }, 400);
  if (!message) return json({ error: "message", message: "Add a short message." }, 400);

  const to = env.CONTACT_TO || "memories@ka-performancefl.com";
  if (!env.RESEND_API_KEY) { console.log(`[dev] contact ${name} <${email}> ${phone} ${date}: ${message}`); return json({ ok: true }); }

  const text = [
    "New inquiry from the kamemories site.",
    "",
    "Name:  " + name,
    "Email: " + email,
    phone ? "Phone: " + phone : null,
    date ? "Event date: " + date : null,
    "",
    "Message:",
    message,
  ].filter((l) => l !== null).join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.MAIL_FROM || "KA Memories <login@ka-testing.com>",
      to: [to],
      reply_to: email,
      subject: "New inquiry from " + name,
      text: text,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.log(`[mail] contact resend failed ${res.status}: ${detail}`);
    return json({ error: "send", message: "Could not send right now. Please email memories@ka-performancefl.com directly." }, 502);
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Event lookups and shapes
// ---------------------------------------------------------------------------

async function eventBySlug(env, slug) {
  return env.DB.prepare("SELECT * FROM events WHERE slug = ?").bind(slug).first();
}

async function eventById(env, id) {
  return env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(id).first();
}

// Fetch an event only if it belongs to this organizer.
async function ownedEvent(env, org, id) {
  const e = await eventById(env, id);
  if (!e || e.organizer_id !== org.id) return null;
  return e;
}

// Fetch an upload only if its event belongs to this organizer.
async function ownedUpload(env, org, uploadId) {
  return env.DB.prepare(
    `SELECT u.* FROM uploads u JOIN events e ON e.id = u.event_id
     WHERE u.id = ? AND e.organizer_id = ?`
  ).bind(uploadId, org.id).first();
}

// What the dashboard sees: everything editable, plus the live URLs.
function ownerEventShape(env, e) {
  const host = `${e.slug}.${env.ROOT_HOST || "kamemories.com"}`;
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    tagline: e.tagline,
    event_date: e.event_date,
    venue: e.venue,
    theme: e.theme,
    daily_limit: e.daily_limit,
    event_tz: e.event_tz,
    rollover_h: e.rollover_h,
    auto_approve: e.auto_approve ? 1 : 0,
    status: e.status,
    plan: e.plan || null,
    paid_at: e.paid_at || null,
    reviewed_at: e.reviewed_at || null,
    created_at: e.created_at,
    host,
    url: `https://${host}`,
    capture_url: `https://${host}/add`,
  };
}

// What guests see on the event landing and capture pages.
function publicEventShape(e) {
  const plan = PLANS[e.plan] || null;
  return {
    slug: e.slug,
    name: e.name,
    tagline: e.tagline,
    event_date: e.event_date,
    venue: e.venue,
    theme: e.theme,
    daily_limit: effectiveDailyLimit(e),
    instant: !!e.auto_approve,
    features: {
      video: plan ? plan.video : false,
      badge: plan ? plan.badge : true,
    },
  };
}

// Quota day boundary. A new day starts at rollover_h on the event's wall clock,
// so a photo dump after a late night still counts toward that night.
function eventDayKey(tz, rolloverH, date = new Date()) {
  const shifted = new Date(date.getTime() - (rolloverH || 0) * 3600 * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ---------------------------------------------------------------------------
// Control plane: auth
// ---------------------------------------------------------------------------

async function authRequest(request, env, url) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad", message: "Bad request." }, 400); }
  const email = (body.email || "").toString().trim().toLowerCase();
  if (!isEmail(email)) return json({ error: "email", message: "Enter a valid email address." }, 400);

  let org = await env.DB.prepare("SELECT id FROM organizers WHERE email = ?").bind(email).first();
  if (!org) {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO organizers (id, email, created_at) VALUES (?, ?, ?)")
      .bind(id, email, Date.now()).run();
    org = { id };
  }

  const raw = randomToken();
  const tokenHash = await sha256hex(raw);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO login_tokens (token_hash, organizer_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(tokenHash, org.id, now, now + LOGIN_TOKEN_TTL_MS).run();

  const link = `${baseOf(url, env)}/auth/verify?token=${raw}`;
  const isDev = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "127.0.0.1";
  try {
    const result = await sendMagicLink(env, email, link);
    if (result.sent) return json({ ok: true });
    // No email provider configured. Reveal the link only in local dev, never on a
    // deployed host (otherwise anyone could mint a sign-in link for any email).
    if (isDev) return json({ ok: true, devLink: result.devLink });
    return json({ error: "mail_unconfigured", message: "Sign-in email is not set up yet. Try again soon." }, 503);
  } catch {
    return json({ error: "mail", message: "We could not send the email just now. Try again." }, 502);
  }
}

async function authVerify(request, env, url) {
  const fail = (code) => {
    const h = new Headers();
    h.set("location", `${baseOf(url, env)}/login?error=${code}`);
    return new Response(null, { status: 302, headers: h });
  };
  const raw = url.searchParams.get("token") || "";
  if (!raw) return fail("missing");

  const tokenHash = await sha256hex(raw);
  const row = await env.DB.prepare(
    "SELECT organizer_id, expires_at, used_at FROM login_tokens WHERE token_hash = ?"
  ).bind(tokenHash).first();
  if (!row || row.used_at || row.expires_at < Date.now()) return fail("expired");

  await env.DB.prepare("UPDATE login_tokens SET used_at = ? WHERE token_hash = ?").bind(Date.now(), tokenHash).run();

  const sid = randomToken();
  const idHash = await sha256hex(sid);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (id_hash, organizer_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(idHash, row.organizer_id, now, now + SESSION_TTL_MS).run();

  const headers = new Headers();
  headers.set("set-cookie", sessionCookie(sid));
  headers.set("location", `${baseOf(url, env)}/app`);
  return new Response(null, { status: 302, headers });
}

async function authMe(request, env) {
  const org = await getOrganizer(request, env);
  if (!org) return json({ error: "auth" }, 401);
  return json({ organizer: { email: org.email, name: org.name || null }, admin: isAdmin(org, env) });
}

async function authLogout(request, env) {
  const sid = getCookie(request, "sid");
  if (sid) {
    const idHash = await sha256hex(sid);
    await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
  }
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}

// ---------------------------------------------------------------------------
// Control plane: events
// ---------------------------------------------------------------------------

async function eventsCreate(request, env) {
  const org = await getOrganizer(request, env);
  if (!org) return json({ error: "auth", message: "Sign in required." }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad", message: "Bad request." }, 400); }

  const name = (body.name || "").toString().trim().slice(0, 80);
  if (!name) return json({ error: "name", message: "Give your event a name." }, 400);

  const typedSlug = (body.slug || "").toString().trim().toLowerCase();
  let slug = typedSlug || slugify(name);
  if (!validSlug(slug)) return json({ error: "slug", message: "Use 2 to 40 letters, numbers, and hyphens." }, 400);
  if (reservedSet(env).has(slug)) return json({ error: "slug_reserved", message: "That address is reserved. Pick another." }, 400);

  const existing = await env.DB.prepare("SELECT id FROM events WHERE slug = ?").bind(slug).first();
  if (existing) {
    if (typedSlug) return json({ error: "slug_taken", message: "That address is taken. Pick another." }, 409);
    slug = `${slug}-${randomToken().slice(0, 4)}`; // auto-derived: nudge it unique
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const tagline = (body.tagline || "").toString().slice(0, 120) || null;
  const eventDate = (body.event_date || "").toString().slice(0, 80) || null;
  const venue = (body.venue || "").toString().slice(0, 120) || null;
  const dailyLimit = clampInt(body.daily_limit, 1, 1000, 10);
  const eventTz = (body.event_tz || "America/New_York").toString().slice(0, 64);
  const rolloverH = clampInt(body.rollover_h, 0, 23, 2);

  // With billing on, new events start as private drafts until they are paid for.
  // Without a Stripe key, they go live immediately (free mode).
  const status = billingOn(env) ? "draft" : "active";
  await env.DB.prepare(
    `INSERT INTO events (id, organizer_id, slug, name, tagline, event_date, venue, theme, daily_limit, event_tz, rollover_h, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'midnight-pearl', ?, ?, ?, ?, ?)`
  ).bind(id, org.id, slug, name, tagline, eventDate, venue, dailyLimit, eventTz, rolloverH, status, now).run();

  const event = await eventById(env, id);
  return json({ ok: true, event: ownerEventShape(env, event) }, 201);
}

async function eventsList(request, env) {
  const org = await getOrganizer(request, env);
  if (!org) return json({ error: "auth", message: "Sign in required." }, 401);
  const { results } = await env.DB.prepare(
    `SELECT e.*,
       (SELECT COUNT(*) FROM uploads u WHERE u.event_id = e.id) AS total,
       (SELECT COUNT(*) FROM uploads u WHERE u.event_id = e.id AND u.approved = 0) AS pending,
       (SELECT COUNT(*) FROM uploads u WHERE u.event_id = e.id AND u.approved = 1) AS approved_count
     FROM events e WHERE e.organizer_id = ? ORDER BY e.created_at DESC`
  ).bind(org.id).all();
  const events = (results || []).map((e) => ({
    ...ownerEventShape(env, e),
    total: e.total,
    pending: e.pending,
    approved: e.approved_count,
  }));
  return json({ events });
}

async function eventGet(request, env, id) {
  const org = await getOrganizer(request, env);
  if (!org) return json({ error: "auth", message: "Sign in required." }, 401);
  const e = await ownedEvent(env, org, id);
  if (!e) return json({ error: "notfound", message: "Event not found." }, 404);
  return json({ event: ownerEventShape(env, e) });
}

async function eventUpdate(request, env, id) {
  const org = await getOrganizer(request, env);
  if (!org) return json({ error: "auth", message: "Sign in required." }, 401);
  const e = await ownedEvent(env, org, id);
  if (!e) return json({ error: "notfound", message: "Event not found." }, 404);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad", message: "Bad request." }, 400); }

  const name = body.name != null ? body.name.toString().trim().slice(0, 80) : e.name;
  if (!name) return json({ error: "name", message: "Give your event a name." }, 400);
  const tagline = body.tagline != null ? (body.tagline.toString().slice(0, 120) || null) : e.tagline;
  const eventDate = body.event_date != null ? (body.event_date.toString().slice(0, 80) || null) : e.event_date;
  const venue = body.venue != null ? (body.venue.toString().slice(0, 120) || null) : e.venue;
  const dailyLimit = body.daily_limit != null ? clampInt(body.daily_limit, 1, 1000, e.daily_limit) : e.daily_limit;
  const eventTz = body.event_tz != null ? body.event_tz.toString().slice(0, 64) : e.event_tz;
  const rolloverH = body.rollover_h != null ? clampInt(body.rollover_h, 0, 23, e.rollover_h) : e.rollover_h;
  const autoApprove = body.auto_approve != null ? (body.auto_approve ? 1 : 0) : (e.auto_approve ? 1 : 0);
  const status = body.status != null && ["active", "draft", "archived"].includes(body.status) ? body.status : e.status;

  let slug = e.slug;
  if (body.slug != null && body.slug.toString().trim().toLowerCase() !== e.slug) {
    slug = body.slug.toString().trim().toLowerCase();
    if (!validSlug(slug)) return json({ error: "slug", message: "Use 2 to 40 letters, numbers, and hyphens." }, 400);
    if (reservedSet(env).has(slug)) return json({ error: "slug_reserved", message: "That address is reserved." }, 400);
    const taken = await env.DB.prepare("SELECT id FROM events WHERE slug = ? AND id <> ?").bind(slug, id).first();
    if (taken) return json({ error: "slug_taken", message: "That address is taken." }, 409);
  }

  await env.DB.prepare(
    `UPDATE events SET name = ?, tagline = ?, event_date = ?, venue = ?, daily_limit = ?, event_tz = ?, rollover_h = ?, auto_approve = ?, status = ?, slug = ? WHERE id = ?`
  ).bind(name, tagline, eventDate, venue, dailyLimit, eventTz, rolloverH, autoApprove, status, slug, id).run();

  // Switching auto-approve on means "everything goes live": publish anything that
  // was still waiting in the pending queue, too.
  if (autoApprove && !e.auto_approve) {
    await env.DB.prepare(
      "UPDATE uploads SET approved = 1, approved_at = COALESCE(approved_at, ?) WHERE event_id = ? AND approved = 0"
    ).bind(Date.now(), id).run();
  }

  const updated = await eventById(env, id);
  return json({ ok: true, event: ownerEventShape(env, updated) });
}

async function eventDelete(request, env, id) {
  const org = await getOrganizer(request, env);
  if (!org) return json({ error: "auth", message: "Sign in required." }, 401);
  const e = await ownedEvent(env, org, id);
  if (!e) return json({ error: "notfound", message: "Event not found." }, 404);

  const { results } = await env.DB.prepare("SELECT r2_key, thumb_key FROM uploads WHERE event_id = ?").bind(id).all();
  for (const row of results || []) {
    await env.BUCKET.delete(row.r2_key);
    if (row.thumb_key) await env.BUCKET.delete(row.thumb_key);
  }
  await env.DB.prepare("DELETE FROM uploads WHERE event_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Control plane: owner console. Gated to the operator emails in ADMIN_EMAILS so
// only we can see every client and every event and set things up for them.
// ---------------------------------------------------------------------------

function adminEmails(env) {
  return new Set((env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
}
function isAdmin(org, env) {
  return !!org && adminEmails(env).has((org.email || "").toLowerCase());
}
// Resolve the signed-in operator, or an error response to return as-is.
async function requireAdmin(request, env) {
  const org = await getOrganizer(request, env);
  if (!org) return { error: json({ error: "auth", message: "Sign in required." }, 401) };
  if (!isAdmin(org, env)) return { error: json({ error: "forbidden", message: "Not authorized." }, 403) };
  return { org };
}

async function adminOverview(request, env) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;

  const clientsQ = await env.DB.prepare(
    `SELECT o.id, o.email, o.name, o.created_at,
       (SELECT COUNT(*) FROM events e WHERE e.organizer_id = o.id) AS events,
       (SELECT COUNT(*) FROM uploads u JOIN events e ON e.id = u.event_id WHERE e.organizer_id = o.id) AS photos
     FROM organizers o ORDER BY o.created_at DESC`
  ).all();
  const eventsQ = await env.DB.prepare(
    `SELECT e.*, o.email AS organizer_email,
       (SELECT COUNT(*) FROM uploads u WHERE u.event_id = e.id) AS total,
       (SELECT COUNT(*) FROM uploads u WHERE u.event_id = e.id AND u.approved = 0) AS pending,
       (SELECT COUNT(*) FROM uploads u WHERE u.event_id = e.id AND u.approved = 1) AS approved_count
     FROM events e JOIN organizers o ON o.id = e.organizer_id ORDER BY e.created_at DESC`
  ).all();

  const clients = clientsQ.results || [];
  const events = (eventsQ.results || []).map((e) => Object.assign({}, ownerEventShape(env, e), {
    organizer_email: e.organizer_email, total: e.total, pending: e.pending, approved: e.approved_count,
  }));
  const photos = clients.reduce((n, c) => n + (c.photos || 0), 0);
  const newBookings = events.filter((e) => e.paid_at && !e.reviewed_at).length;
  // Total commission still owed to vendors (per code: commission earned minus
  // payouts, floored at zero so an overpaid code never offsets another).
  const owedRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(owed), 0) AS owed FROM (
       SELECT MAX(0,
         (SELECT COALESCE(SUM(commission_cents), 0) FROM vendor_redemptions r WHERE r.code_id = vc.id)
         - (SELECT COALESCE(SUM(amount_cents), 0) FROM vendor_payouts p WHERE p.code_id = vc.id)
       ) AS owed FROM vendor_codes vc
     )`
  ).first();
  return json({
    me: gate.org,
    clients: clients,
    events: events,
    stats: { clients: clients.length, events: events.length, photos: photos, newBookings: newBookings, owed_cents: owedRow ? owedRow.owed : 0 },
    billing: billingOn(env),
    assistant: !!env.ANTHROPIC_API_KEY,
  });
}

async function adminCreateEvent(request, env) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad", message: "Bad request." }, 400); }

  const email = (body.email || "").toString().trim().toLowerCase();
  if (!isEmail(email)) return json({ error: "email", message: "Enter the client email." }, 400);
  const name = (body.name || "").toString().trim().slice(0, 80);
  if (!name) return json({ error: "name", message: "Give the event a name." }, 400);

  // Upsert the client organizer so the event has an owner who can sign in later.
  let org = await env.DB.prepare("SELECT id FROM organizers WHERE email = ?").bind(email).first();
  if (!org) {
    const oid = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO organizers (id, email, created_at) VALUES (?, ?, ?)").bind(oid, email, Date.now()).run();
    org = { id: oid };
  }

  const typedSlug = (body.slug || "").toString().trim().toLowerCase();
  let slug = typedSlug || slugify(name);
  if (!validSlug(slug)) return json({ error: "slug", message: "Use 2 to 40 letters, numbers, and hyphens." }, 400);
  if (reservedSet(env).has(slug)) return json({ error: "slug_reserved", message: "That address is reserved." }, 400);
  const existing = await env.DB.prepare("SELECT id FROM events WHERE slug = ?").bind(slug).first();
  if (existing) {
    if (typedSlug) return json({ error: "slug_taken", message: "That address is taken." }, 409);
    slug = `${slug}-${randomToken().slice(0, 4)}`;
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const tagline = (body.tagline || "").toString().slice(0, 120) || null;
  const eventDate = (body.event_date || "").toString().slice(0, 80) || null;
  const venue = (body.venue || "").toString().slice(0, 120) || null;
  const dailyLimit = clampInt(body.daily_limit, 1, 1000, 10);
  const plan = PLANS[body.plan] ? body.plan : null;
  const status = ["active", "draft", "archived"].includes(body.status) ? body.status : "active";
  const paidAt = plan && status === "active" ? now : null;
  await env.DB.prepare(
    `INSERT INTO events (id, organizer_id, slug, name, tagline, event_date, venue, theme, daily_limit, event_tz, rollover_h, status, plan, paid_at, reviewed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'midnight-pearl', ?, 'America/New_York', 2, ?, ?, ?, ?, ?)`
  ).bind(id, org.id, slug, name, tagline, eventDate, venue, dailyLimit, status, plan, paidAt, now, now).run();
  const event = await eventById(env, id);
  return json({ ok: true, event: Object.assign({}, ownerEventShape(env, event), { organizer_email: email }) }, 201);
}

async function adminUpdateEvent(request, env, id) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  const e = await eventById(env, id);
  if (!e) return json({ error: "notfound", message: "Event not found." }, 404);
  let body; try { body = await request.json(); } catch { body = {}; }

  let slug = e.slug;
  if (body.slug != null && body.slug.toString().trim().toLowerCase() !== e.slug) {
    slug = body.slug.toString().trim().toLowerCase();
    if (!validSlug(slug)) return json({ error: "slug", message: "Use 2 to 40 letters, numbers, and hyphens." }, 400);
    if (reservedSet(env).has(slug)) return json({ error: "slug_reserved", message: "That address is reserved." }, 400);
    const taken = await env.DB.prepare("SELECT id FROM events WHERE slug = ? AND id <> ?").bind(slug, id).first();
    if (taken) return json({ error: "slug_taken", message: "That address is taken." }, 409);
  }
  const name = body.name != null ? (body.name.toString().trim().slice(0, 80) || e.name) : e.name;
  const status = ["active", "draft", "archived"].includes(body.status) ? body.status : e.status;
  const plan = body.plan === null ? null : (PLANS[body.plan] ? body.plan : e.plan);
  const dailyLimit = body.daily_limit != null ? clampInt(body.daily_limit, 1, 1000, e.daily_limit) : e.daily_limit;
  const tagline = body.tagline != null ? (body.tagline.toString().slice(0, 120) || null) : e.tagline;
  const eventDate = body.event_date != null ? (body.event_date.toString().slice(0, 80) || null) : e.event_date;
  const venue = body.venue != null ? (body.venue.toString().slice(0, 120) || null) : e.venue;
  const paidAt = plan && status === "active" ? (e.paid_at || Date.now()) : e.paid_at;
  const reviewedAt = body.reviewed ? (e.reviewed_at || Date.now()) : e.reviewed_at;
  await env.DB.prepare(
    "UPDATE events SET name = ?, slug = ?, status = ?, plan = ?, daily_limit = ?, paid_at = ?, tagline = ?, event_date = ?, venue = ?, reviewed_at = ? WHERE id = ?"
  ).bind(name, slug, status, plan, dailyLimit, paidAt, tagline, eventDate, venue, reviewedAt, id).run();
  const updated = await eventById(env, id);
  return json({ ok: true, event: Object.assign({}, ownerEventShape(env, updated)) });
}

async function adminDeleteEvent(request, env, id) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  const e = await eventById(env, id);
  if (!e) return json({ error: "notfound", message: "Event not found." }, 404);
  const { results } = await env.DB.prepare("SELECT r2_key, thumb_key FROM uploads WHERE event_id = ?").bind(id).all();
  for (const row of results || []) {
    if (row.r2_key) await env.BUCKET.delete(row.r2_key);
    if (row.thumb_key) await env.BUCKET.delete(row.thumb_key);
  }
  await env.DB.prepare("DELETE FROM uploads WHERE event_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// Operations assistant. Proxies to Claude (Opus) with a read-only snapshot of the
// business so the operators can ask about clients and plan next steps. The API key
// never leaves the Worker. Absent key = a friendly "not configured yet".
async function adminAssistant(request, env) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  if (!env.ANTHROPIC_API_KEY) return json({ error: "no_key", message: "The assistant is not set up yet. Add the ANTHROPIC_API_KEY secret to switch it on." }, 503);
  let body; try { body = await request.json(); } catch { return json({ error: "bad", message: "Bad request." }, 400); }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  if (!messages.length) return json({ error: "empty", message: "Say something first." }, 400);

  const orgsQ = await env.DB.prepare(
    "SELECT o.email, o.created_at, (SELECT COUNT(*) FROM events e WHERE e.organizer_id = o.id) AS events FROM organizers o ORDER BY o.created_at DESC LIMIT 200"
  ).all();
  const evsQ = await env.DB.prepare(
    `SELECT e.name, e.slug, e.status, e.plan, o.email AS owner,
       (SELECT COUNT(*) FROM uploads u WHERE u.event_id = e.id) AS photos
     FROM events e JOIN organizers o ON o.id = e.organizer_id ORDER BY e.created_at DESC LIMIT 200`
  ).all();
  const snapshot = JSON.stringify({ clients: orgsQ.results || [], events: evsQ.results || [] });
  const system =
    "You are the operations assistant for KA Memories, a multi-tenant wedding and event photo-sharing service at kamemories.com. " +
    "You help the two operators run the business: understanding clients and events, drafting client messages, and suggesting next steps. " +
    "Be concise, warm, and concrete. You can read the data snapshot below but cannot change anything; when the operator wants to make a change, point them to the control in this panel (New client event, or the status and plan selectors on an event). " +
    "Never invent clients or numbers that are not in the snapshot. Data snapshot (JSON): " + snapshot;

  const payload = {
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system: system,
    messages: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: (m.content || "").toString().slice(0, 4000) })),
  };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) return json({ error: "upstream", message: (data && data.error && data.error.message) || "The assistant could not respond." }, 502);
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return json({ ok: true, reply: text || "(no reply)" });
  } catch (e) {
    return json({ error: "network", message: "Could not reach the assistant." }, 502);
  }
}

// ---------------------------------------------------------------------------
// Control plane: photo curation (scoped to the organizer's own events)
// ---------------------------------------------------------------------------

async function ownerPhotos(request, env, eventId) {
  const org = await getOrganizer(request, env);
  if (!org) return json({ error: "auth", message: "Sign in required." }, 401);
  const e = await ownedEvent(env, org, eventId);
  if (!e) return json({ error: "notfound", message: "Event not found." }, 404);
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, approved_at, r2_key, thumb_key, kind, content_type, caption, guest_name, approved, featured, day,
            (SELECT COUNT(*) FROM likes WHERE upload_id = uploads.id) AS likes
     FROM uploads WHERE event_id = ? ORDER BY created_at DESC LIMIT 5000`
  ).bind(eventId).all();
  return json({ event: ownerEventShape(env, e), photos: results || [] });
}

async function ownerApprove(request, env, uploadId) {
  const org = await getOrganizer(request, env);
  if (!org) return json({ error: "auth", message: "Sign in required." }, 401);
  const u = await ownedUpload(env, org, uploadId);
  if (!u) return json({ error: "notfound", message: "Photo not found." }, 404);
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const approved = body.approved ? 1 : 0;
  if (approved) {
    await env.DB.prepare("UPDATE uploads SET approved = 1, approved_at = COALESCE(approved_at, ?) WHERE id = ?")
      .bind(Date.now(), uploadId).run();
    return json({ ok: true, id: uploadId, approved: 1 });
  }
  await env.DB.prepare("UPDATE uploads SET approved = 0, featured = 0, approved_at = NULL WHERE id = ?").bind(uploadId).run();
  return json({ ok: true, id: uploadId, approved: 0, featured: 0 });
}

async function ownerFeature(request, env, uploadId) {
  const org = await getOrganizer(request, env);
  if (!org) return json({ error: "auth", message: "Sign in required." }, 401);
  const u = await ownedUpload(env, org, uploadId);
  if (!u) return json({ error: "notfound", message: "Photo not found." }, 404);
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const featured = body.featured ? 1 : 0;
  if (featured) {
    await env.DB.prepare("UPDATE uploads SET featured = 1, approved = 1, approved_at = COALESCE(approved_at, ?) WHERE id = ?")
      .bind(Date.now(), uploadId).run();
    return json({ ok: true, id: uploadId, featured: 1, approved: 1 });
  }
  await env.DB.prepare("UPDATE uploads SET featured = 0 WHERE id = ?").bind(uploadId).run();
  return json({ ok: true, id: uploadId, featured: 0 });
}

async function ownerDelete(request, env, uploadId) {
  const org = await getOrganizer(request, env);
  if (!org) return json({ error: "auth", message: "Sign in required." }, 401);
  const u = await ownedUpload(env, org, uploadId);
  if (!u) return json({ error: "notfound", message: "Photo not found." }, 404);
  await env.BUCKET.delete(u.r2_key);
  if (u.thumb_key) await env.BUCKET.delete(u.thumb_key);
  await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(uploadId).run();
  return json({ ok: true });
}

// Owner media: any state (including pending), but only for the organizer's own
// uploads, served on the control plane behind the session.
async function ownerMedia(request, env, key) {
  const org = await getOrganizer(request, env);
  if (!org) return new Response("Not authorized.", { status: 401 });
  const baseKey = baseKeyOf(key);
  const row = await env.DB.prepare(
    `SELECT u.id FROM uploads u JOIN events e ON e.id = u.event_id
     WHERE u.r2_key = ? AND e.organizer_id = ?`
  ).bind(baseKey, org.id).first();
  if (!row) return new Response("Not found.", { status: 404 });
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found.", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  headers.set("accept-ranges", "bytes");
  return new Response(obj.body, { headers });
}

// ---------------------------------------------------------------------------
// Event plane: public, scoped to the resolved event
// ---------------------------------------------------------------------------

function handlePublicEvent(event) {
  return json({ event: publicEventShape(event) });
}

async function handleQuota(request, env, event) {
  const { gid, setCookie } = await ensureGid(request);
  const day = eventDayKey(event.event_tz, event.rollover_h);
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM uploads WHERE event_id = ? AND gid = ? AND day = ?"
  ).bind(event.id, gid, day).first();
  const used = row ? row.count : 0;
  const limit = effectiveDailyLimit(event);
  const headers = {};
  if (setCookie) headers["set-cookie"] = setCookie;
  return json({ used, limit, remaining: Math.max(0, limit - used), event: event.name }, 200, headers);
}

async function handleUpload(request, env, event) {
  const { gid, setCookie } = await ensureGid(request);
  const day = eventDayKey(event.event_tz, event.rollover_h);
  const limit = effectiveDailyLimit(event);

  const used = (await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM uploads WHERE event_id = ? AND gid = ? AND day = ?"
  ).bind(event.id, gid, day).first()).count;

  if (used >= limit) {
    return json(
      { error: "limit", message: `You have reached today's limit of ${limit} posts. Come back tomorrow and keep them coming.` },
      429,
      setCookie ? { "set-cookie": setCookie } : {}
    );
  }

  // Per-plan guest cap (distinct devices). Guests who already posted are exempt.
  const plan = planFor(event);
  if (plan && plan.guests > 0) {
    const seen = await env.DB.prepare("SELECT 1 FROM uploads WHERE event_id = ? AND gid = ? LIMIT 1").bind(event.id, gid).first();
    if (!seen) {
      const gc = await env.DB.prepare("SELECT COUNT(DISTINCT gid) AS n FROM uploads WHERE event_id = ?").bind(event.id).first();
      if (gc && gc.n >= plan.guests) {
        return json(
          { error: "guests", message: "This event has reached its guest limit." },
          403,
          setCookie ? { "set-cookie": setCookie } : {}
        );
      }
    }
  }

  let form;
  try { form = await request.formData(); } catch { return json({ error: "bad_form", message: "That upload did not come through. Try again." }, 400); }

  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") return json({ error: "no_file", message: "No photo was attached." }, 400);

  const contentType = file.type || "application/octet-stream";
  if (!ALLOWED_PREFIXES.some((p) => contentType.startsWith(p))) return json({ error: "type", message: "Only photos can be posted." }, 415);
  if (file.size > MAX_BYTES) return json({ error: "size", message: "That file is too large. Try a smaller photo." }, 413);

  const kind = (form.get("kind") || "photo").toString().slice(0, 16);
  const caption = (form.get("caption") || "").toString().slice(0, 280);
  const guestName = (form.get("name") || "").toString().slice(0, 60);

  const id = crypto.randomUUID();
  const fileExt = extFor(contentType);
  const key = `${event.id}/${day}/${id}.${fileExt}`;
  await env.BUCKET.put(key, await file.arrayBuffer(), { httpMetadata: { contentType } });

  let thumbKey = null;
  const thumb = form.get("thumb");
  if (thumb && typeof thumb.arrayBuffer === "function" && thumb.size > 0 && thumb.size <= MAX_BYTES) {
    const thumbType = thumb.type && thumb.type.startsWith("image/") ? thumb.type : "image/jpeg";
    thumbKey = `${event.id}/${day}/${id}.t.${extFor(thumbType)}`;
    await env.BUCKET.put(thumbKey, await thumb.arrayBuffer(), { httpMetadata: { contentType: thumbType } });
  }

  // Events with auto_approve on skip the pending queue: the upload lands already
  // approved (and stamped), so it shows in the public gallery right away.
  const approved = event.auto_approve ? 1 : 0;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO uploads (id, event_id, gid, day, created_at, r2_key, thumb_key, kind, content_type, size, caption, guest_name, approved, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, event.id, gid, day, now, key, thumbKey, kind, contentType, file.size, caption, guestName, approved, approved ? now : null).run();

  const remaining = Math.max(0, limit - (used + 1));
  const headers = {};
  if (setCookie) headers["set-cookie"] = setCookie;
  return json({ ok: true, id, remaining, limit }, 200, headers);
}

async function handlePublicPhotos(request, env, event) {
  const url = new URL(request.url);
  const featuredOnly = url.searchParams.get("scope") === "featured";
  const sortTop = url.searchParams.get("sort") === "top";
  const where = featuredOnly ? "u.featured = 1" : "u.approved = 1";
  // "Most loved" leads with the like count; ties and "Latest" fall back to time.
  const orderBy = sortTop
    ? "likes DESC, COALESCE(u.approved_at, u.created_at) DESC"
    : "COALESCE(u.approved_at, u.created_at) DESC";
  // Read (not set) the gid cookie so the list can mark the photos this device
  // already liked, without minting a cookie on a plain gallery view.
  const gid = getCookie(request, "gid") || "";
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.created_at, u.approved_at, u.r2_key, u.thumb_key, u.content_type, u.caption, u.guest_name,
            COUNT(l.gid) AS likes,
            MAX(CASE WHEN l.gid = ? THEN 1 ELSE 0 END) AS liked
     FROM uploads u LEFT JOIN likes l ON l.upload_id = u.id
     WHERE u.event_id = ? AND ${where}
     GROUP BY u.id
     ORDER BY ${orderBy} LIMIT 1000`
  ).bind(gid, event.id).all();
  return json({ photos: results || [] });
}

// A guest "likes" (votes for) a featured photo. One like per anonymous device,
// toggleable. Only the host's featured picks are voteable, so the gallery's
// uncurated photos cannot be liked.
async function handleLike(request, env, event, uploadId) {
  const { gid, setCookie } = await ensureGid(request);
  const headers = setCookie ? { "set-cookie": setCookie } : {};
  const u = await env.DB.prepare(
    "SELECT id FROM uploads WHERE id = ? AND event_id = ? AND featured = 1"
  ).bind(uploadId, event.id).first();
  if (!u) return json({ error: "notfound", message: "Photo not found." }, 404, headers);
  const existing = await env.DB.prepare(
    "SELECT 1 FROM likes WHERE upload_id = ? AND gid = ?"
  ).bind(uploadId, gid).first();
  let liked;
  if (existing) {
    await env.DB.prepare("DELETE FROM likes WHERE upload_id = ? AND gid = ?").bind(uploadId, gid).run();
    liked = false;
  } else {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO likes (upload_id, event_id, gid, created_at) VALUES (?, ?, ?, ?)"
    ).bind(uploadId, event.id, gid, Date.now()).run();
    liked = true;
  }
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM likes WHERE upload_id = ?").bind(uploadId).first();
  return json({ ok: true, liked, likes: cnt ? cnt.n : 0 }, 200, headers);
}

// Event media is public only for that event's approved photos. Pending photos
// are not reachable here. The organizer views pending media in the dashboard.
async function handleMedia(request, env, event, key) {
  const baseKey = baseKeyOf(key);
  const row = await env.DB.prepare("SELECT event_id, approved FROM uploads WHERE r2_key = ?").bind(baseKey).first();
  if (!row || row.event_id !== event.id || row.approved !== 1) {
    return new Response("Not authorized.", { status: 401 });
  }
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found.", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=86400");
  headers.set("accept-ranges", "bytes");
  return new Response(obj.body, { headers });
}

// ---------------------------------------------------------------------------
// Billing (Stripe one-time checkout)
// ---------------------------------------------------------------------------

// Flatten a nested object into Stripe's bracketed form-encoding.
function stripeForm(obj, prefix, out) {
  out = out || new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => stripeForm(item, `${key}[${i}]`, out));
    else if (typeof v === "object") stripeForm(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

// Pin a recent API version so newer params (e.g. promotion_codes' coupon) are
// accepted regardless of the account's default version.
const STRIPE_API_VERSION = "2024-06-20";

async function stripeRequest(env, path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION,
    },
    body: stripeForm(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `stripe ${res.status}`;
    console.log(`[stripe] ${path} failed: ${msg}`);
    throw new Error(msg);
  }
  return data;
}

async function stripeGet(env, path) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": STRIPE_API_VERSION },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error && data.error.message) || `stripe ${res.status}`);
  return data;
}

async function stripeDelete(env, path) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  return res.json().catch(() => ({}));
}

// Verify a Stripe webhook signature (scheme v1: HMAC-SHA256 of "timestamp.payload").
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = {};
  for (const seg of sigHeader.split(",")) {
    const i = seg.indexOf("=");
    if (i > 0) parts[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
  }
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // replay window
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// Start a one-time Checkout Session to publish an event on the chosen plan.
async function handleCheckout(request, env, url, id) {
  const org = await getOrganizer(request, env);
  if (!org) return json({ error: "auth", message: "Sign in required." }, 401);
  if (!billingOn(env)) return json({ error: "billing_off", message: "Checkout is not available yet." }, 503);
  const e = await ownedEvent(env, org, id);
  if (!e) return json({ error: "notfound", message: "Event not found." }, 404);
  if (e.paid_at) return json({ error: "paid", message: "This event is already published." }, 409);

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const planKey = (body.plan || "").toString();
  const plan = PLANS[planKey];
  if (!plan) return json({ error: "plan", message: "Pick a valid plan." }, 400);

  const base = baseOf(url, env);
  try {
    const session = await stripeRequest(env, "checkout/sessions", {
      mode: "payment",
      allow_promotion_codes: true,
      success_url: `${base}/app?paid=${e.id}#/e/${e.id}`,
      cancel_url: `${base}/app#/e/${e.id}`,
      client_reference_id: e.id,
      customer_email: org.email,
      metadata: { event_id: e.id, plan: planKey, organizer_id: org.id },
      payment_intent_data: { metadata: { event_id: e.id, plan: planKey } },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: plan.amount,
          product_data: { name: `kamemories ${plan.label} plan (${e.name})` },
        },
      }],
    });
    return json({ ok: true, url: session.url });
  } catch {
    return json({ error: "stripe", message: "Could not start checkout. Try again." }, 502);
  }
}

// Stripe webhook. Verified by signature, then publishes the paid event.
async function handleStripeWebhook(request, env) {
  const payload = await request.text();
  const sig = request.headers.get("stripe-signature");
  if (!(await verifyStripeSignature(payload, sig, env.STRIPE_WEBHOOK_SECRET))) {
    return new Response("bad signature", { status: 400 });
  }
  let evt;
  try { evt = JSON.parse(payload); } catch { return new Response("bad payload", { status: 400 }); }

  if (evt.type === "checkout.session.completed") {
    const s = evt.data && evt.data.object;
    const meta = (s && s.metadata) || {};
    if (s && s.payment_status === "paid") {
      const plan = PLANS[meta.plan];
      if (meta.event_id && plan) {
        // An event purchase: publish it, then record the sale.
        const e = await eventById(env, meta.event_id);
        if (e && !e.paid_at) {
          await env.DB.prepare(
            "UPDATE events SET plan = ?, paid_at = ?, status = 'active', daily_limit = ?, stripe_session = ? WHERE id = ?"
          ).bind(meta.plan, Date.now(), plan.daily, s.id, meta.event_id).run();
        }
        try { await recordPayment(env, s, { source: "event", eventId: meta.event_id, plan: meta.plan, label: plan.label }); } catch (err) { console.log("[pay] " + (err.message || err)); }
      } else if (s.payment_link) {
        // A package link: create a draft event for the buyer, then record the sale.
        try {
          const pl = await env.DB.prepare("SELECT * FROM package_links WHERE stripe_link = ?").bind(s.payment_link).first();
          if (pl) {
            const evId = await createDraftFromPayment(env, s, pl);
            await recordPayment(env, s, { source: "package_link", eventId: evId, plan: pl.plan, label: pl.label });
          }
        } catch (err) { console.log("[pkg] " + (err.message || err)); }
      }
      // If a vendor code was used, log the redemption so we can tally commission owed.
      try { await recordVendorRedemption(env, s); } catch (err) { console.log("[vendor] " + (err.message || err)); }
    }
  }
  return json({ received: true });
}

// Record a completed checkout in the revenue ledger (idempotent on the session).
async function recordPayment(env, s, info) {
  const amount = s.amount_total != null ? s.amount_total : 0;
  const discount = (s.total_details && s.total_details.amount_discount) || 0;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO payments (id, stripe_session, event_id, source, plan, label, amount_cents, discount_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), s.id, info.eventId || null, info.source, info.plan || null, info.label || null, amount, discount, Date.now()).run();
}

// Create a hidden, paid draft event for a package-link buyer, for the operator to
// finish naming and configuring (it surfaces as a new booking).
async function createDraftFromPayment(env, s, pl) {
  const email = ((s.customer_details && s.customer_details.email) || s.customer_email || "").toString().trim().toLowerCase();
  let org = email ? await env.DB.prepare("SELECT id FROM organizers WHERE email = ?").bind(email).first() : null;
  if (!org) {
    const oid = crypto.randomUUID();
    const addr = isEmail(email) ? email : ("buyer+" + oid.slice(0, 8) + "@kamemories.com");
    await env.DB.prepare("INSERT INTO organizers (id, email, created_at) VALUES (?, ?, ?)").bind(oid, addr, Date.now()).run();
    org = { id: oid };
  }
  const rawName = (((s.customer_details && s.customer_details.name) || (email ? email.split("@")[0] : "") || pl.label || "New booking").toString()).slice(0, 80) || "New booking";
  let base = slugify(rawName).slice(0, 30);
  if (base.length < 2) base = "event";
  let slug = base;
  const taken = await env.DB.prepare("SELECT id FROM events WHERE slug = ?").bind(slug).first();
  if (taken || reservedSet(env).has(slug)) slug = base + "-" + randomToken().slice(0, 4);
  const plan = PLANS[pl.plan] ? pl.plan : "grand";
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO events (id, organizer_id, slug, name, theme, daily_limit, event_tz, rollover_h, status, plan, paid_at, stripe_session, created_at)
     VALUES (?, ?, ?, ?, 'midnight-pearl', ?, 'America/New_York', 2, 'draft', ?, ?, ?, ?)`
  ).bind(id, org.id, slug, rawName, PLANS[plan].daily, plan, now, s.id, now).run();
  return id;
}

// ---------------------------------------------------------------------------
// Vendor referral codes (operator only)
// ---------------------------------------------------------------------------

const VENDOR_POOL_PCT = 50; // margin set aside per code: customer discount + vendor commission
const PAYOUT_METHODS = ["venmo", "paypal", "applepay"];
function normPayoutMethod(v) {
  v = (v || "").toString().trim().toLowerCase();
  return PAYOUT_METHODS.includes(v) ? v : null;
}

async function adminListCodes(request, env) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  // Subqueries (not joins) so redemption and payout sums do not multiply together.
  const { results } = await env.DB.prepare(
    `SELECT vc.id, vc.code, vc.vendor_name, vc.vendor_email, vc.payout_method, vc.payout_id, vc.discount_pct, vc.pool_pct, vc.active, vc.created_at,
            (SELECT COUNT(*) FROM vendor_redemptions vr WHERE vr.code_id = vc.id) AS redemptions,
            (SELECT COALESCE(SUM(gross_cents), 0) FROM vendor_redemptions vr WHERE vr.code_id = vc.id) AS gross_cents,
            (SELECT COALESCE(SUM(commission_cents), 0) FROM vendor_redemptions vr WHERE vr.code_id = vc.id) AS commission_cents,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM vendor_payouts vp WHERE vp.code_id = vc.id) AS paid_cents,
            (SELECT COUNT(*) FROM vendor_payouts vp WHERE vp.code_id = vc.id) AS payouts
     FROM vendor_codes vc ORDER BY vc.created_at DESC`
  ).all();
  return json({ codes: results || [], pool: VENDOR_POOL_PCT, billing: billingOn(env) });
}

async function adminCreateCode(request, env) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  if (!billingOn(env)) return json({ error: "billing_off", message: "Connect Stripe first to mint codes." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad", message: "Bad request." }, 400); }

  const vendorName = (body.vendor_name || "").toString().trim().slice(0, 80);
  if (!vendorName) return json({ error: "vendor", message: "Name the vendor." }, 400);
  const vendorEmail = (body.vendor_email || "").toString().trim().toLowerCase().slice(0, 120) || null;
  if (vendorEmail && !isEmail(vendorEmail)) return json({ error: "email", message: "That vendor email looks off." }, 400);
  const payoutMethod = normPayoutMethod(body.payout_method);
  const payoutId = (body.payout_id || "").toString().trim().slice(0, 120) || null;

  const discountPct = clampInt(body.discount_pct, 1, VENDOR_POOL_PCT, 0);
  if (discountPct < 1) return json({ error: "discount", message: `Pick a customer discount from 1 to ${VENDOR_POOL_PCT} percent.` }, 400);

  let code = (body.code || "").toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) code = (vendorName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "VENDOR") + discountPct;
  if (code.length < 3 || code.length > 40) return json({ error: "code", message: "Codes are 3 to 40 letters and numbers." }, 400);
  const taken = await env.DB.prepare("SELECT id FROM vendor_codes WHERE code = ?").bind(code).first();
  if (taken) return json({ error: "code_taken", message: "That code is already in use." }, 409);

  // A Stripe coupon carries the customer discount; a promotion code is the string
  // the guest types at checkout. Clean up the coupon if the promo step fails.
  let coupon = null, promo = null;
  try {
    coupon = await stripeRequest(env, "coupons", {
      percent_off: discountPct,
      duration: "once",
      name: `${vendorName} (${discountPct}% off)`,
      metadata: { vendor: vendorName, pool: VENDOR_POOL_PCT, discount: discountPct },
    });
    promo = await stripeRequest(env, "promotion_codes", {
      coupon: coupon.id,
      code: code,
      metadata: { vendor: vendorName, pool: VENDOR_POOL_PCT, discount: discountPct, commission: VENDOR_POOL_PCT - discountPct },
    });
  } catch (err) {
    if (coupon && coupon.id && !promo) { try { await stripeDelete(env, "coupons/" + coupon.id); } catch (e) {} }
    return json({ error: "stripe", message: "Stripe could not create that code. " + (err.message || "") }, 502);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO vendor_codes (id, code, vendor_name, vendor_email, payout_method, payout_id, discount_pct, pool_pct, stripe_coupon, stripe_promo, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).bind(id, code, vendorName, vendorEmail, payoutMethod, payoutId, discountPct, VENDOR_POOL_PCT, coupon.id, promo.id, now).run();

  return json({ ok: true, code: {
    id, code, vendor_name: vendorName, vendor_email: vendorEmail, payout_method: payoutMethod, payout_id: payoutId,
    discount_pct: discountPct, pool_pct: VENDOR_POOL_PCT, active: 1, created_at: now, redemptions: 0, gross_cents: 0, commission_cents: 0,
  } }, 201);
}

async function adminUpdateCode(request, env, id) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  const vc = await env.DB.prepare("SELECT * FROM vendor_codes WHERE id = ?").bind(id).first();
  if (!vc) return json({ error: "notfound", message: "Code not found." }, 404);
  let body;
  try { body = await request.json(); } catch { body = {}; }

  const isEdit = body.discount_pct != null || body.payout_method !== undefined || body.payout_id !== undefined;

  // Toggle on/off (Deactivate / Activate); mirror to Stripe so it stops working.
  if (!isEdit) {
    const active = body.active ? 1 : 0;
    if (vc.stripe_promo) {
      try { await stripeRequest(env, "promotion_codes/" + vc.stripe_promo, { active: active ? "true" : "false" }); } catch (e) {}
    }
    await env.DB.prepare("UPDATE vendor_codes SET active = ? WHERE id = ?").bind(active, id).run();
    return json({ ok: true, id, active });
  }

  // Edit: payout details, and optionally the discount. A coupon's percent_off is
  // immutable, so a discount change mints a fresh coupon + promotion code that
  // reuses the same customer-facing code string (the old promo is archived first).
  const payoutMethod = body.payout_method !== undefined ? normPayoutMethod(body.payout_method) : (vc.payout_method || null);
  const payoutId = body.payout_id !== undefined ? ((body.payout_id || "").toString().trim().slice(0, 120) || null) : (vc.payout_id || null);

  let newPct = vc.discount_pct, newCoupon = vc.stripe_coupon, newPromo = vc.stripe_promo;
  if (body.discount_pct != null) {
    const p = clampInt(body.discount_pct, 1, vc.pool_pct, vc.discount_pct);
    if (p < 1) return json({ error: "discount", message: `Pick a discount from 1 to ${vc.pool_pct} percent.` }, 400);
    if (p !== vc.discount_pct) {
      if (!billingOn(env)) return json({ error: "billing_off", message: "Connect Stripe first." }, 503);
      let coupon = null, promo = null;
      try {
        coupon = await stripeRequest(env, "coupons", {
          percent_off: p, duration: "once",
          name: `${vc.vendor_name} (${p}% off)`,
          metadata: { vendor: vc.vendor_name, pool: vc.pool_pct, discount: p },
        });
        if (vc.stripe_promo) { try { await stripeRequest(env, "promotion_codes/" + vc.stripe_promo, { active: "false" }); } catch (e) {} }
        promo = await stripeRequest(env, "promotion_codes", {
          coupon: coupon.id, code: vc.code, active: vc.active ? "true" : "false",
          metadata: { vendor: vc.vendor_name, pool: vc.pool_pct, discount: p, commission: vc.pool_pct - p },
        });
      } catch (err) {
        if (coupon && coupon.id && !promo) { try { await stripeDelete(env, "coupons/" + coupon.id); } catch (e) {} }
        if (vc.stripe_promo) { try { await stripeRequest(env, "promotion_codes/" + vc.stripe_promo, { active: vc.active ? "true" : "false" }); } catch (e) {} }
        return json({ error: "stripe", message: "Could not change the discount. " + (err.message || "") }, 502);
      }
      if (vc.stripe_coupon) { try { await stripeDelete(env, "coupons/" + vc.stripe_coupon); } catch (e) {} }
      newPct = p; newCoupon = coupon.id; newPromo = promo.id;
    }
  }

  await env.DB.prepare(
    "UPDATE vendor_codes SET discount_pct = ?, stripe_coupon = ?, stripe_promo = ?, payout_method = ?, payout_id = ? WHERE id = ?"
  ).bind(newPct, newCoupon, newPromo, payoutMethod, payoutId, id).run();
  return json({ ok: true, id, discount_pct: newPct, payout_method: payoutMethod, payout_id: payoutId, active: vc.active });
}

// Permanently remove a deactivated code and its history. Blocked while it is live
// or still owes commission, so nothing in use or unpaid is lost by accident.
async function adminDeleteCode(request, env, id) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  const vc = await env.DB.prepare("SELECT id, active, stripe_coupon FROM vendor_codes WHERE id = ?").bind(id).first();
  if (!vc) return json({ error: "notfound", message: "Code not found." }, 404);
  if (vc.active) return json({ error: "active", message: "Deactivate the code before removing it." }, 409);
  const sums = await env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(commission_cents), 0) FROM vendor_redemptions WHERE code_id = ?) AS commission,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM vendor_payouts WHERE code_id = ?) AS paid`
  ).bind(id, id).first();
  const owed = Math.max(0, (sums.commission || 0) - (sums.paid || 0));
  if (owed > 0) return json({ error: "owed", message: `This code still owes $${(owed / 100).toFixed(2)}. Record the payout first, then remove it.` }, 409);

  // Delete any payout receipts from R2, then the rows, then the Stripe coupon.
  const { results: payouts } = await env.DB.prepare("SELECT receipt_key FROM vendor_payouts WHERE code_id = ?").bind(id).all();
  for (const p of (payouts || [])) { if (p.receipt_key) { try { await env.BUCKET.delete(p.receipt_key); } catch (e) {} } }
  await env.DB.prepare("DELETE FROM vendor_payouts WHERE code_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM vendor_redemptions WHERE code_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM vendor_codes WHERE id = ?").bind(id).run();
  if (vc.stripe_coupon) { try { await stripeDelete(env, "coupons/" + vc.stripe_coupon); } catch (e) {} }
  return json({ ok: true, id });
}

// ---------------------------------------------------------------------------
// Revenue and package links (operator only)
// ---------------------------------------------------------------------------

async function adminRevenue(request, env) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  // Each line, with the affiliate (vendor commission) for that same session and
  // the net we keep (paid minus affiliate).
  const { results: rowsRaw } = await env.DB.prepare(
    `SELECT p.id, p.label, p.amount_cents, p.discount_cents, p.source, p.created_at, e.name AS event_name,
            COALESCE((SELECT SUM(vr.commission_cents) FROM vendor_redemptions vr WHERE vr.stripe_session = p.stripe_session), 0) AS affiliate_cents
     FROM payments p LEFT JOIN events e ON e.id = p.event_id
     ORDER BY p.created_at DESC LIMIT 1000`
  ).all();
  const payments = (rowsRaw || []).map((r) => ({
    id: r.id, label: r.label, source: r.source, event_name: r.event_name, created_at: r.created_at,
    amount_cents: r.amount_cents || 0, discount_cents: r.discount_cents || 0, affiliate_cents: r.affiliate_cents || 0,
    net_cents: (r.amount_cents || 0) - (r.affiliate_cents || 0),
  }));
  const total = payments.reduce((a, r) => ({
    count: a.count + 1,
    amount_cents: a.amount_cents + r.amount_cents,
    discount_cents: a.discount_cents + r.discount_cents,
    affiliate_cents: a.affiliate_cents + r.affiliate_cents,
    net_cents: a.net_cents + r.net_cents,
  }), { count: 0, amount_cents: 0, discount_cents: 0, affiliate_cents: 0, net_cents: 0 });
  const byMap = {};
  for (const r of payments) {
    const k = r.label || "Other";
    if (!byMap[k]) byMap[k] = { label: k, n: 0, amount: 0 };
    byMap[k].n += 1; byMap[k].amount += r.amount_cents;
  }
  const by_package = Object.values(byMap).sort((a, b) => b.amount - a.amount);
  return json({ total, by_package, payments });
}

// Clear a line from the revenue ledger (a test, refund, or cancellation). Removes
// only the ledger row; it does not refund anything in Stripe.
async function adminDeletePayment(request, env, id) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  await env.DB.prepare("DELETE FROM payments WHERE id = ?").bind(id).run();
  return json({ ok: true, id });
}

async function adminListPackageLinks(request, env) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  const { results } = await env.DB.prepare(
    "SELECT id, label, plan, amount_cents, url, active, created_at FROM package_links ORDER BY created_at DESC"
  ).all();
  return json({ links: results || [], billing: billingOn(env), plans: Object.keys(PLANS).map((k) => ({ plan: k, label: PLANS[k].label, amount_cents: PLANS[k].amount })) });
}

async function adminCreatePackageLink(request, env, url) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  if (!billingOn(env)) return json({ error: "billing_off", message: "Connect Stripe first to make links." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad", message: "Bad request." }, 400); }

  let plan, label, amount;
  if (PLANS[body.plan] && !body.custom) {
    plan = body.plan; label = PLANS[plan].label; amount = PLANS[plan].amount;
  } else {
    label = (body.label || "").toString().trim().slice(0, 60);
    if (!label) return json({ error: "label", message: "Name the package." }, 400);
    amount = Math.round(Number(body.amount_cents) || 0);
    if (!(amount >= 100)) return json({ error: "amount", message: "Enter a price of at least $1." }, 400);
    if (amount > 5000000) return json({ error: "amount", message: "That price looks too high." }, 400);
    plan = PLANS[body.plan] ? body.plan : "grand";
  }

  const base = baseOf(url, env);
  let price = null, link = null;
  try {
    price = await stripeRequest(env, "prices", {
      currency: "usd", unit_amount: amount,
      product_data: { name: "kamemories " + label },
    });
    link = await stripeRequest(env, "payment_links", {
      line_items: [{ price: price.id, quantity: 1 }],
      allow_promotion_codes: true,
      after_completion: { type: "redirect", redirect: { url: `${base}/?paid=1` } },
      metadata: { kind: "package_link", plan: plan, label: label },
      payment_intent_data: { metadata: { kind: "package_link", plan: plan, label: label } },
    });
  } catch (err) {
    return json({ error: "stripe", message: "Stripe could not make that link. " + (err.message || "") }, 502);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO package_links (id, label, plan, amount_cents, stripe_price, stripe_link, url, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).bind(id, label, plan, amount, price.id, link.id, link.url, now).run();

  return json({ ok: true, link: { id, label, plan, amount_cents: amount, url: link.url, active: 1, created_at: now } }, 201);
}

async function adminUpdatePackageLink(request, env, id) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  const pl = await env.DB.prepare("SELECT id, stripe_link FROM package_links WHERE id = ?").bind(id).first();
  if (!pl) return json({ error: "notfound", message: "Link not found." }, 404);
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const active = body.active ? 1 : 0;
  if (pl.stripe_link) {
    try { await stripeRequest(env, "payment_links/" + pl.stripe_link, { active: active ? "true" : "false" }); } catch (e) {}
  }
  await env.DB.prepare("UPDATE package_links SET active = ? WHERE id = ?").bind(active, id).run();
  return json({ ok: true, id, active });
}

const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

// Record a payout against a vendor's owed commission, with an optional receipt
// (PDF or image) stored privately in R2. Multipart so the file can ride along.
async function adminCreatePayout(request, env, codeId) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  const vc = await env.DB.prepare("SELECT id FROM vendor_codes WHERE id = ?").bind(codeId).first();
  if (!vc) return json({ error: "notfound", message: "Code not found." }, 404);

  let form;
  try { form = await request.formData(); } catch { return json({ error: "bad", message: "Bad request." }, 400); }
  const amount = Math.round(Number(form.get("amount_cents")) || 0);
  if (!(amount > 0)) return json({ error: "amount", message: "Enter a payout amount." }, 400);
  const note = (form.get("note") || "").toString().slice(0, 280).trim() || null;

  let receiptKey = null, receiptType = null;
  const file = form.get("receipt");
  if (file && typeof file.arrayBuffer === "function" && file.size > 0) {
    const ct = file.type || "application/octet-stream";
    if (ct !== "application/pdf" && !ct.startsWith("image/")) return json({ error: "file", message: "Attach a PDF or an image." }, 415);
    if (file.size > RECEIPT_MAX_BYTES) return json({ error: "file_size", message: "That file is too large. Max 10MB." }, 413);
    const pid = crypto.randomUUID();
    const ext = ct === "application/pdf" ? "pdf" : extFor(ct);
    receiptKey = `payouts/${codeId}/${pid}.${ext}`;
    receiptType = ct;
    await env.BUCKET.put(receiptKey, await file.arrayBuffer(), { httpMetadata: { contentType: ct } });
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO vendor_payouts (id, code_id, amount_cents, note, receipt_key, receipt_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, codeId, amount, note, receiptKey, receiptType, now).run();

  const sums = await env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(commission_cents), 0) FROM vendor_redemptions WHERE code_id = ?) AS commission,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM vendor_payouts WHERE code_id = ?) AS paid`
  ).bind(codeId, codeId).first();
  return json({
    ok: true,
    payout: { id, amount_cents: amount, note, has_receipt: !!receiptKey, created_at: now },
    commission_cents: sums ? sums.commission : 0,
    paid_cents: sums ? sums.paid : 0,
  }, 201);
}

async function adminListPayouts(request, env, codeId) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  const { results } = await env.DB.prepare(
    "SELECT id, amount_cents, note, receipt_key, created_at FROM vendor_payouts WHERE code_id = ? ORDER BY created_at DESC"
  ).bind(codeId).all();
  const payouts = (results || []).map((p) => ({ id: p.id, amount_cents: p.amount_cents, note: p.note, has_receipt: !!p.receipt_key, created_at: p.created_at }));
  return json({ payouts });
}

// Serve a payout receipt from R2, operator only.
async function adminReceipt(request, env, payoutId) {
  const gate = await requireAdmin(request, env);
  if (gate.error) return gate.error;
  const p = await env.DB.prepare("SELECT receipt_key, receipt_type FROM vendor_payouts WHERE id = ?").bind(payoutId).first();
  if (!p || !p.receipt_key) return new Response("Not found.", { status: 404 });
  const obj = await env.BUCKET.get(p.receipt_key);
  if (!obj) return new Response("Not found.", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("content-type", p.receipt_type || "application/octet-stream");
  headers.set("cache-control", "private, max-age=60");
  return new Response(obj.body, { headers });
}

// From a paid Checkout Session, log a vendor-code redemption (idempotent on the
// session id) so the console can show commission owed. Only runs when a discount
// was applied and the promotion code maps to one of our vendor codes.
async function recordVendorRedemption(env, s) {
  const discountCents = (s.total_details && s.total_details.amount_discount) || 0;
  if (discountCents <= 0) return;

  // Pull the applied promotion code id from whichever shape Stripe used: the
  // session's discounts array, or the total_details breakdown. The breakdown is
  // not inlined by default, so retrieve the session expanded if needed.
  const promoFrom = (arr) => {
    const d = Array.isArray(arr) ? arr[0] : null;
    if (!d) return null;
    let p = d.promotion_code != null ? d.promotion_code : (d.discount && d.discount.promotion_code);
    if (p && typeof p === "object") p = p.id;
    return p || null;
  };
  const breakdown = (x) => x && x.total_details && x.total_details.breakdown && x.total_details.breakdown.discounts;
  let promoId = promoFrom(s.discounts) || promoFrom(breakdown(s));
  if (!promoId) {
    try {
      const full = await stripeGet(env, "checkout/sessions/" + s.id + "?expand[]=total_details.breakdown.discounts");
      promoId = promoFrom(full.discounts) || promoFrom(breakdown(full));
    } catch (e) {}
  }
  if (!promoId) return;

  const vc = await env.DB.prepare("SELECT id, pool_pct FROM vendor_codes WHERE stripe_promo = ?").bind(promoId).first();
  if (!vc) return;

  const gross = s.amount_subtotal != null ? s.amount_subtotal : (s.amount_total || 0) + discountCents;
  const commission = Math.max(0, Math.round(gross * vc.pool_pct / 100) - discountCents);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO vendor_redemptions (id, code_id, event_id, gross_cents, discount_cents, commission_cents, stripe_session, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), vc.id, (s.metadata && s.metadata.event_id) || null, gross, discountCents, commission, s.id, Date.now()).run();
}

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

// Serve a specific asset path (used for clean URLs like / -> /home.html). With a
// status override, rewrap the asset response (used for the event-not-found page).
async function asset(env, url, request, pathname, status) {
  if (!env.ASSETS) return new Response("Not found.", { status: status || 404 });
  const res = await env.ASSETS.fetch(new Request(new URL(pathname, url), request));
  if (!status) return res;
  return new Response(res.body, { status, headers: res.headers });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cold-outreach email tracking (first-party). An open pixel, a click redirect,
// and an unsubscribe, all logged to D1 and surfaced in /admin. Sending stays in
// Gmail; the Worker registers each send (a token + the campaign's tracked links)
// and serves these /t/ endpoints.
// ---------------------------------------------------------------------------

// 1x1 transparent GIF.
const TRACK_PIXEL = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0)
);
// User agents that fetch images on the recipient's behalf (privacy proxies and
// security scanners), firing the pixel without a human looking. Flagged so they
// can be left out of headline open counts.
const TRACK_PROXY_UA = /GoogleImageProxy|YahooMailProxy|Barracuda|Mimecast|Proofpoint|Cloudmark|Microsoft|GoogleDocs/i;

function trackPixelResponse() {
  return new Response(TRACK_PIXEL, {
    headers: {
      "content-type": "image/gif",
      "cache-control": "no-store, no-cache, must-revalidate, private, max-age=0",
      "pragma": "no-cache",
      "expires": "0",
    },
  });
}

// Log without delaying the response. With ctx we use waitUntil; otherwise the
// write still fires, just unawaited.
function fireAndForget(ctx, promise) {
  const p = Promise.resolve(promise).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
}

// GET /t/o/{send_token}.gif -> log an open (only for a real send token), return
// the pixel. The SELECT inserts a row only when a matching send exists.
async function trackOpen(request, env, ctx, sendToken) {
  const ua = request.headers.get("user-agent") || "";
  const ip = request.headers.get("cf-connecting-ip") || "";
  const country = (request.cf && request.cf.country) || "";
  const prefetch = TRACK_PROXY_UA.test(ua) ? 1 : 0;
  fireAndForget(ctx, env.DB.prepare(
    `INSERT INTO tracking_events (send_id, event_type, user_agent, ip, country, is_probably_prefetch, created_at)
     SELECT id, 'open', ?, ?, ?, ?, ?
     FROM outreach_sends WHERE id = ?`
  ).bind(ua, ip, country, prefetch, Date.now(), sendToken).run());
  return trackPixelResponse();
}

// GET /t/c/{send_token}/{link_id} -> log a click, then 302 to the destination
// looked up from tracked_links (never from the request), so it cannot be turned
// into an open redirect. Unknown token or link returns 404 and never redirects.
async function trackClick(request, env, ctx, sendToken, linkId) {
  const row = await env.DB.prepare(
    `SELECT l.destination_url AS dest
       FROM tracked_links l
       JOIN outreach_sends s ON s.campaign_id = l.campaign_id
      WHERE l.id = ? AND s.id = ?`
  ).bind(linkId, sendToken).first();
  if (!row || !row.dest) return new Response("Not found.", { status: 404 });
  const ua = request.headers.get("user-agent") || "";
  const ip = request.headers.get("cf-connecting-ip") || "";
  const country = (request.cf && request.cf.country) || "";
  fireAndForget(ctx, env.DB.prepare(
    `INSERT INTO tracking_events (send_id, event_type, link_id, user_agent, ip, country, created_at)
     VALUES (?, 'click', ?, ?, ?, ?, ?)`
  ).bind(sendToken, linkId, ua, ip, country, Date.now()).run());
  return Response.redirect(row.dest, 302);
}

// GET /t/u/{send_token} -> mark the recipient unsubscribed (suppressing future
// sends) and show a small confirmation page.
async function trackUnsub(request, env, ctx, sendToken) {
  const now = Date.now();
  fireAndForget(ctx, (async () => {
    const send = await env.DB.prepare("SELECT recipient_id FROM outreach_sends WHERE id = ?").bind(sendToken).first();
    if (!send) return;
    if (send.recipient_id) {
      await env.DB.prepare(
        "UPDATE outreach_recipients SET unsubscribed_at = ?, status = 'unsubscribed' WHERE id = ? AND unsubscribed_at IS NULL"
      ).bind(now, send.recipient_id).run();
    }
    await env.DB.prepare(
      `INSERT INTO tracking_events (send_id, event_type, user_agent, ip, country, created_at) VALUES (?, 'unsub', ?, ?, ?, ?)`
    ).bind(sendToken, request.headers.get("user-agent") || "", request.headers.get("cf-connecting-ip") || "", (request.cf && request.cf.country) || "", now).run();
  })());
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Unsubscribed</title><link rel="icon" type="image/png" href="/favicon.png" /><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070d18;color:#eef2f8;font-family:Helvetica,Arial,sans-serif;text-align:center;padding:24px}div{max-width:430px}h1{font-family:Georgia,serif;font-weight:400;font-size:1.7rem;margin:0 0 14px;color:#f2ede2}p{color:#9fb1c6;line-height:1.65;margin:0;font-size:15px}</style></head><body><div><h1>You're unsubscribed</h1><p>You won't receive any more outreach from K &amp; A Memories. If this was a mistake, just reply to our last email and we'll add you back.</p></div></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// Turn a campaign template into per-recipient HTML: rewrite each registered link
// to its tracked click URL, swap the {{unsubscribe}} token, and append the open
// pixel. Only href destinations in the registry are rewritten; other content is
// left untouched. (Used by the Phase 2 campaign-prep step.)
function personalizeEmail(html, { baseUrl, sendToken, links }) {
  let out = html;
  for (const link of links || []) {
    const clickUrl = `${baseUrl}/t/c/${sendToken}/${link.id}`;
    out = out.replaceAll(`href="${link.destination_url}"`, `href="${clickUrl}"`);
    out = out.replaceAll(`href='${link.destination_url}'`, `href='${clickUrl}'`);
  }
  out = out.replaceAll("{{unsubscribe}}", `${baseUrl}/t/u/${sendToken}`);
  const pixel = `<img src="${baseUrl}/t/o/${sendToken}.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;max-height:1px;max-width:1px" />`;
  out = out.includes("</body>") ? out.replace("</body>", `${pixel}</body>`) : out + pixel;
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const { plane, slug } = hostInfo(url, env);

    try {
      // ----- Cold-outreach email tracking: host-agnostic, handled before the
      // plane split so the pixel/click/unsubscribe links work from any host. -----
      if (path.startsWith("/t/") && method === "GET") {
        const om = path.match(/^\/t\/o\/([^/]+)$/);
        if (om) {
          let tok = decodeURIComponent(om[1]);
          if (tok.endsWith(".gif")) tok = tok.slice(0, -4);
          return trackOpen(request, env, ctx, tok);
        }
        const cm = path.match(/^\/t\/c\/([^/]+)\/([^/]+)$/);
        if (cm) return trackClick(request, env, ctx, decodeURIComponent(cm[1]), decodeURIComponent(cm[2]));
        const um = path.match(/^\/t\/u\/([^/]+)$/);
        if (um) return trackUnsub(request, env, ctx, decodeURIComponent(um[1]));
      }

      // ----- Control plane: kamemories.com -----
      if (plane === "control") {
        if (path === "/api/stripe/webhook" && method === "POST") return handleStripeWebhook(request, env);
        if (path === "/api/auth/request" && method === "POST") return authRequest(request, env, url);
        if (path === "/auth/verify" && method === "GET") return authVerify(request, env, url);
        if (path === "/api/auth/me" && method === "GET") return authMe(request, env);
        if (path === "/api/auth/logout" && method === "POST") return authLogout(request, env);
        if (path === "/api/contact" && method === "POST") return handleContact(request, env);

        if (path === "/api/events" && method === "GET") return eventsList(request, env);
        if (path === "/api/events" && method === "POST") return eventsCreate(request, env);

        const evMatch = path.match(/^\/api\/events\/([^/]+)$/);
        if (evMatch) {
          const id = decodeURIComponent(evMatch[1]);
          if (method === "GET") return eventGet(request, env, id);
          if (method === "PATCH") return eventUpdate(request, env, id);
          if (method === "DELETE") return eventDelete(request, env, id);
        }

        const evPhotos = path.match(/^\/api\/events\/([^/]+)\/photos$/);
        if (evPhotos && method === "GET") return ownerPhotos(request, env, decodeURIComponent(evPhotos[1]));

        const evCheckout = path.match(/^\/api\/events\/([^/]+)\/checkout$/);
        if (evCheckout && method === "POST") return handleCheckout(request, env, url, decodeURIComponent(evCheckout[1]));

        const pa = path.match(/^\/api\/photos\/([^/]+)\/(approve|feature|delete)$/);
        if (pa && method === "POST") {
          const id = decodeURIComponent(pa[1]);
          if (pa[2] === "approve") return ownerApprove(request, env, id);
          if (pa[2] === "feature") return ownerFeature(request, env, id);
          if (pa[2] === "delete") return ownerDelete(request, env, id);
        }

        if (path.startsWith("/owner-media/")) {
          return ownerMedia(request, env, decodeURIComponent(path.slice("/owner-media/".length)));
        }

        if (path === "/api/admin/overview" && method === "GET") return adminOverview(request, env);
        if (path === "/api/admin/events" && method === "POST") return adminCreateEvent(request, env);
        const adminEv = path.match(/^\/api\/admin\/events\/([^/]+)$/);
        if (adminEv) {
          const id = decodeURIComponent(adminEv[1]);
          if (method === "PATCH") return adminUpdateEvent(request, env, id);
          if (method === "DELETE") return adminDeleteEvent(request, env, id);
        }
        if (path === "/api/admin/assistant" && method === "POST") return adminAssistant(request, env);
        if (path === "/api/admin/codes" && method === "GET") return adminListCodes(request, env);
        if (path === "/api/admin/codes" && method === "POST") return adminCreateCode(request, env);
        const adminCode = path.match(/^\/api\/admin\/codes\/([^/]+)$/);
        if (adminCode && method === "PATCH") return adminUpdateCode(request, env, decodeURIComponent(adminCode[1]));
        if (adminCode && method === "DELETE") return adminDeleteCode(request, env, decodeURIComponent(adminCode[1]));
        const adminPayouts = path.match(/^\/api\/admin\/codes\/([^/]+)\/payouts$/);
        if (adminPayouts) {
          const cid = decodeURIComponent(adminPayouts[1]);
          if (method === "GET") return adminListPayouts(request, env, cid);
          if (method === "POST") return adminCreatePayout(request, env, cid);
        }
        const adminReceiptM = path.match(/^\/api\/admin\/payouts\/([^/]+)\/receipt$/);
        if (adminReceiptM && method === "GET") return adminReceipt(request, env, decodeURIComponent(adminReceiptM[1]));
        if (path === "/api/admin/revenue" && method === "GET") return adminRevenue(request, env);
        const adminPay = path.match(/^\/api\/admin\/payments\/([^/]+)$/);
        if (adminPay && method === "DELETE") return adminDeletePayment(request, env, decodeURIComponent(adminPay[1]));
        if (path === "/api/admin/package-links" && method === "GET") return adminListPackageLinks(request, env);
        if (path === "/api/admin/package-links" && method === "POST") return adminCreatePackageLink(request, env, url);
        const adminPl = path.match(/^\/api\/admin\/package-links\/([^/]+)$/);
        if (adminPl && method === "PATCH") return adminUpdatePackageLink(request, env, decodeURIComponent(adminPl[1]));

        if (method === "GET") {
          if (path === "/") return asset(env, url, request, "/home.html");
          if (path === "/login") return asset(env, url, request, "/login.html");
          if (path === "/app") return asset(env, url, request, "/dashboard.html");
          if (path === "/admin") return asset(env, url, request, "/admin.html");
        }

        return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found.", { status: 404 });
      }

      // ----- Event plane: {slug}.kamemories.com -----
      const event = await eventBySlug(env, slug);
      const isActive = !!event && event.status === "active";

      if (path.startsWith("/api/") || path.startsWith("/media/")) {
        if (!isActive) return json({ error: "no_event", message: "This event is not available." }, 404);
        if (path === "/api/event" && method === "GET") return handlePublicEvent(event);
        if (path === "/api/quota" && method === "GET") return handleQuota(request, env, event);
        if (path === "/api/upload" && method === "POST") return handleUpload(request, env, event);
        if (path === "/api/public/photos" && method === "GET") return handlePublicPhotos(request, env, event);
        const likeM = path.match(/^\/api\/public\/photos\/([^/]+)\/like$/);
        if (likeM && method === "POST") return handleLike(request, env, event, decodeURIComponent(likeM[1]));
        if (path.startsWith("/media/")) return handleMedia(request, env, event, decodeURIComponent(path.slice("/media/".length)));
        return json({ error: "not_found", message: "Not found." }, 404);
      }

      if (!isActive) {
        if (method === "GET") {
          // Serve real static files (styles, favicon, the footer logo) so the
          // not-found page renders properly; show the page itself for navigations.
          if (/\.[a-z0-9]+$/i.test(path) && !path.endsWith(".html")) {
            return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found.", { status: 404 });
          }
          return asset(env, url, request, "/event-404.html", 404);
        }
        return new Response("Not found.", { status: 404 });
      }

      if (method === "GET") {
        if (path === "/") return asset(env, url, request, "/event.html");
        if (path === "/gallery") return asset(env, url, request, "/gallery.html");
        if (path === "/add") return asset(env, url, request, "/add.html");
        // The demo subdomain also exposes a sandboxed organizer dashboard.
        if (path === "/app" && slug === "demo") return asset(env, url, request, "/dashboard.html");
      }

      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found.", { status: 404 });
    } catch (err) {
      return json({ error: "server", message: "Something broke on our end. Try again." }, 500);
    }
  },
};
