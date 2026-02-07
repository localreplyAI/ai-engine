const express = require("express");
const cors = require("cors");

let OpenAI = require("openai");
OpenAI = OpenAI.default || OpenAI;

const app = express();
app.use(cors());
app.use(express.json());

/* ================================
   FALLBACK BUSINESS (sécurité)
================================= */
const FALLBACK_BUSINESSES = {
  "atelier-roma": {
    name: "Atelier Roma",
    business_type: "hair_salon",
    kb: {
      business: { name: "Atelier Roma", business_type: "hair_salon", timezone: "Europe/Zurich" },
      hours_text: "Lun-Ven 09:00-18:00, Sam 09:00-16:00",
      services: [
        { id: "svc_1", name: "Coupe homme", duration_min: 30, price_chf: 35 },
        { id: "svc_2", name: "Barbe", duration_min: 20, price_chf: 25 },
        { id: "svc_3", name: "Coupe + barbe", duration_min: 50, price_chf: 55 },
      ],
      faq: [
        { q: "Acceptez-vous Twint ?", a: "Oui, Twint est accepté." },
        { q: "Faites-vous sans rendez-vous ?", a: "Non, uniquement sur rendez-vous." },
      ],
    },
  },
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function safeLower(s) {
  return String(s || "").toLowerCase();
}

/* ================================
   ANALYSE OPENAI (JSON STRICT)
================================= */
async function analyzeMessage({ message, kb }) {
  try {
    const prompt = `
Tu es un analyseur. Tu dois retourner UNIQUEMENT un JSON valide.
Aucune phrase, aucun commentaire.

Règles :
- N’invente rien.
- Si une info n’est pas claire, mets null.
- La date doit être YYYY-MM-DD si identifiable.
- L’heure doit être HH:MM (24h) si identifiable.
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
      input: prompt,
    });

    const text = resp.output_text || "{}";
    return JSON.parse(text);
  } catch (e) {
    console.error("Analyze error:", e);
    return { intent: "other", service_name: null, date: null, time: null, party_size: null };
  }
}

/* ================================
   UTILS
================================= */
function findServiceByName(kb, serviceName) {
  if (!kb || !Array.isArray(kb.services) || !serviceName) return null;
  return kb.services.find(s => safeLower(s.name) === safeLower(serviceName));
}

function listServicesText(kb) {
  if (!kb?.services?.length) return "Je n’ai pas encore la liste des services.";
  return kb.services.map(s => `${s.name} (${s.price_chf} CHF)`).join(" | ");
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

    const fallback = FALLBACK_BUSINESSES[business_slug];
    const effectiveKB = kb || (fallback ? fallback.kb : null);

    const businessName =
      effectiveKB?.business?.name || fallback?.name || "ce business";

    /* ===== Analyse OpenAI ===== */
    const analysis = await analyzeMessage({ message, kb: effectiveKB });
    console.log("ANALYSIS:", analysis); // <-- volontaire (debug pédagogique)

    /* ===== BOOKING INTELLIGENT (V1) ===== */
    if (analysis.intent === "booking") {
      if (!analysis.service_name) {
        return res.json({
          session_id,
          reply: { text: "Quel service souhaitez-vous réserver ?" }
        });
      }

      const service = findServiceByName(effectiveKB, analysis.service_name);
      if (!service) {
        return res.json({
          session_id,
          reply: { text: `Je n’ai pas trouvé ce service. Voici ceux disponibles : ${listServicesText(effectiveKB)}` }
        });
      }

      if (!analysis.date) {
        return res.json({
          session_id,
          reply: { text: "Pour quelle date souhaitez-vous le rendez-vous ?" }
        });
      }

      if (!analysis.time) {
        return res.json({
          session_id,
          reply: { text: "À quelle heure souhaitez-vous le rendez-vous ?" }
        });
      }

      // Tout est compris → confirmation (pas encore de calendrier)
      return res.json({
        session_id,
        reply: {
          text: `Parfait 👍 Je récapitule : ${service.name} le ${analysis.date} à ${analysis.time}. Souhaitez-vous confirmer ?`
        }
      });
    }

    /* ===== FALLBACK SAFE (OpenAI déjà filtré avant) ===== */
    return res.json({
      session_id,
      reply: { text: `Bienvenue chez ${businessName}. Comment puis-je vous aider ?` }
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`AI engine running on http://localhost:${PORT}`));