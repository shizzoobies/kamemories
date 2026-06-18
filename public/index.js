// Landing page: optional hero backdrop plus the featured photo strip.

const F = (id) => document.getElementById(id);

function mediaUrl(p) {
  return "/media/" + encodeURIComponent(p.thumb_key || p.r2_key);
}

// If a hero image has been added at /assets/hero.jpg, place it behind the names.
// Until then the navy hero stands on its own.
(function heroPhoto() {
  const el = F("heroPhoto");
  if (!el) return;
  const img = new Image();
  img.onload = () => {
    el.style.backgroundImage = "url('/assets/hero.jpg')";
    el.classList.add("show");
  };
  img.src = "/assets/hero.jpg";
})();

// The home strip shows the most recent featured photos. The rest still live in the
// full gallery (every approved photo is there).
const STRIP_MAX = 15;

function makeStripCard(p) {
  const card = document.createElement("a");
  card.className = "strip-card";
  card.href = "/gallery";

  const img = document.createElement("img");
  img.src = mediaUrl(p);
  img.loading = "lazy";
  img.alt = p.caption || "A photo from the weekend";
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

// Slow, seamless drift. Pauses on touch or hover, resumes after, and stays still for
// anyone who prefers reduced motion.
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

  // If the row is longer than the viewport, duplicate it once so the drift loops
  // seamlessly. With only a few photos it just sits still.
  requestAnimationFrame(() => {
    if (strip.scrollWidth <= strip.clientWidth + 8) return;
    const second = featured.map(makeStripCard);
    const loopMark = second[0];
    for (const c of second) strip.appendChild(c);
    autoGlide(strip, () => loopMark.offsetLeft);
  });
}

loadStrip();
