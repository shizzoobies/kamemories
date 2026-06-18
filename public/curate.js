// Owner curation console.
// Primary auth is Cloudflare Access (email one-time PIN): the protected paths sit
// behind Access, so a signed-in owner reaches the APIs with no key. The album key
// stays as a fallback (e.g. local dev or if Access is ever off).

const $ = (id) => document.getElementById(id);
let KEY = null; // set only in key-fallback mode; null means Access mode
let photos = [];
let filter = "all";
let sortOrder = "new";
let search = "";

function mediaUrl(p) {
  const k = p.thumb_key || p.r2_key;
  return KEY
    ? "/media/" + encodeURIComponent(k) + "?k=" + encodeURIComponent(KEY)
    : "/owner-media/" + encodeURIComponent(k);
}
function fullUrl(p) {
  return KEY
    ? "/media/" + encodeURIComponent(p.r2_key) + "?k=" + encodeURIComponent(KEY)
    : "/owner-media/" + encodeURIComponent(p.r2_key);
}
function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function fetchPhotos(headers) {
  const r = await fetch("/api/photos", { headers: headers || {}, credentials: "include" });
  if (!r.ok) return false;
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return false; // got the Access login page, not data
  const data = await r.json();
  photos = data.photos || [];
  return true;
}
const tryAccess = () => fetchPhotos({ accept: "application/json" });
const tryLoad = (key) => fetchPhotos({ "x-album-key": key });

async function fetchIdentity() {
  try {
    const r = await fetch("/cdn-cgi/access/get-identity", { credentials: "include" });
    if (!r.ok) return;
    const id = await r.json();
    const email = id.email || id.name;
    if (!email) return;
    $("who").textContent = "";
    const span = document.createElement("span");
    span.textContent = "Signed in as " + email + "  ";
    const out = document.createElement("a");
    out.href = "/cdn-cgi/access/logout";
    out.textContent = "Sign out";
    out.style.color = "var(--silver)";
    $("who").appendChild(span);
    $("who").appendChild(out);
  } catch {}
}

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
  $("empty").style.display = list.length ? "none" : "block";
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

async function post(path, body) {
  const headers = { "content-type": "application/json" };
  if (KEY) headers["x-album-key"] = KEY;
  const r = await fetch(path, { method: "POST", headers, body: JSON.stringify(body), credentials: "include" });
  return r.ok ? r.json() : null;
}

async function doApprove(p, approved) {
  const res = await post("/api/photos/approve", { id: p.id, approved: approved ? 1 : 0 });
  if (!res) return;
  p.approved = approved ? 1 : 0;
  if (!approved) p.featured = 0;
  render();
}

async function doFeature(p, featured) {
  const res = await post("/api/photos/feature", { id: p.id, featured: featured ? 1 : 0 });
  if (!res) return;
  p.featured = featured ? 1 : 0;
  if (featured) p.approved = 1;
  render();
}

async function doDelete(p) {
  const res = await post("/api/photos/delete", { id: p.id });
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

// ---- Wiring ----
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

function openConsole() {
  $("gate").style.display = "none";
  $("console").style.display = "block";
  render();
}

$("keyBtn").addEventListener("click", submitKey);
$("keyInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submitKey(); });
async function submitKey() {
  const key = $("keyInput").value.trim();
  if (!key) return;
  if (await tryLoad(key)) {
    KEY = key;
    sessionStorage.setItem("ownerKey", key);
    openConsole();
  } else {
    $("gateErr").textContent = "That key did not work. Check it and try again.";
  }
}

function getKeyFromUrl() { return new URL(location.href).searchParams.get("k"); }

(async function boot() {
  // Access mode first: behind Cloudflare Access, /api/photos returns data with no key.
  if (await tryAccess()) {
    KEY = null;
    fetchIdentity();
    openConsole();
    return;
  }
  // Fallback: album key (local dev, or Access not enforced).
  const urlKey = getKeyFromUrl();
  const saved = sessionStorage.getItem("ownerKey");
  const candidate = urlKey || saved;
  if (candidate && (await tryLoad(candidate))) {
    KEY = candidate;
    sessionStorage.setItem("ownerKey", candidate);
    if (urlKey) history.replaceState({}, "", "/curate");
    openConsole();
  } else {
    $("gate").style.display = "block";
  }
})();
