// Demo-only personalization: a "make it yours" bar. A visitor types their names
// and picks two colors (one-tap presets or a typed hex code), and the whole demo
// re-skins live, names and palette, by overriding the Midnight Pearl CSS variables
// and the displayed event name. Client-side only; nothing is saved to the server.
// The choices ride along in localStorage so the event pages and the organizer demo
// stay in sync. Active only on the demo subdomain (demo.kamemories.com).

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

  function makeSep() { const s = document.createElement("span"); s.style.cssText = "width:1px;height:18px;background:rgba(255,255,255,0.18)"; return s; }
  function field(w, titleText, placeholder) {
    const inp = document.createElement("input");
    inp.type = "text"; inp.spellcheck = false; inp.autocomplete = "off";
    inp.title = titleText; inp.setAttribute("aria-label", titleText); inp.placeholder = placeholder;
    Object.assign(inp.style, { width: w, padding: "5px 9px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.07)", color: "#fff", font: "inherit" });
    return inp;
  }

  const bar = document.createElement("div");
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Personalize the demo with your names and colors");
  Object.assign(bar.style, {
    position: "fixed", top: "0", left: "0", right: "0", zIndex: "200",
    display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap",
    gap: "9px 14px", padding: "9px 16px",
    background: "rgba(8, 12, 20, 0.82)", backdropFilter: "blur(10px)", webkitBackdropFilter: "blur(10px)",
    borderBottom: "1px solid rgba(255,255,255,0.12)",
    font: "500 0.8rem 'Hanken Grotesk', system-ui, sans-serif", color: "rgba(255,255,255,0.82)",
  });

  const lab = document.createElement("span");
  lab.textContent = "Make it yours";
  lab.style.letterSpacing = "0.04em"; lab.style.opacity = "0.9";

  // Names
  const nameInput = field("150px", "Your names", "Your names");
  nameInput.maxLength = 40;
  nameInput.addEventListener("input", () => {
    const n = nameInput.value.trim();
    try { localStorage.setItem(NAME_STORE, n); } catch (e) {}
    applyName(n);
  });

  // Preset swatches (one tap, no color theory needed)
  const chips = document.createElement("span");
  chips.style.display = "inline-flex"; chips.style.gap = "7px";
  PRESETS.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button"; b.title = p.name; b.setAttribute("aria-label", p.name);
    Object.assign(b.style, { width: "22px", height: "22px", borderRadius: "50%", border: "1px solid rgba(255,255,255,0.3)", cursor: "pointer", padding: "0", background: `linear-gradient(135deg, ${p.c1} 0 50%, ${p.c2} 50% 100%)` });
    b.addEventListener("click", () => setColors(p.c1, p.c2, p.reset, true));
    chips.appendChild(b);
  });

  // Each color offers both: a swatch that opens the full system color picker, and
  // a hex code you can type or paste. They stay in sync, and either updates the
  // live theme.
  function colorField(titleText) {
    const wrap = document.createElement("span");
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px";
    const pick = document.createElement("input");
    pick.type = "color";
    pick.title = titleText + ": click to pick";
    pick.setAttribute("aria-label", titleText + ", color picker");
    Object.assign(pick.style, { width: "30px", height: "30px", padding: "0", border: "1px solid rgba(255,255,255,0.35)", borderRadius: "50%", background: "none", cursor: "pointer", appearance: "none", webkitAppearance: "none", flex: "0 0 auto" });
    const inp = field("84px", titleText + " hex code", "#000000");
    inp.maxLength = 7; inp.style.letterSpacing = "0.03em";
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
  reset.type = "button"; reset.textContent = "Reset";
  Object.assign(reset.style, { background: "none", border: "0", color: "rgba(255,255,255,0.6)", font: "inherit", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: "3px" });
  reset.addEventListener("click", () => setColors(DEF1, DEF2, true, true));

  const admin = document.createElement("a");
  admin.href = "/app"; admin.textContent = "Organizer demo"; admin.title = "See the dashboard the host uses";
  Object.assign(admin.style, { color: "rgba(255,255,255,0.92)", font: "inherit", fontWeight: "600", textDecoration: "none", letterSpacing: "0.02em", whiteSpace: "nowrap" });

  bar.append(lab, nameInput, makeSep(), chips, baseF.wrap, accF.wrap, reset, makeSep(), admin);

  function fit() { document.body.style.paddingTop = bar.offsetHeight + "px"; }

  function mount() {
    document.body.appendChild(bar);
    fit();
    window.addEventListener("resize", fit, { passive: true });
    // Restore previous color choice (e.g. navigating landing -> gallery).
    const st = savedTheme();
    if (st && st.c1 && st.c2) setColors(st.c1, st.c2, !!st.reset, true);
    else { one.value = DEF1; two.value = DEF2; basePick.value = expand(DEF1); accPick.value = expand(DEF2); }
    // Restore previous name and keep it applied over the API fill.
    const sn = savedName();
    if (sn) nameInput.value = sn;
    watchName();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
