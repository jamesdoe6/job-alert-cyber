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
const GRAD_SHEET_TAB = process.env.GRAD_SHEET_TAB || "Graduate-Programmes";

// Tous les pays couverts par Adzuna — élargi au-delà de ta liste initiale
// pour maximiser les chances de trouver de vrais Graduate Programmes
const COUNTRIES = ["gb", "fr", "sg"];

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const scoringModel = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });

const PROFILE = `Candidat : James Marville — cybersécurité, infrastructure, réseau, Python, PowerShell.
Recherche un Graduate Programme/Scheme IT ou cybersécurité (y compris IT généraliste avec rotation cyber).
Niveau 0-4 ans. Exclut les stages/alternances classiques non labellisés "Graduate Programme".`;

async function fetchAdzunaGraduate(country) {
  const offers = [];
  for (let page = 1; page <= 2; page++) {
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`);
    url.searchParams.set("app_id", ADZUNA_APP_ID);
    url.searchParams.set("app_key", ADZUNA_APP_KEY);
    url.searchParams.set("results_per_page", "30");
    url.searchParams.set("what", "graduate");
    try {
      const r = await fetch(url.toString(), { headers: { Accept: "application/json" } });
      if (!r.ok) { console.warn(`  ⚠️  ${country} HTTP ${r.status}`); continue; }
      const data = await r.json();
      for (const o of data.results || []) {
        const title = (o.title || "").trim();
        // Filtre strict : le mot "Graduate" doit apparaître dans le TITRE, pas juste la description
        if (!/graduate/i.test(title)) continue;
        offers.push({
          title,
          company: (o.company?.display_name || "Non précisé").trim(),
          location: (o.location?.display_name || country).trim(),
          country,
          url: o.redirect_url || "",
          snippet: (o.description || "").replace(/<[^>]+>/g, "").slice(0, 400),
        });
      }
    } catch (e) { console.warn(`  ⚠️  ${country} : ${e.message}`); }
    await new Promise((r) => setTimeout(r, 400));
  }
  return offers;
}

async function scoreAndFilter(offers) {
  const results = [];
  for (let i = 0; i < offers.length; i += 3) {
    const batch = offers.slice(i, i + 3);
    const items = batch.map((o, idx) =>
      `OFFRE ${idx + 1} [${o.country.toUpperCase()}]: ${o.title} | ${o.company} | ${o.location} | ${o.snippet.slice(0, 200)}`
    ).join("\n");
    const prompt = `Profil :\n${PROFILE}\n\n` +
      `Évalue si ces "Graduate Programme" sont en IT/cybersécurité (accepte IT généraliste avec rotation cyber, rejette Finance/Marketing/RH/Ventes purs).\n` +
      `Retourne UNIQUEMENT : {"scores":[{"score":75,"is_it_cyber":true,"pros":["..."],"cons":["..."]}]}\n\n${items}`;
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
          if (s.is_it_cyber) results.push({ ...batch[idx], score: Number(s.score) || 0 });
        });
      }
    } catch (e) { console.warn(`  ⚠️  ${e.message}`); }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return results;
}

async function pushToSheet(offers) {
  if (!GOOGLE_SERVICE_ACCOUNT_KEY || !TRACKER_SHEET_ID || offers.length === 0) {
    console.log("📋  Rien de nouveau à ajouter.");
    return;
  }
  const auth = new google.auth.GoogleAuth({ keyFile: GOOGLE_SERVICE_ACCOUNT_KEY, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const sheets = google.sheets({ version: "v4", auth });

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId: TRACKER_SHEET_ID, range: `${GRAD_SHEET_TAB}!A2:G500` });
  const existingRows = existing.data.values || [];
  const seen = new Set(existingRows.map((r) => `${(r[0] || "").trim()}|${(r[2] || "").trim()}`));

  const newRows = offers
    .filter((o) => !seen.has(`${o.company}|${o.title}`))
    .map((o) => [o.company, o.score, o.title, new Date().toISOString().slice(0, 10), "à trier", o.location, o.url]);

  if (newRows.length === 0) { console.log("📋  Rien de nouveau (déjà présents)."); return; }

  let lastUsedIndex = -1;
  const emptyRowIndexes = [];
  existingRows.forEach((row, i) => {
    const isEmpty = !row || row.every((c) => !c || c.trim() === "");
    if (isEmpty) emptyRowIndexes.push(i); else lastUsedIndex = i;
  });

  const remaining = [...newRows];
  let filled = 0;
  for (const idx of emptyRowIndexes) {
    if (idx > lastUsedIndex) continue;
    if (remaining.length === 0) break;
    const rowNumber = idx + 2;
    const row = remaining.shift();
    await sheets.spreadsheets.values.update({
      spreadsheetId: TRACKER_SHEET_ID, range: `${GRAD_SHEET_TAB}!A${rowNumber}:G${rowNumber}`,
      valueInputOption: "USER_ENTERED", requestBody: { values: [row] },
    });
    filled++;
  }
  if (remaining.length > 0) {
    const startRow = lastUsedIndex + 2 + 1;
    const endRow = startRow + remaining.length - 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: TRACKER_SHEET_ID, range: `${GRAD_SHEET_TAB}!A${startRow}:G${endRow}`,
      valueInputOption: "USER_ENTERED", requestBody: { values: remaining },
    });
  }
  console.log(`📋  ${filled} trou(s) comblé(s), ${remaining.length} ajoutée(s) (total ${newRows.length}).`);
}

async function main() {
  console.log(`📡  Recherche "Graduate" dans le titre — ${COUNTRIES.length} pays...`);
  let allOffers = [];
  for (const country of COUNTRIES) {
    const offers = await fetchAdzunaGraduate(country);
    allOffers.push(...offers);
    console.log(`  🌐  ${country.toUpperCase()} → ${offers.length} offres "Graduate"`);
  }
  const uniqueMap = new Map();
  for (const o of allOffers) uniqueMap.set(`${o.company}|${o.title}`, o);
  allOffers = [...uniqueMap.values()];
  console.log(`  → ${allOffers.length} offres uniques\n`);

  console.log("🎯  Scoring (filtre IT/cyber)...");
  const scored = await scoreAndFilter(allOffers);
  console.log(`  → ${scored.length} programmes IT/cyber pertinents\n`);

  await pushToSheet(scored);
}

main().catch((err) => { console.error("❌", err.message); process.exit(1); });
