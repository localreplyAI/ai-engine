/**
 * LocalReply AI Engine — server.js (Step B - fixed)
 * - Serves static JS from /public (lr-auth.js, etc.)
 * - POST /chat                    -> chat + booking flow
 * - GET  /business/:slug          -> public business data
 * - POST /business/upsert (ADMIN) -> create/update a business
 *
 * Requires:
 *   npm i express cors openai pg
 *
 * Render ENV vars:
 *   OPENAI_API_KEY=...
 *   DATABASE_URL=... (Neon/Supabase Postgres)
 *   ADMIN_TOKEN=...  (long random)
 *   RESEND_API_KEY=... (optional, only if you want email sending)
 *
 * 🔧 PATCH AUTH ENV:
 *   APP_BASE_URL=https://ai-engine-zcer.onrender.com
 *   ODOO_BASE_URL=https://TON-DOMAINE-ODOO (ex: https://localreply.ai)
 */

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

let OpenAI = require("openai");
OpenAI = OpenAI.default || OpenAI;

const app = express();
app.use(cors());
app.use(express.json());

/**
 * ✅ IMPORTANT
 * Sert tout ce qui est dans /public à la racine :
 * public/lr-auth.js -> https://<render>/lr-auth.js
 */
app.use(express.static("public"));

/* ================================
   🔧 PATCH AUTH — BASE URLS
================================= */
const APP_BASE_URL =
  (process.env.APP_BASE_URL || "https://ai-engine-zcer.onrender.com").replace(/\/$/, "");

const ODOO_BASE_URL =
  (process.env.ODOO_BASE_URL || "").replace(/\/$/, "");

/* ================================
   DB (Postgres)
================================= */
if (!process.env.DATABASE_URL) {
  console.warn("⚠️ Missing DATABASE_URL. The /business endpoints will fail until set.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ✅ Neon/Supabase/Render: souvent nécessaire
  ssl: { rejectUnauthorized: false },
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

initDb()
  .then(() => console.log("✅ DB ready"))
  .catch((e) => console.error("❌ DB init error:", e));

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
   EMAIL via RESEND (optional)
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

  const h = text.match(/\b(\d{1,2})h(\d{2})?\b/i);
  if (h) return `${String(h[1]).padStart(2, "0")}:${h[2] || "00"}`;

  const c = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (c) return `${String(c[1]).padStart(2, "0")}:${c[2]}`;

  return null;
}

/* ================================
   BUSINESS ENDPOINTS
================================= */
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
      map_url:
        row.map_url ||
        (row.address
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(row.address)}`
          : ""),
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

    const sid = session_id || "anon";
    SESSIONS[sid] = SESSIONS[sid] || {
      service: null,
      date: null,
      time: null,
      in_booking: false,
    };
    const state = SESSIONS[sid];

    const r = await pool.query(
      `SELECT name, business_type, contact_email, timezone, services
       FROM businesses
       WHERE slug = $1`,
      [business_slug]
    );
    const dbBusiness = r.rowCount ? r.rows[0] : null;

    const effectiveKB =
      kb ||
      (dbBusiness
        ? {
            business: {
              name: dbBusiness.name,
              business_type: dbBusiness.business_type || "local_business",
              timezone: dbBusiness.timezone || "Europe/Zurich",
            },
            services: Array.isArray(dbBusiness.services) ? dbBusiness.services : [],
          }
        : null);

    const businessName = effectiveKB?.business?.name || "ce business";
    const services = effectiveKB?.services || [];

    const businessEmail =
      effectiveKB?.business?.contact_email ||
      (dbBusiness && dbBusiness.contact_email ? dbBusiness.contact_email : null);

    const intentRes = await analyzeIntent(message);
    if (intentRes.intent === "booking" || state.in_booking) {
      state.in_booking = true;
    }

    if (!state.in_booking) {
      return res.json({
        session_id: sid,
        reply: { text: `Bienvenue chez ${businessName}. Comment puis-je vous aider ?` },
      });
    }

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
          booking: { service: state.service, date: state.date, time: state.time },
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
   AUTH (Magic link - MOCK v1) — PATCHED
================================= */

// (optionnel) Evite la confusion "Cannot GET" si tu ouvres l'URL dans un navigateur
app.get("/auth/send-link", (req, res) => {
  return res
    .status(405)
    .send("Use POST /auth/send-link with JSON: { email, slug }");
});

// Envoi du lien magique
app.post("/auth/send-link", async (req, res) => {
  const { email, slug } = req.body || {};

  if (!email || !slug) {
    return res.status(400).json({ error: "email et slug requis" });
  }

  console.log("🔐 Magic link demandé :", email, slug);

  // ✅ IMPORTANT: lien ABSOLU (sinon Odoo ouvre sur son propre domaine => 404)
  const verify_url =
    `${APP_BASE_URL}/auth/verify` +
    `?email=${encodeURIComponent(email)}` +
    `&slug=${encodeURIComponent(slug)}`;

  return res.json({
    ok: true,
    message: "Magic link généré (mock)",
    verify_url,
  });
});

// Vérification du lien magique
app.get("/auth/verify", async (req, res) => {
  const { email, slug } = req.query || {};

  if (!email || !slug) {
    return res.status(400).send("Lien invalide");
  }

  // ✅ Redirige vers Odoo (dashboard) si tu as configuré ODOO_BASE_URL
  if (ODOO_BASE_URL) {
    const to =
      `${ODOO_BASE_URL}/dashboard?slug=${encodeURIComponent(slug)}` +
      `&email=${encodeURIComponent(email)}`;
    return res.redirect(to);
  }

  // Fallback si ODOO_BASE_URL pas défini
  res.send(`
    <h2>✅ Connecté (mock)</h2>
    <p>Email : ${email}</p>
    <p>Business : ${slug}</p>
    <p>⚠️ Définis ODOO_BASE_URL pour rediriger automatiquement vers ton dashboard Odoo.</p>
  `);
});

// Session courante (mock)
app.get("/me", async (req, res) => {
  return res.status(401).json({ error: "Non connecté (mock)" });
});

// Déconnexion
app.post("/auth/logout", async (req, res) => {
  return res.json({ ok: true });
});

/* ================================
   START
================================= */
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`AI engine running on ${PORT}`);
});