# Security and privacy model

LedgerLens holds bank statements. This document says what it protects, how, and where the limits are.

## What is protected

| Asset | Where it lives | Main risk |
|---|---|---|
| Statements, receipts | Wherever you keep them; read in memory on import | Committed to git by accident |
| The ledger | `data/ledgerlens.db` (git-ignored) | Committed, or read by another site in your browser |
| API keys | `.env` (git-ignored) or the environment | Committed, logged |
| Personal identifiers | Inside the documents | Sent to a third party, or left in a fixture |

## Keeping data out of the repository

Four independent layers. Any one of them failing does not expose data.

| Layer | Mechanism | Stops |
|---|---|---|
| 1 | `.gitignore` ignores financial and secret file types anywhere in the tree | `git add .` picking up a statement |
| 2 | `scripts/privacy-guard.mjs` as pre-commit and pre-push hooks | `git add -f`, a pasted key, an address in a comment |
| 3 | CI runs the guard on all tracked files and gitleaks on the full history | A commit made with `--no-verify` or from a clone without hooks |
| 4 | Fixtures, demo and screenshots come from a seeded generator | Any need to commit real data |

The guard checks, on the staged content rather than the working tree:

- **File types**: PDFs, emails, spreadsheets, databases, archives, photos and key files, unless under `**/fixtures/synthetic/`, `docs/screenshots/` or `web/public/`.
- **Credentials**: Anthropic, OpenAI, GitHub, AWS, Google, Slack, Stripe and Postman key formats; private key blocks; high-entropy values assigned to names like `api_key` or `password`.
- **Identifiers**: payment card numbers (network prefix, length and Luhn check digit), Canadian SINs.
- **Your denylist**: every line of `.privacy-denylist`, matched case-insensitively against file contents and file names. Put your street, postal code, account and loyalty numbers there. The file is git-ignored and the guard refuses to commit it.

It prints a masked preview, never the value it found, and fails closed if it cannot run.

## The running application

| Control | Detail |
|---|---|
| Loopback by default | Binds `127.0.0.1`. Starting on any other host without `API_TOKEN` is a fatal configuration error. |
| DNS rebinding | When bound to loopback, requests whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]` get 403. |
| CSRF | A state-changing request with an `Origin` that differs from `Host` gets 403. No CORS headers are ever sent. |
| Authentication | Optional bearer token, compared in constant time. Required in the container image. |
| Input | Every body and query string is validated with Zod; unknown keys are rejected. SQL is parameterized; sort columns come from a fixed whitelist. |
| Uploads | Size-limited, held in memory, never written to disk. The document type is detected from content. PDFs are read for their text layer only. |
| Output | Errors are problem-details JSON with a request id. Unexpected errors return a generic message; the detail goes to the server log only. |
| Logging | Method, path and status. No query strings, bodies, hostnames or headers. |
| Headers | Helmet with a strict Content-Security-Policy, `no-store` on API responses, `frame-ancestors 'none'`. |
| Storage | Card numbers are never stored beyond the last four digits (enforced by a `CHECK` constraint). Loyalty and customer numbers on receipts are never extracted. |
| Rate limits | General limit on the API, a tighter one on parsing and AI routes. |
| Container | Runs as a non-root user; compose file uses a read-only root filesystem and drops all capabilities. |

## What leaves the machine

Nothing, unless `ANTHROPIC_API_KEY` is set **and** you use an AI feature. Each feature sends the minimum it needs:

| Feature | Sent | Not sent |
|---|---|---|
| Categorize merchants | Merchant names that have no category | Amounts, dates, locations, notes |
| Insights | Aggregates: totals by category and by merchant, counts, weekday averages | Individual transactions |
| Read a statement | Lines shaped like a transaction or a total, after redaction | Name and address blocks; card and account numbers, emails, phone numbers, postal codes, and any term in `REDACT_TERMS` are masked |

Model output is treated as untrusted input. It must match a schema, is validated again locally, and an AI-read statement is reconciled against the document's printed totals exactly like a built-in parse. Categories come from an enum built from your category list, so the model cannot invent one.

## Limits

- The database is not encrypted at rest. Use full-disk encryption.
- Anyone with access to your user account can read the database file.
- A statement that prints no totals (a CSV export) cannot be verified; the UI says so.
- Merchant names sent for AI categorization can themselves be sensitive. The feature is opt-in per click.

## Reporting a problem

Open a private security advisory on the GitHub repository rather than a public issue.
