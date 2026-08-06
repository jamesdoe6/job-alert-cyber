# veille-emploi-cyber

> Automated daily job-search pipeline for cybersecurity roles — aggregates listings, scores them with AI, and emails a filtered digest every day, hands-off.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)](package.json)
[![Automated](https://img.shields.io/badge/automation-GitHub%20Actions-blue)](.github/workflows/veille.yml)

## Overview

Job searching in cybersecurity means checking multiple platforms every day for a handful of roles that actually fit — and most listings don't. This project automates that first pass: it pulls job postings from **Adzuna** and **France Travail**, scores each one against a candidate profile using **Google Gemini**, deduplicates against previously seen listings, and emails a digest of only the relevant matches.

It runs entirely on GitHub Actions — no server to maintain, no always-on machine required.

## How it works

```
Scheduled trigger (GitHub Actions cron)
        │
        ▼
Fetch listings ── Adzuna API
              └── France Travail API (OAuth2)
        │
        ▼
Deduplicate against veille-seen-ids.json
        │
        ▼
Score each new listing ── Gemini API
        │
        ▼
Filter by relevance threshold
        │
        ▼
Email digest ── SMTP (Gmail)
```

## Features

- **Multi-source aggregation** — combines Adzuna (which itself indexes Indeed, LinkedIn, Monster, and more) with the official France Travail API
- **AI-based relevance scoring** — each listing is scored against a defined candidate profile instead of relying on keyword matching alone
- **Deduplication** — tracks previously seen listing IDs so the same offer never triggers a second email
- **Zero infrastructure** — the entire pipeline runs on GitHub Actions' free tier on a schedule; nothing to host
- **Test scripts included** — `test-adzuna.js` and `test-email.js` let you validate each integration independently before running the full pipeline

## Prerequisites

- Node.js ≥ 18
- API credentials for:
  - [Google Gemini](https://aistudio.google.com/app/apikey) (free tier available)
  - [Adzuna](https://developer.adzuna.com) (free tier: 250 requests/day)
  - [France Travail](https://francetravail.io/data/api/offres-emploi) (free, requires account)
- A Gmail account with an [App Password](https://myaccount.google.com/apppasswords) for sending digest emails

## Installation

```bash
git clone https://github.com/jamesdoe6/veille-emploi-cyber.git
cd veille-emploi-cyber
npm install
cp env.gemini.example .env
# Fill in .env with your own credentials — see the inline comments in env.gemini.example
```

## Configuration

| Variable | Description | Required |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini API key, used for scoring listings | Yes |
| `FT_CLIENT_ID` / `FT_CLIENT_SECRET` | France Travail API OAuth2 credentials | Optional — enables the France Travail source |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | Adzuna API credentials | Yes |
| `EMAIL_TO` | Recipient address for the daily digest | Yes |
| `EMAIL_FROM` / `SMTP_USER` | Sender Gmail address | Yes |
| `SMTP_PASS` | Gmail App Password (not your regular password) | Yes |
| `SMTP_HOST` / `SMTP_PORT` | SMTP server settings (defaults to Gmail) | Yes |

## Usage

**Run locally:**
```bash
node veille-emploi-gemini.js
```

**Test individual integrations before a full run:**
```bash
node test-adzuna.js   # verify Adzuna API connectivity
node test-email.js    # verify SMTP configuration
```

**Automated runs:** the pipeline runs on a schedule via `.github/workflows/veille.yml`. Configure the same environment variables as [repository secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions) (Settings → Secrets and variables → Actions) — GitHub Actions injects them at runtime, they are never stored in the repo.

## Project structure

```
.
├── .github/workflows/veille.yml   # GitHub Actions schedule + pipeline steps
├── veille-emploi-gemini.js        # Main pipeline: fetch → score → filter → email
├── test-adzuna.js                 # Adzuna API integration test
├── test-email.js                  # SMTP integration test
├── veille-seen-ids.json           # Deduplication state (listing IDs already emailed)
├── env.gemini.example             # Template for local .env configuration
└── package.json
```

## Security notes

- No credentials are hardcoded anywhere in this codebase — all secrets are read from environment variables (`process.env`)
- `.env` is excluded via `.gitignore` and has never been committed to this repository
- In production (GitHub Actions), credentials are injected via [encrypted repository secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions), never written to disk in plaintext
- See [SECURITY.md](SECURITY.md) to report a vulnerability

## Roadmap

- [ ] Add a scoring weight configuration file instead of hardcoded thresholds
- [ ] Support additional job platforms
- [ ] Optional Slack/Telegram digest as an alternative to email

## License

MIT — see [LICENSE](LICENSE)