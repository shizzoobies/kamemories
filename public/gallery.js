// Public approved gallery. No key needed: the API and media are public for
// approved photos. The event is resolved from the subdomain by the Worker.

const $ = (id) => document.getElementById(id);
let photos = [];

function fullUrl(p) { return "/media/" + encodeURIComponent(p.r2_key); }
function thumbUrl(p) { return "/media/" + encodeURIComponent(p.thumb_key || p.r2_key); }

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const PAGE = 60;
let cursor = 0;
let io = null;
let sort = "recent"; // "recent" (latest) or "top" (most loved)

const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3s-6.9-4.2-9.3-8.5C1.3 9.1 2.6 6 5.5 5.5c1.9-.3 3.5.6 4.6 2 .5.6.9 1.3 1.9 1.3s1.4-.7 1.9-1.3c1.1-1.4 2.7-2.3 4.6-2 2.9.5 4.2 3.6 2.8 6.3-2.4 4.3-9.3 8.5-9.3 8.5z"/></svg>';

async function loadEventName() {
  try {
    const r = await fetch("/api/event");
    if (!r.ok) return;
    const { event } = await r.json();
    if (event && event.name) {
      $("brand").textContent = event.name;
      document.title = "The gallery . " + event.name;
    }
  } catch {}
}

async function load() {
  try {
    const r = await fetch("/api/public/photos?scope=gallery&sort=" + sort);
    const data = await r.json();
    photos = data.photos || [];
  } catch {
    photos = [];
  }
  render();
}

function setSort(next) {
  if (next === sort) return;
  sort = next;
  document.querySelectorAll("#gallerySort button").forEach((b) => b.classList.toggle("on", b.dataset.sort === sort));
  load();
}

// One vote per device, toggleable. Optimistic: flip the heart now, reconcile with
// the server's authoritative count, and roll back if the request fails.
function paintLike(p) {
  const liked = !!p.liked;
  document.querySelectorAll('[data-like-id="' + p.id + '"]').forEach((btn) => {
    btn.classList.toggle("liked", liked);
    btn.setAttribute("aria-pressed", liked ? "true" : "false");
    const n = btn.querySelector(".like-n");
    if (n) n.textContent = p.likes > 0 ? p.likes : "";
  });
}

async function toggleLike(p) {
  const wasLiked = !!p.liked, wasLikes = p.likes || 0;
  p.liked = wasLiked ? 0 : 1;
  p.likes = Math.max(0, wasLikes + (wasLiked ? -1 : 1));
  paintLike(p);
  try {
    const r = await fetch("/api/public/photos/" + encodeURIComponent(p.id) + "/like", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { p.liked = d.liked ? 1 : 0; p.likes = d.likes; }
    else { p.liked = wasLiked ? 1 : 0; p.likes = wasLikes; }
  } catch {
    p.liked = wasLiked ? 1 : 0; p.likes = wasLikes;
  }
  paintLike(p);
}

function buildLikeButton(p) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "like-btn" + (p.liked ? " liked" : "");
  btn.dataset.likeId = p.id;
  btn.setAttribute("aria-pressed", p.liked ? "true" : "false");
  btn.setAttribute("aria-label", "Love this photo");
  btn.innerHTML = HEART + '<span class="like-n">' + (p.likes > 0 ? p.likes : "") + "</span>";
  btn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); toggleLike(p); });
  return btn;
}

function render() {
  $("albumCount").textContent = photos.length === 1 ? "1 photo" : `${photos.length} photos`;
  const grid = $("grid");
  grid.innerHTML = "";
  cursor = 0;
  if (io) { io.disconnect(); io = null; }
  $("empty").style.display = photos.length ? "none" : "block";
  renderBatch();
  setupSentinel();
}

function renderBatch() {
  const grid = $("grid");
  const end = Math.min(cursor + PAGE, photos.length);
  for (let i = cursor; i < end; i++) grid.appendChild(buildTile(photos[i], i));
  cursor = end;
}

function setupSentinel() {
  let sentinel = $("sentinel");
  if (!sentinel) {
    sentinel = document.createElement("div");
    sentinel.id = "sentinel";
    sentinel.style.height = "1px";
    $("grid").after(sentinel);
  }
  if (cursor >= photos.length) return;
  io = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      renderBatch();
      if (cursor >= photos.length && io) { io.disconnect(); io = null; }
    }
  }, { rootMargin: "700px" });
  io.observe(sentinel);
}

function buildTile(p, i) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.addEventListener("click", () => openLightbox(i));

  const img = document.createElement("img");
  img.src = thumbUrl(p);
  img.loading = "lazy";
  img.alt = p.caption || "Event photo";
  tile.appendChild(img);
  tile.appendChild(buildLikeButton(p));

  if (p.caption) {
    const cap = document.createElement("div");
    cap.className = "cap-note";
    cap.textContent = p.caption;
    tile.appendChild(cap);
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = p.guest_name || "A guest";
  const when = document.createElement("span");
  when.textContent = fmtTime(p.created_at);
  meta.appendChild(who);
  meta.appendChild(when);
  tile.appendChild(meta);
  return tile;
}

let lbIndex = -1;
function openLightbox(i) {
  lbIndex = i;
  const p = photos[i];
  const content = $("lbContent");
  content.innerHTML = "";
  const node = document.createElement("img");
  node.src = fullUrl(p);
  content.appendChild(node);

  $("lbCaption").textContent = p.caption || "";
  const bits = [];
  if (p.guest_name) bits.push(p.guest_name);
  bits.push(fmtTime(p.created_at));
  $("lbMeta").textContent = bits.join("  .  ");
  $("lbDownload").href = fullUrl(p);

  const lbLike = $("lbLike");
  lbLike.dataset.likeId = p.id;
  lbLike.classList.toggle("liked", !!p.liked);
  lbLike.setAttribute("aria-pressed", p.liked ? "true" : "false");
  lbLike.querySelector(".like-n").textContent = p.likes > 0 ? p.likes : "";

  $("lightbox").classList.add("show");
}

$("lbClose").addEventListener("click", closeLightbox);
$("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
function closeLightbox() {
  $("lightbox").classList.remove("show");
  $("lbContent").innerHTML = "";
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });

$("lbLike").addEventListener("click", (e) => { e.stopPropagation(); if (lbIndex >= 0) toggleLike(photos[lbIndex]); });
document.querySelectorAll("#gallerySort button").forEach((b) => b.addEventListener("click", () => setSort(b.dataset.sort)));

loadEventName();
load();
