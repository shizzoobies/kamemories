// Event landing: fill the names and details from the event, then show the
// featured photo strip. Everything is scoped to this subdomain's event by the
// Worker, so the relative /api calls return only this event's data.

const F = (id) => document.getElementById(id);

function mediaUrl(p) {
  return "/media/" + encodeURIComponent(p.thumb_key || p.r2_key);
}

function initials(name) {
  const parts = (name || "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function setText(id, val) {
  const el = F(id);
  if (el && val) el.textContent = val;
}

async function loadEvent() {
  try {
    const r = await fetch("/api/event");
    if (!r.ok) return;
    const { event } = await r.json();
    if (!event) return;
    document.title = event.name;
    setText("brand", event.name);
    setText("names", event.name);
    setText("footName", event.name);
    const mono = F("monogram");
    if (mono) mono.textContent = initials(event.name);
    if (event.tagline) setText("eyebrow", event.tagline);
    if (event.event_date) setText("date", event.event_date);
    if (event.venue) setText("venue", event.venue);
    const footMeta = F("footMeta");
    if (footMeta) {
      const bits = [event.event_date, event.venue].filter(Boolean);
      footMeta.textContent = bits.join("  .  ");
    }
  } catch {}
}

// ---- Featured strip ----
const STRIP_MAX = 15;

function makeStripCard(p) {
  const card = document.createElement("a");
  card.className = "strip-card";
  card.href = "/gallery";

  const img = document.createElement("img");
  img.src = mediaUrl(p);
  img.loading = "lazy";
  img.alt = p.caption || "A photo from the celebration";
  card.appendChild(img);

  const label = p.caption || p.guest_name;
  if (label) {
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = label;
    card.appendChild(cap);
  }
  return card;
}

// Slow, seamless drift. Pauses on touch or hover, resumes after, and stays still
// for anyone who prefers reduced motion.
function autoGlide(strip, loopWidth) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let paused = false;
  let resume = null;
  const pauseBriefly = () => {
    paused = true;
    clearTimeout(resume);
    resume = setTimeout(() => { paused = false; }, 2500);
  };
  ["pointerdown", "touchstart", "wheel"].forEach((ev) => strip.addEventListener(ev, pauseBriefly, { passive: true }));
  strip.addEventListener("mouseenter", () => { paused = true; });
  strip.addEventListener("mouseleave", () => { paused = false; });

  function tick() {
    if (!paused) {
      strip.scrollLeft += 0.5;
      const w = loopWidth();
      if (w > 0 && strip.scrollLeft >= w) strip.scrollLeft -= w;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function loadStrip() {
  let photos = [];
  try {
    const r = await fetch("/api/public/photos?scope=featured");
    const data = await r.json();
    photos = data.photos || [];
  } catch {}

  const strip = F("strip");
  if (!photos.length) {
    strip.style.display = "none";
    F("stripEmpty").style.display = "block";
    return;
  }

  const featured = photos.slice(0, STRIP_MAX);
  strip.innerHTML = "";
  for (const p of featured) strip.appendChild(makeStripCard(p));

  requestAnimationFrame(() => {
    if (strip.scrollWidth <= strip.clientWidth + 8) return;
    const second = featured.map(makeStripCard);
    const loopMark = second[0];
    for (const c of second) strip.appendChild(c);
    autoGlide(strip, () => loopMark.offsetLeft);
  });
}

loadEvent();
loadStrip();
