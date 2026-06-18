// Organizer dashboard. Session-authed against the control plane. Lists the
// organizer's events, creates new ones, and curates each event's photos.
// Routing is by hash: #/ is the event list, #/e/<id> manages one event.

const $ = (id) => document.getElementById(id);

let me = null;
let events = [];
let current = null; // the event being managed (owner shape)
let photos = [];
let filter = "all";
let sortOrder = "new";
let search = "";

function mediaUrl(p) { return "/owner-media/" + encodeURIComponent(p.thumb_key || p.r2_key); }
function fullUrl(p) { return "/owner-media/" + encodeURIComponent(p.r2_key); }

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function setMsg(id, text, isErr) {
  const el = $(id);
  el.textContent = text || "";
  el.classList.toggle("err", !!isErr);
}

let toastTimer = null;
function toast(msg, isErr) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("err", !!isErr);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

// ---- Boot ----
async function boot() {
  const r = await fetch("/api/auth/me", { credentials: "same-origin" });
  if (!r.ok) { location.href = "/login"; return; }
  const data = await r.json();
  me = data.organizer;
  renderWho();
  await loadEvents();
  await route();
  window.addEventListener("hashchange", route);

  // Returned from Stripe Checkout: confirm and wait for the webhook to publish.
  const paid = new URLSearchParams(location.search).get("paid");
  if (paid) {
    history.replaceState({}, "", "/app" + location.hash);
    toast("Payment received. Publishing your event...");
    pollPublished(paid, 0);
  }
}

async function pollPublished(id, tries) {
  await loadEvents();
  const e = events.find((x) => x.id === id);
  if (e && e.status === "active") {
    toast("Your event is live.");
    if (current && current.id === id) await openManage(id);
    else renderEvents();
    return;
  }
  if (tries < 6) setTimeout(() => pollPublished(id, tries + 1), 1500);
  else toast("Payment received. It may take a moment to publish; refresh shortly.");
}

function renderWho() {
  const who = $("who");
  who.innerHTML = "";
  const span = document.createElement("span");
  span.className = "who-email";
  span.textContent = me.email;
  const out = document.createElement("a");
  out.href = "#";
  out.className = "who-out";
  out.textContent = "Sign out";
  out.addEventListener("click", async (e) => {
    e.preventDefault();
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    location.href = "/login";
  });
  who.appendChild(span);
  who.appendChild(out);
}

async function loadEvents() {
  const r = await fetch("/api/events", { credentials: "same-origin" });
  if (!r.ok) return;
  const data = await r.json();
  events = data.events || [];
}

async function route() {
  const m = location.hash.match(/^#\/e\/(.+)$/);
  if (m) {
    await openManage(decodeURIComponent(m[1]));
  } else {
    await loadEvents();
    showEvents();
  }
}

// ---- Events list ----
function showEvents() {
  $("loading").style.display = "none";
  $("view-manage").style.display = "none";
  $("view-events").style.display = "block";
  renderEvents();
}

function renderEvents() {
  const list = $("eventsList");
  list.innerHTML = "";
  $("eventsEmpty").style.display = events.length ? "none" : "block";
  for (const e of events) list.appendChild(evCard(e));
}

function evCard(e) {
  const card = document.createElement("div");
  card.className = "ev-card";
  card.addEventListener("click", () => { location.hash = "#/e/" + e.id; });

  const top = document.createElement("div");
  top.className = "ev-top";
  const name = document.createElement("h3");
  name.className = "ev-name display";
  name.textContent = e.name;
  const badge = document.createElement("span");
  badge.className = "ev-badge " + e.status;
  badge.textContent = e.status;
  top.appendChild(name);
  top.appendChild(badge);
  card.appendChild(top);

  const host = document.createElement("div");
  host.className = "ev-host";
  host.textContent = e.host;
  card.appendChild(host);

  const stats = document.createElement("div");
  stats.className = "ev-stats";
  stats.innerHTML =
    `<span><strong>${e.pending || 0}</strong> pending</span>` +
    `<span><strong>${e.approved || 0}</strong> approved</span>` +
    `<span><strong>${e.total || 0}</strong> total</span>`;
  card.appendChild(stats);
  return card;
}

// ---- Manage one event ----
async function openManage(id) {
  $("view-events").style.display = "none";
  const r = await fetch("/api/events/" + encodeURIComponent(id) + "/photos", { credentials: "same-origin" });
  if (!r.ok) { location.hash = ""; return; }
  const data = await r.json();
  current = data.event;
  photos = data.photos || [];
  filter = "all"; search = "";
  $("search").value = "";
  Array.from($("seg").querySelectorAll("button")).forEach((b) => b.classList.toggle("active", b.dataset.f === "all"));
  $("loading").style.display = "none";
  $("view-manage").style.display = "block";
  renderManageHead();
  fillSettings();
  setTab("photos");
  render();
}

function renderManageHead() {
  $("mName").textContent = current.name;
  const url = $("mUrl");
  url.textContent = current.host;
  url.href = current.url;
  $("viewBtn").href = current.url;
  $("publish").style.display = current.status === "draft" ? "block" : "none";
}

// ---- Curation: counts, filtering, rendering ----
function counts() {
  let pending = 0, approved = 0, featured = 0;
  for (const p of photos) {
    if (p.approved) approved++; else pending++;
    if (p.featured) featured++;
  }
  return { pending, approved, featured, total: photos.length };
}

function visible() {
  let list = photos.filter((p) => {
    if (filter === "pending") return !p.approved;
    if (filter === "approved") return !!p.approved;
    if (filter === "featured") return !!p.featured;
    return true;
  });
  if (search) {
    const t = search.toLowerCase();
    list = list.filter((p) => (p.guest_name || "").toLowerCase().includes(t));
  }
  list.sort((a, b) => sortOrder === "old" ? a.created_at - b.created_at : b.created_at - a.created_at);
  return list;
}

function renderStats() {
  const c = counts();
  const items = [
    { label: "Pending", value: c.pending },
    { label: "Approved", value: c.approved },
    { label: "Featured", value: c.featured },
    { label: "Total", value: c.total },
  ];
  $("stats").innerHTML = "";
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "stat";
    const v = document.createElement("div"); v.className = "stat-v"; v.textContent = it.value;
    const l = document.createElement("div"); l.className = "stat-l"; l.textContent = it.label;
    card.appendChild(v); card.appendChild(l);
    $("stats").appendChild(card);
  }
  const btn = $("reviewBtn");
  btn.textContent = c.pending ? `Review pending (${c.pending})` : "Nothing to review";
  btn.disabled = c.pending === 0;
}

function render() {
  renderStats();
  const grid = $("grid");
  grid.innerHTML = "";
  const list = visible();
  $("photosEmpty").style.display = photos.length ? "none" : "block";
  for (const p of list) grid.appendChild(buildCard(p));
}

function buildCard(p) {
  const card = document.createElement("div");
  card.className = "cur-card";

  const ph = document.createElement("div");
  ph.className = "ph";
  const img = document.createElement("img");
  img.src = mediaUrl(p);
  img.loading = "lazy";
  img.alt = p.caption || "Photo";
  ph.appendChild(img);
  const badge = document.createElement("span");
  badge.className = "cur-badge" + (p.featured ? " featured" : p.approved ? " approved" : "");
  badge.textContent = p.featured ? "Featured" : p.approved ? "Approved" : "Pending";
  ph.appendChild(badge);
  card.appendChild(ph);

  if (p.caption) {
    const cap = document.createElement("div");
    cap.className = "cur-cap";
    cap.textContent = p.caption;
    card.appendChild(cap);
  }

  const meta = document.createElement("div");
  meta.className = "cur-meta";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = p.guest_name || "A guest";
  const when = document.createElement("span");
  when.textContent = fmtTime(p.created_at);
  meta.appendChild(who);
  meta.appendChild(when);
  card.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "cur-actions";

  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.className = p.approved ? "on" : "";
  approveBtn.textContent = p.approved ? "Approved" : "Approve";
  approveBtn.addEventListener("click", () => doApprove(p, !p.approved));

  const featureBtn = document.createElement("button");
  featureBtn.type = "button";
  featureBtn.className = p.featured ? "on" : "";
  featureBtn.textContent = p.featured ? "Featured" : "Feature";
  featureBtn.addEventListener("click", () => doFeature(p, !p.featured));

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "danger";
  delBtn.textContent = "Remove";
  delBtn.addEventListener("click", () => doDelete(p));

  actions.appendChild(approveBtn);
  actions.appendChild(featureBtn);
  actions.appendChild(delBtn);
  card.appendChild(actions);
  return card;
}

async function photoAction(p, action, body) {
  const r = await fetch("/api/photos/" + encodeURIComponent(p.id) + "/" + action, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return r.ok ? r.json() : null;
}

async function doApprove(p, approved) {
  const res = await photoAction(p, "approve", { approved: approved ? 1 : 0 });
  if (!res) return;
  p.approved = approved ? 1 : 0;
  if (!approved) p.featured = 0;
  render();
}

async function doFeature(p, featured) {
  const res = await photoAction(p, "feature", { featured: featured ? 1 : 0 });
  if (!res) return;
  p.featured = featured ? 1 : 0;
  if (featured) p.approved = 1;
  render();
}

async function doDelete(p) {
  const res = await photoAction(p, "delete", {});
  if (!res) return;
  photos = photos.filter((x) => x.id !== p.id);
  render();
}

// ---- Review queue: one pending photo at a time ----
let rList = [];
let rIdx = 0;

function openReview() {
  rList = photos.filter((p) => !p.approved).sort((a, b) => a.created_at - b.created_at);
  if (!rList.length) return;
  rIdx = 0;
  $("review").classList.add("show");
  renderReview();
}

function closeReview() {
  $("review").classList.remove("show");
  $("reviewPhoto").style.backgroundImage = "";
  render();
}

function renderReview() {
  const p = rList[rIdx];
  if (!p) {
    $("reviewPhoto").style.backgroundImage = "";
    $("reviewMeta").textContent = "All caught up. Nice work.";
    $("reviewProgress").textContent = "";
    return;
  }
  $("reviewPhoto").style.backgroundImage = "url('" + fullUrl(p) + "')";
  const bits = [p.guest_name || "A guest"];
  if (p.caption) bits.push('"' + p.caption + '"');
  bits.push(fmtTime(p.created_at));
  $("reviewMeta").textContent = bits.join("  .  ");
  $("reviewProgress").textContent = (rIdx + 1) + " of " + rList.length;
}

function advance() { rIdx++; renderReview(); }

async function rApproveAction() { const p = rList[rIdx]; if (!p) return; await doApprove(p, true); advance(); }
async function rFeatureAction() { const p = rList[rIdx]; if (!p) return; await doFeature(p, true); advance(); }
async function rRemoveAction() {
  const p = rList[rIdx];
  if (!p) return;
  if (!confirm("Remove this photo for good?")) return;
  await doDelete(p);
  advance();
}

// ---- Settings ----
function fillSettings() {
  $("sName").value = current.name || "";
  $("sSlug").value = current.slug || "";
  $("sTagline").value = current.tagline || "";
  $("sDate").value = current.event_date || "";
  $("sVenue").value = current.venue || "";
  $("sLimit").value = current.daily_limit || 10;
  $("sStatus").value = current.status || "active";
  setMsg("settingsMsg", "", false);
}

// ---- Tabs and modals ----
function setTab(t) {
  Array.from($("tabs").querySelectorAll("button")).forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  $("tab-photos").style.display = t === "photos" ? "block" : "none";
  $("tab-settings").style.display = t === "settings" ? "block" : "none";
}

function openModal(id) { $(id).classList.add("show"); }
function closeModal(id) { $(id).classList.remove("show"); }

function openQr() {
  if (!current) return;
  $("qrNames").textContent = current.name;
  $("qrUrl").textContent = (current.capture_url || "").replace(/^https?:\/\//, "");
  const box = $("qrBox");
  box.innerHTML = "";
  if (window.QRCode) {
    new QRCode(box, { text: current.capture_url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
  } else {
    box.textContent = "QR library failed to load. Check your connection.";
  }
  openModal("qrModal");
}

// ---- Wiring ----
$("newBtn").addEventListener("click", () => { setMsg("createMsg", "", false); openModal("createModal"); });
$("backBtn").addEventListener("click", () => { location.hash = ""; });
$("tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab); });

$("publish").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-plan]");
  if (!btn || !current) return;
  btn.disabled = true;
  setMsg("publishMsg", "Taking you to secure checkout...", false);
  try {
    const r = await fetch("/api/events/" + encodeURIComponent(current.id) + "/checkout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: btn.dataset.plan }),
    });
    const data = await r.json();
    if (!r.ok || !data.url) { setMsg("publishMsg", data.message || "Could not start checkout.", true); btn.disabled = false; return; }
    location.href = data.url;
  } catch {
    setMsg("publishMsg", "No connection. Try again.", true);
    btn.disabled = false;
  }
});

$("seg").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-f]");
  if (!btn) return;
  filter = btn.dataset.f;
  Array.from($("seg").querySelectorAll("button")).forEach((b) => b.classList.toggle("active", b === btn));
  render();
});
$("sort").addEventListener("change", (e) => { sortOrder = e.target.value; render(); });
$("search").addEventListener("input", (e) => { search = e.target.value.trim(); render(); });
$("reviewBtn").addEventListener("click", openReview);
$("reviewClose").addEventListener("click", closeReview);
$("rSkip").addEventListener("click", advance);
$("rApprove").addEventListener("click", rApproveAction);
$("rFeature").addEventListener("click", rFeatureAction);
$("rRemove").addEventListener("click", rRemoveAction);
document.addEventListener("keydown", (e) => {
  if (!$("review").classList.contains("show")) return;
  if (e.key === "Escape") closeReview();
  else if (e.key === "ArrowRight") advance();
});

$("copyBtn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(current.capture_url); toast("Capture link copied."); }
  catch { toast("Could not copy. Long-press the address instead.", true); }
});
$("qrBtn").addEventListener("click", openQr);
$("qrPrint").addEventListener("click", () => window.print());
$("createClose").addEventListener("click", () => closeModal("createModal"));
$("qrClose").addEventListener("click", () => closeModal("qrModal"));
["createModal", "qrModal"].forEach((id) => {
  $(id).addEventListener("click", (e) => { if (e.target.id === id) closeModal(id); });
});

$("createForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("createSubmit");
  btn.disabled = true;
  const body = {
    name: $("cName").value.trim(),
    slug: $("cSlug").value.trim(),
    event_date: $("cDate").value.trim(),
    venue: $("cVenue").value.trim(),
  };
  try {
    const r = await fetch("/api/events", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) { setMsg("createMsg", data.message || "Could not create the event.", true); return; }
    closeModal("createModal");
    $("createForm").reset();
    await loadEvents();
    location.hash = "#/e/" + data.event.id; // hashchange triggers openManage
  } catch {
    setMsg("createMsg", "No connection. Try again.", true);
  } finally {
    btn.disabled = false;
  }
});

$("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("saveBtn");
  btn.disabled = true;
  const body = {
    name: $("sName").value.trim(),
    slug: $("sSlug").value.trim(),
    tagline: $("sTagline").value,
    event_date: $("sDate").value,
    venue: $("sVenue").value,
    daily_limit: parseInt($("sLimit").value, 10),
    status: $("sStatus").value,
  };
  try {
    const r = await fetch("/api/events/" + encodeURIComponent(current.id), {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) { setMsg("settingsMsg", data.message || "Could not save.", true); return; }
    current = data.event;
    renderManageHead();
    setMsg("settingsMsg", "Saved.", false);
    toast("Saved.");
  } catch {
    setMsg("settingsMsg", "No connection. Try again.", true);
  } finally {
    btn.disabled = false;
  }
});

$("deleteEventBtn").addEventListener("click", async () => {
  if (!current) return;
  if (!confirm("Delete this event and every photo in it for good?")) return;
  const r = await fetch("/api/events/" + encodeURIComponent(current.id), { method: "DELETE", credentials: "same-origin" });
  if (!r.ok) { toast("Could not delete the event.", true); return; }
  toast("Event deleted.");
  location.hash = "";
});

boot();
