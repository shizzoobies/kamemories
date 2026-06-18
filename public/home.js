// Rotating cinematic background. Two stacked <video> layers crossfade through
// the source list on a slow timer. If the files are absent or cannot autoplay,
// nothing fades in and the gradient base (CSS) remains, which is a finished look
// on its own. Honors reduced-motion by holding a single still frame.

const SOURCES = [
  "/videos/beach.mp4",
  "/videos/mountain.mp4",
  "/videos/ranch.mp4",
  "/videos/church.mp4",
];
const HOLD_MS = 9000; // time each clip is shown before the crossfade
const FADE_MS = 2600; // must match the .bg-video opacity transition

const a = document.getElementById("bgA");
const b = document.getElementById("bgB");

if (a && b && SOURCES.length) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let idx = 0;
  let front = a;
  let back = b;

  const play = (el) => {
    el.muted = true;
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  };

  // Bring up the first clip.
  front.src = SOURCES[0];
  front.addEventListener("loadeddata", () => { front.classList.add("show"); play(front); }, { once: true });
  front.load();

  if (!reduce && SOURCES.length > 1) {
    const cycle = () => {
      const next = (idx + 1) % SOURCES.length;
      back.src = SOURCES[next];

      const reveal = () => {
        play(back);
        back.classList.add("show");
        front.classList.remove("show");
        // After the fade, the old front is hidden; reuse it as the next back.
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
    setInterval(cycle, HOLD_MS);
  }
}
