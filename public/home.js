// Rotating cinematic background. Two stacked <video> layers crossfade through
// the four clips: each plays a couple of seconds, then softly dissolves into the
// next, looping forever. As soon as the visitor scrolls off the top, the frame
// freezes wherever it is; it resumes when they return to the top. If the files
// are absent or cannot autoplay, the gradient base (CSS) remains, which is a
// finished look on its own. Honors reduced-motion by holding a single frame.

const SOURCES = [
  "/videos/beach.mp4",
  "/videos/mountain.mp4",
  "/videos/ranch.mp4",
  "/videos/church.mp4",
];
const HOLD_MS = 2500; // each clip is fully shown for about this long
const FADE_MS = 1800; // soft dissolve; must match the .bg-video opacity transition

const a = document.getElementById("bgA");
const b = document.getElementById("bgB");

if (a && b && SOURCES.length) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let idx = 0;
  let front = a;
  let back = b;
  let timer = null;
  let frozen = false;

  const play = (el) => {
    el.muted = true;
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  };

  // Bring up the first clip.
  front.src = SOURCES[0];
  front.addEventListener("loadeddata", () => { front.classList.add("show"); if (!frozen) play(front); }, { once: true });
  front.load();

  const cycle = () => {
    if (frozen) return;
    const next = (idx + 1) % SOURCES.length;
    back.src = SOURCES[next];
    const reveal = () => {
      if (frozen) return;
      play(back);
      back.classList.add("show");
      front.classList.remove("show");
      setTimeout(() => {
        front.pause();
        const tmp = front;
        front = back;
        back = tmp;
        idx = next;
      }, FADE_MS);
    };
    if (back.readyState >= 3) reveal();
    else back.addEventListener("canplay", reveal, { once: true });
    back.load();
  };

  const startRotation = () => {
    if (!reduce && SOURCES.length > 1 && timer === null) timer = setInterval(cycle, HOLD_MS + FADE_MS);
  };
  const stopRotation = () => {
    if (timer !== null) { clearInterval(timer); timer = null; }
  };

  startRotation();

  // Freeze on scroll, resume at the top.
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const atTop = window.scrollY <= 8;
      if (!atTop && !frozen) {
        frozen = true;
        stopRotation();
        front.pause();
        back.pause();
      } else if (atTop && frozen) {
        frozen = false;
        play(front);
        startRotation();
      }
      ticking = false;
    });
  }, { passive: true });
}
