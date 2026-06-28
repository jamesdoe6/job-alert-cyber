import { config } from "dotenv";
config();

const url = new URL("https://api.adzuna.com/v1/api/jobs/fr/search/1");
url.searchParams.set("app_id",          process.env.ADZUNA_APP_ID);
url.searchParams.set("app_key",         process.env.ADZUNA_APP_KEY);
url.searchParams.set("what",            "cybersecurity");
url.searchParams.set("results_per_page","5");

console.log("URL appelée :", url.toString());
console.log("app_id :", process.env.ADZUNA_APP_ID);
console.log("app_key :", process.env.ADZUNA_APP_KEY?.slice(0, 6) + "...");

const r = await fetch(url.toString(), { headers: { Accept: "application/json" } });
console.log("Status HTTP :", r.status);

const data = await r.json();
console.log("Réponse brute :", JSON.stringify(data, null, 2));