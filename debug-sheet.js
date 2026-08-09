import { google } from "googleapis";
import { readFileSync, existsSync } from "fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const { GOOGLE_SERVICE_ACCOUNT_KEY, TRACKER_SHEET_ID, SUGGESTIONS_SHEET_TAB } = process.env;

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: TRACKER_SHEET_ID,
    range: `${SUGGESTIONS_SHEET_TAB}!A2:G`,
  });

  const rows = res.data.values || [];
  console.log(`Total lignes retournées : ${rows.length}\n`);
  rows.forEach((row, i) => {
    const isEmpty = !row || row.every((cell) => !cell || cell.trim() === "");
    console.log(`Ligne Sheet ${i + 2} | vide=${isEmpty} | contenu:`, JSON.stringify(row));
  });
}
main().catch((e) => console.error("Erreur :", e.message));
