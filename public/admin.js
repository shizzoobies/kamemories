// Operator console. Gated server-side to ADMIN_EMAILS: this page only renders
// data the /api/admin endpoints return, and they return nothing unless the signed
// in organizer is an operator. A compact list of every event (built to scan dozens)
// opens into a full detail view where each event's settings are edited. Hash routed:
// #/ is the list, #/e/<id> manages one event. Also lists clients and talks to Opus.

const $ = (id) => document.getElementById(id);

let data = null;            // { me, clients, events, stats, billing, assistant }
let eventsFilter = "";
let currentId = null;       // event open in the detail view
const chat = [];            // assistant messages [{role, content}]
let codes = [];             // vendor referral codes
let POOL = 50;              // margin pool per code (customer discount + vendor commission)
let eventSort = "soon", clientSort = "new", codeSort = "new";

let toastTimer = null;
function toast(msg, isErr) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("err", !!isErr);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}
function setMsg(id, text, isErr) { const el = $(id); el.textContent = text || ""; el.classList.toggle("err", !!isErr); }
function esc(s) { return (s || "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function fmtDate(ms) { try { return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch (e) { return ""; } }
const PLAN_LABEL = { intimate: "Intimate", signature: "Signature", grand: "Grand" };

// ---- Event date parsing + live countdown ----
// event_date is free text, so parse best effort: a clean date first, then ranges
// like "July 9-12, 2026" (take the start), then any "Month Day ... Year".
function parseEventDate(s) {
  if (!s) return null;
  s = String(s).trim();
  // Trust a direct parse only when a 4-digit year is present, so casual strings
  // like "June 20th-June23rd" do not parse to a garbage year.
  let t = Date.parse(s);
  if (!isNaN(t) && /\d{4}/.test(s)) return t;
  // Normalize dashes (via char code, to keep dash characters out of source) and
  // drop ordinal suffixes, then take the month and first day, assuming a year.
  const norm = s.split(String.fromCharCode(0x2013)).join("-")
    .split(String.fromCharCode(0x2014)).join("-")
    .replace(/(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
  const m = norm.match(/([A-Za-z]{3,})\.?\s+(\d{1,2})(?:\s*(?:-|to)\s*(?:[A-Za-z]+\.?\s*)?\d{1,2})?(?:,?\s*(\d{4}))?/i);
  if (m) {
    const year = m[3] ? m[3] : assumeYear(m[1], m[2]);
    t = Date.parse(m[1] + " " + m[2] + ", " + year);
    if (!isNaN(t)) return t;
  }
  return null;
}
function assumeYear(monthName, day) {
  const y = new Date().getFullYear();
  const t = Date.parse(monthName + " " + day + ", " + y);
  if (isNaN(t)) return y;
  // A date well in the past with no year was probably meant for next year.
  return t < Date.now() - 60 * 86400000 ? y + 1 : y;
}
function eventTs(e) {
  if (e._ts === undefined) e._ts = parseEventDate(e.event_date);
  return e._ts;
}
function countdownText(ts) {
  if (ts == null) return null;
  const day = 86400000;
  const diff = ts - Date.now();
  if (diff <= 0) {
    const d = Math.floor(-diff / day);
    if (d === 0) return { text: "happening today", cls: "now" };
    return { text: d + (d === 1 ? " day ago" : " days ago"), cls: "past" };
  }
  const d = Math.floor(diff / day);
  const h = Math.floor((diff % day) / 3600000);
  if (d === 0) {
    if (h === 0) { const mn = Math.floor((diff % 3600000) / 60000); return { text: "in " + mn + " min", cls: "now" }; }
    return { text: "in " + h + (h === 1 ? " hr" : " hrs"), cls: "now" };
  }
  if (d <= 2) return { text: "in " + d + (d === 1 ? " day" : " days") + (h ? ", " + h + (h === 1 ? " hr" : " hrs") : ""), cls: "soon" };
  return { text: "in " + d + " days", cls: d <= 14 ? "near" : "" };
}
let countdownTimer = null;
function updateCountdowns() {
  document.querySelectorAll(".evr-countdown[data-ts]").forEach((el) => {
    const cd = countdownText(Number(el.getAttribute("data-ts")));
    if (cd) { el.textContent = cd.text; el.className = "evr-countdown " + cd.cls; }
  });
  if (!countdownTimer) countdownTimer = setInterval(updateCountdowns, 60000);
}

async function boot() {
  let r;
  try { r = await fetch("/api/admin/overview", { credentials: "same-origin" }); }
  catch (e) { $("loading").textContent = "Could not load. Check your connection."; return; }
  if (r.status === 401) { location.href = "/login"; return; }
  $("loading").style.display = "none";
  if (r.status === 403) { $("denied").style.display = "block"; return; }
  if (!r.ok) { $("loading").style.display = "block"; $("loading").textContent = "Something went wrong."; return; }
  data = await r.json();
  renderWho();
  renderStats();
  renderClients();
  loadCodes();
  loadRevenue();
  loadPackageLinks();
  setupCollapse("revenueColhead", "revenueWrap", "kmRevenueOpen");
  setupCollapse("linksColhead", "linksWrap", "kmLinksOpen");
  setupCollapse("codesColhead", "codesWrap", "kmCodesOpen");
  setupCollapse("clientsColhead", "clientsWrap", "kmClientsOpen");
  if (data.assistant === false) $("asstNote").textContent = "The assistant is not switched on yet. Add the ANTHROPIC_API_KEY secret and it will appear here.";
  window.addEventListener("hashchange", route);
  route();
}

function route() {
  const m = location.hash.match(/^#\/e\/(.+)$/);
  if (m) openEvent(decodeURIComponent(m[1]));
  else showList();
}

function renderWho() {
  const who = $("who");
  who.innerHTML = "";
  const span = document.createElement("span");
  span.className = "who-email";
  span.textContent = data.me.email;
  const dash = document.createElement("a");
  dash.href = "/app"; dash.className = "who-out"; dash.textContent = "My dashboard";
  const out = document.createElement("a");
  out.href = "#"; out.className = "who-out"; out.textContent = "Sign out";
  out.addEventListener("click", async (e) => {
    e.preventDefault();
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    location.href = "/login";
  });
  who.append(span, dash, out);
}

function renderStats() {
  const owed = data.stats.owed_cents || 0;
  const items = [
    { label: "Clients", value: data.stats.clients },
    { label: "Events", value: data.stats.events },
    { label: "Billing", value: data.billing ? "Live" : "Off" },
    { label: "Owed", value: money(owed), owed: true },
  ];
  const wrap = $("stats");
  wrap.innerHTML = "";
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "stat";
    const v = document.createElement("div");
    v.className = "stat-v" + (it.owed ? " owed-v" : "");
    if (it.owed) { v.id = "statOwed"; if (owed > 0) v.classList.add("owed"); }
    v.textContent = it.value;
    const l = document.createElement("div"); l.className = "stat-l"; l.textContent = it.label;
    card.append(v, l);
    wrap.appendChild(card);
  }
}

// Keep the top "Owed to vendors" figure in sync with the codes list (which has
// the live per-code commission and payout totals).
function recomputeOwed() {
  const el = $("statOwed");
  if (!el) return;
  const total = codes.reduce((n, c) => n + Math.max(0, (c.commission_cents || 0) - (c.paid_cents || 0)), 0);
  el.textContent = money(total);
  el.classList.toggle("owed", total > 0);
}

// ---- List view ----
function showList() {
  currentId = null;
  $("eventDetail").style.display = "none";
  $("console").style.display = "block";
  renderNewBookings();
  renderEvents();
  window.scrollTo(0, 0);
}

function eventMatches(e) {
  if (!eventsFilter) return true;
  const t = eventsFilter.toLowerCase();
  return (e.name || "").toLowerCase().includes(t) || (e.slug || "").toLowerCase().includes(t) || (e.organizer_email || "").toLowerCase().includes(t);
}

function isNewBooking(e) { return !!(e && e.paid_at && !e.reviewed_at); }

function renderNewBookings() {
  const wrap = $("newBookings");
  const rows = data.events.filter(isNewBooking);
  if (!rows.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";
  $("newbkCount").textContent = rows.length + (rows.length === 1 ? " booking" : " bookings");
  const list = $("newbkList");
  list.innerHTML = "";
  for (const e of rows) list.appendChild(eventRow(e));
}

function renderEvents() {
  const list = $("eventsList");
  list.innerHTML = "";
  const rows = data.events.filter(eventMatches);
  const sumPhotos = rows.reduce((n, e) => n + (e.total || 0), 0);
  $("eventsCount").textContent = rows.length + (rows.length === 1 ? " event" : " events") +
    " · " + sumPhotos + (sumPhotos === 1 ? " photo" : " photos");
  if (!rows.length) { list.innerHTML = '<p class="admin-empty">No events match.</p>'; return; }
  for (const e of sortEvents(rows)) list.appendChild(eventRow(e));
  updateCountdowns();
}

function eventRow(e) {
  const row = document.createElement("div");
  row.className = "admin-row";
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const plan = e.plan ? PLAN_LABEL[e.plan] : "No plan";
  const ts = eventTs(e);
  const cd = ts != null ? countdownText(ts) : null;
  const cdHtml = cd ? '<span class="evr-countdown ' + cd.cls + '" data-ts="' + ts + '">' + esc(cd.text) + '</span>' : '';
  row.innerHTML =
    '<div class="evr-id">' +
      '<div class="evr-top">' +
        '<span class="evr-name">' + esc(e.name) + '</span>' +
        '<span class="ev-badge ' + esc(e.status) + '">' + esc(e.status) + '</span>' +
        (isNewBooking(e) ? '<span class="newbk-pill">New</span>' : '') +
      '</div>' +
      '<span class="evr-host">' + esc(e.host) + '</span>' +
    '</div>' +
    '<div class="evr-right">' +
      '<div class="evr-meta">' +
        cdHtml +
        '<span class="evr-owner">' + esc(e.organizer_email) + '</span>' +
        '<span class="evr-count">' + (e.total || 0) + ' photos &middot; ' + esc(plan) + '</span>' +
      '</div>' +
      '<span class="evr-go" aria-hidden="true">&rsaquo;</span>' +
    '</div>';
  const open = () => { location.hash = "#/e/" + encodeURIComponent(e.id); };
  row.addEventListener("click", open);
  row.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
  return row;
}

function renderClients() {
  const list = $("clientsList");
  list.innerHTML = "";
  $("clientsCount").textContent = data.clients.length + (data.clients.length === 1 ? " client" : " clients");
  if (!data.clients.length) { list.innerHTML = '<p class="admin-empty">No clients yet.</p>'; return; }
  for (const c of sortClients(data.clients)) {
    const row = document.createElement("div");
    row.className = "admin-client";
    const initial = esc(((c.email || "?").trim().charAt(0) || "?").toUpperCase());
    row.innerHTML =
      '<div class="cl-mono">' + initial + '</div>' +
      '<div class="cl-body"><div class="cl-email">' + esc(c.email) + '</div></div>' +
      '<div class="cl-meta">' + (c.events || 0) + ' events &middot; ' + (c.photos || 0) + ' photos &middot; joined ' + fmtDate(c.created_at) + '</div>';
    list.appendChild(row);
  }
}

// ---- Sorting (every list in the console) ----
function sortEvents(rows) {
  const a = rows.slice();
  if (eventSort === "soon") {
    // Soonest upcoming (today counts as upcoming, so an event in progress leads);
    // then past events (most recent first); then events with no readable date.
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const today = midnight.getTime();
    a.sort((x, y) => {
      const tx = eventTs(x), ty = eventTs(y);
      const ux = tx != null && tx >= today, uy = ty != null && ty >= today;
      if (ux && uy) return tx - ty;
      if (ux !== uy) return ux ? -1 : 1;
      const px = tx != null, py = ty != null;
      if (px && py) return ty - tx;
      if (px !== py) return px ? -1 : 1;
      return y.created_at - x.created_at;
    });
  }
  else if (eventSort === "name") a.sort((x, y) => (x.name || "").localeCompare(y.name || ""));
  else if (eventSort === "status") a.sort((x, y) => (x.status || "").localeCompare(y.status || "") || (y.created_at - x.created_at));
  else if (eventSort === "paid") a.sort((x, y) => (y.paid_at || 0) - (x.paid_at || 0) || (y.created_at - x.created_at));
  else if (eventSort === "photos") a.sort((x, y) => (y.total || 0) - (x.total || 0));
  else a.sort((x, y) => y.created_at - x.created_at);
  return a;
}
function sortClients(rows) {
  const a = rows.slice();
  if (clientSort === "name") a.sort((x, y) => (x.email || "").localeCompare(y.email || ""));
  else if (clientSort === "events") a.sort((x, y) => (y.events || 0) - (x.events || 0));
  else if (clientSort === "photos") a.sort((x, y) => (y.photos || 0) - (x.photos || 0));
  else a.sort((x, y) => y.created_at - x.created_at);
  return a;
}
function codeOwed(c) { return Math.max(0, (c.commission_cents || 0) - (c.paid_cents || 0)); }
function sortCodes(rows) {
  const a = rows.slice();
  if (codeSort === "owed") a.sort((x, y) => codeOwed(y) - codeOwed(x));
  else if (codeSort === "uses") a.sort((x, y) => (y.redemptions || 0) - (x.redemptions || 0));
  else if (codeSort === "discount") a.sort((x, y) => (y.discount_pct || 0) - (x.discount_pct || 0));
  else if (codeSort === "name") a.sort((x, y) => (x.vendor_name || "").localeCompare(y.vendor_name || ""));
  else a.sort((x, y) => y.created_at - x.created_at);
  return a;
}
$("eventsSort").addEventListener("change", (e) => { eventSort = e.target.value; renderEvents(); });
$("clientsSort").addEventListener("change", (e) => { clientSort = e.target.value; renderClients(); });
$("codesSort").addEventListener("change", (e) => { codeSort = e.target.value; renderCodes(); });

// ---- Detail view ----
function openEvent(id) {
  const e = data && data.events.find((x) => x.id === id);
  if (!e) { location.hash = ""; return; }
  currentId = id;
  $("console").style.display = "none";
  $("eventDetail").style.display = "block";
  fillDetail(e);
  window.scrollTo(0, 0);
}

function detailStats(e) {
  const items = [
    { label: "Total", value: e.total || 0 },
    { label: "Pending", value: e.pending || 0 },
    { label: "Approved", value: e.approved || 0 },
  ];
  const wrap = $("dStats");
  wrap.innerHTML = "";
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "stat";
    const v = document.createElement("div"); v.className = "stat-v"; v.textContent = it.value;
    const l = document.createElement("div"); l.className = "stat-l"; l.textContent = it.label;
    card.append(v, l);
    wrap.appendChild(card);
  }
}

function fillDetail(e) {
  $("dName").textContent = e.name;
  const url = $("dUrl"); url.textContent = e.host; url.href = e.url;
  $("dOwner").textContent = "Client: " + e.organizer_email;
  $("dView").href = e.url;
  detailStats(e);
  $("dInName").value = e.name || "";
  $("dInSlug").value = e.slug || "";
  $("dInLimit").value = e.daily_limit || 10;
  $("dInPlan").value = e.plan || "";
  $("dInStatus").value = e.status || "active";
  $("dInTagline").value = e.tagline || "";
  $("dInDate").value = e.event_date || "";
  $("dInVenue").value = e.venue || "";
  $("dNewBanner").style.display = isNewBooking(e) ? "flex" : "none";
  setMsg("detailMsg", "", false);
}

$("detailBack").addEventListener("click", () => { location.hash = ""; });

$("dCopy").addEventListener("click", async () => {
  const e = data.events.find((x) => x.id === currentId);
  if (!e) return;
  try { await navigator.clipboard.writeText(e.capture_url); toast("Capture link copied."); }
  catch (err) { toast("Could not copy.", true); }
});

$("dConfirm").addEventListener("click", async () => {
  const e = data.events.find((x) => x.id === currentId);
  if (!e) return;
  const btn = $("dConfirm");
  btn.disabled = true;
  try {
    const r = await fetch("/api/admin/events/" + encodeURIComponent(currentId), {
      method: "PATCH", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewed: true }),
    });
    const d = await r.json();
    if (!r.ok) { toast(d.message || "Could not confirm.", true); return; }
    Object.assign(e, d.event);
    $("dNewBanner").style.display = "none";
    renderNewBookings();
    renderEvents();
    toast("Booking confirmed.");
  } catch (err) { toast("No connection.", true); }
  finally { btn.disabled = false; }
});

$("detailForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const e = data.events.find((x) => x.id === currentId);
  if (!e) return;
  const btn = $("dSave");
  btn.disabled = true;
  const body = {
    name: $("dInName").value.trim(),
    slug: $("dInSlug").value.trim(),
    daily_limit: parseInt($("dInLimit").value, 10),
    plan: $("dInPlan").value || null,
    status: $("dInStatus").value,
    tagline: $("dInTagline").value,
    event_date: $("dInDate").value,
    venue: $("dInVenue").value,
  };
  try {
    const r = await fetch("/api/admin/events/" + encodeURIComponent(currentId), {
      method: "PATCH", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) { setMsg("detailMsg", d.message || "Could not save.", true); return; }
    Object.assign(e, d.event);
    fillDetail(e);
    setMsg("detailMsg", "Saved.", false);
    toast("Saved.");
  } catch (err) {
    setMsg("detailMsg", "No connection. Try again.", true);
  } finally {
    btn.disabled = false;
  }
});

$("dDelete").addEventListener("click", async () => {
  const e = data.events.find((x) => x.id === currentId);
  if (!e) return;
  if (!confirm("Delete " + e.name + " and every photo in it? This cannot be undone.")) return;
  try {
    const r = await fetch("/api/admin/events/" + encodeURIComponent(currentId), { method: "DELETE", credentials: "same-origin" });
    if (!r.ok) { toast("Could not delete.", true); return; }
    data.events = data.events.filter((x) => x.id !== currentId);
    data.stats.events = data.events.length;
    toast("Event deleted.");
    location.hash = "";
  } catch (err) { toast("No connection.", true); }
});

// ---- New client event wizard ----
function openModal(id) { $(id).classList.add("show"); }
function closeModal(id) { $(id).classList.remove("show"); }
function slugify(s) { return (s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }

const PLAN_INFO = {
  intimate: { name: "Intimate", price: "$49", guests: "Up to 75 guests", photos: 10, hint: "Intimate covers up to 75 guests. 10 photos each keeps the gallery curated and is plenty for most." },
  signature: { name: "Signature", price: "$99", guests: "Up to 200 guests", photos: 20, hint: "Signature covers up to 200 guests. 20 photos each is a generous default; most weddings never reach it." },
  grand: { name: "Grand", price: "$149", guests: "Unlimited guests", photos: 30, hint: "Grand has no guest cap. 30 photos each suits big, photo-happy celebrations." },
};
const WIZ_LAST = 3;
let wizStep = 0;
let wizPlan = "signature";
let wizLimitTouched = false;

function openWizard(prefill) {
  prefill = prefill || {};
  wizStep = 0;
  wizPlan = prefill.plan && PLAN_INFO[prefill.plan] ? prefill.plan : "signature";
  wizLimitTouched = !!prefill.daily_limit;
  $("wName").value = prefill.name || "";
  $("wEmail").value = prefill.email || "";
  $("wDate").value = prefill.event_date || "";
  $("wVenue").value = prefill.venue || "";
  $("wSlug").value = prefill.slug || "";
  $("wLimit").value = prefill.daily_limit || PLAN_INFO[wizPlan].photos;
  $("wActive").checked = true;
  setMsg("wizMsg", "", false);
  renderWizPlans();
  showWizStep();
  openModal("wizModal");
  setTimeout(() => $("wName").focus(), 60);
}

function renderWizPlans() {
  const wrap = $("wizPlans");
  wrap.innerHTML = "";
  Object.keys(PLAN_INFO).forEach((key) => {
    const p = PLAN_INFO[key];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wiz-plan" + (key === wizPlan ? " on" : "");
    b.innerHTML = '<div class="wiz-plan-top"><span class="wiz-plan-name">' + p.name + '</span><span class="wiz-plan-price">' + p.price + '</span></div>' +
      '<div class="wiz-plan-meta">' + p.guests + ' &middot; ' + p.photos + ' photos per guest, daily</div>';
    b.addEventListener("click", () => {
      wizPlan = key;
      if (!wizLimitTouched) $("wLimit").value = p.photos;
      renderWizPlans();
    });
    wrap.appendChild(b);
  });
}

function showWizStep() {
  document.querySelectorAll(".wiz-step").forEach((s) => { s.hidden = (+s.dataset.step !== wizStep); });
  const dots = $("wizSteps");
  dots.innerHTML = "";
  for (let i = 0; i <= WIZ_LAST; i++) { const d = document.createElement("span"); d.className = "wiz-dot" + (i <= wizStep ? " on" : ""); dots.appendChild(d); }
  $("wizBack").style.visibility = wizStep === 0 ? "hidden" : "visible";
  $("wizNext").style.display = wizStep === WIZ_LAST ? "none" : "";
  $("wizCreate").style.display = wizStep === WIZ_LAST ? "" : "none";
  if (wizStep === 2) $("wLimitHint").textContent = PLAN_INFO[wizPlan].hint;
  if (wizStep === WIZ_LAST) renderWizReview();
}

function wizValidate() {
  if (wizStep === 0) {
    if (!$("wName").value.trim()) { setMsg("wizMsg", "Add the couple or event name.", true); return false; }
    if (!/.+@.+\..+/.test($("wEmail").value.trim())) { setMsg("wizMsg", "Add a valid client email.", true); return false; }
  }
  setMsg("wizMsg", "", false);
  return true;
}

function wizAdvance() {
  if (!wizValidate()) return;
  if (wizStep === 0 && !$("wSlug").value.trim()) $("wSlug").value = slugify($("wName").value);
  if (wizStep < WIZ_LAST) { wizStep++; showWizStep(); }
}

function renderWizReview() {
  const slug = ($("wSlug").value.trim() || slugify($("wName").value)) || "event";
  const rows = [
    ["Couple", $("wName").value.trim()],
    ["Client", $("wEmail").value.trim()],
    ["Plan", PLAN_INFO[wizPlan].name],
    ["Photos per guest", $("wLimit").value + " daily"],
    ["Address", slug + ".kamemories.com"],
    ["Date", $("wDate").value.trim() || "Not set"],
    ["Venue", $("wVenue").value.trim() || "Not set"],
  ];
  $("wizReview").innerHTML = rows.map((r) => '<div class="wiz-review-row"><span>' + esc(r[0]) + '</span><span>' + esc(r[1]) + '</span></div>').join("");
}

$("newBtn").addEventListener("click", () => openWizard());
$("wizClose").addEventListener("click", () => closeModal("wizModal"));
$("wizModal").addEventListener("click", (e) => { if (e.target.id === "wizModal") closeModal("wizModal"); });
$("wizBack").addEventListener("click", () => { if (wizStep > 0) { wizStep--; showWizStep(); } });
$("wizNext").addEventListener("click", wizAdvance);
$("wLimit").addEventListener("input", () => { wizLimitTouched = true; });
$("wMinus").addEventListener("click", () => { const v = parseInt($("wLimit").value, 10) || 1; $("wLimit").value = Math.max(1, v - 1); wizLimitTouched = true; });
$("wPlus").addEventListener("click", () => { const v = parseInt($("wLimit").value, 10) || 0; $("wLimit").value = Math.min(1000, v + 1); wizLimitTouched = true; });

$("wizForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (wizStep !== WIZ_LAST) { wizAdvance(); return; } // Enter advances on earlier steps
  const btn = $("wizCreate");
  btn.disabled = true;
  const body = {
    email: $("wEmail").value.trim(),
    name: $("wName").value.trim(),
    slug: $("wSlug").value.trim(),
    plan: wizPlan,
    status: $("wActive").checked ? "active" : "draft",
    daily_limit: parseInt($("wLimit").value, 10) || PLAN_INFO[wizPlan].photos,
    event_date: $("wDate").value.trim(),
    venue: $("wVenue").value.trim(),
  };
  try {
    const r = await fetch("/api/admin/events", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) { setMsg("wizMsg", d.message || "Could not create the event.", true); return; }
    closeModal("wizModal");
    toast("Event created.");
    const o = await fetch("/api/admin/overview", { credentials: "same-origin" });
    if (o.ok) { data = await o.json(); renderStats(); renderClients(); }
    location.hash = "#/e/" + encodeURIComponent(d.event.id);
  } catch (err) {
    setMsg("wizMsg", "No connection. Try again.", true);
  } finally {
    btn.disabled = false;
  }
});

$("eventsSearch").addEventListener("input", (e) => { eventsFilter = e.target.value.trim(); renderEvents(); });

// ---- Assistant ----
function renderChat() {
  const log = $("asstLog");
  log.innerHTML = "";
  for (const m of chat) {
    const row = document.createElement("div");
    row.className = "asst-msg " + (m.role === "user" ? "asst-user" : "asst-bot");
    row.textContent = m.content;
    log.appendChild(row);
  }
  log.scrollTop = log.scrollHeight;
}

$("asstForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("asstInput");
  const text = input.value.trim();
  if (!text) return;
  chat.push({ role: "user", content: text });
  input.value = "";
  const send = $("asstSend");
  send.disabled = true;
  const thinking = { role: "assistant", content: "Thinking..." };
  chat.push(thinking);
  renderChat();
  try {
    const r = await fetch("/api/admin/assistant", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: chat.filter((m) => m !== thinking) }),
    });
    const d = await r.json();
    chat.pop();
    chat.push({ role: "assistant", content: r.ok ? (d.reply || "(no reply)") : (d.message || "The assistant could not respond.") });
    renderChat();
  } catch (err) {
    chat.pop();
    chat.push({ role: "assistant", content: "Could not reach the assistant." });
    renderChat();
  } finally {
    send.disabled = false;
    input.focus();
  }
});

// Floating assistant: collapsed to a bubble until opened.
function openAsst() { $("asstPanel").classList.add("open"); $("asstFab").style.display = "none"; $("asstInput").focus(); }
function closeAsst() { $("asstPanel").classList.remove("open"); $("asstFab").style.display = "flex"; }
$("asstFab").addEventListener("click", openAsst);
$("asstClose").addEventListener("click", closeAsst);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("asstPanel").classList.contains("open")) closeAsst(); });

// ---- Vendor referral codes ----
function money(cents) { return "$" + (Math.round(cents || 0) / 100).toFixed(2); }

async function loadCodes() {
  try {
    const r = await fetch("/api/admin/codes", { credentials: "same-origin" });
    if (!r.ok) return;
    const d = await r.json();
    codes = d.codes || [];
    if (d.pool) POOL = d.pool;
    renderCodes();
    recomputeOwed();
  } catch (e) {}
}

const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

async function copyCode(code) {
  try { await navigator.clipboard.writeText(code); toast(code + " copied."); }
  catch (e) { toast("Could not copy. Select the code to copy it.", true); }
}

const PAYOUT_LABELS = { venmo: "Venmo", paypal: "PayPal", applepay: "Apple Pay" };
function payViaText(c) {
  if (!c.payout_method) return "";
  const label = PAYOUT_LABELS[c.payout_method] || c.payout_method;
  return c.payout_id ? label + " · " + c.payout_id : label;
}

function renderCodes() {
  const list = $("codesList");
  if (!list) return;
  list.innerHTML = "";
  if (!codes.length) { list.innerHTML = '<p class="admin-empty">No vendor codes yet. Create one to start a referral.</p>'; return; }
  for (const c of sortCodes(codes)) {
    const pool = c.pool_pct || POOL;
    const earn = pool - c.discount_pct;
    const owed = codeOwed(c);
    const card = document.createElement("div");
    card.className = "code-card" + (c.active ? "" : " off");
    card.innerHTML =
      '<div class="code-id">' +
        '<strong class="code-vendor">' + esc(c.vendor_name) + '</strong>' +
        '<span class="code-tagrow"><span class="code-tag">' + esc(c.code) + '</span>' +
          '<button class="code-copy" type="button" title="Copy code" aria-label="Copy code">' + COPY_ICON + '</button></span>' +
        (c.payout_method ? '<span class="code-payvia">' + esc(payViaText(c)) + '</span>' : '') +
      '</div>' +
      '<span class="code-split">' + c.discount_pct + '% off &middot; vendor earns ' + earn + '% &middot; you keep ' + (100 - pool) + '%</span>' +
      '<div class="code-stats">' + (c.redemptions || 0) + (c.redemptions === 1 ? ' use' : ' uses') +
        ' &middot; <strong class="code-owed' + (owed > 0 ? ' due' : '') + '">' + money(owed) + '</strong> owed' +
        ((c.paid_cents || 0) > 0 ? ' &middot; ' + money(c.paid_cents) + ' paid' : '') + '</div>' +
      '<div class="code-actions">' +
        '<button class="btn code-edit" type="button">Edit</button>' +
        '<button class="btn code-pay" type="button">Mark paid</button>' +
        '<button class="btn code-toggle" type="button">' + (c.active ? "Deactivate" : "Activate") + '</button>' +
        (!c.active ? '<button class="btn code-remove" type="button">Remove</button>' : '') +
      '</div>';
    card.querySelector(".code-copy").addEventListener("click", () => copyCode(c.code));
    card.querySelector(".code-edit").addEventListener("click", () => openEditCode(c));
    card.querySelector(".code-pay").addEventListener("click", () => openPayout(c));
    card.querySelector(".code-toggle").addEventListener("click", (e) => toggleCode(c, e.currentTarget));
    const rm = card.querySelector(".code-remove");
    if (rm) rm.addEventListener("click", () => removeCode(c));
    list.appendChild(card);
  }
}

async function toggleCode(c, btn) {
  btn.disabled = true;
  try {
    const r = await fetch("/api/admin/codes/" + encodeURIComponent(c.id), {
      method: "PATCH", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ active: c.active ? 0 : 1 }),
    });
    const d = await r.json();
    if (!r.ok) { toast(d.message || "Could not update.", true); return; }
    c.active = d.active;
    renderCodes();
    toast(c.active ? "Code is live." : "Code switched off.");
  } catch (e) { toast("No connection.", true); }
  finally { btn.disabled = false; }
}

async function removeCode(c) {
  if (!confirm("Remove " + c.code + " permanently? This deletes its history and cannot be undone.")) return;
  try {
    const r = await fetch("/api/admin/codes/" + encodeURIComponent(c.id), { method: "DELETE", credentials: "same-origin" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.message || "Could not remove the code.", true); return; }
    codes = codes.filter((x) => x.id !== c.id);
    renderCodes();
    recomputeOwed();
    toast("Code removed.");
  } catch (e) { toast("No connection.", true); }
}

function cdSplit() {
  const d = Math.max(0, Math.min(POOL, parseInt($("cdDiscount").value, 10) || 0));
  $("cdSplit").textContent = "Customer saves " + d + "%, vendor earns " + (POOL - d) + "%, you keep " + (100 - POOL) + "%.";
}

$("newCodeBtn").addEventListener("click", () => {
  $("cdVendor").value = ""; $("cdEmail").value = ""; $("cdDiscount").value = 10; $("cdCode").value = "";
  $("cdMethod").value = ""; $("cdId").value = "";
  setMsg("codeMsg", "", false); cdSplit(); openModal("codeModal");
  setTimeout(() => $("cdVendor").focus(), 60);
});
$("codeClose").addEventListener("click", () => closeModal("codeModal"));
$("codeModal").addEventListener("click", (e) => { if (e.target.id === "codeModal") closeModal("codeModal"); });
$("cdDiscount").addEventListener("input", cdSplit);

$("codeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("cdCreate");
  btn.disabled = true;
  const body = {
    vendor_name: $("cdVendor").value.trim(),
    vendor_email: $("cdEmail").value.trim(),
    discount_pct: parseInt($("cdDiscount").value, 10),
    code: $("cdCode").value.trim(),
    payout_method: $("cdMethod").value,
    payout_id: $("cdId").value.trim(),
  };
  try {
    const r = await fetch("/api/admin/codes", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) { setMsg("codeMsg", d.message || "Could not create the code.", true); return; }
    closeModal("codeModal");
    codes.unshift(d.code);
    renderCodes();
    toast("Code " + d.code.code + " created.");
  } catch (err) {
    setMsg("codeMsg", "No connection. Try again.", true);
  } finally {
    btn.disabled = false;
  }
});

// ---- Change a code's discount (mints a fresh Stripe coupon, same code) ----
let editCodeRef = null;
function ecSplit() {
  const d = Math.max(0, Math.min(POOL, parseInt($("ecDiscount").value, 10) || 0));
  $("ecSplit").textContent = "Customer saves " + d + "%, vendor earns " + (POOL - d) + "%, you keep " + (100 - POOL) + "%.";
}
function openEditCode(c) {
  editCodeRef = c;
  $("editCodeFor").textContent = c.vendor_name + " (" + c.code + ")";
  $("ecDiscount").value = c.discount_pct;
  $("ecMethod").value = c.payout_method || "";
  $("ecId").value = c.payout_id || "";
  setMsg("editCodeMsg", "", false);
  ecSplit();
  openModal("editCodeModal");
  setTimeout(() => $("ecDiscount").focus(), 60);
}
$("editCodeClose").addEventListener("click", () => closeModal("editCodeModal"));
$("editCodeModal").addEventListener("click", (e) => { if (e.target.id === "editCodeModal") closeModal("editCodeModal"); });
$("ecDiscount").addEventListener("input", ecSplit);
$("editCodeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!editCodeRef) return;
  const pct = parseInt($("ecDiscount").value, 10);
  if (!(pct >= 1 && pct <= POOL)) { setMsg("editCodeMsg", "Pick a discount from 1 to " + POOL + "%.", true); return; }
  const btn = $("ecSave");
  btn.disabled = true;
  setMsg("editCodeMsg", pct !== editCodeRef.discount_pct ? "Updating the code in Stripe..." : "Saving...", false);
  try {
    const r = await fetch("/api/admin/codes/" + encodeURIComponent(editCodeRef.id), {
      method: "PATCH", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ discount_pct: pct, payout_method: $("ecMethod").value, payout_id: $("ecId").value.trim() }),
    });
    const d = await r.json();
    if (!r.ok) { setMsg("editCodeMsg", d.message || "Could not save.", true); return; }
    editCodeRef.discount_pct = d.discount_pct;
    editCodeRef.payout_method = d.payout_method;
    editCodeRef.payout_id = d.payout_id;
    renderCodes();
    closeModal("editCodeModal");
    toast("Code updated.");
  } catch (err) {
    setMsg("editCodeMsg", "No connection. Try again.", true);
  } finally {
    btn.disabled = false;
  }
});

// ---- Vendor payouts (zero out commission owed, with an optional receipt) ----
let payoutCode = null;
function payoutSummary(c) {
  const owed = codeOwed(c);
  $("payoutFor").textContent = "Owed " + money(owed) + " to " + c.vendor_name + " (" + c.code + ")";
  const via = payViaText(c);
  $("payoutVia").textContent = via ? "Pay via " + via : "";
  $("payoutVia").style.display = via ? "" : "none";
  $("poAmount").value = (owed / 100).toFixed(2);
}
function openPayout(c) {
  payoutCode = c;
  payoutSummary(c);
  $("poNote").value = ""; $("poReceipt").value = "";
  setMsg("payoutMsg", "", false);
  $("poHistory").innerHTML = "";
  openModal("payoutModal");
  loadPayoutHistory(c.id);
  setTimeout(() => $("poAmount").focus(), 60);
}
async function loadPayoutHistory(codeId) {
  try {
    const r = await fetch("/api/admin/codes/" + encodeURIComponent(codeId) + "/payouts", { credentials: "same-origin" });
    if (!r.ok) return;
    const d = await r.json();
    renderPayoutHistory(d.payouts || []);
  } catch (e) {}
}
function renderPayoutHistory(list) {
  const box = $("poHistory");
  if (!list.length) { box.innerHTML = ""; return; }
  box.innerHTML = '<div class="po-hist-h">Past payouts</div>' + list.map((p) => {
    const rec = p.has_receipt ? ' <a class="po-receipt" href="/api/admin/payouts/' + encodeURIComponent(p.id) + '/receipt" target="_blank" rel="noopener">receipt</a>' : '';
    const note = p.note ? ' <span class="po-hist-note">' + esc(p.note) + '</span>' : '';
    return '<div class="po-hist-row"><span class="po-hist-amt">' + money(p.amount_cents) + '</span> <span class="po-hist-date">' + fmtDate(p.created_at) + '</span>' + note + rec + '</div>';
  }).join("");
}
$("payoutClose").addEventListener("click", () => closeModal("payoutModal"));
$("payoutModal").addEventListener("click", (e) => { if (e.target.id === "payoutModal") closeModal("payoutModal"); });
$("payoutForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!payoutCode) return;
  const btn = $("poSave");
  const cents = Math.round((parseFloat($("poAmount").value) || 0) * 100);
  if (!(cents > 0)) { setMsg("payoutMsg", "Enter a payout amount.", true); return; }
  btn.disabled = true;
  const fd = new FormData();
  fd.append("amount_cents", String(cents));
  fd.append("note", $("poNote").value.trim());
  const f = $("poReceipt").files[0];
  if (f) fd.append("receipt", f);
  try {
    const r = await fetch("/api/admin/codes/" + encodeURIComponent(payoutCode.id) + "/payouts", { method: "POST", credentials: "same-origin", body: fd });
    const d = await r.json();
    if (!r.ok) { setMsg("payoutMsg", d.message || "Could not record the payout.", true); return; }
    payoutCode.commission_cents = d.commission_cents;
    payoutCode.paid_cents = d.paid_cents;
    renderCodes();
    recomputeOwed();
    payoutSummary(payoutCode);
    $("poNote").value = ""; $("poReceipt").value = "";
    setMsg("payoutMsg", "Payout recorded.", false);
    loadPayoutHistory(payoutCode.id);
    toast("Payout recorded.");
  } catch (err) {
    setMsg("payoutMsg", "No connection. Try again.", true);
  } finally {
    btn.disabled = false;
  }
});

// Collapsible section: the caret (or its heading) folds the content away. State
// is remembered per operator so a tidy console stays tidy across visits.
function setupCollapse(colheadId, wrapId, key) {
  const colhead = document.getElementById(colheadId);
  const wrap = document.getElementById(wrapId);
  if (!colhead || !wrap) return;
  const caret = colhead.querySelector(".admin-caret");
  const h2 = colhead.querySelector(".admin-h");
  let open = true;
  try { open = localStorage.getItem(key) !== "0"; } catch (e) {}
  const apply = () => {
    wrap.style.display = open ? "" : "none";
    colhead.classList.toggle("collapsed", !open);
    if (caret) caret.setAttribute("aria-expanded", open ? "true" : "false");
  };
  const toggle = () => { open = !open; try { localStorage.setItem(key, open ? "1" : "0"); } catch (e) {} apply(); };
  if (caret) caret.addEventListener("click", toggle);
  if (h2) { h2.style.cursor = "pointer"; h2.addEventListener("click", toggle); }
  apply();
}

// ---- Revenue ----
let revenue = null;
async function loadRevenue() {
  try {
    const r = await fetch("/api/admin/revenue", { credentials: "same-origin" });
    if (!r.ok) return;
    revenue = await r.json();
    renderRevenue();
  } catch (e) {}
}
function renderRevenue() {
  if (!revenue) return;
  const t = revenue.total || { amount_cents: 0, count: 0 };
  $("revenueTotal").textContent = money(t.amount_cents) + " in" + (t.count ? " · " + t.count + (t.count === 1 ? " sale" : " sales") : "");
  const bd = $("revenueBreakdown");
  bd.innerHTML = "";
  if (!(revenue.by_package || []).length) {
    bd.innerHTML = '<p class="admin-empty">No payments yet. Sales show here as customers pay.</p>';
  } else {
    for (const p of revenue.by_package) {
      const chip = document.createElement("div");
      chip.className = "rev-chip";
      chip.innerHTML = '<div class="rev-chip-amt">' + money(p.amount) + '</div>' +
        '<div class="rev-chip-label">' + esc(p.label || "Other") + '</div>' +
        '<div class="rev-chip-n">' + (p.n || 0) + (p.n === 1 ? " sale" : " sales") + '</div>';
      bd.appendChild(chip);
    }
  }
  const rec = $("revenueRecent");
  const recH = document.querySelector(".rev-recent-h");
  rec.innerHTML = "";
  if (!(revenue.recent || []).length) { rec.style.display = "none"; if (recH) recH.style.display = "none"; return; }
  rec.style.display = ""; if (recH) recH.style.display = "";
  for (const p of revenue.recent) {
    const row = document.createElement("div");
    row.className = "rev-row";
    const via = p.source === "package_link" ? "package link" : (p.event_name ? esc(p.event_name) : "event checkout");
    row.innerHTML =
      '<div class="rev-row-main"><strong>' + esc(p.label || "Payment") + '</strong>' +
        '<span class="rev-row-via">' + via + ((p.discount_cents || 0) > 0 ? " · " + money(p.discount_cents) + " off" : "") + '</span></div>' +
      '<div class="rev-row-amt">' + money(p.amount_cents) + '</div>' +
      '<div class="rev-row-date">' + fmtDate(p.created_at) + '</div>';
    rec.appendChild(row);
  }
}

// ---- Package links ----
let pkgLinks = [];
async function loadPackageLinks() {
  try {
    const r = await fetch("/api/admin/package-links", { credentials: "same-origin" });
    if (!r.ok) return;
    const d = await r.json();
    pkgLinks = d.links || [];
    renderPackageLinks();
  } catch (e) {}
}
function renderPackageLinks() {
  const list = $("linksList");
  if (!list) return;
  list.innerHTML = "";
  if (!pkgLinks.length) { list.innerHTML = '<p class="admin-empty">No package links yet. Create one to sell a package by link.</p>'; return; }
  for (const l of pkgLinks) {
    const card = document.createElement("div");
    card.className = "link-card" + (l.active ? "" : " off");
    card.innerHTML =
      '<div class="link-id"><strong class="link-label">' + esc(l.label) + '</strong>' +
        '<span class="link-amt">' + money(l.amount_cents) + (l.plan ? ' · ' + esc(PLAN_LABEL[l.plan] || l.plan) + ' features' : '') + '</span></div>' +
      '<div class="link-url-row"><span class="link-url">' + esc(l.url || "") + '</span>' +
        '<button class="code-copy link-copy" type="button" title="Copy link" aria-label="Copy link">' + COPY_ICON + '</button></div>';
    const actions = document.createElement("div");
    actions.className = "code-actions";
    const open = document.createElement("a");
    open.className = "btn link-open"; open.href = l.url || "#"; open.target = "_blank"; open.rel = "noopener"; open.textContent = "Open";
    const tgl = document.createElement("button");
    tgl.type = "button"; tgl.className = "btn code-toggle"; tgl.textContent = l.active ? "Deactivate" : "Activate";
    tgl.addEventListener("click", () => togglePackageLink(l, tgl));
    actions.append(open, tgl);
    card.appendChild(actions);
    const cp = card.querySelector(".link-copy");
    if (cp) cp.addEventListener("click", () => copyLink(l.url));
    list.appendChild(card);
  }
}
async function copyLink(url) {
  try { await navigator.clipboard.writeText(url); toast("Link copied."); }
  catch (e) { toast("Could not copy. Select the link to copy it.", true); }
}
async function togglePackageLink(l, btn) {
  btn.disabled = true;
  try {
    const r = await fetch("/api/admin/package-links/" + encodeURIComponent(l.id), {
      method: "PATCH", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ active: l.active ? 0 : 1 }),
    });
    const d = await r.json();
    if (!r.ok) { toast(d.message || "Could not update.", true); return; }
    l.active = d.active; renderPackageLinks();
    toast(l.active ? "Link is live." : "Link switched off.");
  } catch (e) { toast("No connection.", true); }
  finally { btn.disabled = false; }
}
function lkToggleCustom() {
  const custom = $("lkPlan").value === "custom";
  $("lkCustom").style.display = custom ? "" : "none";
  $("lkNote").style.display = custom ? "" : "none";
}
$("newLinkBtn").addEventListener("click", () => {
  $("lkPlan").value = "signature"; $("lkLabel").value = ""; $("lkAmount").value = "";
  setMsg("linkMsg", "", false); $("linkDone").style.display = "none"; $("linkDone").innerHTML = "";
  $("lkCreate").style.display = ""; lkToggleCustom(); openModal("linkModal");
});
$("linkClose").addEventListener("click", () => closeModal("linkModal"));
$("linkModal").addEventListener("click", (e) => { if (e.target.id === "linkModal") closeModal("linkModal"); });
$("lkPlan").addEventListener("change", lkToggleCustom);
$("linkForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("lkCreate");
  const sel = $("lkPlan").value;
  let body;
  if (sel === "custom") {
    body = { custom: true, plan: "grand", label: $("lkLabel").value.trim(), amount_cents: Math.round((parseFloat($("lkAmount").value) || 0) * 100) };
    if (!body.label) { setMsg("linkMsg", "Name the package.", true); return; }
    if (!(body.amount_cents >= 100)) { setMsg("linkMsg", "Enter a price of at least $1.", true); return; }
  } else {
    body = { plan: sel };
  }
  btn.disabled = true;
  setMsg("linkMsg", "Creating the link in Stripe...", false);
  try {
    const r = await fetch("/api/admin/package-links", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { setMsg("linkMsg", d.message || "Could not create the link.", true); return; }
    pkgLinks.unshift(d.link); renderPackageLinks();
    setMsg("linkMsg", "", false);
    const done = $("linkDone");
    done.style.display = "block";
    done.innerHTML = '<div class="link-done-h">Link ready, send it to your customer</div><div class="link-done-url">' + esc(d.link.url) + '</div>';
    const cp = document.createElement("button");
    cp.type = "button"; cp.className = "btn primary"; cp.textContent = "Copy link";
    cp.addEventListener("click", () => copyLink(d.link.url));
    done.appendChild(cp);
    $("lkCreate").style.display = "none";
    toast("Package link created.");
  } catch (err) {
    setMsg("linkMsg", "No connection. Try again.", true);
  } finally {
    btn.disabled = false;
  }
});

boot();
