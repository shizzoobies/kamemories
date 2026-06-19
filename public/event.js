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
    const cinema = !!(event.features && event.features.video);
    const mono = F("monogram");
    if (mono) {
      if (cinema) mono.remove();
      else mono.textContent = initials(event.name);
    }
    if (event.tagline) setText("eyebrow", event.tagline);
    if (event.event_date) setText("date", event.event_date);
    if (event.venue) setText("venue", event.venue);
    const footMeta = F("footMeta");
    if (footMeta) {
      const bits = [event.event_date, event.venue].filter(Boolean);
      footMeta.textContent = bits.join("  .  ");
    }
    if (cinema) startCinema();
  } catch {}
}

// Cinematic landing backdrop (Signature and Grand). A slow, heavily veiled reel
// of wedding footage behind the page that plays each clip through, crossfades to
// the next, and freezes the moment the visitor scrolls. Kept dependency free and
// self contained here, mirroring the marketing home's backdrop.
function startCinema() {
  const SOURCES = [
    "/videos/v1-beach.mp4",
    "/videos/v2-ceremony.mp4",
    "/videos/v3-vows.mp4",
    "/videos/v4-cake.mp4",
    "/videos/v5-toss.mp4",
  ];
  const reduce =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.body.classList.add("cinema");
  const stage = document.createElement("div");
  stage.className = "bg-stage";
  stage.setAttribute("aria-hidden", "true");
  const a = document.createElement("video");
  const b = document.createElement("video");
  [a, b].forEach((v) => {
    v.className = "bg-video";
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("muted", "");
    v.preload = "auto";
    stage.appendChild(v);
  });
  const veil = document.createElement("div");
  veil.className = "veil";
  veil.setAttribute("aria-hidden", "true");
  const grain = document.createElement("div");
  grain.className = "grain";
  grain.setAttribute("aria-hidden", "true");
  document.body.prepend(grain);
  document.body.prepend(veil);
  document.body.prepend(stage);

  const FADE_MS = 3000;
  const TAIL = 3.2; // begin the crossfade this many seconds before a clip ends
  const MIN_HOLD = 2.5;
  let idx = 0;
  let front = a;
  let back = b;
  let busy = false;
  let frozen = false;

  const play = (v) => {
    v.muted = true;
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  };
  const load = (v, src) => {
    v.loop = false;
    if (v.getAttribute("src") !== src) {
      v.setAttribute("src", src);
      v.load();
    }
  };

  load(front, SOURCES[0]);
  front.addEventListener(
    "loadeddata",
    () => {
      front.classList.add("show");
      if (!frozen && !reduce) play(front);
    },
    { once: true }
  );
  load(back, SOURCES[1 % SOURCES.length]);

  function advance() {
    if (busy || frozen || reduce) return;
    busy = true;
    const next = (idx + 1) % SOURCES.length;
    load(back, SOURCES[next]);
    const go = () => {
      try { back.currentTime = 0; } catch (_) {}
      if (!frozen) play(back);
      back.classList.add("show");
      front.classList.remove("show");
      setTimeout(() => {
        front.pause();
        const t = front; front = back; back = t;
        idx = next;
        busy = false;
        load(back, SOURCES[(idx + 1) % SOURCES.length]);
      }, FADE_MS);
    };
    if (back.readyState >= 3) go();
    else back.addEventListener("canplay", go, { once: true });
  }

  const onTime = (e) => {
    if (busy || frozen || reduce || e.target !== front) return;
    const d = front.duration;
    if (d && isFinite(d) && front.currentTime >= Math.max(MIN_HOLD, d - TAIL)) advance();
  };
  const onEnd = (e) => {
    if (!busy && !frozen && !reduce && e.target === front) advance();
  };
  a.addEventListener("timeupdate", onTime);
  b.addEventListener("timeupdate", onTime);
  a.addEventListener("ended", onEnd);
  b.addEventListener("ended", onEnd);

  // Freeze the reel on the current frame the moment they scroll; resume only
  // when they return to the very top.
  let ticking = false;
  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const atTop = window.scrollY <= 8;
        if (!atTop && !frozen) {
          frozen = true;
          front.pause();
          back.pause();
        } else if (atTop && frozen) {
          frozen = false;
          if (!reduce) play(front);
        }
        ticking = false;
      });
    },
    { passive: true }
  );
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
