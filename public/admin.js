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
  const items = [
    { label: "Clients", value: data.stats.clients },
    { label: "Events", value: data.stats.events },
    { label: "Photos", value: data.stats.photos },
    { label: "Billing", value: data.billing ? "Live" : "Off" },
  ];
  const wrap = $("stats");
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
  $("eventsCount").textContent = rows.length + (rows.length === 1 ? " event" : " events");
  if (!rows.length) { list.innerHTML = '<p class="admin-empty">No events match.</p>'; return; }
  for (const e of rows) list.appendChild(eventRow(e));
}

function eventRow(e) {
  const row = document.createElement("div");
  row.className = "admin-row";
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const plan = e.plan ? PLAN_LABEL[e.plan] : "No plan";
  const newPill = isNewBooking(e) ? '<span class="newbk-pill">New</span>' : '';
  row.innerHTML = newPill +
    '<span class="admin-row-name">' + esc(e.name) + '</span>' +
    '<span class="ev-badge ' + esc(e.status) + '">' + esc(e.status) + '</span>' +
    '<span class="admin-row-host">' + esc(e.host) + '</span>' +
    '<span class="admin-row-owner">' + esc(e.organizer_email) + '</span>' +
    '<span class="admin-row-count">' + (e.total || 0) + ' photos &middot; ' + esc(plan) + '</span>' +
    '<span class="admin-row-go" aria-hidden="true">&rsaquo;</span>';
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
  for (const c of data.clients) {
    const row = document.createElement("div");
    row.className = "admin-client";
    row.innerHTML = '<div class="admin-client-email">' + esc(c.email) + '</div>' +
      '<div class="admin-client-meta">' + (c.events || 0) + ' events &middot; ' + (c.photos || 0) + ' photos &middot; joined ' + fmtDate(c.created_at) + '</div>';
    list.appendChild(row);
  }
}

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

boot();
