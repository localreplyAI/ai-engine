/**
 * LocalReply AI Engine — server.js (Step B)
 * - POST /chat                    -> chat + booking flow (your existing logic)
 * - GET  /business/:slug          -> public business data for Odoo /business?slug=...
 * - POST /business/upsert (ADMIN) -> create/update a business (for your "simulate business" page)
 *
 * Requires:
 *   npm i express cors openai pg
 *
 * Render ENV vars:
 *   OPENAI_API_KEY=...
 *   DATABASE_URL=... (Neon/Supabase Postgres)
 *   ADMIN_TOKEN=...  (long random)
 *   RESEND_API_KEY=... (optional, only if you want email sending)
 */

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

let OpenAI = require("openai");
OpenAI = OpenAI.default || OpenAI;

const app = express();
app.use(cors());
app.use(express.json());

/* ================================
   DB (Postgres)
================================= */
if (!process.env.DATABASE_URL) {
  console.warn("⚠️ Missing DATABASE_URL. The /business endpoints will fail until set.");
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // If your provider requires SSL, uncomment:
  // ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS businesses (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      address TEXT DEFAULT '',
      map_url TEXT DEFAULT '',
      business_type TEXT DEFAULT 'local_business',
      contact_email TEXT DEFAULT '',
      timezone TEXT DEFAULT 'Europe/Zurich',
      services JSONB DEFAULT '[]'::jsonb,
      hours JSONB DEFAULT '{}'::jsonb,
      rules JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
initDb().then(() => console.log("✅ DB ready")).catch((e) => {
  console.error("❌ DB init error:", e);
});

/* ================================
   ADMIN AUTH (simple)
================================= */
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!process.env.ADMIN_TOKEN) {
    return res.status(500).json({ error: "Missing ADMIN_TOKEN on server" });
  }
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/* ================================
   SESSION MEMORY (in-memory)
   (ok for now; later you can move to DB/Redis)
================================= */
const SESSIONS = {};

/* ================================
   OPENAI (intent only)
================================= */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function analyzeIntent(message) {
  try {
    const prompt = `
Return ONLY JSON.
intent = booking | other

Message:
"${message}"

JSON:
{ "intent": "booking|other" }
    `.trim();

    const resp = await client.responses.create({
      model: "gpt-5.2",
      input: prompt,
    });

    return JSON.parse(resp.output_text || "{}");
  } catch {
    return { intent: "other" };
  }
}

/* ================================
   EMAIL via RESEND (no SMTP)
   (optional - can be disabled by not setting RESEND_API_KEY)
================================= */
async function sendBookingEmail({ to, businessName, booking }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Missing RESEND_API_KEY on server");

  const payload = {
    from: "LocalReply AI <onboarding@resend.dev>",
    to: [to],
    subject: `Nouvelle demande de rendez-vous – ${businessName}`,
    text: `
Nouvelle demande de rendez-vous – ${businessName}

Service : ${booking.service}
Date    : ${booking.date}
Heure   : ${booking.time}

Envoyé via LocalReply AI.
    `.trim(),
  };

  // Node 18+ has fetch. If not, install node-fetch.
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error("Resend error: " + err);
  }
}

/* ================================
   UTILS
================================= */
function safeLower(s) {
  return String(s || "").toLowerCase();
}

function isConfirmation(text) {
  const t = safeLower(text).trim();
  const yesWords = [
    "oui",
    "ok",
    "okay",
    "confirmer",
    "confirmé",
    "confirme",
    "c'est bon",
    "cest bon",
    "d'accord",
    "valider",
    "go",
  ];
  return yesWords.some((w) => t === w || t.includes(w));
}

function parseDateFromText(text) {
  if (!text) return null;

  // already YYYY-MM-DD
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const months = {
    janvier: 1,
    février: 2,
    fevrier: 2,
    mars: 3,
    avril: 4,
    mai: 5,
    juin: 6,
    juillet: 7,
    août: 8,
    aout: 8,
    septembre: 9,
    octobre: 10,
    novembre: 11,
    décembre: 12,
    decembre: 12,
  };

  const m = text.toLowerCase();
  const match = m.match(
    /(\d{1,2})\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)/
  );
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = months[match[2]];
  if (!month) return null;

  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(year, month - 1, day);
  if (candidate < now) year += 1;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseTimeFromText(text) {
  if (!text) return null;

  // "14h", "14h30"
  const h = text.match(/\b(\d{1,2})h(\d{2})?\b/i);
  if (h) return `${String(h[1]).padStart(2, "0")}:${h[2] || "00"}`;

  // "14:30"
  const c = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (c) return `${String(c[1]).padStart(2, "0")}:${c[2]}`;

  return null;
}

/* ================================
   BUSINESS ENDPOINTS
================================= */

/**
 * Create or update a business (admin-only)
 * Used by your Odoo "/create-business" test form.
 */
app.post("/business/upsert", requireAdmin, async (req, res) => {
  try {
    const {
      slug,
      name,
      description = "",
      address = "",
      map_url = "",
      business_type = "local_business",
      contact_email = "",
      timezone = "Europe/Zurich",
      services = [],
      hours = {},
      rules = {},
    } = req.body || {};

    if (!slug || !name) {
      return res.status(400).json({ error: "slug + name requis" });
    }

    await pool.query(
      `
      INSERT INTO businesses
        (slug, name, description, address, map_url, business_type, contact_email, timezone, services, hours, rules, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,NOW())
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        address = EXCLUDED.address,
        map_url = EXCLUDED.map_url,
        business_type = EXCLUDED.business_type,
        contact_email = EXCLUDED.contact_email,
        timezone = EXCLUDED.timezone,
        services = EXCLUDED.services,
        hours = EXCLUDED.hours,
        rules = EXCLUDED.rules,
        updated_at = NOW()
      `,
      [
        slug,
        name,
        description,
        address,
        map_url,
        business_type,
        contact_email,
        timezone,
        JSON.stringify(services),
        JSON.stringify(hours),
        JSON.stringify(rules),
      ]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur", details: String(e) });
  }
});

/**
 * Public business data for the public page (/business?slug=...)
 * Returns only non-sensitive fields.
 */
app.get("/business/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;

    const r = await pool.query(
      `SELECT slug, name, description, address, map_url, business_type
       FROM businesses
       WHERE slug = $1`,
      [slug]
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ error: "Business not found" });
    }

    const row = r.rows[0];
    return res.json({
      slug: row.slug,
      name: row.name,
      description: row.description || "",
      address: row.address || "",
      map_url: row.map_url || (row.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(row.address)}` : ""),
      business_type: row.business_type || "local_business",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur", details: String(e) });
  }
});

/* ================================
   CHAT ENDPOINT
================================= */
app.post("/chat", async (req, res) => {
  try {
    const { business_slug, session_id, message, kb } = req.body || {};
    if (!business_slug || !message) {
      return res.status(400).json({ error: "business_slug et message requis." });
    }

    // Session
    const sid = session_id || "anon";
    SESSIONS[sid] = SESSIONS[sid] || {
      service: null,
      date: null,
      time: null,
      in_booking: false,
    };
    const state = SESSIONS[sid];

    // Load business from DB
    const r = await pool.query(
      `SELECT name, business_type, contact_email, timezone, services
       FROM businesses
       WHERE slug = $1`,
      [business_slug]
    );

    const dbBusiness = r.rowCount ? r.rows[0] : null;

    // Effective KB: if caller provides kb, it overrides; else build from DB
    const effectiveKB =
      kb ||
      (dbBusiness
        ? {
            business: {
              name: dbBusiness.name,
              business_type: dbBusiness.business_type || "local_business",
              timezone: dbBusiness.timezone || "Europe/Zurich",
              // you can add more later (hours/rules/etc.)
            },
            services: Array.isArray(dbBusiness.services) ? dbBusiness.services : [],
          }
        : null);

    const businessName = effectiveKB?.business?.name || "ce business";
    const services = effectiveKB?.services || [];

    // Email: from DB first, or from kb if you later include it
    const businessEmail =
      effectiveKB?.business?.contact_email ||
      (dbBusiness && dbBusiness.contact_email ? dbBusiness.contact_email : null);

    // Intent
    const intentRes = await analyzeIntent(message);
    if (intentRes.intent === "booking" || state.in_booking) {
      state.in_booking = true;
    }

    // If not in booking, simple reply for now
    if (!state.in_booking) {
      return res.json({
        session_id: sid,
        reply: { text: `Bienvenue chez ${businessName}. Comment puis-je vous aider ?` },
      });
    }

    // Fill fields (code > IA)
    if (!state.service) {
      const svc = services.find((s) => safeLower(message).includes(safeLower(s.name)));
      if (svc) state.service = svc.name;
    }
    if (!state.date) {
      const d = parseDateFromText(message);
      if (d) state.date = d;
    }
    if (!state.time) {
      const t = parseTimeFromText(message);
      if (t) state.time = t;
    }

    // If all set -> confirm
    if (state.service && state.date && state.time) {
      if (isConfirmation(message)) {
        if (!businessEmail) {
          delete SESSIONS[sid];
          return res.json({
            session_id: sid,
            reply: {
              text:
                "Merci 🙏 Votre demande est prête, mais le business n’a pas encore configuré son email de réception. " +
                "Merci de le contacter directement pour finaliser.",
            },
          });
        }

        await sendBookingEmail({
          to: businessEmail,
          businessName,
          booking: {
            service: state.service,
            date: state.date,
            time: state.time,
          },
        });

        delete SESSIONS[sid];

        return res.json({
          session_id: sid,
          reply: { text: "Merci 🙏 Votre demande a bien été transmise. L’équipe vous recontactera rapidement." },
        });
      }

      return res.json({
        session_id: sid,
        reply: { text: `Parfait 👍 Je récapitule : ${state.service} le ${state.date} à ${state.time}. Souhaitez-vous confirmer ?` },
      });
    }

    // Ask what is missing
    if (!state.service) {
      const list = services.length ? services.map((s) => s.name).join(" | ") : null;
      return res.json({
        session_id: sid,
        reply: { text: list ? `Quel service souhaitez-vous réserver ? (${list})` : "Quel service souhaitez-vous réserver ?" },
      });
    }

    if (!state.date) {
      return res.json({
        session_id: sid,
        reply: { text: "Pour quelle date souhaitez-vous le rendez-vous ? (ex: 13 février)" },
      });
    }

    return res.json({
      session_id: sid,
      reply: { text: "À quelle heure souhaitez-vous le rendez-vous ? (ex: 14h ou 14:30)" },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur", details: String(e) });
  }
});

/* ================================
   STATIC JS for Odoo (script src)
================================= */
app.get("/lr-business.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.send(`(function(){
  function getSlug(){ return new URLSearchParams(window.location.search).get("slug"); }
  var slug = getSlug();
  var API = "https://ai-engine-zcer.onrender.com"; // <= ton URL Render

  function byId(id){ return document.getElementById(id); }
  var elName = byId("biz-name");
  var elDesc = byId("biz-desc");
  var elAddr = byId("biz-address");
  var elMap = byId("biz-map");
  var elMapEmbed = byId("biz-map-embed");
  var elDebug = byId("lr-debug");

  function dbg(t){ if(elDebug) elDebug.textContent = "DEBUG: " + t; }

  if(!slug){
    if(elName) elName.textContent = "Business introuvable";
    if(elDesc) elDesc.textContent = "Lien incomplet. Exemple : /business?slug=atelier-roma";
    dbg("slug manquant");
    return;
  }

  dbg("slug = " + slug + " (chargement...)");

  fetch(API + "/business/" + encodeURIComponent(slug))
    .then(function(r){ return r.json().then(function(data){ 
      if(!r.ok) throw new Error(data.error || ("HTTP " + r.status));
      return data;
    });})
    .then(function(b){
      if(elName) elName.textContent = b.name || slug;
      if(elDesc) elDesc.textContent = b.description || "";
      if(elAddr) elAddr.textContent = b.address || "—";

      var mapUrl = b.address
        ? ("https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(b.address))
        : (b.map_url || "#");

      if(elMap) elMap.href = mapUrl;

      if(elMapEmbed && b.address){
        elMapEmbed.src = "https://www.google.com/maps?q=" + encodeURIComponent(b.address) + "&output=embed";
      }

      dbg("OK ✅ données chargées");
    })
    .catch(function(e){
      if(elName) elName.textContent = "Business introuvable";
      if(elDesc) elDesc.textContent = "Impossible de charger les données.";
      dbg("Erreur fetch: " + e.message);
      console.error(e);
    });

  // Chat (optionnel si tu as déjà ton widget ailleurs)
  var sessionId = "sess_" + Math.random().toString(16).slice(2);
  var box = byId("lr-messages");
  var input = byId("lr-input");
  var btn = byId("lr-send");

  function addMessage(role, text){
    if(!box) return;
    var div = document.createElement("div");
    div.style.margin = "6px 0";
    div.innerHTML = "<b>" + role + " :</b> " + text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  async function sendMessage(){
    if(!input) return;
    var message = (input.value || "").trim();
    if(!message) return;

    addMessage("Vous", message);
    input.value = "";

    try{
      var r = await fetch(API + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_slug: slug, session_id: sessionId, message: message })
      });
      var data = await r.json();
      if(!r.ok) throw new Error(data.error || "Erreur API");
      addMessage("Assistant", (data.reply && data.reply.text) ? data.reply.text : "…");
    }catch(e){
      addMessage("Assistant", "Désolé, problème technique. (" + e.message + ")");
    }
  }

  if(btn) btn.addEventListener("click", sendMessage);
  if(input) input.addEventListener("keydown", function(e){ if(e.key === "Enter") sendMessage(); });
})();`);
});

/* ================================
   ODOO SCRIPT: /lr-auth.js
   (Login page: send magic link)
================================= */
var st = document.getElementById("lr-auth-status");
if(st) st.textContent = "État script : ✅ chargé";

app.get("/lr-auth.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.send(`(function(){
  var API = "${APP_BASE_URL}";
  function byId(id){ return document.getElementById(id); }
  var emailEl = byId("lr-email");
  var slugEl  = byId("lr-slug");
  var btnEl   = byId("lr-send-link");
  var msgEl   = byId("lr-msg");

  function setMsg(text, ok){
    if(!msgEl) return;
    msgEl.style.display = "block";
    msgEl.style.borderColor = ok ? "#A7F3D0" : "#FECACA";
    msgEl.style.background  = ok ? "#ECFDF5" : "#FEF2F2";
    msgEl.style.color       = ok ? "#065F46" : "#7F1D1D";
    msgEl.textContent = text;
  }

  async function sendLink(){
    var email = (emailEl && emailEl.value || "").trim().toLowerCase();
    var slug  = (slugEl && slugEl.value || "").trim().toLowerCase();

    if(!email || email.indexOf("@") === -1) return setMsg("❌ Email invalide", false);
    if(!slug) return setMsg("❌ Slug requis (ex: atelier-roma)", false);

    btnEl.disabled = true;
    btnEl.style.opacity = "0.7";
    btnEl.textContent = "⏳ Envoi…";

    try{
      var r = await fetch(API + "/auth/send-link", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ email: email, slug: slug })
      });
      var data = await r.json().catch(function(){ return {}; });

      if(!r.ok) throw new Error(data.error || ("HTTP " + r.status));

      // Si Resend bloque, le backend renvoie verify_url (fallback)
      if(data.verify_url){
        setMsg("⚠️ Email bloqué en test. Ouvre ce lien pour te connecter : " + data.verify_url, true);
        return;
      }

      setMsg("✅ Lien envoyé. Vérifie tes emails (valide 15 min).", true);
    }catch(e){
      setMsg("❌ " + e.message, false);
    }finally{
      btnEl.disabled = false;
      btnEl.style.opacity = "1";
      btnEl.textContent = "📩 Envoyer un lien de connexion";
    }
  }

  if(btnEl) btnEl.addEventListener("click", sendLink);

  // stop Odoo editor hotkeys
  [emailEl, slugEl].forEach(function(el){
    if(!el) return;
    ["keydown","keyup","keypress","input","click","mousedown"].forEach(function(ev){
      el.addEventListener(ev, function(e){ e.stopPropagation(); }, true);
    });
  });
})();`);
});

/* ================================
   ODOO SCRIPT: /lr-dashboard.js
   (Dashboard page: check session + load business)
================================= */
app.get("/lr-dashboard.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.send(`(function(){
  var API = "${APP_BASE_URL}";
  function byId(id){ return document.getElementById(id); }
  var box = byId("lr-dash");
  var msg = byId("lr-dash-msg");
  var btnLogout = byId("lr-logout");

  function setMsg(t){
    if(!msg) return;
    msg.textContent = t;
  }

  async function load(){
    try{
      var r = await fetch(API + "/me", { method:"GET", credentials:"include" });
      var data = await r.json().catch(function(){ return {}; });

      if(!r.ok) {
        // not logged in -> show link to /login
        setMsg("🔒 Non connecté. Va sur /login pour recevoir ton lien.");
        return;
      }

      var b = data.business || {};
      byId("lr-biz-name").textContent = b.name || "—";
      byId("lr-biz-slug").textContent = b.slug || "—";
      byId("lr-biz-email").textContent = b.owner_email || "—";

      // lien public
      var pub = (window.location.origin || "") + "/business?slug=" + encodeURIComponent(b.slug || "");
      var a = byId("lr-public-link");
      a.href = pub;
      a.textContent = pub;

      setMsg("✅ Connecté");
    }catch(e){
      setMsg("❌ Erreur: " + e.message);
    }
  }

  async function logout(){
    try{
      await fetch(API + "/auth/logout", { method:"POST", credentials:"include" });
    }catch(e){}
    window.location.href = "/login";
  }

  if(btnLogout) btnLogout.addEventListener("click", logout);

  load();
})();`);
});

/* ================================
   START
================================= */
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`AI engine running on ${PORT}`);
});