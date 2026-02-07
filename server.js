const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Mini "base" de business (V0 : hardcodé pour tester)
const BUSINESSES = {
  "atelier-roma": {
    business_type: "hair_salon",
    name: "Atelier Roma",
    kb: {
      services: [
        { id: "svc_1", name: "Coupe homme", duration_min: 30, price_chf: 35 },
        { id: "svc_2", name: "Barbe", duration_min: 20, price_chf: 25 },
      ],
      faq: [
        { q: "Acceptez-vous Twint ?", a: "Oui, Twint est accepté." },
        { q: "Faites-vous sans rendez-vous ?", a: "Non, uniquement sur rendez-vous." },
      ],
      hours_text: "Lun-Ven 09:00-18:00, Sam 09:00-16:00"
    }
  }
};

// Endpoint principal
app.post("/chat", async (req, res) => {
  try {
    const { business_slug, session_id, message } = req.body || {};
    if (!business_slug || !message) {
      return res.status(400).json({ error: "business_slug et message sont requis." });
    }

    const biz = BUSINESSES[business_slug];
    if (!biz) {
      return res.status(404).json({ error: "Business inconnu." });
    }

    // V0 : réponse simple (sans OpenAI)
    // But: valider que Odoo -> serveur -> Odoo marche.
    let reply = `Bienvenue chez ${biz.name}. Tu peux me dire ce que tu veux ?`;

    // Mini logique selon type
    const m = message.toLowerCase();
    if (m.includes("twint")) reply = "Oui, Twint est accepté.";
    else if (m.includes("horaire") || m.includes("ouvert")) reply = biz.kb.hours_text;
    else if (m.includes("prix") || m.includes("combien")) reply = `Services: ${biz.kb.services.map(s => `${s.name} (${s.price_chf} CHF)`).join(", ")}.`;
    else if (m.includes("rdv") || m.includes("rendez")) reply = "Ok. Pour quel service ? (Coupe homme / Barbe)";

    return res.json({
      session_id: session_id || null,
      reply: { text: reply }
    });
  } catch (e) {
    return res.status(500).json({ error: "Erreur serveur", details: String(e) });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`AI engine running on http://localhost:${PORT}`));