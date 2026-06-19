// Operator console. Gated server-side to ADMIN_EMAILS: this page only renders
// data the /api/admin endpoints return, and they return nothing unless the signed
// in organizer is an operator. Lists every client and event, sets up new client
// events and subdomains, and talks to the Opus operations assistant.

const $ = (id) => document.getElementById(id);

let data = null;            // { me, clients, events, stats, billing, assistant }
let eventsFilter = "";
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
  renderEvents();
  renderClients();
  $("console").style.display = "block";
  $("assistantSection").style.display = "block";
  if (data.assistant === false) $("asstNote").textContent = "The assistant is not switched on yet. Add the ANTHROPIC_API_KEY secret and it will appear here.";
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

const PLAN_LABEL = { intimate: "Intimate", signature: "Signature", grand: "Grand" };

function eventMatches(e) {
  if (!eventsFilter) return true;
  const t = eventsFilter.toLowerCase();
  return (e.name || "").toLowerCase().includes(t) || (e.slug || "").toLowerCase().includes(t) || (e.organizer_email || "").toLowerCase().includes(t);
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

  const head = document.createElement("div");
  head.className = "admin-row-head";
  head.innerHTML = '<div class="admin-row-name">' + esc(e.name) + '</div>' +
    '<a class="admin-row-host" href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.host) + '</a>' +
    '<div class="admin-row-owner">' + esc(e.organizer_email) + '</div>';
  row.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "admin-row-meta";
  meta.innerHTML = '<span><strong>' + (e.total || 0) + '</strong> photos</span>' +
    '<span><strong>' + (e.pending || 0) + '</strong> pending</span>' +
    '<span><strong>' + (e.approved || 0) + '</strong> approved</span>';
  row.appendChild(meta);

  const controls = document.createElement("div");
  controls.className = "admin-row-controls";

  const statusSel = document.createElement("select");
  statusSel.className = "cur-input admin-mini";
  ["active", "draft", "archived"].forEach((s) => {
    const o = document.createElement("option"); o.value = s; o.textContent = s[0].toUpperCase() + s.slice(1); if (e.status === s) o.selected = true; statusSel.appendChild(o);
  });
  statusSel.addEventListener("change", () => patchEvent(e, { status: statusSel.value }));

  const planSel = document.createElement("select");
  planSel.className = "cur-input admin-mini";
  [["", "No plan"], ["intimate", "Intimate"], ["signature", "Signature"], ["grand", "Grand"]].forEach(([v, lbl]) => {
    const o = document.createElement("option"); o.value = v; o.textContent = lbl; if ((e.plan || "") === v) o.selected = true; planSel.appendChild(o);
  });
  planSel.addEventListener("change", () => patchEvent(e, { plan: planSel.value || null }));

  const del = document.createElement("button");
  del.type = "button"; del.className = "admin-del"; del.textContent = "Delete";
  del.addEventListener("click", () => deleteEvent(e));

  controls.append(statusSel, planSel, del);
  row.appendChild(controls);
  return row;
}

async function patchEvent(e, patch) {
  try {
    const r = await fetch("/api/admin/events/" + encodeURIComponent(e.id), {
      method: "PATCH", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
    });
    const d = await r.json();
    if (!r.ok) { toast(d.message || "Could not update.", true); return; }
    Object.assign(e, { status: d.event.status, plan: d.event.plan, slug: d.event.slug, host: d.event.host, url: d.event.url });
    toast("Updated.");
  } catch (err) { toast("No connection.", true); }
}

async function deleteEvent(e) {
  if (!confirm("Delete " + e.name + " and every photo in it? This cannot be undone.")) return;
  try {
    const r = await fetch("/api/admin/events/" + encodeURIComponent(e.id), { method: "DELETE", credentials: "same-origin" });
    if (!r.ok) { toast("Could not delete.", true); return; }
    data.events = data.events.filter((x) => x.id !== e.id);
    data.stats.events = data.events.length;
    renderStats(); renderEvents();
    toast("Event deleted.");
  } catch (err) { toast("No connection.", true); }
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

// ---- Create ----
function openModal(id) { $(id).classList.add("show"); }
function closeModal(id) { $(id).classList.remove("show"); }

$("newBtn").addEventListener("click", () => { setMsg("createMsg", "", false); openModal("createModal"); });
$("createClose").addEventListener("click", () => closeModal("createModal"));
$("createModal").addEventListener("click", (e) => { if (e.target.id === "createModal") closeModal("createModal"); });

$("createForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("createSubmit");
  btn.disabled = true;
  const body = {
    email: $("cEmail").value.trim(),
    name: $("cName").value.trim(),
    slug: $("cSlug").value.trim(),
    plan: $("cPlan").value || null,
    status: $("cStatus").value,
  };
  try {
    const r = await fetch("/api/admin/events", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) { setMsg("createMsg", d.message || "Could not create the event.", true); return; }
    closeModal("createModal");
    $("createForm").reset();
    toast("Event created.");
    const o = await fetch("/api/admin/overview", { credentials: "same-origin" });
    if (o.ok) { data = await o.json(); renderStats(); renderEvents(); renderClients(); }
  } catch (err) {
    setMsg("createMsg", "No connection. Try again.", true);
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
    chat.pop(); // remove the thinking placeholder
    if (!r.ok) { chat.push({ role: "assistant", content: d.message || "The assistant could not respond." }); }
    else { chat.push({ role: "assistant", content: d.reply || "(no reply)" }); }
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

boot();
