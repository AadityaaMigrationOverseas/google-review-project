# Deployment report — Stellar Review Portal

Date: 3 Nov 2026  
Auditor: local production-readiness pass on `/Users/aaditya/Desktop/Google-reviews`  
Rule: no fabricated Docker builds, mailbox screenshots, or SPF/DKIM “pass” results.

---

## 1. Initial audit

### Stack

| Layer         | Technology                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| Runtime       | Node 24 (this Mac: v24.21.0)                                                                                   |
| HTTP          | Fastify 5, `@fastify/cookie`, `@fastify/static`                                                                |
| UI            | Vanilla TypeScript, Vite 8 multi-page build (`review`, `complaint`, `admin`, `privacy`, `404`, `link-invalid`) |
| Shared        | `@stellar/shared` validators, routing, DTOs                                                                    |
| DB            | Node 24 `node:sqlite`, WAL, SQL migrations on boot                                                             |
| Sentiment     | Long-lived C++ DistilBERT ONNX workers (`sentiment_server`)                                                    |
| Email         | Nodemailer SMTP + transactional outbox                                                                         |
| Reverse proxy | Caddy (`deploy/Caddyfile`)                                                                                     |

### Why Vercel serverless and Bluehost shared hosting cannot run the backend

The process is a **single long-lived Node server** that:

1. Holds a SQLite file plus WAL on disk (`DATABASE_PATH`).
2. Spawns C++ workers that load a ~256 MB ONNX model (~560 MB RSS each).
3. Runs timers: email outbox poll, sentiment retry, retention purge.
4. Keeps in-memory rate-limit buckets and form-token replay state.

Vercel serverless functions are ephemeral, read-only, and have no subprocess/ONNX budget. Bluehost **shared** hosting is Apache/PHP, not Docker/Node 24/C++. **Required host:** Linux VPS / Cloud / dedicated (Bluehost VPS is acceptable) with Docker or Node 24 + C++17.

Frontend-only Vercel is optional and **must** rewrite `/api` to the VPS so the browser stays same-origin (`connect-src 'self'`, session cookies, origin checks). Cross-origin POSTs are rejected.

### `YOUR_BACKEND_URL`

`web/vercel.json` previously proxied `/api` and `/r` to `https://YOUR_BACKEND_URL/...` and fell through to a non-existent `index.html`. That would 404 every page on Vercel.

---

## 2. Modifications

### Hosting / Docker / proxy

- Added `compose.yaml`: production-shaped Compose, `127.0.0.1:3000`, `TRUST_PROXY=loopback`, SQLite volume, read-only model mount.
- Replaced `web/vercel.json` with multi-page HTML rewrites. `scripts/generate-vercel-config.mjs` + `npm run vercel-build` add `/api` and `/healthz` proxies when `BACKEND_ORIGIN` is a valid `https` origin.
- Documented Caddy topology: app **must** use `TRUST_PROXY=loopback` so rate limits hash the real client IP.
- systemd unit comments now require `DATABASE_PATH` under `ReadWritePaths`.
- `.dockerignore` tightened (secrets, logs, reports). `.gitignore` ignores local scratch logs.

### SMTP

- Production boot calls `SmtpTransport.verify()` and **exits** if SMTP is down.
- `npm run email:verify` — connection/auth check, no message.
- `npm run email:test` — one authorized test email to `COMPLAINT_NOTIFY_TO` with **no patient data**.

### Cleanup (unused)

Deleted: `ZZbuild_log.txt`, `ChangingTheRoutingRule_log.txt`, `RemoveChromeExtension_OutputLogs.txt`, `sentiment-engine-report.md`.  
Removed unused `isAppError` from `server/src/http/security.ts`. Chrome extension was already gone.

### Preserved behaviour

Patient Google option for every rating, private complaint as an extra choice, clipboard Google handoff, C++ sentiment for staff flags only, admin RBAC, short links, outbox email.

---

## 3. Security improvements

| Change                                             | Effect                                                  |
| -------------------------------------------------- | ------------------------------------------------------- |
| SMTP verify on production boot                     | Fail closed if mail cannot send                         |
| `TRUST_PROXY=loopback` in Compose + Caddy comments | Rate limits and IP hashes use the client, not 127.0.0.1 |
| No hop-count `TRUST_PROXY`                         | Unchanged; hop counts still rejected                    |
| Secrets                                            | `.env` still gitignored; not copied into the image      |
| CSP / cookies / CSRF / origin check                | Unchanged, still same-origin                            |

### Remaining security notes (not silently “fixed”)

- `/api/reviews/submit` and `/api/complaints/submit` still do **not** consume form tokens (only `/api/public/*` does). Frontend sends a token on review submit but the new routes ignore it. Left unchanged to avoid breaking the live review/escalation path without a dedicated token pass.
- Form-token “used” set is in-memory (replays after restart until TTL).
- `STAFF_PASSWORD` env for `admin:create` is convenience-only; prefer TTY prompt on the VPS.

---

## 4. Hosting decision

| Target                           | Verdict                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| **Primary**                      | Docker or systemd + Caddy on a Linux VPS. One HTTPS origin.                    |
| **Bluehost shared**              | Not supported.                                                                 |
| **Bluehost VPS / any Linux VPS** | Supported. Install Docker Engine, mount models, set `/etc/stellar-portal/env`. |
| **Vercel frontend**              | Optional static host only. Set `BACKEND_ORIGIN`. Do not put the API on Vercel. |

Exact commands: see README “Deployment”.

---

## 5. Docker build log

**Location:** `deploy/docker-build.log`

**Result: not built.** This Mac has Node 24 and no Docker Engine.

```
command -v docker exit=1
docker: command not found
docker --version exit=127
docker compose version exit=127
docker build -t stellar-portal . exit=127
```

Dockerfile / Compose were not executed. **Do not treat this as a green image build.** Run `docker compose up -d --build` on a machine that has Docker, then `curl -sS https://reviews.stellardentalclinic.com/healthz`.

Local Node smoke (same log file, not Docker): `GET /healthz` → `200 {"status":"ok","db":true,"sentimentReady":true}`; `/`, `/review`, `/complaint`, `/privacy`, `/admin` → 200.

---

## 6. Testing results

| Check                                             | Result                                                    |
| ------------------------------------------------- | --------------------------------------------------------- |
| `npm run check` (Prettier, ESLint, `tsc`, Vitest) | Pass — **115** tests                                      |
| `npm run test:e2e`                                | **29 passed, 1 skipped** (keyboard stars on mobile)       |
| `npm run build:app`                               | Pass                                                      |
| `npm run email:verify`                            | Exit **2** — `EMAIL_TRANSPORT=console`, `SMTP_HOST` empty |
| `npm run email:test`                              | Exit **2** — same; no message sent                        |
| `docker build`                                    | **Not run** — Docker missing                              |

---

## 7. SMTP verification status

**Not sent. No mailbox screenshot. No delivery evidence.**

Local `.env`: `EMAIL_TRANSPORT=console`, `SMTP_HOST` empty, `SMTP_USER` empty, `SMTP_PASSWORD` empty. Sending would be a lie.

To complete for real:

1. Put provider credentials in `/etc/stellar-portal/env` (chmod 600), never in git.
2. `EMAIL_TRANSPORT=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`.
3. `EMAIL_FROM` must be a mailbox the provider is allowed to send (SPF/DKIM).
4. `COMPLAINT_NOTIFY_TO=aaditya@migrationoverseas.com`.
5. `npm run build:app && npm run email:verify && npm run email:test`.
6. Open the clinic inbox, save a screenshot of From / To / Subject / time / body (no passwords).
7. Read `Authentication-Results` on that message (`spf=pass`, `dkim=pass`).

---

## 8. SPF / DKIM (public DNS only)

Lookups against `stellardentalclinic.com` on 3 Nov 2026. This is **publication**, not a received-mail pass.

| Record      | Value                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| NS          | `ns1.hostmonster.com` / `ns2.hostmonster.com` (HostMonster / Bluehost DNS)                            |
| MX          | `0 mail.stellardentalclinic.com` ; `10 stellardentalclinic.com`                                       |
| SPF (`TXT`) | `v=spf1 a mx ip4:67.20.114.203 include:eig.spf.a.cloudfilter.net include:spf.websitewelcome.com ~all` |
| DKIM        | `default._domainkey` — `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A…` (key present)            |
| DMARC       | `v=DMARC1; p=none; rua=mailto:smit@stellardentalclinic.com; adkim=r; aspf=r`                          |
| Extra TXT   | `zoho-verification=zb59019892.zmverify.zoho.in`                                                       |

**SPF/DKIM pass on a received message: unknown.** No test email was accepted by a mailbox, so Authentication-Results were not inspected.

If `EMAIL_FROM` is sent through Gmail, Microsoft 365, or Zoho SMTP, the current SPF (`websitewelcome` / `eig` / one IPv4) will **fail** unless that provider is added to SPF and a matching DKIM selector is published. Align `EMAIL_FROM` with the actual SMTP host before go-live. DMARC is `p=none` (monitor only).

---

## 9. Unresolved issues / manual actions

1. Install Docker on the VPS (or this Mac) and run `docker compose up -d --build`; keep `deploy/docker-build.log` from that machine.
2. Provide SMTP credentials and authorization to mail `aaditya@migrationoverseas.com`; run `npm run email:test`; capture a real inbox screenshot.
3. Confirm Authentication-Results on that test (`spf=pass dkim=pass`) for the chosen `EMAIL_FROM`.
4. Generate `APP_SECRET` (≥ 32 chars) and a production `https` `APP_BASE_URL`; never commit them.
5. Place model files on the VPS (`distilbert-sst2.onnx`, `vocab.txt`) and mount them read-only.
6. Create the first admin: `npm run admin:create`.
7. Point DNS A/AAAA for `reviews.stellardentalclinic.com` at the VPS; install Caddy with `deploy/Caddyfile`.
8. Optional: tighten form-token checks on `/api/reviews/submit` and `/api/complaints/submit` in a follow-up.
9. Optional: raise DMARC from `p=none` after SPF/DKIM pass in production mail.

---

## 10. File list

**Added:** `compose.yaml`, `scripts/generate-vercel-config.mjs`, `server/src/cli/verifySmtp.ts`, `server/src/cli/sendTestEmail.ts`, `deploy/docker-build.log`, `DEPLOYMENT_REPORT.md`

**Updated:** `README.md`, `.env.example`, `.gitignore`, `.dockerignore`, `package.json`, `web/vercel.json`, `deploy/Caddyfile`, `deploy/stellar-portal.service`, `server/src/index.ts`, `server/src/container.ts`, `server/src/http/security.ts`

**Deleted:** `ZZbuild_log.txt`, `ChangingTheRoutingRule_log.txt`, `RemoveChromeExtension_OutputLogs.txt`, `sentiment-engine-report.md`
