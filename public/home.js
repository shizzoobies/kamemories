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

// How-it-works: reveal each step as it enters view, light its marker, and draw
// the connecting line as the section scrolls past.
(function () {
  const steps = Array.from(document.querySelectorAll(".cine-step"));
  if (!steps.length) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    steps.forEach((s) => s.classList.add("in"));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    });
  }, { threshold: 0.4, rootMargin: "0px 0px -12% 0px" });
  steps.forEach((s) => io.observe(s));

  const fill = document.getElementById("stepsFill");
  const wrap = document.getElementById("howSteps");
  if (wrap) {
    const draw = () => {
      const r = wrap.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      if (fill) {
        const start = vh * 0.78, end = vh * 0.4;
        const span = r.height + (start - end);
        let p = (start - r.top) / span;
        p = Math.max(0, Math.min(1, p));
        fill.style.height = (p * 100).toFixed(1) + "%";
      }
      // Light the step nearest the viewport's vertical center, and clear all when
      // the section is essentially off screen, so exactly one glow follows the
      // reader and hands off cleanly from one step to the next.
      const inView = r.bottom > vh * 0.15 && r.top < vh * 0.85;
      if (!inView) { steps.forEach((s) => s.classList.remove("is-active")); return; }
      const focus = vh * 0.5;
      let best = null, bestDist = Infinity;
      for (const s of steps) {
        const br = (s.querySelector(".cine-step-body") || s).getBoundingClientRect();
        const center = br.top + br.height / 2;
        const dist = Math.abs(center - focus);
        if (dist < bestDist) { bestDist = dist; best = s; }
      }
      steps.forEach((s) => s.classList.toggle("is-active", s === best));
    };
    let pending = false;
    window.addEventListener("scroll", () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; draw(); }); } }, { passive: true });
    window.addEventListener("resize", draw, { passive: true });
    draw();
  }
})();

// The footer logo glides back to the top of the page.
(function () {
  const top = document.querySelector(".cine-foot-top");
  if (top) top.addEventListener("click", (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); });
})();

// Contact: a modal form that emails the inquiry to us (POST /api/contact). The
// triggers keep a mailto href as a no-JS fallback; here we intercept and open it.
(function () {
  const modal = document.getElementById("contactModal");
  if (!modal) return;
  const form = document.getElementById("contactForm");
  const bodyEl = document.getElementById("contactBody");
  const done = document.getElementById("contactDone");
  const msg = document.getElementById("contactMsg");
  const val = (id) => (document.getElementById(id).value || "").trim();

  function open() {
    bodyEl.style.display = "";
    done.style.display = "none";
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    setTimeout(() => document.getElementById("ctName").focus(), 60);
  }
  function close() { modal.classList.remove("show"); modal.setAttribute("aria-hidden", "true"); }

  document.querySelectorAll(".js-contact-open").forEach((el) =>
    el.addEventListener("click", (e) => { e.preventDefault(); open(); })
  );
  document.getElementById("contactClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal.classList.contains("show")) close(); });

  // Format the phone live as it is typed, e.g. (904)210-1071.
  const phone = document.getElementById("ctPhone");
  function formatPhone(v) {
    const d = (v || "").replace(/\D/g, "").slice(0, 10);
    if (d.length === 0) return "";
    if (d.length < 4) return "(" + d;
    if (d.length < 7) return "(" + d.slice(0, 3) + ")" + d.slice(3);
    return "(" + d.slice(0, 3) + ")" + d.slice(3, 6) + "-" + d.slice(6);
  }
  if (phone) phone.addEventListener("input", () => { phone.value = formatPhone(phone.value); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("contactSubmit");
    btn.disabled = true;
    msg.textContent = ""; msg.classList.remove("err");
    const payload = {
      name: val("ctName"), email: val("ctEmail"), phone: val("ctPhone"),
      event_date: val("ctDate"), message: val("ctMessage"), company: val("ctCompany"),
    };
    try {
      const r = await fetch("/api/contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { msg.textContent = d.message || "Something went wrong. Try again."; msg.classList.add("err"); return; }
      bodyEl.style.display = "none";
      done.style.display = "block";
    } catch {
      msg.textContent = "No connection. Try again.";
      msg.classList.add("err");
    } finally {
      btn.disabled = false;
    }
  });
})();
