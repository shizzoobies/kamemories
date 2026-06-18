// Public approved gallery. No key needed: the API and media are public for approved photos.

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

async function load() {
  try {
    const r = await fetch("/api/public/photos?scope=gallery");
    const data = await r.json();
    photos = data.photos || [];
  } catch {
    photos = [];
  }
  render();
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
  img.alt = p.caption || "Wedding photo";
  tile.appendChild(img);

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
  $("lightbox").classList.add("show");
}

$("lbClose").addEventListener("click", closeLightbox);
$("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
function closeLightbox() {
  $("lightbox").classList.remove("show");
  $("lbContent").innerHTML = "";
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });

load();
