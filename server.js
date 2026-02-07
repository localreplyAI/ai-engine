const express = require("express");
const cors = require("cors");

let OpenAI = require("openai");
OpenAI = OpenAI.default || OpenAI;

const app = express();
app.use(cors());
app.use(express.json());

/* ================================
   SESSION MEMORY
================================= */
const SESSIONS = {};

/* ================================
   FALLBACK BUSINESS
   (si pas de KB / ou pas d’email fourni)
================================= */
const FALLBACK_BUSINESSES = {
  "atelier-roma": {
    name: "Atelier Roma",
    business_type: "hair_salon",
    contact_email: "ton-email-business@exemple.com", // <-- CHANGE ICI (email du business)
    kb: {
      business: {
        name: "Atelier Roma",
        business_type: "hair_salon",
        timezone: "Europe/Zurich",
      },
      services: [
        { name: "Coupe homme", price_chf: 35 },
        { name: "Barbe", price_chf: 25 },
        { name: "Coupe + barbe", price_chf: 55 },
      ],
    },
  },
};

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
================================= */
async function sendBookingEmail({ to, businessName, booking }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Missing RESEND_API_KEY on server");

  // Pour commencer, Resend fournit un domaine de test : onboarding@resend.dev
  // Plus tard, tu mettras ton domaine (ex: no-reply@localreply.ai)
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

  // Si déjà YYYY-MM-DD
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

    // Business & KB
    const fallback = FALLBACK_BUSINESSES[business_slug];
    const effectiveKB = kb || (fallback ? fallback.kb : null);

    const businessName =
      effectiveKB?.business?.name ||
      fallback?.name ||
      "ce business";

    const services = effectiveKB?.services || fallback?.kb?.services || [];
    const businessEmail =
      effectiveKB?.business?.contact_email || // si tu veux l’ajouter plus tard dans le KB
      fallback?.contact_email ||
      null;

    // Intent
    const intentRes = await analyzeIntent(message);
    if (intentRes.intent === "booking" || state.in_booking) {
      state.in_booking = true;
    }

    // Si pas en booking, réponse simple
    if (!state.in_booking) {
      return res.json({
        session_id: sid,
        reply: { text: `Bienvenue chez ${businessName}. Comment puis-je vous aider ?` },
      });
    }

    // Remplir les champs (code > IA)
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

    // Si tout est rempli, proposer confirmation
    if (state.service && state.date && state.time) {
      // Si l'utilisateur confirme -> envoi email + reset
      if (isConfirmation(message)) {
        if (!businessEmail) {
          // Pas d’email configuré => on ne bloque pas, mais on informe
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

        delete SESSIONS[sid]; // reset session

        return res.json({
          session_id: sid,
          reply: {
            text: "Merci 🙏 Votre demande a bien été transmise. L’équipe vous recontactera rapidement.",
          },
        });
      }

      return res.json({
        session_id: sid,
        reply: {
          text: `Parfait 👍 Je récapitule : ${state.service} le ${state.date} à ${state.time}. Souhaitez-vous confirmer ?`,
        },
      });
    }

    // Sinon, demander ce qui manque
    if (!state.service) {
      const list = services.length ? services.map((s) => s.name).join(" | ") : null;
      return res.json({
        session_id: sid,
        reply: {
          text: list
            ? `Quel service souhaitez-vous réserver ? (${list})`
            : "Quel service souhaitez-vous réserver ?",
        },
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
   START
================================= */
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`AI engine running on ${PORT}`);
});