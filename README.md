# Stellar Dental Clinic — Review Portal

A patient feedback portal for **Stellar Dental Clinic** and **Dr. Dhruvi Shah**:

- **Patients** open a short link (WhatsApp / SMS / QR), rate 1–5 stars, write a review, and are then _offered_ the
  clinic's Google review page as an optional next step. Anyone with a problem can report it privately.
- **The clinic** gets every private complaint emailed to `aaditya@migrationoverseas.com` (test inbox), plus a staff dashboard
  for reviews, sentiment analytics, complaints, short links / QR codes, and staff accounts.
- **Sentiment** is computed server-side by the supplied C++ DistilBERT engine (`UpdatedUltra-low-latency.cpp`), kept
  warm in a process pool (p50 ≈ 19 ms per review on an Intel i7).

## Feedback workflow

1. **Landing & Input (`/`, `/review`, `/r/:code`):** Patient selects 1–5 stars and enters review text. The **Submit Review** button remains disabled until at least 1 star is selected and the normalized review text reaches at least 5 characters. An active `sessionId` is maintained for tracing.
2. **Real-Time Verification (`POST /api/sentiment/preview`, 350 ms debounce):** As the patient types, the frontend sends the text to the backend, which queries the persistent C++ DistilBERT worker pool (~19 ms) and caches the predicted label (`POSITIVE` or `NEGATIVE`) and confidence so final submission resolves instantaneously.
3. **Authoritative Submission (`POST /api/reviews/submit`):** The patient-facing next step is **always Google** (`next: "google"`) — every patient is shown the Google review option with equal prominence, with the private complaint form offered as an extra choice. Google's policy forbids "review gating" (steering only happy patients to review), so rating and sentiment never decide what the patient sees.
   - The response still carries an **internal-only** `status` for staff reporting and flags: `POSITIVE` when `rating >= 4` AND `sentiment == 'positive'`; otherwise `NEGATIVE` (covering low stars, `neutral`, `uncertain`, or a rating/sentiment mismatch). When C++ inference times out (`> 1000 ms`) or is unavailable, the status falls back to the star heuristic (`rating >= 4` → `POSITIVE`). This drives the admin dashboard's sentiment analytics and the rating/text mismatch flag — not the patient's routing.
4. **Google Review Handoff (Copy & Paste) — shown to every patient:**
   - Immediately copies `reviewText` to the clipboard within the user-gesture context (`navigator.clipboard.writeText` with `document.execCommand('copy')` fallback).
   - Opens Google's native review box in a new tab (`https://search.google.com/local/writereview?placeid=<GOOGLE_PLACE_ID>` or configured `GOOGLE_REVIEW_URL`) and displays an animated toast: _"Review copied to clipboard! Opening Google Reviews—simply press Paste (Ctrl+V / Cmd+V) to post."_ **The patient pastes and posts the review themselves** — browsers enforce the Same-Origin Policy, so the portal cannot read Google's page or type into it on the patient's behalf.
   - If clipboard permissions are blocked, immediately displays a one-click floating modal (_"Click here to copy and continue"_). If a popup blocker intercepts `window.open`, displays an inline high-visibility button (_"Proceed to Google Reviews"_).
5. **Private Complaint Form (offered as an extra choice):**
   - The success screen always offers a **"Tell the clinic privately"** option. Choosing it reveals the **Internal Escalation Form** (`#escalation-view`) in-place (no page reload) with a locked read-only preview accordion of the submitted star rating and review text, and pre-validated fields (**Full Name**, **Phone Number**, **Email Address**). The standalone `/complaint` page offers the same form for anyone who prefers it.
   - Submitting posts to `POST /api/complaints/submit`, stores the complaint in SQLite, records an audit log entry, queues the automated doctor alert email, and transitions in-place to the confirmation screen: _"Your message has been sent directly to the doctor's management desk. We will contact you within 24–48 hours."_

### Google integration — what is and isn't possible

Verified against the Business Profile API reference and FAQ (Oct 2026); implemented in
`server/src/services/google/reviewDestination.ts`:

| Capability                                  | Supported by Google?                                                                                          | Used here                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Send a user to the "Write a review" dialog  | Yes — `https://search.google.com/local/writereview?placeid=…` (the location's `newReviewUrl`) or a share link | Yes. Set `GOOGLE_PLACE_ID` for the direct dialog; defaults to the share link                                                         |
| Prefill review text or stars                | **No** — no URL parameter, no API                                                                             | Patient's text is copied to the clipboard on tap instead                                                                             |
| Create/submit a review on the user's behalf | **No** — Reviews API only `list`s reviews and manages the owner's `reply`                                     | Never; also forbidden by Google policy                                                                                               |
| Confirmation that a review was posted       | **No** callback or webhook                                                                                    | UI never claims "posted"                                                                                                             |
| Read the clinic's reviews / reply to them   | Yes — Business Profile Reviews API (OAuth 2.0, approved Google Cloud project, Profile owner/manager access)   | **Not implemented**: requires the clinic's Google credentials. The destination service is the seam where such a client would plug in |

Destination URLs are restricted to `https` Google hosts, so a misconfigured `GOOGLE_REVIEW_URL` cannot become an open
redirect.

---

## Architecture

```
Browser (vanilla TS, ~11 KB gz)          Node 24 · Fastify 5                         C++ engine
┌───────────────────────────┐   JSON   ┌──────────────────────────────────┐ stdin/  ┌──────────────────────┐
│ /review  /complaint       │ ───────► │ http/  routes · CSRF · headers    │ stdout  │ sentiment_server     │
│ /r/:code  /privacy        │          │ services/  review · complaint ·   │ ──────► │  (wraps the supplied │
│ /admin (staff SPA)        │ ◄─────── │   sentiment · google · email ·    │ ◄────── │   .cpp unchanged)    │
│                           │          │   auth · security                 │         │                      │
└───────────────────────────┘          │ repositories/ → SQLite (WAL)      │  pool   │ ONNX Runtime 1.17.1  │
                                       └───────────────┬──────────────────┘         └──────────────────────┘
                                                       │ SMTP (outbox, retries)
                                                       ▼
                                           aaditya@migrationoverseas.com
```

| Concern      | Decision                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Layering     | `http → services → repositories → db`; all wiring in one composition root (`container.ts`)     |
| DI / testing | Clock, DB, sentiment analyzer, email transport, password hasher injectable for tests           |
| Shared rules | `shared/` holds validators, limits and DTOs used by both browser and server (DRY)              |
| Storage      | Built-in `node:sqlite`, STRICT tables, SQL migrations applied on boot                          |
| Sentiment    | Long-lived C++ workers, line protocol, timeouts, crash restart, backpressure, async retry      |
| Email        | Transactional outbox: complaint + email row committed atomically, worker delivers with backoff |
| Frontend     | No framework; multi-page Vite build, precompressed (brotli/gzip), immutable hashed assets      |

### Repository layout

```
shared/            Validation, constants, API DTOs (browser + server)
server/src/
  config/env.ts    Typed, validated configuration (fails fast on insecure production config)
  db/              Connection, migration runner, migrations/*.sql
  repositories/    SQL (prepared statements only)
  services/        sentiment/ google/ email/ auth/ security/ + review, complaint, shortLink, stats, retention
  http/            app, security headers, auth/CSRF guards, routes/
  cli/             migrate, createUser, purge
server/test/       unit/ + integration/ (Vitest; real C++ engine + fake-engine fixture)
web/               Vite pages (review, complaint, privacy, admin, 404, link-invalid), partials, src/
  src/components/  starRating, form (FormController), reviewNextStep (thank-you / Google / complaint step)
  src/lib/         api, dom (XSS-safe h()), clipboard, formToken, reviewSession, complaintPrefill
sentiment-engine/  vendor/ (original .cpp, unmodified), src/sentiment_server.cpp (wrapper), Makefile
e2e/               Playwright specs (desktop + Pixel 7) and test server bootstrap
deploy/            Caddyfile, systemd unit
compose.yaml       Docker Compose for a Linux VPS (Caddy on the host, TRUST_PROXY=loopback)
```

### Data flow

1. **Review**: `GET /api/public/form-token` → `POST /api/reviews/submit` (the review page) or `POST /api/public/reviews`
   (legacy) → validated → C++ sentiment (≤ `SENTIMENT_TIMEOUT_MS`) → stored → `{ id, googleReviewUrl, sentiment, next: "google" }`.
   If the engine is unavailable the review is still stored as `pending` and re-analysed by a background loop.
2. **Complaint**: `POST /api/complaints/submit` (in-page escalation) or `POST /api/public/complaints` (standalone page)
   → complaint row + outbox row in one transaction → reference `SDC-XXXXXXXX` returned → outbox worker emails the clinic.
3. **Short link**: `GET /r/:code` → active link serves the review page (click counted, review attributed);
   unknown/disabled/expired → friendly 404 with a link to the general review page. No open redirects.

---

## C++ sentiment engine

- `vendor/UpdatedUltra-low-latency.cpp` is a byte-for-byte copy of the supplied file (SHA-256 `2463b3e7…`).
- `src/sentiment_server.cpp` renames its `main` and `#include`s it, then adds a persistent stdin/stdout protocol:
  - `READY\t1` handshake after model load + warm-up
  - request `<id>\t<text>` → `<id>\tOK\t<LABEL>\t<confidence>\t<p_positive>\t<tokens>\t<micros>` or `<id>\tERR\t<CODE>`
- The wrapper replaces non-ASCII and control bytes with spaces before they reach the supplied tokenizer (the original
  calls `isalnum` on signed chars — undefined behaviour) and truncates to the model's 512-token limit. The model is
  English SST-2, so a review written only in Hindi or Gujarati has no readable words left. Node stores that as
  **`uncertain`** for staff, not as a skipped review. Roman-script Hinglish is scored normally. None of this changes
  the patient path: every patient still gets the Google option, with the private complaint form as an extra choice.
- Node side (`cppEngine.ts`): `spawn` with `shell: false`, an argument array and a minimal environment (no command
  injection surface); text travels over stdin, never argv. Per-request deadline with `SIGKILL`, exponential restart
  backoff, crash-loop fail-fast, bounded queue (`OVERLOADED`), protocol-desync recycling.
- **Four classes from a binary model**: SST-2 has no neutral class, so confidence below
  `SENTIMENT_NEUTRAL_THRESHOLD` (0.75) is stored as `neutral` and below `SENTIMENT_UNCERTAIN_THRESHOLD` (0.6) — or any
  internally inconsistent output — as `uncertain`. Reviews whose stars disagree with the text are flagged for staff.

Build:

```bash
sentiment-engine/scripts/fetch-onnxruntime.sh   # ORT 1.17.1 for macOS/Linux, x64/arm64
make -C sentiment-engine                         # → sentiment-engine/build/sentiment_server
make -C sentiment-engine check                   # classifies two sample sentences
```

Model files go in `sentiment-engine/models/` (see its README).

---

## Getting started

**Prerequisites**: Node ≥ 24, a C++17 compiler (Xcode CLT / build-essential), `make`, `curl`, and the model files.

```bash
npm ci
sentiment-engine/scripts/fetch-onnxruntime.sh
ln -s /path/to/distilbert-sst2.onnx /path/to/vocab.txt sentiment-engine/models/
cp .env.example .env            # defaults work for local development (emails are logged, not sent)
npm run build                   # C++ engine + shared + server + web
npm run admin:create -- --email you@stellardentalclinic.com --name "Your Name" --role admin
npm start                       # http://localhost:3000  (staff: /admin)
```

Development with hot reload: `npm run dev` (API on :3000 via tsx, Vite on :5173 proxying `/api`).

### Commands

| Command                   | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `npm run build`           | Build C++ engine and all TypeScript workspaces                       |
| `npm start`               | Run the production server (reads `.env` if present)                  |
| `npm run db:migrate`      | Apply migrations (also automatic on boot)                            |
| `npm run admin:create`    | Create a staff account (hidden password prompt, or `STAFF_PASSWORD`) |
| `npm run email:verify`    | Verify SMTP credentials (`EMAIL_TRANSPORT=smtp` required)            |
| `npm run email:test`      | Send one authorized test message to `COMPLAINT_NOTIFY_TO`            |
| `npm run vercel-build`    | Optional Vercel static build; set `BACKEND_ORIGIN` to proxy `/api`   |
| `npm run retention:purge` | Run the retention purge once (also runs daily in-process)            |
| `npm run check`           | Prettier check + ESLint + typecheck + unit/integration tests         |
| `npm run test:e2e`        | Playwright E2E against the production build (run `build` first)      |

First-time E2E setup: `npx playwright install chromium`.

---

## Configuration

All configuration is environment-driven and validated at startup; see **`.env.example`** for every variable with
defaults. Production refuses to start without: `https` `APP_BASE_URL`, `APP_SECRET` (≥ 32 chars),
`EMAIL_TRANSPORT=smtp` with `SMTP_HOST` and `EMAIL_FROM`.

Key variables: `APP_BASE_URL`, `APP_SECRET`, `TRUST_PROXY`, `SHORT_LINK_BASE_URL`, `SHORT_LINK_HOST`,
`GOOGLE_REVIEW_URL`, `GOOGLE_PLACE_ID`, `DATABASE_PATH`, `SENTIMENT_*` (incl. `SENTIMENT_NEUTRAL_THRESHOLD`,
`SENTIMENT_UNCERTAIN_THRESHOLD`), `EMAIL_TRANSPORT`, `SMTP_*`, `COMPLAINT_NOTIFY_TO`, `RETENTION_*_DAYS`.

Schema changes are SQL files in `server/src/db/migrations/` and are applied automatically on boot (or via
`npm run db:migrate`); `002_review_uncertain_idempotency.sql` rebuilds the reviews table for the `uncertain` label and
the idempotency key, preserving existing rows.

### Email

- Transports: `smtp` (production), `console` (logs metadata only — never PII), `disabled`.
- SMTP enforces TLS (STARTTLS required on 587, or implicit TLS with `SMTP_SECURE=true` on 465), TLS ≥ 1.2.
- Credentials come only from the environment / secret store. Use an app-specific password or provider API key
  (e.g. Google Workspace SMTP relay, Amazon SES, Postmark). Configure SPF/DKIM for `EMAIL_FROM`'s domain.
- Delivery: outbox with leases, retries at 30 s → 2 m → 10 m → 30 m → 2 h → 6 h (`EMAIL_MAX_ATTEMPTS`),
  permanent SMTP 5xx stops retrying, stable `Message-ID` per complaint prevents duplicates. Status and errors are
  visible per complaint in the dashboard; managers can retry.
- The subject line carries no PII. Set `EMAIL_INCLUDE_DETAILS=false` to send only the reference and a dashboard link.

### Short links

- Codes: 7 random base62 characters (`SHORT_LINK_CODE_LENGTH`), ~3.5 × 10¹² space, collision-retried.
- Default URL form `https://<APP_BASE_URL>/r/<code>`. For a dedicated domain, set
  `SHORT_LINK_BASE_URL=https://stlr.link` and `SHORT_LINK_HOST=stlr.link`, and route that domain to the server.
- Staff create, label, expire, disable links and download QR codes (SVG) in **Dashboard → Review links**; the
  WhatsApp / SMS buttons prefill a polite message.
- Lookups are rate limited per IP and cached for 30 s; malformed codes are rejected before any database lookup.

---

## Security

| Area      | Control                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------- |
| Auth      | scrypt (N=2¹⁷) passwords, ≥ 12 chars / 3 classes; 5 failures → 15-min lockout; timing-safe         |
| Sessions  | Random token, only SHA-256 stored; `HttpOnly; SameSite=Strict; Secure; __Host-` cookie             |
|           | 60-min idle / 12-h absolute expiry; revoked on logout, role change and deactivation                |
| CSRF      | Per-session token in `X-CSRF-Token` + Origin / `Sec-Fetch-Site` checks + JSON-only bodies          |
| RBAC      | `staff` (links, reviews, masked complaints) · `manager` (+ PII, status, retry) · `admin` (+ users) |
| PII       | Masked for `staff`; PII views audit-logged; IPs stored only as keyed HMAC; logs redact PII         |
| Injection | Prepared statements only; no shell; C++ input via stdin; DOM built with `textContent` only         |
|           | (ESLint bans `innerHTML`); email HTML escaped                                                      |
| Headers   | Strict CSP (`script-src 'self'`), `frame-ancestors 'none'`, nosniff, no-referrer, HSTS (prod)      |
| Abuse     | Per-IP rate limits, signed single-use form tokens with minimum fill time, honeypot, 32 KB body cap |
| Privacy   | Explicit consent (versioned) on both forms; privacy notice at `/privacy`; configurable retention   |

`TRUST_PROXY` must name your proxy (e.g. `loopback`), not a hop count: Fastify ignores hop counts because they're
spoofable, which would otherwise collapse every patient onto the proxy's IP for rate limiting.

---

## Testing

| Suite                | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                    | Result                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Unit (Vitest)        | Validation, routing rule, 4-way sentiment mapping + engine-output validation, Google destination (deep link, host allow-list), process pool (hangs, crashes, garbage, overload), outbox, rate limiter, form tokens, RBAC, passwords, templates, config                                                                                                                                                                                            | 115 passing (with integration)                  |
| Integration (Vitest) | Real C++ engine (positive / negative / low-confidence / unicode / 512-token), full HTTP API, review + complaint idempotency, uncertain verdicts, CSRF, RBAC, PII masking, email, short links, headers, proxy IPs                                                                                                                                                                                                                                  | (included above)                                |
| E2E (Playwright)     | Positive flow (exact text preserved on screen, copy to clipboard, explicit Google tap, back-from-Google restore, patient pastes manually), decline, clipboard-denied fallback, popup-blocked fallback, every patient (even 1-star) sees Google with the private complaint form offered as an extra choice, validation, keyboard stars, invalid link, admin login, link → review attribution, sign-out, no horizontal overflow (desktop + Pixel 7) | 29 passing, 1 skipped (keyboard test on mobile) |

---

## Deployment

**Recommended production topology: Docker (or systemd) + Caddy on a Linux VPS.** One HTTPS origin serves the Vite pages and the API. This matches `connect-src 'self'`, session cookies, and CSRF.

This backend **cannot** run on Vercel serverless or Bluehost **shared** hosting. It is a long-lived Node 24 process with:

- a SQLite file (`DATABASE_PATH`) and WAL files that need durable writable disk
- a pool of C++ DistilBERT workers (~560 MB RSS each) loading ONNX from disk
- in-process timers (email outbox, sentiment retry, retention)
- in-memory rate-limit buckets and form-token replay protection

**Bluehost:** use a **VPS / Cloud / dedicated** plan with Docker or Node 24 + a C++17 toolchain. Shared hosting (Apache/PHP only) is not compatible.

### Docker (VPS)

Model files must be present at `sentiment-engine/models/distilbert-sst2.onnx` and `vocab.txt` (not in git; see `sentiment-engine/models/README.md`). Production secrets live in `.env` or `/etc/stellar-portal/env` (never in the image).

```bash
# Production-shaped Compose: binds 127.0.0.1:3000, TRUST_PROXY=loopback, SQLite volume
docker compose up -d --build

# Equivalent manual commands
docker build -t stellar-portal .
docker run -d --name stellar-portal --restart unless-stopped -p 127.0.0.1:3000:3000 \
  --env-file /etc/stellar-portal/env \
  -e NODE_ENV=production -e HOST=0.0.0.0 -e TRUST_PROXY=loopback \
  -e DATABASE_PATH=/data/portal.sqlite \
  -v stellar-data:/data \
  -v /srv/models:/app/sentiment-engine/models:ro \
  stellar-portal
```

Front the published port with `deploy/Caddyfile` (`TRUST_PROXY=loopback` on the app). Point DNS A/AAAA for `reviews.stellardentalclinic.com` at the VPS; Caddy issues HTTPS automatically.

### systemd (VM / bare metal)

Build on the target OS/arch (the engine links ONNX Runtime by absolute rpath), copy to `/opt/stellar-portal`, set `DATABASE_PATH=/var/lib/stellar-portal/portal.sqlite` (must stay under the unit's `ReadWritePaths`), install `deploy/stellar-portal.service`, and front it with `deploy/Caddyfile`.

### Optional Vercel static frontend

Use this only if the API already runs on the VPS. The browser still calls `/api/*` on the Vercel hostname; rewrites proxy to the backend so cookies stay first-party.

1. In the Vercel project: Framework = Vite, Root Directory = `web` **or** Build Command = `npm run vercel-build` from the repo root.
2. Set `BACKEND_ORIGIN` to the public **https** origin of the Docker/Caddy API (no trailing slash), e.g. `https://reviews.stellardentalclinic.com`.
3. `scripts/generate-vercel-config.mjs` writes `web/vercel.json` (MPA routes plus `/api` and `/healthz` proxies). Do not leave `YOUR_BACKEND_URL` in the file.
4. Set the backend `APP_BASE_URL` (and `SHORT_LINK_BASE_URL` if used) to the URL patients actually open. If that URL is the Vercel host, also set `ALLOWED_ORIGINS` to it.

Monolith on Caddy remains the supported path. A split deploy without the rewrite proxy will fail: the server rejects cross-origin POSTs and CSP is `connect-src 'self'`.

### SMTP

Production requires `EMAIL_TRANSPORT=smtp`, `SMTP_HOST`, and `EMAIL_FROM`. Boot calls `transporter.verify()` and **exits** if the connection fails.

```bash
npm run build:app
npm run email:verify    # TCP/auth check, no message sent
npm run email:test      # sends one message with no patient data to COMPLAINT_NOTIFY_TO
```

Publish SPF and DKIM for the domain in `EMAIL_FROM` before going live. Confirm the received test in the clinic mailbox (Authentication-Results: `spf=pass` `dkim=pass`).

Checklist:

- [ ] Linux VPS (not Bluehost shared hosting); Docker or Node 24 + C++17
- [ ] HTTPS domain, `APP_BASE_URL`, `APP_SECRET` (≥ 32 chars) from a secret store
- [ ] SMTP credentials + SPF/DKIM; `npm run email:verify` and `npm run email:test`
- [ ] `TRUST_PROXY=loopback` when Caddy is on the same host
- [ ] Model files mounted; `GET /healthz` shows `db: true`
- [ ] First admin created with `npm run admin:create`
- [ ] Back up the SQLite file (e.g. `sqlite3 portal.sqlite ".backup ..."` nightly; WAL-safe)
- [ ] Decide `RETENTION_REVIEWS_DAYS` / `RETENTION_COMPLAINTS_DAYS` with the clinic's records policy

## Troubleshooting

| Symptom                                      | Fix                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Library not loaded: @rpath/libonnxruntime…` | Run `fetch-onnxruntime.sh`, then rebuild (`make -C sentiment-engine clean all`)      |
| `/healthz` shows `sentimentReady: false`     | Check `SENTIMENT_*` paths; run `make -C sentiment-engine check`; see server logs     |
| Reviews stuck as `pending` sentiment         | Engine down; they're re-analysed every `SENTIMENT_RETRY_INTERVAL_SECONDS`            |
| Complaint emails `failed`                    | Dashboard shows the SMTP error; fix credentials/TLS, then **Retry** on the complaint |
| "Too many requests" for everyone             | `TRUST_PROXY` missing or wrong behind a proxy                                        |
| Staff cookie not set on http://              | Expected in production (`Secure`); use HTTPS, or `COOKIE_SECURE=false` locally only  |
| Process exits at boot: smtp verification     | Fill `SMTP_*` and `EMAIL_FROM`; run `npm run email:verify`                           |
| Bluehost shared hosting 500 / no Node        | Move to a VPS and run Docker or systemd; shared hosting cannot run this stack        |

## Known limitations

- **Model domain**: SST-2 is trained on film reviews and is occasionally wrong on clinical language (e.g. "spotless"
  can score negative). Sentiment is advisory analytics only; stars and text are always shown to staff.
- **Single node**: SQLite and the in-memory rate limiter assume one server process. Scale-out needs a shared store
  (e.g. Postgres + Redis) behind the existing repository / limiter interfaces.
- **Memory**: each sentiment worker holds the model (~560 MB RSS measured; the Node server ~80 MB); size `SENTIMENT_WORKERS` accordingly.
- **Containers**: this development Mac has Node 24 but no Docker Engine (`docker: command not found`). Build the image on the VPS (or any machine with Docker) using the commands above; see `deploy/docker-build.log` for the local attempt.
