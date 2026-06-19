// Demo-only: a "see it in your colors" bar. A visitor picks two colors and the
// whole demo re-skins live by overriding the Midnight Pearl CSS variables with a
// palette derived from their two colors. Client-side only; nothing is saved to
// the server, so every visitor sees their own colors. Active only on the demo
// subdomain (demo.kamemories.com / demo.localhost).

(function () {
  const label = (location.hostname.split(".")[0] || "").toLowerCase();
  if (label !== "demo") return;

  const root = document.documentElement;
  const STORE = "kamemoriesDemoTheme";
  const VARS = ["--bg", "--bg-grad-top", "--surface", "--surface-2", "--line", "--line-soft", "--ink", "--muted", "--faint", "--silver", "--silver-bright", "--silver-deep", "--gold", "--gold-bright", "--ivory", "--sheen"];

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

  function apply(c1, c2) {
    const p = palette(c1, c2);
    for (const k in p) root.style.setProperty(k, p[k]);
  }
  function clearTheme() { VARS.forEach((k) => root.style.removeProperty(k)); }

  // c1 = base, c2 = accent. The first is the default Midnight Pearl.
  const PRESETS = [
    { name: "Midnight Pearl", c1: "#0a1626", c2: "#c7cfdb", reset: true },
    { name: "Blush & Sage", c1: "#e8b4b8", c2: "#a3b18a" },
    { name: "Navy & Gold", c1: "#1f2a44", c2: "#cda434" },
    { name: "Terracotta & Cream", c1: "#b5651d", c2: "#efe6d4" },
    { name: "Dusty Blue & Champagne", c1: "#6f8faf", c2: "#e7d8b8" },
    { name: "Plum & Rose", c1: "#512840", c2: "#e0a8b0" },
  ];

  function setTheme(c1, c2, isReset) {
    if (isReset) clearTheme(); else apply(c1, c2);
    if (one) one.value = c1;
    if (two) two.value = c2;
    try { localStorage.setItem(STORE, JSON.stringify({ c1, c2, reset: !!isReset })); } catch (e) {}
  }

  // ---- UI ----
  let one, two;
  const bar = document.createElement("div");
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Preview the gallery in your colors");
  Object.assign(bar.style, {
    position: "fixed", top: "0", left: "0", right: "0", zIndex: "200",
    display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "wrap",
    gap: "10px 16px", padding: "9px 16px",
    background: "rgba(8, 12, 20, 0.82)", backdropFilter: "blur(10px)", webkitBackdropFilter: "blur(10px)",
    borderBottom: "1px solid rgba(255,255,255,0.12)",
    font: "500 0.8rem 'Hanken Grotesk', system-ui, sans-serif", color: "rgba(255,255,255,0.82)",
  });

  const lab = document.createElement("span");
  lab.textContent = "See it in your colors";
  lab.style.letterSpacing = "0.04em";
  lab.style.opacity = "0.9";

  function swatch(titleText) {
    const inp = document.createElement("input");
    inp.type = "color";
    inp.title = titleText;
    inp.setAttribute("aria-label", titleText);
    Object.assign(inp.style, { width: "30px", height: "30px", padding: "0", border: "1px solid rgba(255,255,255,0.35)", borderRadius: "50%", background: "none", cursor: "pointer", appearance: "none", webkitAppearance: "none" });
    return inp;
  }
  one = swatch("Your first color (base)");
  two = swatch("Your second color (accent)");
  const swatchWrap = document.createElement("span");
  swatchWrap.style.display = "inline-flex";
  swatchWrap.style.gap = "8px";
  swatchWrap.append(one, two);

  one.addEventListener("input", () => setTheme(one.value, two.value, false));
  two.addEventListener("input", () => setTheme(one.value, two.value, false));

  const chips = document.createElement("span");
  chips.style.display = "inline-flex";
  chips.style.gap = "7px";
  PRESETS.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.title = p.name;
    b.setAttribute("aria-label", p.name);
    Object.assign(b.style, { width: "22px", height: "22px", borderRadius: "50%", border: "1px solid rgba(255,255,255,0.3)", cursor: "pointer", padding: "0", background: `linear-gradient(135deg, ${p.c1} 0 50%, ${p.c2} 50% 100%)` });
    b.addEventListener("click", () => setTheme(p.c1, p.c2, p.reset));
    chips.appendChild(b);
  });

  const sep = document.createElement("span");
  sep.textContent = "";
  sep.style.cssText = "width:1px;height:18px;background:rgba(255,255,255,0.18)";

  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset";
  Object.assign(reset.style, { background: "none", border: "0", color: "rgba(255,255,255,0.6)", font: "inherit", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: "3px" });
  reset.addEventListener("click", () => setTheme("#0a1626", "#c7cfdb", true));

  bar.append(lab, swatchWrap, chips, sep, reset);

  function fit() { document.body.style.paddingTop = bar.offsetHeight + "px"; }

  function mount() {
    document.body.appendChild(bar);
    fit();
    window.addEventListener("resize", fit, { passive: true });
    // Restore a previous choice (e.g. navigating from landing to gallery).
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) {}
    if (saved && saved.c1 && saved.c2) setTheme(saved.c1, saved.c2, !!saved.reset);
    else { one.value = "#0a1626"; two.value = "#c7cfdb"; }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
