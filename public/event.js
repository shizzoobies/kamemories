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

// Cinematic landing backdrop (Signature and Grand packages). A slow, heavily veiled reel
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

// ---- Featured strip (the host's picks, which guests can vote on) ----
const STRIP_MAX = 15;

// One vote per device, toggleable. Optimistic: flip the heart now, reconcile with
// the server's count, and roll back on failure. Cards are duplicated for the
// looping glide, so paint every element that shares this photo's id.
const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3s-6.9-4.2-9.3-8.5C1.3 9.1 2.6 6 5.5 5.5c1.9-.3 3.5.6 4.6 2 .5.6.9 1.3 1.9 1.3s1.4-.7 1.9-1.3c1.1-1.4 2.7-2.3 4.6-2 2.9.5 4.2 3.6 2.8 6.3-2.4 4.3-9.3 8.5-9.3 8.5z"/></svg>';

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

function buildVoteButton(p) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "like-btn" + (p.liked ? " liked" : "");
  btn.dataset.likeId = p.id;
  btn.setAttribute("aria-pressed", p.liked ? "true" : "false");
  btn.setAttribute("aria-label", "Vote for this photo");
  btn.innerHTML = HEART + '<span class="like-n">' + (p.likes > 0 ? p.likes : "") + "</span>";
  btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleLike(p); });
  return btn;
}

function makeStripCard(p) {
  const card = document.createElement("a");
  card.className = "strip-card";
  card.href = "/gallery";

  const img = document.createElement("img");
  img.src = mediaUrl(p);
  img.loading = "lazy";
  img.alt = p.caption || "A photo from the celebration";
  card.appendChild(img);
  card.appendChild(buildVoteButton(p));

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
    const r = await fetch("/api/public/photos?scope=featured&sort=top");
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
