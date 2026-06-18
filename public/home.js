// Cinematic background. Two stacked <video> layers play one real wedding clip
// at a time, all the way through, then very slowly dissolve into the next, and
// cycle through all five. No clip loops or repeats back-to-back, so the backdrop
// stays smooth and never jumps. The moment the visitor scrolls off the top, the
// current frame freezes; it resumes when they return to the top. If the files
// are missing or autoplay is blocked, the gradient base (CSS) carries the look.
// Honors reduced-motion by holding a single still frame.

const SOURCES = [
  "/videos/v1-beach.mp4",
  "/videos/v2-ceremony.mp4",
  "/videos/v3-vows.mp4",
  "/videos/v4-cake.mp4",
  "/videos/v5-toss.mp4",
];
const FADE_MS = 3000; // very slow dissolve; must match the .bg-video opacity transition
const TAIL_S = 3.4;   // begin the dissolve this many seconds before a clip ends
const MIN_S = 2.5;    // but always show a clip at least this long (guards short clips)

const a = document.getElementById("bgA");
const b = document.getElementById("bgB");

if (a && b && SOURCES.length) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let idx = 0;
  let front = a;
  let back = b;
  let transitioning = false;
  let frozen = false;

  const play = (el) => {
    el.muted = true;
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  };
  const prep = (el, src) => {
    el.loop = false;
    el.muted = true;
    if (el.getAttribute("src") !== src) { el.setAttribute("src", src); el.load(); }
  };

  // First clip up, next clip preloaded on the back layer.
  prep(front, SOURCES[0]);
  front.addEventListener("loadeddata", () => { front.classList.add("show"); if (!frozen && !reduce) play(front); }, { once: true });
  prep(back, SOURCES[1 % SOURCES.length]);

  // Drive the crossfade off the visible clip nearing its end, not a fixed timer,
  // so each clip plays through and there is never a loop seam or hard cut.
  const onProgress = (e) => {
    if (transitioning || frozen || reduce || e.target !== front) return;
    const d = front.duration;
    if (d && isFinite(d) && front.currentTime >= Math.max(MIN_S, d - TAIL_S)) advance();
  };
  const onEnded = (e) => { if (!transitioning && !frozen && !reduce && e.target === front) advance(); };
  a.addEventListener("timeupdate", onProgress);
  b.addEventListener("timeupdate", onProgress);
  a.addEventListener("ended", onEnded);
  b.addEventListener("ended", onEnded);

  function advance() {
    if (transitioning || frozen || reduce) return;
    transitioning = true;
    const next = (idx + 1) % SOURCES.length;
    prep(back, SOURCES[next]);

    const go = () => {
      try { back.currentTime = 0; } catch (_) {}
      if (!frozen) play(back);
      back.classList.add("show");
      front.classList.remove("show");
      setTimeout(() => {
        front.pause();
        const tmp = front; front = back; back = tmp;
        idx = next;
        transitioning = false;
        prep(back, SOURCES[(idx + 1) % SOURCES.length]); // preload the following clip
      }, FADE_MS);
    };

    if (back.readyState >= 3) go();
    else { back.addEventListener("canplay", go, { once: true }); back.load(); }
  }

  // Freeze the current frame on scroll, resume at the top.
  let ticking = false;
  window.addEventListener("scroll", () => {
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
  }, { passive: true });
}
