const express = require("express");
const cors = require("cors");

let OpenAI = require("openai");
OpenAI = OpenAI.default || OpenAI;

const app = express();
app.use(cors());
app.use(express.json());

/* ================================
   SESSION MEMORY (in-memory V1)
================================= */
const SESSIONS = {};

/* ================================
   FALLBACK BUSINESS (sécurité)
================================= */
const FALLBACK_BUSINESSES = {
  "atelier-roma": {
    name: "Atelier Roma",
    business_type: "hair_salon",
    kb: {
      business: {
        name: "Atelier Roma",
        business_type: "hair_salon",
        timezone: "Europe/Zurich"
      },
      hours_text: "Lun-Ven 09:00-18:00, Sam 09:00-16:00",
      services: [
        { id: "svc_1", name: "Coupe homme", duration_min: 30, price_chf: 35 },
        { id: "svc_2", name: "Barbe", duration_min: 20, price_chf: 25 },
        { id: "svc_3", name: "Coupe + barbe", duration_min: 50, price_chf: 55 }
      ],
      faq: [
        { q: "Acceptez-vous Twint ?", a: "Oui, Twint est accepté." },
        { q: "Faites-vous sans rendez-vous ?", a: "Non, uniquement sur rendez-vous." }
      ]
    }
  }
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* ================================
   UTILS
================================= */
function safeLower(s) {
  return String(s || "").toLowerCase();
}

function findServiceByName(kb, serviceName) {
  if (!kb || !Array.isArray(kb.services) || !serviceName) return null;
  return kb.services.find(
    s => safeLower(s.name) === safeLower(serviceName)
  );
}

function listServicesText(kb) {
  if (!kb?.services?.length) return "Je n’ai pas encore la liste des services.";
  return kb.services
    .map(s => `${s.name} (${s.price_chf} CHF)`)
    .join(" | ");
}

/* ================================
   DATE NORMALIZATION
================================= */
function normalizeDate(dateStr) {
  if (!dateStr) return null;

  // déjà normalisée
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }

  const months = {
    "janvier": 1,
    "février": 2,
    "fevrier": 2,
    "mars": 3,
    "avril": 4,
    "mai": 5,
    "juin": 6,
    "juillet": 7,
    "août": 8,
    "aout": 8,
    "septembre": 9,
    "octobre": 10,
    "novembre": 11,
    "décembre": 12,
    "decembre": 12
  };

  const m = dateStr.toLowerCase().trim();
  const match = m.match(/^(\d{1,2})\s+([a-zéû]+)/);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = months[match[2]];
  if (!month) return null;

  const now = new Date();
  let year = now.getFullYear();

  const candidate = new Date(year, month - 1, day);
  if (candidate < now) {
    year += 1;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/* ================================
   OPENAI ANALYZER (JSON STRICT)
================================= */
async function analyzeMessage({ message, kb }) {
  try {
    const prompt = `
Tu es un analyseur. Tu dois retourner UNIQUEMENT un JSON valide.
Aucun texte, aucun commentaire.

Règles :
- N’invente rien.
- Si une info est absente ou ambiguë → null.
- Date: YYYY-MM-DD
- Heure: HH:MM (24h)
- intent = "booking" | "faq" | "other"

Services disponibles :
${(kb?.services || []).map(s => `- ${s.name}`).join("\n")}

Message client :
"${message}"

JSON attendu :
{
  "intent": "booking|faq|other",
  "service_name": string|null,
  "date": string|null,
  "time": string|null,
  "party_size": number|null
}
`.trim();

    const resp = await client.responses.create({
      model: "gpt-5.2",
      input: prompt
    });

    const text = resp.output_text || "{}";
    return JSON.parse(text);

  } catch (e) {
    console.error("Analyze error:", e);
    return {
      intent: "other",
      service_name: null,
      date: null,
      time: null,
      party_size: null
    };
  }
}

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

    // Init session
    SESSIONS[sid] = SESSIONS[sid] || {
      service_name: null,
      date: null,
      time: null
    };
    const state = SESSIONS[sid];

    const fallback = FALLBACK_BUSINESSES[business_slug];
    const effectiveKB = kb || (fallback ? fallback.kb : null);

    const businessName =
      effectiveKB?.business?.name ||
      fallback?.name ||
      "ce business";

    /* ===== Analyse OpenAI ===== */
    const analysis = await analyzeMessage({ message, kb: effectiveKB });
    console.log("ANALYSIS:", analysis);

    // Merge dans l’état (jamais écraser par null)
    if (analysis.service_name) state.service_name = analysis.service_name;
    if (analysis.date) {
      const normalized = normalizeDate(analysis.date);
      if (normalized) state.date = normalized;
    }
    if (analysis.time) state.time = analysis.time;

    /* ===== BOOKING STATE MACHINE (HAIR SALON V1) ===== */
    if (analysis.intent === "booking") {

      if (!state.service_name) {
        return res.json({
          session_id: sid,
          reply: { text: "Quel service souhaitez-vous réserver ?" }
        });
      }

      const service = findServiceByName(effectiveKB, state.service_name);
      if (!service) {
        state.service_name = null;
        return res.json({
          session_id: sid,
          reply: {
            text: `Je n’ai pas trouvé ce service. Voici ceux disponibles : ${listServicesText(effectiveKB)}`
          }
        });
      }

      if (!state.date) {
        return res.json({
          session_id: sid,
          reply: { text: "Pour quelle date souhaitez-vous le rendez-vous ?" }
        });
      }

      if (!state.time) {
        return res.json({
          session_id: sid,
          reply: { text: "À quelle heure souhaitez-vous le rendez-vous ?" }
        });
      }

      // Confirmation
      return res.json({
        session_id: sid,
        reply: {
          text: `Parfait 👍 Je récapitule : ${service.name} le ${state.date} à ${state.time}. Souhaitez-vous confirmer ?`
        }
      });
    }

    /* ===== FALLBACK ===== */
    return res.json({
      session_id: sid,
      reply: { text: `Bienvenue chez ${businessName}. Comment puis-je vous aider ?` }
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ================================
   START SERVER
================================= */
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`AI engine running on http://localhost:${PORT}`);
});