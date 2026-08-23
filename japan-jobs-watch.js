import * as cheerio from "cheerio";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());
import { GoogleGenerativeAI } from "@google/generative-ai";
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const { GEMINI_API_KEY, GOOGLE_SERVICE_ACCOUNT_KEY, TRACKER_SHEET_ID, SUGGESTIONS_INTL_TAB } = process.env;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const scoringModel = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });

const PROFILE = "Candidat : James Marville - cybersecurite, infrastructure, forensics, incident response, Linux, reseau, Python, PowerShell, analyse de logs. Niveau 0-4 ans. Aucune exigence de japonais acceptee.";

const TOKYODEV_URL = "https://www.tokyodev.com/jobs/security";

async function fetchTokyoDev() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  await page.goto(TOKYODEV_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 5000));
  const html = await page.content();
  await browser.close();

  const $ = cheerio.load(html);
  const offers = [];

  $("h3").each((_, h3el) => {
    const company = $(h3el).text().trim();
    if (!company) return;
    const companyBlock = $(h3el).closest("div").parent();

    companyBlock.find('[data-collapsable-list-target="item"]').each((_, item) => {
      const titleEl = $(item).find("a.font-bold").first();
      const title = titleEl.text().trim();
      const href = titleEl.attr("href");
      if (!title || !href) return;

      const tags = $(item).find("a[href*='/jobs/']").map((_, t) => $(t).text().trim()).get();
      if (!tags.some((t) => /no japanese required/i.test(t))) return;

      const cityMatch = title.match(/,\s*([A-Za-zÀ-ÿ\s]+)$/);
      const city = cityMatch ? cityMatch[1].trim() : "Japon";

      offers.push({
        title,
        company,
        location: city + ", Japon",
        url: "https://www.tokyodev.com" + href,
        tags: tags.join(", "),
      });
    });
  });

  return offers;
}

async function scoreAndFilter(offers) {
  const results = [];
  for (let i = 0; i < offers.length; i += 3) {
    const batch = offers.slice(i, i + 3);
    const items = batch.map((o, idx) => "OFFRE " + (idx + 1) + ": " + o.title + " | Tags: " + o.tags).join("\n");
    const prompt = "Profil :\n" + PROFILE + "\n\n" +
      "Evalue ces offres au Japon. Rejette DevOps, Data/Data Analytics, vente/pre-vente, support client local, conformite japonaise pure.\n" +
      'Retourne UNIQUEMENT : {"scores":[{"score":75,"pros":["..."],"cons":["..."]}]}\n\n' + items;
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
          results.push({ ...batch[idx], score: Number(s.score) || 0 });
        });
      }
    } catch (e) { console.warn("  ⚠️  " + e.message); }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return results;
}

async function pushToSheet(offers) {
  if (!GOOGLE_SERVICE_ACCOUNT_KEY || !TRACKER_SHEET_ID || offers.length === 0) {
    console.log("📋  Rien de nouveau a ajouter.");
    return;
  }
  const auth = new google.auth.GoogleAuth({ keyFile: GOOGLE_SERVICE_ACCOUNT_KEY, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const sheets = google.sheets({ version: "v4", auth });

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId: TRACKER_SHEET_ID, range: SUGGESTIONS_INTL_TAB + "!A2:G500" });
  const existingRows = existing.data.values || [];
  const seen = new Set(existingRows.map((r) => (r[0] || "").trim() + "|" + (r[2] || "").trim()));

  const newRows = offers
    .filter((o) => !seen.has(o.company + "|" + o.title))
    .map((o) => [o.company, o.score, o.title, new Date().toISOString().slice(0, 10), "à trier", o.location, o.url]);

  if (newRows.length === 0) { console.log("📋  Rien de nouveau (deja presents)."); return; }

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
      spreadsheetId: TRACKER_SHEET_ID,
      range: SUGGESTIONS_INTL_TAB + "!A" + rowNumber + ":G" + rowNumber,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
    filled++;
  }
  if (remaining.length > 0) {
    const startRow = lastUsedIndex + 2 + 1;
    const endRow = startRow + remaining.length - 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: TRACKER_SHEET_ID,
      range: SUGGESTIONS_INTL_TAB + "!A" + startRow + ":G" + endRow,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: remaining },
    });
  }
  console.log("📋  " + filled + " trou(s) comble(s), " + remaining.length + " ajoutee(s) (total " + newRows.length + ").");
}

async function main() {
  console.log("📡  Scraping TokyoDev (Japon, no-Japanese)...");
  const offers = await fetchTokyoDev();
  console.log("  → " + offers.length + " offres filtrees \"No Japanese required\"\n");
  const scored = await scoreAndFilter(offers);
  const relevant = scored.filter((o) => o.score >= 50);
  await pushToSheet(relevant);
}

main().catch((err) => { console.error("❌", err.message); process.exit(1); });
