import { GoogleGenerativeAI } from "@google/generative-ai";
import { google } from "googleapis";
import { readFileSync, existsSync } from "fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const { ADZUNA_APP_ID, ADZUNA_APP_KEY, GEMINI_API_KEY, GOOGLE_SERVICE_ACCOUNT_KEY, TRACKER_SHEET_ID } = process.env;
const SUGGESTIONS_INTL_TAB = process.env.SUGGESTIONS_INTL_TAB || "Suggestions-Intl";

const COUNTRIES = ["fr", "ch", "sg"];
const KEYWORDS = ["cybersecurity graduate programme", "cybersecurity", "IT security", "SOC analyst"];

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const scoringModel = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });

const PROFILE = `Candidat : James Marville
Poste visé : Ingénieur / Analyste Cybersécurité Opérationnelle, ou Graduate Programme IT/Cyber
Stack : Splunk SIEM, HarfangLab EDR, CyberArk PAM, Check Point, Fortinet, AD, Python, Bash, Linux
Niveau : 0-4 ans d'expérience, profil junior à confirmé
Langue : Français natif, Anglais technique B1`;

async function fetchAdzuna(country, keyword) {
  const offers = [];
  for (let page = 1; page <= 2; page++) {
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`);
    url.searchParams.set("app_id", ADZUNA_APP_ID);
    url.searchParams.set("app_key", ADZUNA_APP_KEY);
    url.searchParams.set("results_per_page", "20");
    url.searchParams.set("what", keyword);
    try {
      const r = await fetch(url.toString(), { headers: { Accept: "application/json" } });
      if (!r.ok) { console.warn(`  ⚠️  Adzuna ${country} HTTP ${r.status}`); continue; }
      const data = await r.json();
      for (const o of data.results || []) {
        offers.push({
          title: (o.title || "").trim(),
          company: (o.company?.display_name || "Non précisé").trim(),
          location: (o.location?.display_name || country).trim(),
          country,
          url: o.redirect_url || "",
          snippet: (o.description || "").replace(/<[^>]+>/g, "").slice(0, 400),
        });
      }
    } catch (e) { console.warn(`  ⚠️  ${country} "${keyword}" : ${e.message}`); }
    await new Promise((r) => setTimeout(r, 400));
  }
  return offers;
}

async function scoreAndFilter(offers) {
  const results = [];
  for (let i = 0; i < offers.length; i += 10) {
    const batch = offers.slice(i, i + 10);
    const items = batch.map((o, idx) =>
      `OFFRE ${idx + 1} [${o.country.toUpperCase()}]: ${o.title} | ${o.company} | ${o.location} | ${o.snippet.slice(0, 200)}`
    ).join("\n");

    const prompt = `Profil candidat :\n${PROFILE}\n\n` +
      `Évalue ces ${batch.length} offres. Pour chacune, détermine si c'est un vrai match :\n` +
      `- Accepte les Graduate Programmes/Schemes cyber ou IT-avec-rotation-cyber\n` +
      `- Accepte les postes cyber classiques correspondant au profil\n` +
      `- Rejette : stage/alternance classique non labellisé "Graduate Programme", postes sans rapport avec la cybersécurité\n` +
      `Retourne UNIQUEMENT ce JSON : {"scores":[{"score":75,"is_graduate":true,"pros":["..."],"cons":["..."]}]}\n\n${items}`;

    try {
      const result = await scoringModel.generateContent(prompt);
      const raw = result.response.text().trim();
      let parsed;
      try { parsed = JSON.parse(raw); } catch {
        const m = raw.match(/\{[\s\S]*\}/) || raw.match(/\[[\s\S]*\]/);
        if (m) try { parsed = JSON.parse(m[0]); } catch {}
      }
      const scoresArray = Array.isArray(parsed) ? parsed : parsed?.scores;
      if (scoresArray?.length) {
        scoresArray.forEach((s, idx) => {
          if (!batch[idx]) return;
          results.push({ ...batch[idx], score: Number(s.score) || 0, isGraduate: !!s.is_graduate });
        });
      }
    } catch (e) { console.warn(`  ⚠️  Scoring erreur : ${e.message}`); }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return results;
}
function extractOfferId(url) {
  const m = url.match(/\/(?:details|land\/ad)\/(\d+)/);
  return m ? m[1] : url;
}


async function pushToSheet(offers, tab) {
  if (!GOOGLE_SERVICE_ACCOUNT_KEY || !TRACKER_SHEET_ID) return;
  const auth = new google.auth.GoogleAuth({ keyFile: GOOGLE_SERVICE_ACCOUNT_KEY, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const sheets = google.sheets({ version: "v4", auth });

  // Lit toute la colonne A pour connaître la VRAIE dernière ligne utilisée
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: TRACKER_SHEET_ID,
    range: `${tab}!A2:G500`,
  });
  const existingRows = existing.data.values || [];

  const seen = new Set(
    existingRows.map((r) => extractOfferId((r[6] || "").trim()))
  );

  const newRows = offers
    .filter((o) => !seen.has(extractOfferId(o.url)))
    .map((o) => [o.company, o.score, o.title, new Date().toISOString().slice(0, 10), "à trier", `${o.location} (${o.country.toUpperCase()})`, o.url]);  if (newRows.length === 0) {
    console.log(`📋  ${tab} : rien de nouveau.`);
    return;
  }

  // Repère les trous ET la vraie dernière ligne utilisée (pas de "trou" au-delà)
  let lastUsedIndex = -1;
  const emptyRowIndexes = [];
  existingRows.forEach((row, i) => {
    const isEmpty = !row || row.every((cell) => !cell || cell.trim() === "");
    if (isEmpty) { emptyRowIndexes.push(i); }
    else { lastUsedIndex = i; }
  });

  const remaining = [...newRows];
  let filled = 0;

  // 1. Comble les trous SITUÉS AVANT la dernière ligne réellement utilisée
  for (const idx of emptyRowIndexes) {
    if (idx > lastUsedIndex) continue; // ignore les "trous" après la fin réelle, ce sont juste des lignes non encore écrites
    if (remaining.length === 0) break;
    const rowNumber = idx + 2;
    const row = remaining.shift();
    await sheets.spreadsheets.values.update({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `${tab}!A${rowNumber}:G${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
    filled++;
  }

  // 2. Le surplus est écrit via update explicite, jamais via append
  if (remaining.length > 0) {
    const startRow = lastUsedIndex + 2 + 1; // +2 (offset Sheet), +1 (ligne suivante)
    const endRow = startRow + remaining.length - 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `${tab}!A${startRow}:G${endRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: remaining },
    });
  }

  console.log(`📋  ${tab} : ${filled} trou(s) comblé(s), ${remaining.length} ajoutée(s) juste après la dernière ligne utilisée (total ${newRows.length}).`);
}
async function main() {
  console.log("📡  Collecte Graduate/Cyber — FR/CH/SG...");
  let allOffers = [];
  for (const country of COUNTRIES) {
    for (const kw of KEYWORDS) {
      const offers = await fetchAdzuna(country, kw);
      allOffers.push(...offers);
      console.log(`  🌐  ${country.toUpperCase()} "${kw}" → ${offers.length} offres`);
    }
  }
  // Dédup par titre+entreprise avant scoring (évite de scorer 2x la même offre trouvée par 2 mots-clés)
  const uniqueMap = new Map();
  for (const o of allOffers) uniqueMap.set(`${o.company}|${o.title}`, o);
  allOffers = [...uniqueMap.values()];
  console.log(`  → ${allOffers.length} offres uniques\n`);

  console.log("🎯  Scoring...");
  const scored = await scoreAndFilter(allOffers);
  const relevant = scored.filter((o) => o.score >= 50);
  console.log(`  → ${relevant.length}/${scored.length} pertinentes\n`);

  await pushToSheet(relevant, SUGGESTIONS_INTL_TAB);
  await notifyTelegram(`✅ Veille Intl (FR/CH/SG) terminée : ${relevant.length} offres pertinentes trouvées.`);
}

async function notifyTelegram(message) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
  } catch (e) { console.warn("⚠️  Telegram notif échouée :", e.message); }
}

main().catch((err) => { console.error("❌  Erreur fatale :", err.message); process.exit(1); });
