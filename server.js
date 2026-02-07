const express = require("express");
const cors = require("cors");

// OpenAI SDK (compatible CommonJS)
let OpenAI = require("openai");
OpenAI = OpenAI.default || OpenAI;

const app = express();
app.use(cors());
app.use(express.json());

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

function safeLower(s) {
  return String(s || "").toLowerCase();
}

function listServicesText(kb) {
  if (!kb || !Array.isArray(kb.services) || kb.services.length === 0) return "Je n’ai pas encore la liste des services.";
  return kb.services
    .map((s) => {
      const price = s.price_chf != null ? `${s.price_chf} CHF` : "prix sur demande";
      const dur = s.duration_min != null ? `${s.duration_min} min` : "";
      return `${s.name}${dur ? ` (${dur})` : ""} — ${price}`;
    })
    .join(" | ");
}

function findServiceByName(kb, message) {
  if (!kb || !Array.isArray(kb.services)) return null;
  const m = safeLower(message);
  return kb.services.find((s) => safeLower(s.name) && m.includes(safeLower(s.name)));
}

function findFaqAnswer(kb, message) {
  if (!kb || !Array.isArray(kb.faq)) return null;
  const m = safeLower(message);
  for (const item of kb.faq) {
    const q = safeLower(item.q);
    if (!q) continue;

    if (q.includes("twint") && m.includes("twint")) return item.a;
    if ((q.includes("rendez") || q.includes("rdv")) && (m.includes("rendez") || m.includes("rdv"))) return item.a;
  }
  return null;
}

async function llmFallbackReply({ message, kb, businessName }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return "Je n’arrive pas à accéder au moteur IA pour le moment (clé API manquante).";
  }

  const client = new OpenAI({ apiKey });

  // On force l’IA à s’appuyer sur le KB, et à dire “je ne sais pas” si absent.
  const instructions = `
Tu es l'assistant de ${businessName}. Réponds en français.
Règles STRICTES :
- Tu dois te baser UNIQUEMENT sur les informations dans le JSON (KB) fourni.
- Si l’info n’est pas dans le KB, dis clairement que tu ne sais pas et propose de laisser un message / demander au personnel.
- Ne devine pas de prix, horaires, adresses, services.
- Réponse courte, claire, ton pro et chaleureux.
  `.trim();

  const input = `
Question client: ${message}

KB JSON:
${JSON.stringify(kb || {}, null, 2)}
  `.trim();

  // Responses API (recommandée)  [oai_citation:1‡GitHub](https://github.com/openai/openai-node?utm_source=chatgpt.com)
  const resp = await client.responses.create({
    model: "gpt-5.2",
    instructions,
    input,
  });

  return resp.output_text?.trim() || "Je n’ai pas pu générer une réponse pour le moment.";
}

app.post("/chat", async (req, res) => {
  try {
    const { business_slug, session_id, message, kb } = req.body || {};
    if (!business_slug || !message) {
      return res.status(400).json({ error: "business_slug et message sont requis." });
    }

    const fallback = FALLBACK_BUSINESSES[business_slug];
    const effectiveKB = kb || (fallback ? fallback.kb : null);

    const businessName =
      (effectiveKB && effectiveKB.business && effectiveKB.business.name) ||
      (fallback && fallback.name) ||
      "ce business";

    const businessType =
      (effectiveKB && effectiveKB.business && effectiveKB.business.business_type) ||
      (fallback && fallback.business_type) ||
      "unknown";

    const m = safeLower(message);

    // 1) FAQ “safe”
    const faqAnswer = findFaqAnswer(effectiveKB, message);
    if (faqAnswer) {
      return res.json({ session_id: session_id || null, reply: { text: faqAnswer } });
    }

    // 2) Horaires “safe”
    if (m.includes("horaire") || m.includes("ouvert") || m.includes("ferme") || m.includes("fermé")) {
      const text = effectiveKB?.hours_text || "Je n’ai pas les horaires pour le moment.";
      return res.json({ session_id: session_id || null, reply: { text } });
    }

    // 3) Services/prix “safe”
    if (m.includes("service") || m.includes("prestations") || m.includes("proposez") || m.includes("prix") || m.includes("combien")) {
      const svc = findServiceByName(effectiveKB, message);
      if (svc) {
        const price = svc.price_chf != null ? `${svc.price_chf} CHF` : "prix sur demande";
        return res.json({ session_id: session_id || null, reply: { text: `${svc.name} : ${price}.` } });
      }
      return res.json({ session_id: session_id || null, reply: { text: `Voici les services : ${listServicesText(effectiveKB)}` } });
    }

    // 4) Booking “safe” (V1)
    if (m.includes("rdv") || m.includes("rendez") || m.includes("réserver") || m.includes("reservation") || m.includes("réservation")) {
      let text = "Ok 🙂 Peux-tu me donner la date, l’heure, et ce que tu souhaites faire ?";
      if (businessType === "hair_salon") text = "Ok 🙂 Pour quel service ? (ex: Coupe homme, Barbe, Coupe + barbe)";
      if (businessType === "restaurant") text = "Ok 🙂 Pour combien de personnes et à quelle heure ?";
      return res.json({ session_id: session_id || null, reply: { text } });
    }

    // 5) Fallback OpenAI (pour le reste)
    const text = await llmFallbackReply({ message, kb: effectiveKB, businessName });
    return res.json({ session_id: session_id || null, reply: { text } });

  } catch (e) {
    return res.status(500).json({ error: "Erreur serveur", details: String(e) });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`AI engine running on http://localhost:${PORT}`));