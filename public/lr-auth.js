(function () {
  // debug visible
  var st = document.getElementById("lr-auth-status");
  if (st) st.textContent = "État script : ✅ chargé";

  // IMPORTANT: mets ici l’URL de ton backend Render (pas Odoo)
  var API = "https://ai-engine-zcer.onrender.com";

  function byId(id) { return document.getElementById(id); }
  var emailEl = byId("lr-email");
  var slugEl = byId("lr-slug");
  var btnEl = byId("lr-send-link");
  var msgEl = byId("lr-msg");

  function setMsg(text, ok) {
    if (!msgEl) return;
    msgEl.style.display = "block";
    msgEl.style.border = "1px solid " + (ok ? "#A7F3D0" : "#FECACA");
    msgEl.style.background = ok ? "#ECFDF5" : "#FEF2F2";
    msgEl.style.color = ok ? "#065F46" : "#7F1D1D";
    msgEl.textContent = text;
  }

  async function sendLink() {
    var email = (emailEl && emailEl.value || "").trim().toLowerCase();
    var slug = (slugEl && slugEl.value || "").trim().toLowerCase();

    if (!email || email.indexOf("@") === -1) return setMsg("❌ Email invalide", false);
    if (!slug) return setMsg("❌ Slug requis (ex: atelier-roma)", false);

    btnEl.disabled = true;
    btnEl.style.opacity = "0.7";
    btnEl.textContent = "⏳ Envoi…";

    try {
      var r = await fetch(API + "/auth/send-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, slug: slug })
      });

      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));

      // Fallback si Resend bloque: verify_url renvoyée
      if (data.verify_url) {
        setMsg("⚠️ Email bloqué (mode test). Ouvre ce lien : " + data.verify_url, true);
      } else {
        setMsg("✅ Lien envoyé. Vérifie ta boîte mail (valide 15 min).", true);
      }
    } catch (e) {
      setMsg("❌ " + e.message, false);
    } finally {
      btnEl.disabled = false;
      btnEl.style.opacity = "1";
      btnEl.textContent = "📩 Envoyer un lien de connexion";
    }
  }

  if (btnEl) btnEl.addEventListener("click", sendLink);

  // anti-Odoo hotkeys (capture)
  [emailEl, slugEl].forEach(function (el) {
    if (!el) return;
    ["keydown","keyup","keypress","input","click","mousedown"].forEach(function (ev) {
      el.addEventListener(ev, function (e) { e.stopPropagation(); }, true);
    });
  });
})();