// Claim page: reads the ?s send token (if the vendor arrived from a tracked
// email), logs the visit + prefills from their record, and posts the claim.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var token = new URLSearchParams(location.search).get("s") || "";

  if (token) {
    fetch("/api/claim/context?s=" + encodeURIComponent(token))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        if (d.email && !$("email").value) $("email").value = d.email;
        if (d.business && !$("business").value) $("business").value = d.business;
        if (d.business_type && $("type")) $("type").value = d.business_type;
      })
      .catch(function () {});
  }

  var form = $("form");
  var btn = $("submit");
  var msg = $("msg");

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    msg.textContent = "";
    var email = $("email").value.trim();
    if (!email) { msg.textContent = "Add your email so we can send your code."; return; }
    var payload = {
      s: token,
      business: $("business").value.trim(),
      name: $("name").value.trim(),
      email: email,
      type: $("type") ? $("type").value : "",
      phone: $("phone").value.trim(),
      note: $("note").value.trim(),
      company: $("company").value,
    };
    btn.disabled = true;
    btn.textContent = "Sending...";
    fetch("/api/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          msg.textContent = (res.d && res.d.message) || "Something went wrong. Please email memories@ka-performancefl.com.";
          btn.disabled = false;
          btn.textContent = "Claim my founding code";
          return;
        }
        $("doneTo").textContent = email;
        form.style.display = "none";
        $("done").style.display = "block";
      })
      .catch(function () {
        msg.textContent = "No connection. Please try again.";
        btn.disabled = false;
        btn.textContent = "Claim my founding code";
      });
  });
})();
