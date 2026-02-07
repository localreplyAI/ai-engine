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
      services: [
        { name: "Coupe homme", price_chf: 35 },
        { name: "Barbe", price_chf: 25 },
        { name: "Coupe + barbe", price_chf: 55 }
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

/* ================================
   DATE PARSER (CODE > IA)
================================= */
function parseDateFromText(text) {
  if (!text) return null;

  const months = {
    "janvier": 1, "février": 2, "fevrier": 2, "mars": 3,
    "avril": 4, "mai": 5, "juin": 6, "juillet": 7,
    "août": 8, "aout": 8, "septembre": 9,
    "octobre": 10, "novembre": 11,
    "décembre": 12, "decembre": 12
  };

  const m = text.toLowerCase();
  const match = m.match(/(\d{1,2})\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)/);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = months[match[2]];

  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(year, month - 1, day);
  if (candidate < now) year += 1;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/* ================================
   OPENAI ANALYSIS (INTENT ONLY)
================================= */
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
      input: prompt
    });

    return JSON.parse(resp.output_text || "{}");
  } catch {
    return { intent: "other" };
  }
}

/* ================================
   CHAT ENDPOINT
================================= */
app.post("/chat", async (req, res) => {
  const { business_slug, session_id, message, kb } = req.body;

  const sid = session_id || "anon";
  SESSIONS[sid] = SESSIONS[sid] || {
    service: null,
    date: null,
    time: null,
    in_booking: false
  };
  const state = SESSIONS[sid];

  const business = FALLBACK_BUSINESSES[business_slug];
  const services = kb?.services || business.kb.services;

  /* ===== INTENT ===== */
  const analysis = await analyzeIntent(message);

  if (analysis.intent === "booking" || state.in_booking) {
    state.in_booking = true;
  }

  /* ===== SERVICE ===== */
  if (!state.service) {
    const svc = services.find(s =>
      safeLower(message).includes(safeLower(s.name))
    );
    if (svc) state.service = svc.name;
  }

  /* ===== DATE (CODE FIRST) ===== */
  if (!state.date) {
    const parsedDate = parseDateFromText(message);
    if (parsedDate) state.date = parsedDate;
  }

  /* ===== TIME ===== */
  if (!state.time) {
    const match = message.match(/(\d{1,2})h(\d{2})?/);
    if (match) {
      state.time = `${match[1].padStart(2, "0")}:${match[2] || "00"}`;
    }
  }

  /* ===== FLOW ===== */
  if (!state.service) {
    return res.json({ reply: { text: "Quel service souhaitez-vous réserver ?" } });
  }

  if (!state.date) {
    return res.json({ reply: { text: "Pour quelle date souhaitez-vous le rendez-vous ?" } });
  }

  if (!state.time) {
    return res.json({ reply: { text: "À quelle heure souhaitez-vous le rendez-vous ?" } });
  }

  return res.json({
    reply: {
      text: `Parfait 👍 Je récapitule : ${state.service} le ${state.date} à ${state.time}. Souhaitez-vous confirmer ?`
    }
  });
});

/* ================================
   START
================================= */
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`AI engine running on ${PORT}`);
});