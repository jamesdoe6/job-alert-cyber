#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  VEILLE EMPLOI CYBER — Automatisation Quotidienne        ║
 * ║  James Marville · SecOps · IPSSI 2026 · IDF             ║
 * ║  Sources : Adzuna API  ·  Scoring : Gemini 1.5 Flash    ║
 * ╚══════════════════════════════════════════════════════════╝
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { google } from "googleapis";
import nodemailer from "nodemailer";
import { readFileSync, writeFileSync, existsSync } from "fs";

// Lecture manuelle du .env (local uniquement — GitHub Actions utilise ses propres secrets)
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// ─────────────────────────────────────────────────────────────
//  GARDE-FOU
// ─────────────────────────────────────────────────────────────
const REQUIRED = ["GEMINI_API_KEY", "EMAIL_TO", "EMAIL_FROM", "SMTP_USER", "SMTP_PASS"];
const missing  = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌  Variables manquantes dans .env : ${missing.join(", ")}`);
  process.exit(1);
}
const HAS_FT     = !!(process.env.FT_CLIENT_ID && process.env.FT_CLIENT_SECRET);
const HAS_ADZUNA = !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
if (!HAS_FT && !HAS_ADZUNA) {
  console.error("❌  Configure au moins une API de recherche (France Travail ou Adzuna)");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
//  PROFIL CANDIDAT
// ─────────────────────────────────────────────────────────────
const PROFILE = `Candidat : James Marville
Poste visé : Ingénieur / Analyste Cybersécurité Opérationnelle (SOC, SecOps, SIEM, IAM, GRC)
Formation : Mastère 2 Cybersécurité & Cloud, IPSSI Paris, diplômé 2026
Expérience : 2 ans alternance BNP Paribas Arval – Ingénieur SecOps
Stack maîtrisée : Splunk SIEM, HarfangLab EDR, CyberArk PAM, Check Point, Fortinet, Active Directory, GPO, Python, Bash, Linux, Windows Server, CIS Benchmarks, DORA, ISO 27001
Localisation : Nanterre (92) – Île-de-France – Remote accepté
Disponibilité : Octobre 2026
Langue : Français natif, Anglais technique B1
À ÉVITER : Red Team offensif, AppSec/dev, Senior 5+ ans exigé, B2 anglais obligatoire`;

const STACK_KEYWORDS = [
  "Splunk","HarfangLab","CyberArk","Check Point","Fortinet",
  "Active Directory","Python","Bash","Linux","Windows Server",
  "DORA","CIS","SIEM","EDR","PAM","SOC","SecOps","IAM",
];

const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeId(src, company, title, i) {
  const s = `${src}${company}${title}${i}`.toLowerCase();
  let h = 5381;
  for (let c = 0; c < s.length; c++) h = ((h << 5) + h) ^ s.charCodeAt(c);
  return (h >>> 0).toString(36);
}

// ─────────────────────────────────────────────────────────────
//  SOURCE 1 — FRANCE TRAVAIL API
// ─────────────────────────────────────────────────────────────
async function getFTToken() {
  const r = await fetch(
    "https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.FT_CLIENT_ID,
        client_secret: process.env.FT_CLIENT_SECRET,
        scope: "api_offresdemploiv2 o2dsoffre",
      }),
    }
  );
  if (!r.ok) throw new Error(`FT Auth HTTP ${r.status}`);
  return (await r.json()).access_token;
}

const FT_KEYWORDS = [
  "ingénieur cybersécurité",
  "ingénieur réseaux sécurité informatique",
  "ingénieur systèmes sécurité",
  "consultant cybersécurité",
  "analyste SOC SIEM cybersécurité",
  "SecOps IAM sécurité opérationnelle",
];

async function searchFranceTravail() {
  if (!HAS_FT) return [];
  console.log("  📋  France Travail...");
  let token;
  try { token = await getFTToken(); }
  catch (e) { console.warn(`  ⚠️  FT auth : ${e.message}`); return []; }

  const offers = [];
  for (const kw of FT_KEYWORDS) {
    try {
      const url = new URL("https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search");
      url.searchParams.set("motsCles",      kw);
      url.searchParams.set("departement",   "75,92,93,94,78,91,77,95"); // IDF complet
      url.searchParams.set("publieeDepuis", "30");
      url.searchParams.set("typeContrat",   "CDI,CDD");
      url.searchParams.set("range",         "0-14");

      const r = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!r.ok) continue;
      const data = await r.json();
      for (const o of data.resultats || []) {
        offers.push({
          id:      makeId("ft", o.entreprise?.nom || "", o.intitule || "", offers.length),
          title:   (o.intitule || "").trim(),
          company: (o.entreprise?.nom || "Non précisé").trim(),
          location:(o.lieuTravail?.libelle || "IDF").trim(),
          url:     o.origineOffre?.urlOrigine || `https://candidat.francetravail.fr/offres/emploi/detail/${o.id}`,
          snippet: (o.description || "").slice(0, 300),
          date:    o.dateCreation?.slice(0, 10) || today,
          source:  "France Travail",
          score: 0, pros: [], cons: [],
        });
      }
    } catch (e) { console.warn(`  ⚠️  FT "${kw}" : ${e.message}`); }
    await sleep(600);
  }
  console.log(`     → ${offers.length} offres France Travail`);
  return offers;
}

// ─────────────────────────────────────────────────────────────
//  SOURCE 2 — ADZUNA API (IDF uniquement)
// ─────────────────────────────────────────────────────────────
const ADZUNA_SEARCHES = [
  { what: "ingénieur cybersécurité",              where: "Paris" },
  { what: "ingénieur réseaux sécurité",           where: "Ile-de-France" },
  { what: "ingénieur systèmes sécurité",          where: "Ile-de-France" },
  { what: "consultant cybersécurité",             where: "Paris" },
  { what: "cybersecurity engineer SOC SIEM",      where: "Paris" },
  { what: "analyste sécurité informatique SOC",   where: "Ile-de-France" },
  { what: "security operations engineer",         where: "France" },
];

async function searchAdzuna() {
  if (!HAS_ADZUNA) return [];
  console.log("  🌐  Adzuna (Indeed · LinkedIn · Monster)...");
  const offers = [];

  for (const s of ADZUNA_SEARCHES) {
    try {
      const url = new URL("https://api.adzuna.com/v1/api/jobs/fr/search/1");
      url.searchParams.set("app_id",          process.env.ADZUNA_APP_ID);
      url.searchParams.set("app_key",         process.env.ADZUNA_APP_KEY);
      url.searchParams.set("what",            s.what);
      url.searchParams.set("where",           s.where);
      url.searchParams.set("distance",        "50");       // 50 km autour
      url.searchParams.set("max_days_old",    "30");
      url.searchParams.set("results_per_page","15");
      url.searchParams.set("content-type",    "application/json");

      const r = await fetch(url.toString(), { headers: { Accept: "application/json" } });
      if (!r.ok) { console.warn(`  ⚠️  Adzuna HTTP ${r.status}`); continue; }

      const data = await r.json();
      for (const o of data.results || []) {
        offers.push({
          id:      makeId("az", o.company?.display_name || "", o.title || "", offers.length),
          title:   (o.title || "").trim(),
          company: (o.company?.display_name || "Non précisé").trim(),
          location:(o.location?.display_name || "IDF").trim(),
          url:     o.redirect_url || "",
          snippet: (o.description || "").replace(/<[^>]+>/g, "").slice(0, 300),
          date:    o.created?.slice(0, 10) || today,
          source:  "Adzuna",
          score: 0, pros: [], cons: [],
        });
      }
    } catch (e) { console.warn(`  ⚠️  Adzuna "${s.what}" : ${e.message}`); }
    await sleep(500);
  }
  console.log(`     → ${offers.length} offres Adzuna`);
  return offers;
}

// ─────────────────────────────────────────────────────────────
//  DÉDUPLICATION
// ─────────────────────────────────────────────────────────────
function deduplicate(offers) {
  const seen = new Set();
  return offers.filter((o) => {
    const key = `${o.company}${o.title}`.toLowerCase().replace(/[\s\W]/g, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─────────────────────────────────────────────────────────────
//  SCORING — Gemini 1.5 Flash (systemInstruction séparé)
// ─────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const scoringModel = genAI.getGenerativeModel({
  model: "gemini-3.5-flash-lite",
  generationConfig: {
    temperature: 0.1,
    responseMimeType: "application/json",
  },
  systemInstruction: `Tu es un recruteur expert cybersécurité. Évalue des offres pour ce candidat :
Candidat : James Marville, Ingénieur SecOps, 2 ans BNP Paribas Arval, dispo oct 2026
Stack : Splunk, HarfangLab, CyberArk, Check Point, Fortinet, Active Directory, Python, Bash, Linux, SIEM, EDR, PAM
Rôles visés : ingénieur cybersécurité, réseaux, systèmes, consultant sécurité, SOC analyst, IAM, GRC
Zone : Île-de-France ou remote. Français natif, anglais B1.
BARÈME /100 :
+30 rôle cyber/SOC/réseau/systèmes/consultant
+25 stack technique (Splunk, CyberArk, SIEM, EDR, AD…)
+20 expérience 0-5 ans requise
+15 IDF ou remote
+10 langue française ou anglais B1
-25 Red Team/offensif/pentest
-20 AppSec/dev sécurisé
-15 senior 5+ ans exigés
-10 anglais C1/C2 obligatoire
Si expérience non précisée : ne pénalise pas.
Retourne UNIQUEMENT ce JSON sans texte autour :
{"scores":[{"score":75,"pros":["point"],"cons":["frein"]}]}`,
});

async function scoreOffers(offers) {
  const batches = [];
  for (let i = 0; i < offers.length; i += 3) batches.push(offers.slice(i, i + 3));

  for (const [idx, batch] of batches.entries()) {
    const items = batch.map((o, i) =>
      `OFFRE ${i + 1}: ${o.title} | ${o.company} | ${o.location} | ${(o.snippet || "").slice(0, 150)}`
    ).join("\n");

    try {
      const result = await scoringModel.generateContent(
        `Evalue ces ${batch.length} offres et retourne ${batch.length} scores dans l\'ordre :\n\n${items}`
      );
      const raw = result.response.text().trim();
      console.log(`  📊  Lot ${idx + 1} : ${raw.slice(0, 120)}`);

      let parsed;
      try { parsed = JSON.parse(raw); } catch {
        const m = raw.match(/\{[\s\S]*\}/) || raw.match(/\[[\s\S]*\]/);
        if (m) try { parsed = JSON.parse(m[0]); } catch {}
      }
      // Accepte les deux formats : {"scores":[...]} ET [...] nu
      const scoresArray = Array.isArray(parsed) ? parsed : parsed?.scores;
      if (scoresArray?.length) {
        scoresArray.forEach((s, i) => {
          if (!batch[i]) return;
          batch[i].score = Math.min(100, Math.max(0, Number(s.score) || 0));
          batch[i].pros  = Array.isArray(s.pros) ? s.pros.slice(0, 3) : [];
          batch[i].cons  = Array.isArray(s.cons) ? s.cons.slice(0, 2) : [];
        });
        console.log(`     → Scores : ${scoresArray.map((s) => s.score).join(" / ")}`);
      } else {
        console.warn(`  ⚠️  Lot ${idx + 1} parsing échoué. Réponse brute : ${raw.slice(0, 200)}`);
        batch.forEach((o) => { o.score = 0; o.pros = []; o.cons = ["Scoring indisponible"]; });
      }
    } catch (err) {
      console.warn(`  ⚠️  Lot ${idx + 1} erreur : ${err.message}`);
      batch.forEach((o) => { o.score = 0; });
    }

    if (idx < batches.length - 1) await sleep(5_000);
  }

  return offers.sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────────────────────────────
//  PERSISTANCE
// ─────────────────────────────────────────────────────────────
const SEEN_FILE = "./veille-seen-ids.json";
function loadSeenIds() {
  if (!existsSync(SEEN_FILE)) return new Set();
  try { return new Set(JSON.parse(readFileSync(SEEN_FILE, "utf8"))); } catch { return new Set(); }
}
function saveSeenIds(offers) {
  try { writeFileSync(SEEN_FILE, JSON.stringify(offers.map((o) => o.id))); } catch {}
}
function filterNew(offers, seen) { return offers.filter((o) => !seen.has(o.id)); }

// ─────────────────────────────────────────────────────────────
//  EMAIL HTML
// ─────────────────────────────────────────────────────────────
function scoreBadge(score) {
  if (score >= 80) return { label: "FORT",  color: "#22c55e", bg: "#052e16" };
  if (score >= 65) return { label: "BON",   color: "#f59e0b", bg: "#1c1307" };
  if (score >= 50) return { label: "MOYEN", color: "#f97316", bg: "#1c0a03" };
  return             { label: "FAIBLE", color: "#a855f7", bg: "#1a0a2e" };
}
function stackMatch(text) {
  return STACK_KEYWORDS.filter((k) => (text || "").toLowerCase().includes(k.toLowerCase()));
}

function buildEmailHTML(offers, stats) {
  const strong = offers.filter((o) => o.score >= 75);
  const good   = offers.filter((o) => o.score >= 65 && o.score < 75);
  const others = offers.filter((o) => o.score < 65);

  const row = (o) => {
    const b  = scoreBadge(o.score);
    const tags = stackMatch(`${o.title} ${o.snippet}`)
      .map((k) => `<span style="background:#0e4429;color:#22c55e;padding:1px 6px;border-radius:3px;font-size:11px;margin:2px;">${k}</span>`).join("");
    const pros = o.pros.map((p) => `<li style="color:#6ee7b7;font-size:11px;">✓ ${p}</li>`).join("");
    const cons = o.cons.map((c) => `<li style="color:#fca5a5;font-size:11px;">✗ ${c}</li>`).join("");
    const btn  = o.url
      ? `<a href="${o.url}" style="display:inline-block;background:#0e7490;color:#fff;padding:4px 14px;border-radius:4px;text-decoration:none;font-size:12px;font-weight:bold;margin-top:8px;">VOIR L'OFFRE →</a>`
      : "";
    return `
<tr><td style="padding:14px 16px;border-bottom:1px solid #1e3a5f;vertical-align:top;">
<table width="100%" cellpadding="0" cellspacing="0"><tr>
  <td style="width:64px;vertical-align:top;padding-right:14px;">
    <div style="background:${b.bg};border:1px solid ${b.color};border-radius:6px;text-align:center;padding:7px 4px;">
      <div style="color:${b.color};font-size:20px;font-weight:900;font-family:monospace;">${o.score}</div>
      <div style="color:${b.color};font-size:9px;font-weight:bold;letter-spacing:1px;">${b.label}</div>
    </div>
  </td>
  <td style="vertical-align:top;">
    <div style="color:#e0f2fe;font-weight:bold;font-size:14px;">${o.title} <span style="color:#334155;font-size:10px;font-weight:normal;">${o.source}</span></div>
    <div style="color:#7dd3fc;font-size:13px;margin-top:2px;">${o.company} · <span style="color:#94a3b8;">${o.location}</span></div>
    ${o.snippet ? `<div style="color:#64748b;font-size:12px;margin-top:5px;line-height:1.4;">${o.snippet.slice(0, 200)}</div>` : ""}
    ${tags ? `<div style="margin-top:6px;">${tags}</div>` : ""}
    ${pros || cons ? `<table style="margin-top:8px;" cellpadding="0" cellspacing="0" width="100%"><tr>
      ${pros ? `<td style="vertical-align:top;width:50%;padding-right:8px;"><ul style="margin:0;padding-left:14px;">${pros}</ul></td>` : ""}
      ${cons ? `<td style="vertical-align:top;"><ul style="margin:0;padding-left:14px;">${cons}</ul></td>` : ""}
    </tr></table>` : ""}
    ${btn}
  </td>
</tr></table>
</td></tr>`;
  };

  const section = (title, color, items) => !items.length ? "" : `
<tr><td style="padding:10px 16px 6px;background:#0d1f35;">
  <span style="color:${color};font-weight:bold;font-size:12px;letter-spacing:2px;">${title} (${items.length})</span>
</td></tr>${items.map(row).join("")}`;

  const dateLabel = new Date().toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#070e1a;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#070e1a;">
<tr><td align="center" style="padding:24px 12px;">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;">
  <tr><td style="background:linear-gradient(135deg,#0d1f35,#112240);border:1px solid #1e3a5f;border-radius:10px 10px 0 0;padding:22px 26px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <div style="color:#22d3ee;font-size:20px;font-weight:900;font-family:'Courier New',monospace;">⬡ VEILLE EMPLOI CYBER · IDF</div>
        <div style="color:#7dd3fc;font-size:13px;margin-top:4px;">James Marville · SecOps · ${dateLabel}</div>
      </td>
      <td align="right" style="vertical-align:top;">
        <div style="background:#0a2540;border:1px solid #22d3ee;border-radius:8px;padding:10px 18px;text-align:center;">
          <div style="color:#22d3ee;font-size:28px;font-weight:900;">${stats.total}</div>
          <div style="color:#94a3b8;font-size:10px;letter-spacing:1px;">NOUVELLES OFFRES</div>
        </div>
      </td>
    </tr></table>
    <table style="margin-top:14px;" cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:12px;"><span style="background:#052e16;color:#22c55e;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:bold;">🟢 FORT ≥75 : ${stats.strong}</span></td>
      <td style="padding-right:12px;"><span style="background:#1c1307;color:#f59e0b;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:bold;">🟡 BON ≥65 : ${stats.good}</span></td>
      <td><span style="background:#0f172a;color:#94a3b8;padding:4px 12px;border-radius:12px;font-size:12px;">⚪ AUTRES : ${stats.others}</span></td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#0a1628;border:1px solid #1e3a5f;border-top:none;">
    <table width="100%" cellpadding="0" cellspacing="0">
      ${section("🟢 FORTE CORRESPONDANCE ≥75", "#22c55e", strong)}
      ${section("🟡 BONNE CORRESPONDANCE ≥65", "#f59e0b", good)}
      ${section("⚪ AUTRES OFFRES", "#64748b", others)}
    </table>
  </td></tr>
  <tr><td style="background:#0d1f35;border:1px solid #1e3a5f;border-top:none;border-radius:0 0 10px 10px;padding:14px 26px;">
    <div style="color:#334155;font-size:11px;line-height:1.6;">
      Île-de-France · Sources : France Travail · Adzuna (Indeed · LinkedIn · Monster · Glassdoor)<br>
      Scoring : Gemini 1.5 Flash · ${new Date().toISOString()}
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────
//  ENVOI EMAIL avec retry
// ─────────────────────────────────────────────────────────────
async function sendEmail(html, stats, attempt = 1) {
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || "smtp.gmail.com",
    port:   parseInt(process.env.SMTP_PORT || "465"),
    secure: true,
    family: 4,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const dateStr = new Date().toLocaleDateString("fr-FR", { weekday:"short", day:"numeric", month:"short" });
  try {
    await transporter.verify();
    const info = await transporter.sendMail({
      from:    `"Veille Emploi Cyber" <${process.env.EMAIL_FROM}>`,
      to:      process.env.EMAIL_TO,
      subject: `[CYBER] ${stats.total} offres IDF · ${stats.strong} FORT · ${stats.good} BON — ${dateStr}`,
      html,
    });
    console.log(`  ✅  Email → ${process.env.EMAIL_TO} (${info.messageId})`);
  } catch (err) {
    console.error(`  ❌  Tentative ${attempt}/3 : ${err.message}`);
    if (attempt < 3) {
      console.log(`  ⏳  Retry dans 30s...`);
      await sleep(30_000);
      return sendEmail(html, stats, attempt + 1);
    }
    throw new Error("Email non envoyé après 3 tentatives");
  }
}

// ─────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║  VEILLE EMPLOI CYBER · IDF                 ║`);
  console.log(`║  ${today}  ·  FT:${HAS_FT?"✓":"✗"}  Adzuna:${HAS_ADZUNA?"✓":"✗"}  Gemini:✓  ║`);
  console.log(`╚════════════════════════════════════════════╝\n`);

  const seenIds = loadSeenIds();
  console.log(`📁  ${seenIds.size} offres déjà vues\n`);

  // 1. Collecte
  console.log("📡  Collecte des offres IDF...");
  const [ftRes, azRes] = await Promise.allSettled([searchFranceTravail(), searchAdzuna()]);
  const allRaw = [
    ...(ftRes.status === "fulfilled" ? ftRes.value : []),
    ...(azRes.status === "fulfilled" ? azRes.value : []),
  ];
  console.log(`\n  → ${allRaw.length} offres brutes\n`);

  const deduped   = deduplicate(allRaw);
  const newOffers = filterNew(deduped, seenIds);
  console.log(`  → ${deduped.length} après dédup · ${newOffers.length} nouvelles\n`);

  if (newOffers.length === 0) {
    console.log("ℹ️   Aucune nouvelle offre. Email non envoyé.");
    console.log(`⏱️   Durée : ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    return;
  }

  // 2. Scoring
  console.log("🎯  Scoring Gemini en cours...");
  const scored = await scoreOffers(newOffers);
  const stats = {
    total:  scored.length,
    strong: scored.filter((o) => o.score >= 75).length,
    good:   scored.filter((o) => o.score >= 65 && o.score < 75).length,
    others: scored.filter((o) => o.score < 65).length,
  };
console.log(`\n  → FORT:${stats.strong}  BON:${stats.good}  AUTRES:${stats.others}\n`);

  // 3. Mémoriser TOUTES les offres scorées (même sous le seuil, pour ne pas les rescorer demain)
  saveSeenIds([...Array.from(seenIds).map((id) => ({ id })), ...scored]);

  // 4. Filtrer avant envoi : seulement les offres au-dessus du seuil
  const SCORE_THRESHOLD = 40;
  const toSend = scored.filter((o) => o.score >= SCORE_THRESHOLD);
  console.log(`  → ${toSend.length}/${scored.length} offre(s) au-dessus du seuil ${SCORE_THRESHOLD} (envoyée(s))\n`);

  if (toSend.length === 0) {
    console.log("ℹ️   Aucune offre au-dessus du seuil. Email non envoyé.");
    console.log(`\n✅  Terminé en ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    return;
  }

  console.log("📧  Envoi email...");
  const html = buildEmailHTML(toSend, stats);
  await sendEmail(html, stats);
  await pushToTracker(toSend);

async function pushToTracker(offers) {
  const { GOOGLE_SERVICE_ACCOUNT_KEY, TRACKER_SHEET_ID, SUGGESTIONS_SHEET_TAB } = process.env;
  if (!GOOGLE_SERVICE_ACCOUNT_KEY || !TRACKER_SHEET_ID) {
    console.warn("⚠️  Tracker Sheet non configuré, étape ignorée.");
    return;
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // Lit TOUTES les lignes existantes (pas juste A:C) pour repérer les trous ET la dédup
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: TRACKER_SHEET_ID,
    range: `${SUGGESTIONS_SHEET_TAB}!A2:G`,
  });
  const existingRows = existing.data.values || [];

  const seen = new Set(
    existingRows.map((r) => `${(r[0] || "").trim()}|${(r[2] || "").trim()}`)
  );

  const newRows = offers
    .filter((o) => !seen.has(`${o.company}|${o.title}`))
    .map((o) => [
      o.company,
      o.score,
      o.title,
      new Date().toISOString().slice(0, 10),
      "à trier",
      "",
      o.url || "",
    ]);

  if (newRows.length === 0) {
    console.log("📋  Tracker : aucune nouvelle offre à ajouter (déjà présentes).");
    return;
  }

  // Repère les indices de lignes complètement vides au milieu du tableau
  // (colonne A vide = ligne considérée comme un "trou" à combler)
  const emptyRowIndexes = [];
  existingRows.forEach((row, i) => {
    const isEmpty = !row || row.every((cell) => !cell || cell.trim() === "");
    if (isEmpty) emptyRowIndexes.push(i); // index 0 = ligne 2 du Sheet (A2)
  });

  let filled = 0;
  const remaining = [...newRows];

  // 1. Comble les trous existants via update ciblé, un par un
  for (const idx of emptyRowIndexes) {
    if (remaining.length === 0) break;
    const rowNumber = idx + 2; // +2 car A2 = index 0, et on est en base 1 pour le Sheet
    const row = remaining.shift();
    await sheets.spreadsheets.values.update({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `${SUGGESTIONS_SHEET_TAB}!A${rowNumber}:G${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
    filled++;
  }

  // 2. Ce qui ne rentre pas dans les trous est ajouté normalement à la fin
  if (remaining.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `${SUGGESTIONS_SHEET_TAB}!A:G`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: remaining },
    });
  }

  console.log(`📋  Tracker : ${filled} ligne(s) vide(s) comblée(s), ${remaining.length} ajoutée(s) en fin de tableau (total ${newRows.length}).`);
}

  console.log(`\n✅  Terminé en ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

main().catch((err) => {
  console.error("\n❌  Erreur fatale :", err.message || err);
  process.exit(1);
});