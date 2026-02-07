const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Base de fallback (si aucun KB n'est fourni par la page Odoo)
 * -> utile pour tests / si une page oublie d'envoyer le KB.
 */
const FALLBACK_BUSINESSES = {
  "atelier-roma": {
    name: "Atelier Roma",
    business_type: "hair_salon",
    kb: {
      business: {
        name: "Atelier Roma",
        business_type: "hair_salon",
        timezone: "Europe/Zurich",
      },
      hours_text: "Lun-Ven 09:00-18:00, Sam 09:00-16:00",
      services: [
        { id: "svc_1", name: "Coupe homme", duration_min: 30, price_chf: 35 },
        { id: "svc_2", name: "Barbe", duration_min: 20, price_chf: 25 },
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

function findFaqAnswer(kb, message) {
  if (!kb || !Array.isArray(kb.faq)) return null;
  const m = safeLower(message);
  // matching simple : si la question contient un mot clé présent dans le message
  // (on fera mieux plus tard, mais ça suffit V1)
  for (const item of kb.faq) {
    const q = safeLower(item.q);
    if (!q) continue;

    // Heuristique simple : si le message contient un mot clé important de la question
    // Ex: "twint" / "rendez-vous" / "rdv"
    if (q.includes("twint") && m.includes("twint")) return item.a;
    if ((q.includes("rendez") || q.includes("rdv")) && (m.includes("rendez") || m.includes("rdv"))) return item.a;
  }
  return null;
}

function listServicesText(kb) {
  if (!kb || !Array.isArray(kb.services) || kb.services.length === 0) return "Je n’ai pas encore la liste des services.";
  return kb.services
    .map((s) => {
      const price = (s.price_chf !== undefined && s.price_chf !== null) ? `${s.price_chf} CHF` : "prix sur demande";
      const dur = (s.duration_min !== undefined && s.duration_min !== null) ? `${s.duration_min} min` : "";
      return `${s.name}${dur ? ` (${dur})` : ""} — ${price}`;
    })
    .join(" | ");
}

function findServiceByName(kb, message) {
  if (!kb || !Array.isArray(kb.services)) return null;
  const m = safeLower(message);
  return kb.services.find((s) => safeLower(s.name) && m.includes(safeLower(s.name)));
}

app.post("/chat", async (req, res) => {
  try {
    const { business_slug, session_id, message, kb } = req.body || {};

    if (!business_slug || !message) {
      return res.status(400).json({ error: "business_slug et message sont requis." });
    }

    // 1) Business fallback
    const fallback = FALLBACK_BUSINESSES[business_slug];

    // 2) KB à utiliser : priorité au KB envoyé depuis Odoo
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

    // Réponse par défaut
    let reply = `Bienvenue chez ${businessName}. Comment je peux t’aider ?`;

    // 1) FAQ simple
    const faqAnswer = findFaqAnswer(effectiveKB, message);
    if (faqAnswer) {
      reply = faqAnswer;
      return res.json({ session_id: session_id || null, reply: { text: reply } });
    }

    // 2) Horaires
    if (m.includes("horaire") || m.includes("ouvert") || m.includes("ferme") || m.includes("fermé")) {
      if (effectiveKB && effectiveKB.hours_text) {
        reply = effectiveKB.hours_text;
      } else {
        reply = "Je n’ai pas les horaires pour le moment.";
      }
      return res.json({ session_id: session_id || null, reply: { text: reply } });
    }

    // 3) Services / prix
    if (
      m.includes("service") ||
      m.includes("prestations") ||
      m.includes("proposez") ||
      m.includes("prix") ||
      m.includes("combien")
    ) {
      // Si la question vise un service précis (ex "prix coupe homme")
      const svc = findServiceByName(effectiveKB, message);
      if (svc) {
        const price = (svc.price_chf !== undefined && svc.price_chf !== null) ? `${svc.price_chf} CHF` : "prix sur demande";
        reply = `${svc.name} : ${price}.`;
      } else {
        reply = `Voici les services : ${listServicesText(effectiveKB)}`;
      }
      return res.json({ session_id: session_id || null, reply: { text: reply } });
    }

    // 4) Booking: réponse selon type (très simple V1)
    if (m.includes("rdv") || m.includes("rendez") || m.includes("réserver") || m.includes("reservation") || m.includes("réservation")) {
      if (businessType === "hair_salon") {
        reply = "Ok 🙂 Pour quel service ? (ex: Coupe homme, Barbe, Coupe + barbe)";
      } else if (businessType === "restaurant") {
        reply = "Ok 🙂 Pour combien de personnes et à quelle heure ?";
      } else {
        reply = "Ok 🙂 Peux-tu me donner la date, l’heure, et ce que tu souhaites faire ?";
      }
      return res.json({ session_id: session_id || null, reply: { text: reply } });
    }

    // Sinon: fallback général
    return res.json({
      session_id: session_id || null,
      reply: { text: reply },
    });

  } catch (e) {
    return res.status(500).json({ error: "Erreur serveur", details: String(e) });
  }
});

// Render fournit PORT automatiquement
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`AI engine running on http://localhost:${PORT}`));