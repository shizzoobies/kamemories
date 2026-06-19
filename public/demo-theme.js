// Demo-only personalization: a premium "make it yours" bar. A visitor types their
// names and picks two colors (one-tap presets, the full system color picker, or a
// typed hex), and the whole demo re-skins live, names and palette, by overriding
// the Midnight Pearl CSS variables and the displayed event name. Client-side only;
// nothing is saved to the server. The choices ride along in localStorage so the
// event pages and the organizer demo stay in sync. A persistent CTA off the right
// edge leads back to the main site. Active only on the demo subdomain.

(function () {
  const host = (location.hostname.split(".")[0] || "").toLowerCase();
  if (host !== "demo") return;

  const root = document.documentElement;
  const STORE = "kamemoriesDemoTheme";
  const NAME_STORE = "kamemoriesDemoName";
  const VARS = ["--bg", "--bg-grad-top", "--surface", "--surface-2", "--line", "--line-soft", "--ink", "--muted", "--faint", "--silver", "--silver-bright", "--silver-deep", "--gold", "--gold-bright", "--ivory", "--sheen"];
  const DEF1 = "#0a1626", DEF2 = "#c7cfdb";

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const hsl = (h, s, l) => `hsl(${Math.round(h)}, ${Math.round(clamp(s, 0, 100))}%, ${Math.round(clamp(l, 0, 100))}%)`;
  const hsla = (h, s, l, a) => `hsla(${Math.round(h)}, ${Math.round(clamp(s, 0, 100))}%, ${Math.round(clamp(l, 0, 100))}%, ${a})`;

  function hexToHsl(hex) {
    hex = (hex || "").replace("#", "");
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h || 0, s: s * 100, l: l * 100 };
  }

  // Build a cinematic dark palette: color one sets the deep base hue, color two
  // the luminous accent. Text stays bright for legibility on the dark base.
  function palette(c1, c2) {
    const a = hexToHsl(c1), b = hexToHsl(c2);
    const bs = clamp(a.s, 22, 52), as = clamp(b.s, 34, 82);
    return {
      "--bg": hsl(a.h, bs, 8),
      "--bg-grad-top": hsl(a.h, bs, 17),
      "--surface": hsl(a.h, bs * 0.9, 12),
      "--surface-2": hsl(a.h, bs * 0.9, 18),
      "--line": hsl(a.h, bs * 0.7, 30),
      "--line-soft": hsla(b.h, 30, 75, 0.16),
      "--ink": hsl(a.h, 14, 95),
      "--muted": hsl(a.h, 16, 72),
      "--faint": hsl(a.h, 14, 55),
      "--silver": hsl(b.h, as, 78),
      "--silver-bright": hsl(b.h, as, 91),
      "--silver-deep": hsl(b.h, as * 0.8, 62),
      "--gold": hsl(b.h, as, 78),
      "--gold-bright": hsl(b.h, as, 91),
      "--ivory": hsl(b.h, clamp(as, 20, 45), 93),
      "--sheen": `linear-gradient(135deg, ${hsl(b.h, as, 95)} 0%, ${hsl(b.h, as, 82)} 36%, ${hsl(b.h, as * 0.85, 64)} 58%, ${hsl(b.h, as, 92)} 100%)`,
    };
  }

  function applyColors(c1, c2) { const p = palette(c1, c2); for (const k in p) root.style.setProperty(k, p[k]); }
  function clearColors() { VARS.forEach((k) => root.style.removeProperty(k)); }

  function savedTheme() { try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { return null; } }
  function savedName() { try { return (localStorage.getItem(NAME_STORE) || "").trim(); } catch (e) { return ""; } }
  function restoreColors() { const s = savedTheme(); if (s && s.c1 && s.c2) { if (s.reset) clearColors(); else applyColors(s.c1, s.c2); } }

  function ready(fn) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn); else fn(); }

  // ---- Name personalization. The event scripts fill these from the API after
  // load, so a MutationObserver keeps the visitor's name on top. ----
  const NAME_TARGETS = ["names", "brand", "footName", "eventName"];
  function applyName(n) {
    n = (n || "").trim();
    if (!n) return;
    NAME_TARGETS.forEach((id) => { const el = document.getElementById(id); if (el && el.textContent !== n) el.textContent = n; });
    if (document.title !== n) document.title = n;
  }
  function watchName() {
    const obs = new MutationObserver(() => applyName(savedName()));
    NAME_TARGETS.forEach((id) => { const el = document.getElementById(id); if (el) obs.observe(el, { childList: true, characterData: true, subtree: true }); });
    applyName(savedName());
  }

  // Persistent CTA back to the main site, on every demo page (guest and dashboard).
  function buildSideCta() {
    if (document.querySelector(".demo-cta")) return;
    const a = document.createElement("a");
    a.className = "demo-cta";
    a.href = "https://kamemories.com";
    a.textContent = "Create your event";
    a.setAttribute("aria-label", "Go to kamemories to create your event");
    document.body.appendChild(a);
  }
  ready(buildSideCta);

  // The organizer dashboard demo (/app) carries the colors and name too, but it
  // renders no bar: the colors come from here, the name from its sandbox backend.
  const onDashboard = location.pathname === "/app" || location.pathname === "/admin";
  if (onDashboard) { restoreColors(); return; }

  // ---- Bar (event, gallery, capture pages) ----
  let one, two, basePick, accPick;
  let last1 = DEF1, last2 = DEF2;

  function setColors(c1, c2, isReset, syncInputs) {
    last1 = c1; last2 = c2;
    if (isReset) clearColors(); else applyColors(c1, c2);
    if (syncInputs) {
      if (one) one.value = c1;
      if (two) two.value = c2;
      if (basePick) basePick.value = expand(c1);
      if (accPick) accPick.value = expand(c2);
    }
    try { localStorage.setItem(STORE, JSON.stringify({ c1: c1, c2: c2, reset: !!isReset })); } catch (e) {}
  }
  function normHex(v) {
    v = (v || "").trim();
    if (v && v[0] !== "#") v = "#" + v;
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v : null;
  }
  // The native color input needs a full six digit hex.
  function expand(hex) {
    const v = normHex(hex) || DEF1;
    return v.length === 4 ? ("#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]) : v;
  }

  // c1 = base, c2 = accent. The first is the default Midnight Pearl.
  const PRESETS = [
    { name: "Midnight Pearl", c1: "#0a1626", c2: "#c7cfdb", reset: true },
    { name: "Blush & Sage", c1: "#e8b4b8", c2: "#a3b18a" },
    { name: "Navy & Gold", c1: "#1f2a44", c2: "#cda434" },
    { name: "Terracotta & Cream", c1: "#b5651d", c2: "#efe6d4" },
    { name: "Dusty Blue & Champagne", c1: "#6f8faf", c2: "#e7d8b8" },
    { name: "Plum & Rose", c1: "#512840", c2: "#e0a8b0" },
  ];

  const bar = document.createElement("div");
  bar.className = "demo-bar";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Personalize the demo with your names and colors");

  const lab = document.createElement("span");
  lab.className = "demo-bar-label";
  lab.textContent = "Make it yours";

  const nameInput = document.createElement("input");
  nameInput.type = "text"; nameInput.className = "demo-text demo-name"; nameInput.maxLength = 40;
  nameInput.placeholder = "Your names"; nameInput.title = "Your names"; nameInput.autocomplete = "off";
  nameInput.setAttribute("aria-label", "Your names for the demo");
  nameInput.addEventListener("input", () => {
    const n = nameInput.value.trim();
    try { localStorage.setItem(NAME_STORE, n); } catch (e) {}
    applyName(n);
  });

  // Color module: presets, then a swatch (full picker) and hex for each color.
  const colors = document.createElement("div");
  colors.className = "demo-colors";

  const presets = document.createElement("span");
  presets.className = "demo-presets";
  PRESETS.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "demo-chip"; b.title = p.name; b.setAttribute("aria-label", p.name);
    b.style.background = `linear-gradient(135deg, ${p.c1} 0 50%, ${p.c2} 50% 100%)`;
    b.addEventListener("click", () => setColors(p.c1, p.c2, p.reset, true));
    presets.appendChild(b);
  });

  function colorField(titleText) {
    const wrap = document.createElement("span");
    wrap.className = "demo-pair";
    const pick = document.createElement("input");
    pick.type = "color"; pick.className = "demo-swatch";
    pick.title = titleText + ": click to pick"; pick.setAttribute("aria-label", titleText + ", color picker");
    const inp = document.createElement("input");
    inp.type = "text"; inp.className = "demo-text demo-hex"; inp.maxLength = 7; inp.spellcheck = false; inp.autocomplete = "off";
    inp.title = titleText + " hex code"; inp.setAttribute("aria-label", titleText + " hex code"); inp.placeholder = "#000000";
    wrap.append(pick, inp);
    return { wrap: wrap, pick: pick, input: inp };
  }
  const baseF = colorField("Your base color");
  const accF = colorField("Your accent color");
  one = baseF.input; two = accF.input; basePick = baseF.pick; accPick = accF.pick;
  basePick.addEventListener("input", () => { one.value = basePick.value; setColors(basePick.value, last2, false, false); });
  accPick.addEventListener("input", () => { two.value = accPick.value; setColors(last1, accPick.value, false, false); });
  one.addEventListener("input", () => { const v = normHex(one.value); if (v) basePick.value = expand(v); setColors(v || last1, last2, false, false); });
  two.addEventListener("input", () => { const v = normHex(two.value); if (v) accPick.value = expand(v); setColors(last1, v || last2, false, false); });

  const reset = document.createElement("button");
  reset.type = "button"; reset.className = "demo-reset"; reset.textContent = "Reset";
  reset.addEventListener("click", () => setColors(DEF1, DEF2, true, true));

  const sep = document.createElement("span"); sep.className = "demo-sep";
  colors.append(presets, sep, baseF.wrap, accF.wrap, reset);

  const sep2 = document.createElement("span"); sep2.className = "demo-sep";

  const flip = document.createElement("a");
  flip.className = "demo-flip"; flip.href = "/app";
  flip.textContent = "Click to see Organizer View";
  flip.title = "See the dashboard the host uses";

  bar.append(lab, nameInput, colors, sep2, flip);

  function fit() { document.body.style.paddingTop = bar.offsetHeight + "px"; }

  function mount() {
    document.body.appendChild(bar);
    fit();
    window.addEventListener("resize", fit, { passive: true });
    const st = savedTheme();
    if (st && st.c1 && st.c2) setColors(st.c1, st.c2, !!st.reset, true);
    else { one.value = DEF1; two.value = DEF2; basePick.value = expand(DEF1); accPick.value = expand(DEF2); }
    const sn = savedName();
    if (sn) nameInput.value = sn;
    watchName();
  }

  ready(mount);
})();
