import { google } from "googleapis";
import { readFileSync, existsSync } from "fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const { GOOGLE_SERVICE_ACCOUNT_KEY, TRACKER_SHEET_ID, SUGGESTIONS_INTL_TAB } = process.env;

async function main() {
  const auth = new google.auth.GoogleAuth({ keyFile: GOOGLE_SERVICE_ACCOUNT_KEY, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const sheets = google.sheets({ version: "v4", auth });

  console.log("Onglet ciblé :", SUGGESTIONS_INTL_TAB);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: TRACKER_SHEET_ID,
    range: `${SUGGESTIONS_INTL_TAB}!A1:G200`,
  });
  console.log("Contenu :", JSON.stringify(res.data.values, null, 2));
}
main().catch((e) => console.error("Erreur :", e.message));
