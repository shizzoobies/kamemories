// Guest capture + upload logic (photos only). The event is resolved from the
// subdomain by the Worker, so /api/quota and /api/upload are already scoped.

const $ = (id) => document.getElementById(id);
const cam = $("cam");
const preview = $("preview");
const placeholder = $("placeholder");
const shutter = $("shutter");
const flipBtn = $("flipBtn");
const flash = $("flash");
const liveControls = $("liveControls");
const reviewActions = $("reviewActions");
const captionEl = $("caption");
const nameInput = $("nameInput");
const fileInput = $("fileInput");
const libraryBtn = $("libraryBtn");
const retakeBtn = $("retakeBtn");
const sendBtn = $("sendBtn");
const toastEl = $("toast");

const MAX_EDGE = 2200;

// On the demo subdomain the capture page is a sandbox: the camera, review, and
// send all work and feel real, but nothing is uploaded or stored.
const IS_DEMO = (location.hostname.split(".")[0] || "").toLowerCase() === "demo";
if (IS_DEMO) {
  const sub = document.querySelector(".event-sub");
  if (sub) sub.textContent = "A live demo. Snap a photo to try the experience. Nothing is uploaded or saved.";
}

let stream = null;
let facing = "environment";
let pending = null; // { blob, url }
let remaining = 10;

// Restore saved name
nameInput.value = localStorage.getItem("guestName") || "";
nameInput.addEventListener("change", () =>
  localStorage.setItem("guestName", nameInput.value.trim())
);
nameInput.addEventListener("input", () => nameInput.classList.remove("needed"));

// ---- Quota ----
async function loadQuota() {
  try {
    const r = await fetch("/api/quota", { credentials: "same-origin" });
    const q = await r.json();
    remaining = q.remaining;
    if (q.event) {
      $("eventName").textContent = q.event;
      document.title = q.event;
    }
    $("limitNote").textContent = q.limit;
    renderQuota(q.used, q.limit, q.remaining);
  } catch {
    $("quotaText").textContent = "";
  }
}

function renderQuota(used, limit, rem) {
  const dots = $("dots");
  dots.innerHTML = "";
  if (limit <= 6) {
    for (let i = 0; i < limit; i++) {
      const d = document.createElement("span");
      d.className = "dot" + (i < used ? " filled" : "");
      dots.appendChild(d);
    }
  }
  $("quotaText").innerHTML =
    rem > 0
      ? `<strong>${rem}</strong> of ${limit} left today`
      : `That's all for today, thank you`;
  shutter.disabled = rem <= 0;
  libraryBtn.disabled = rem <= 0;
}

// ---- Camera ----
async function startCamera() {
  if (remaining <= 0) return;
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1920 } },
      audio: false,
    });
    cam.srcObject = stream;
    cam.muted = true;
    cam.classList.toggle("mirror", facing === "user");
    cam.style.display = "block";
    preview.style.display = "none";
    placeholder.style.display = "none";
    await cam.play().catch(() => {});
  } catch (err) {
    placeholder.textContent =
      "Camera is not available here. Use Choose from my phone instead.";
    placeholder.style.display = "block";
    cam.style.display = "none";
    shutter.disabled = true;
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

flipBtn.addEventListener("click", async () => {
  facing = facing === "environment" ? "user" : "environment";
  if (stream) await startCamera();
});

// ---- Shutter ----
shutter.addEventListener("click", async () => {
  if (remaining <= 0) return;
  if (!stream) { await startCamera(); return; }
  capturePhoto();
});

function capturePhoto() {
  flash.classList.remove("fire");
  void flash.offsetWidth;
  flash.classList.add("fire");

  const vw = cam.videoWidth, vh = cam.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh));
  const cw = Math.round(vw * scale), ch = Math.round(vh * scale);
  const canvas = document.createElement("canvas");
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (facing === "user") { ctx.translate(cw, 0); ctx.scale(-1, 1); }
  ctx.drawImage(cam, 0, 0, cw, ch);
  canvas.toBlob(
    (blob) => { if (blob) showReview(blob); },
    "image/jpeg",
    0.85
  );
}

// ---- Library upload ----
libraryBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  if (file.type.startsWith("image/")) {
    const blob = await downscaleImage(file);
    showReview(blob);
  } else {
    toast("Pick a photo.", true);
  }
  fileInput.value = "";
});

function downscaleImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      if (scale === 1 && file.size < 4 * 1024 * 1024) {
        URL.revokeObjectURL(url);
        return resolve(file); // small enough, send as is
      }
      const cw = Math.round(img.width * scale), ch = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => resolve(b || file), "image/jpeg", 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// Small thumbnail sent alongside the full image, so the gallery grids stay light.
function makeThumb(blob) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const TH = 480;
      const scale = Math.min(1, TH / Math.max(img.width, img.height));
      const cw = Math.round(img.width * scale), ch = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.7);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ---- Review ----
function showReview(blob) {
  if (pending && pending.url) URL.revokeObjectURL(pending.url);
  const url = URL.createObjectURL(blob);
  pending = { blob, url };

  stopCamera();
  cam.style.display = "none";
  placeholder.style.display = "none";
  preview.src = url;
  preview.style.display = "block";

  liveControls.style.display = "none";
  reviewActions.style.display = "flex";
  captionEl.style.display = "block";
}

retakeBtn.addEventListener("click", () => resetCapture());

function resetCapture() {
  if (pending && pending.url) URL.revokeObjectURL(pending.url);
  pending = null;
  preview.style.display = "none";
  preview.removeAttribute("src");
  cam.style.display = "none";
  captionEl.value = "";
  captionEl.style.display = "none";
  reviewActions.style.display = "none";
  liveControls.style.display = "flex";
  placeholder.textContent = "Tap the silver button to start the camera, or choose a photo from your phone below.";
  placeholder.style.display = "block";
}

// ---- Send ----
sendBtn.addEventListener("click", send);

async function send() {
  if (!pending) return;
  const guestName = nameInput.value.trim();
  if (!guestName) {
    toast("Add your name first so they know it's you.", true);
    nameInput.classList.add("needed");
    nameInput.focus();
    nameInput.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  if (IS_DEMO) {
    // Sandbox: celebrate the capture, keep the photo on the device, store nothing.
    showSentPrint();
    remaining = Math.max(0, remaining - 1);
    const limit = parseInt($("limitNote").textContent, 10) || 10;
    renderQuota(Math.max(0, limit - remaining), limit, remaining);
    toast(remaining > 0 ? "Looks great. In a real event, this would post to the album." : "Nice shot. That is your last one in the demo.");
    resetCapture();
    return;
  }

  sendBtn.disabled = true;
  retakeBtn.disabled = true;
  const original = sendBtn.textContent;
  sendBtn.textContent = "Sending...";

  const thumb = await makeThumb(pending.blob);
  const fd = new FormData();
  fd.append("file", pending.blob, "upload.jpg");
  if (thumb) fd.append("thumb", thumb, "thumb.jpg");
  fd.append("kind", "photo");
  fd.append("caption", captionEl.value.trim());
  fd.append("name", guestName);

  try {
    const r = await fetch("/api/upload", { method: "POST", body: fd, credentials: "same-origin" });
    const data = await r.json();
    if (!r.ok) {
      toast(data.message || "Upload failed. Try again.", true);
      if (data.error === "limit") { remaining = 0; renderQuota(data.limit || 10, data.limit || 10, 0); }
    } else {
      remaining = data.remaining;
      showSentPrint();
      const used = data.limit - data.remaining;
      renderQuota(used, data.limit, data.remaining);
      toast(
        data.remaining > 0
          ? `Added. ${data.remaining} more today if you want.`
          : `Added. That's your last one today, thank you.`
      );
      resetCapture();
    }
  } catch {
    toast("No connection. Check signal and try again.", true);
  } finally {
    sendBtn.disabled = false;
    retakeBtn.disabled = false;
    sendBtn.textContent = original;
  }
}

function showSentPrint() {
  const stack = $("sentStack");
  const printEl = $("sentPrint");
  printEl.innerHTML = "";
  if (pending) {
    const node = document.createElement("img");
    node.src = pending.url;
    printEl.appendChild(node);
  }
  const cap = document.createElement("div");
  cap.className = "cap";
  cap.textContent = "Added to the album";
  printEl.appendChild(cap);
  stack.classList.add("show");
  setTimeout(() => stack.classList.remove("show"), 1400);
}

// ---- Toast ----
let toastTimer = null;
function toast(msg, isErr) {
  toastEl.textContent = msg;
  toastEl.classList.toggle("err", !!isErr);
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
}

loadQuota();
