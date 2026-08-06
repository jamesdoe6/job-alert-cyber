# job-alert-cyber

> Automated daily job-search pipeline for cybersecurity roles — aggregates listings, scores them with AI against a candidate profile, and emails a filtered digest every day. Zero infrastructure: runs entirely on GitHub Actions.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)](package.json)
[![Automated](https://img.shields.io/badge/automation-GitHub%20Actions-blue)](.github/workflows/veille.yml)
[![Dependabot](https://img.shields.io/badge/Dependabot-enabled-success)](.github/dependabot.yml)

## Overview

Job searching in cybersecurity means checking multiple platforms every day for a handful of roles that actually fit — most listings don't. This project automates that first pass: it pulls job postings from the **Adzuna API** (which itself aggregates Indeed, LinkedIn, Monster, and more), scores each new listing against a defined candidate profile using **Google Gemini**, filters out irrelevant results, and emails a digest of only what's worth a look.

It runs on a schedule via GitHub Actions — no server to maintain, no machine that needs to stay on.

## How it works

```
GitHub Actions (scheduled cron)
        │
        ▼
Fetch listings ── Adzuna API (Indeed, LinkedIn, Monster...)
        │
        ▼
Deduplicate against previously seen listing IDs
        │
        ▼
Score each new listing ── Gemini API (batches of 3, custom weighted rubric)
        │
        ▼
Filter: keep only listings scoring above threshold
        │
        ▼
Mark ALL scored listings as "seen" (avoids re-scoring tomorrow)
        │
        ▼
Email digest of listings above threshold ── SMTP (Gmail)
```

## Features

- **Multi-source aggregation** via Adzuna, covering multiple major job boards in one call
- **AI-based relevance scoring** — each listing is evaluated against a weighted rubric (role fit, tech stack match, experience level, location, language requirements) rather than simple keyword matching
- **Score threshold filtering** — only listings above a configurable relevance score trigger an email, keeping the digest focused
- **Deduplication** — every scored listing (even low-scoring ones) is recorded, so nothing gets re-evaluated or re-emailed twice
- **Zero infrastructure** — runs entirely on GitHub Actions' free tier on a schedule
- **Test scripts included** — `test-adzuna.js` and `test-email.js` validate each integration independently before a full run

## Prerequisites

- Node.js ≥ 18
- A [Google Gemini API key](https://aistudio.google.com/app/apikey) (free tier available)
- An [Adzuna API](https://developer.adzuna.com) app ID + key (free tier: 250 requests/day)
- A Gmail account with an [App Password](https://myaccount.google.com/apppasswords) for sending digest emails (not your regular password)

## Getting started

```bash
git clone https://github.com/jamesdoe6/job-alert-cyber.git
cd job-alert-cyber
npm install
cp env.gemini.example .env
```

Open `.env` and fill in your own credentials — the file has inline comments explaining exactly where to obtain each one. **Never commit `.env`** — it's already excluded via `.gitignore`.

## Configuration

| Variable | Description | Required |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini API key, used for scoring listings | Yes |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | Adzuna API credentials | Yes |
| `EMAIL_TO` | Recipient address for the daily digest | Yes |
| `EMAIL_FROM` / `SMTP_USER` | Sender Gmail address | Yes |
| `SMTP_PASS` | Gmail App Password (not your regular password) | Yes |
| `SMTP_HOST` / `SMTP_PORT` | SMTP server settings (defaults to Gmail: `smtp.gmail.com` / `587`) | Yes |

The candidate profile used for scoring (target roles, tech stack, location, scoring rubric) is defined directly in `veille-emploi-gemini.js` under the `PROFILE` constant — edit it to match your own background if you fork this project.

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

**Automated runs:** the pipeline is triggered on a schedule via [`.github/workflows/veille.yml`](.github/workflows/veille.yml). To run it on your own fork:

1. Go to your fork's **Settings → Secrets and variables → Actions**
2. Add each variable from the [Configuration](#configuration) table as a repository secret (never as a plain variable — secrets are encrypted and hidden from logs)
3. The workflow will run automatically on its schedule, or trigger it manually from the **Actions** tab

## Project structure

```
.
├── .github/
│   ├── workflows/veille.yml       # GitHub Actions schedule + pipeline steps
│   └── dependabot.yml             # Automated dependency update checks
├── veille-emploi-gemini.js        # Main pipeline: fetch → dedup → score → filter → email
├── test-adzuna.js                 # Adzuna API integration test
├── test-email.js                  # SMTP integration test
├── veille-seen-ids.json           # Deduplication state (listing IDs already scored)
├── env.gemini.example             # Template for local .env configuration
└── package.json
```

## Security

- **No credentials are hardcoded anywhere** in this codebase — every secret is read from environment variables (`process.env`)
- `.env` is excluded via `.gitignore` and has never been committed to this repository's history
- In production (GitHub Actions), credentials are injected via [encrypted repository secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions) and are never written to disk in plaintext or exposed in logs
- Secret scanning and push protection are enabled on this repository
- Dependabot monitors dependencies for known vulnerabilities on a weekly schedule
- See [SECURITY.md](SECURITY.md) to report a vulnerability responsibly

**If you fork this project:** use `env.gemini.example` as your template, generate your own API keys, and never reuse credentials shown in commit history, screenshots, or issues from this or any other repository.

## License

MIT — see [LICENSE](LICENSE)