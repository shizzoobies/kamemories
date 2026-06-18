// Magic-link sign in. Posts the email, then shows a "check your inbox" state.
// In dev mode (no email provider) the API returns the link, which we surface.

const $ = (id) => document.getElementById(id);

// Surface any error passed back by the verify redirect.
const params = new URLSearchParams(location.search);
const err = params.get("error");
if (err) {
  const map = {
    expired: "That link expired or was already used. Request a new one below.",
    missing: "That link was incomplete. Request a new one below.",
  };
  $("msg").textContent = map[err] || "Something went wrong. Try again.";
  $("msg").classList.add("err");
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  if (!email) return;

  const btn = $("submit");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Sending...";
  $("msg").textContent = "";
  $("msg").classList.remove("err");

  try {
    const r = await fetch("/api/auth/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await r.json();
    if (!r.ok) {
      $("msg").textContent = data.message || "Could not send the link. Try again.";
      $("msg").classList.add("err");
    } else {
      $("form").style.display = "none";
      $("sentTo").textContent = email;
      $("sent").style.display = "block";
      if (data.devLink) {
        $("dev").style.display = "block";
        const a = $("devLink");
        a.href = data.devLink;
        a.textContent = data.devLink;
      }
    }
  } catch {
    $("msg").textContent = "No connection. Try again.";
    $("msg").classList.add("err");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});
