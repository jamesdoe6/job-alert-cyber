// top-entreprises-watch.js
// Veille quotidienne : offres cyber correspondant au profil, UNIQUEMENT chez 10 entreprises ciblées.
// Pipeline : Adzuna (1 requête par entreprise) -> filtre strict sur le nom d'entreprise
//            -> filtre séniorité -> scoring Gemini -> Google Sheet (onglet dédié) -> Telegram.
// Dédoublonnage : lecture des liens déjà présents dans l'onglet (aucun fichier d'état à commiter).

import fs from "node:fs";
import { google } from "googleapis";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------- .env local (optionnel, comme les autres scripts) ----------
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const {
  GEMINI_API_KEY,
  ADZUNA_APP_ID,
  ADZUNA_APP_KEY,
  TRACKER_SHEET_ID,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
} = process.env;
const TOP_SHEET_TAB = process.env.TOP_SHEET_TAB || "Top-Entreprises";
const COUNTRIES = (process.env.TOP_COUNTRIES || "fr").split(",").map((s) => s.trim()).filter(Boolean);
const SCORE_THRESHOLD = 70;
const MAX_DAYS_OLD = 7;
const MODEL = "gemini-3.5-flash-lite";

// ---------- Entreprises ciblées (nom de recherche + regex de validation stricte) ----------
const COMPANIES = [
  { name: "Thales", re: /\bthales\b/i },
  { name: "Airbus", re: /\bairbus\b/i },
  { name: "Safran", re: /\bsafran\b/i },
  { name: "Dassault Aviation", re: /dassault\s+aviation/i },
  { name: "EDF", re: /\bEDF\b|électricité de france|electricite de france/i },
  { name: "Google", re: /\bgoogle\b/i },
  { name: "Dassault Systèmes", re: /dassault\s+syst[eè]mes/i },
  { name: "Air France", re: /air[\s-]?france/i },
  { name: "TotalEnergies", re: /total\s?energies/i },
  { name: "Microsoft", re: /\bmicrosoft\b/i },
];
const SEARCH_TERMS_OR = "cybersécurité cybersecurity SOC sécurité security";

const PROFILE = `
Candidat : ingénieur cybersécurité / Security Operations Engineer, junior à confirmé (0 à 4 ans d'expérience), basé en Île-de-France, citoyen français.
Stack : Splunk (SIEM), EDR HarfangLab, CyberArk, pare-feux Check Point et Fortinet, Active Directory, Linux/Unix, VMware vSphere, Python/Shell, Wireshark, IDS/IPS.
Cible : CDI (ou CDD), SOC / détection & réponse / ingénierie sécurité / sécurité opérationnelle / cloud security.
Langues : français natif, anglais B1/B2.
`;

// ---------- Utilitaires ----------
function stripHtml(html = "") {
  let out = String(html);
  let prev;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, " ");
  } while (out !== prev);
  return out.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
}

function isSenior(title = "") {
  return /senior|sénior|confirmé|expert|lead\b|principal|staff\b|manager|head of|directeur|architect/i.test(title);
}

function extractOfferId(url = "") {
  const m = url.match(/\/(?:details|land\/ad)\/(\d+)/);
  return m ? m[1] : url;
}

function formatDateFR(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function parseDateForSort(s) {
  const m = String(s || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime() : 0;
}

async function notifyTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
  } catch (e) {
    console.error("Telegram KO :", e.message);
  }
}

// ---------- Adzuna ----------
async function fetchCompany(company, country) {
  const params = new URLSearchParams({
    app_id: ADZUNA_APP_ID,
    app_key: ADZUNA_APP_KEY,
    results_per_page: "50",
    what_or: SEARCH_TERMS_OR,
    what_and: company.name,
    max_days_old: String(MAX_DAYS_OLD),
    sort_by: "date",
  });
  const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Adzuna ${country}/${company.name} : HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  return (data.results || [])
    .filter((r) => company.re.test(r.company?.display_name || ""))
    .map((r) => ({
      id: String(r.id),
      company: company.name,
      title: r.title || "",
      location: r.location?.display_name || "",
      country: country.toUpperCase(),
      url: r.redirect_url || "",
      description: stripHtml(r.description).slice(0, 700),
    }));
}

// ---------- Gemini ----------
async function scoreOffers(offers) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
  });
  const scored = [];
  for (let i = 0; i < offers.length; i += 5) {
    const batch = offers.slice(i, i + 5);
    const prompt =
      `Tu évalues des offres d'emploi pour ce candidat :\n${PROFILE}\n` +
      `Pour chaque offre, donne un score 0-100 de correspondance avec le profil.\n` +
      `RÈGLES :\n` +
      `- Rejette (score <= 20) tout ce qui n'est pas de la cybersécurité (dev, data, IT généraliste, commercial).\n` +
      `- Rejette (score <= 20) si l'offre exige plus de 4 ans d'expérience, ou un poste senior/lead/manager.\n` +
      `- Rejette (score <= 20) les stages, alternances et thèses.\n` +
      `- Pour une offre hors France : rejette si elle exige un droit de travail local sans sponsorship (ex. UK/US).\n` +
      `Réponds en JSON : {"scores":[{"id":"...","score":0,"reason":"1 phrase courte"}]}\n\n` +
      batch.map((o) => `ID: ${o.id}\nEntreprise: ${o.company}\nTitre: ${o.title}\nLieu: ${o.location}\nDescription: ${o.description}`).join("\n---\n");
    try {
      const result = await model.generateContent(prompt);
      const parsed = JSON.parse(result.response.text());
      const arr = Array.isArray(parsed) ? parsed : parsed?.scores || [];
      for (const o of batch) {
        const s = arr.find((x) => String(x.id) === o.id);
        scored.push({ ...o, score: Number(s?.score ?? 0), reason: s?.reason || "" });
      }
    } catch (e) {
      console.error("Gemini KO sur un lot :", e.message);
      for (const o of batch) scored.push({ ...o, score: 0, reason: "erreur de scoring" });
    }
  }
  return scored;
}

// ---------- Google Sheets ----------
function getSheetsClient() {
  const opts = { scopes: ["https://www.googleapis.com/auth/spreadsheets"] };
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    opts.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    opts.keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  } else {
    throw new Error("Aucun identifiant Google (GOOGLE_SERVICE_ACCOUNT_JSON ou GOOGLE_APPLICATION_CREDENTIALS).");
  }
  return google.sheets({ version: "v4", auth: new google.auth.GoogleAuth(opts) });
}

async function ensureTab(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: TRACKER_SHEET_ID });
  const existing = meta.data.sheets.find((s) => s.properties.title === TOP_SHEET_TAB);
  if (existing) return existing.properties.sheetId;
  const r = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: TRACKER_SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: TOP_SHEET_TAB } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: TRACKER_SHEET_ID,
    range: `${TOP_SHEET_TAB}!A1:G1`,
    valueInputOption: "RAW",
    requestBody: { values: [["entreprise", "score", "poste", "date_envoi", "statut", "localisation", "lien_offre"]] },
  });
  return r.data.replies[0].addSheet.properties.sheetId;
}

async function readExisting(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: TRACKER_SHEET_ID,
    range: `${TOP_SHEET_TAB}!A2:G`,
  });
  return res.data.values || [];
}

async function pushAndSort(sheets, sheetId, offers) {
  const existing = await readExisting(sheets);
  const newRows = offers.map((o) => [o.company, o.score, o.title, formatDateFR(), "à trier", `${o.location} (${o.country})`, o.url]);
  const all = [...existing.map((r) => Array.from({ length: 7 }, (_, i) => r[i] ?? "")), ...newRows];
  all.sort((a, b) => parseDateForSort(b[3]) - parseDateForSort(a[3]));

  // Agrandit la grille si besoin (évite "Range exceeds grid limits")
  const needed = all.length + 2;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: TRACKER_SHEET_ID });
  const tab = meta.data.sheets.find((s) => s.properties.sheetId === sheetId);
  if (tab.properties.gridProperties.rowCount < needed) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: TRACKER_SHEET_ID,
      requestBody: {
        requests: [{ updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount: needed } }, fields: "gridProperties.rowCount" } }],
      },
    });
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: TRACKER_SHEET_ID,
    range: `${TOP_SHEET_TAB}!A2:G${all.length + 1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: all },
  });
}

// ---------- Main ----------
async function main() {
  for (const k of ["GEMINI_API_KEY", "ADZUNA_APP_ID", "ADZUNA_APP_KEY", "TRACKER_SHEET_ID"]) {
    if (!process.env[k]) throw new Error(`Variable manquante : ${k}`);
  }
  const sheets = getSheetsClient();
  const sheetId = await ensureTab(sheets);
  const known = new Set((await readExisting(sheets)).map((r) => extractOfferId(r[6] || "")));

  const collected = new Map();
  for (const country of COUNTRIES) {
    for (const company of COMPANIES) {
      const found = await fetchCompany(company, country);
      for (const o of found) collected.set(o.id, o);
      await new Promise((r) => setTimeout(r, 400)); // reste sous les quotas Adzuna
    }
  }
  console.log(`Offres brutes (entreprises ciblées uniquement) : ${collected.size}`);

  const fresh = [...collected.values()].filter((o) => !isSenior(o.title) && !known.has(extractOfferId(o.url)));
  console.log(`Après filtre séniorité + dédoublonnage : ${fresh.length}`);

  if (fresh.length === 0) {
    await notifyTelegram("🏢 Veille Top Entreprises\n📊 0 nouvelle offre aujourd'hui");
    return;
  }

  const scored = (await scoreOffers(fresh)).filter((o) => o.score >= SCORE_THRESHOLD);
  console.log(`Offres retenues (score >= ${SCORE_THRESHOLD}) : ${scored.length}`);

  if (scored.length > 0) await pushAndSort(sheets, sheetId, scored);

  const byCompany = {};
  for (const o of scored) byCompany[o.company] = (byCompany[o.company] || 0) + 1;
  const detail = Object.entries(byCompany).map(([c, n]) => `${c} : ${n}`).join(" · ");
  await notifyTelegram(
    `🏢 Veille Top Entreprises\n📊 ${scored.length} nouvelle(s) offre(s) pertinente(s)\n📍 ${detail || "aucune"}\n📑 Onglet « ${TOP_SHEET_TAB} »`
  );
}

main().catch(async (e) => {
  console.error(e);
  await notifyTelegram(`❌ Veille Top Entreprises : erreur\n${String(e.message).slice(0, 200)}`);
  process.exit(1);
});