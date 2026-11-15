# Architecture and decisions

## Shape

A single Node process serves a REST API and, in production, the built React app. State is one SQLite file. There is no other moving part.

```
web/src            React pages -> TanStack Query -> typed fetch client
server/src/http    middleware (guards, validation, errors) and routes
server/src/services  importer, categorizer, receipts, analytics, insights
server/src/parsers   one module per document format, all returning the same shape
server/src/ai        the model gateway and the redaction that runs before it
server/src/db        connection, transactions, SQL migrations
```

Dependencies point one way: routes call services, services call the database and parsers. `createApp({ db, config, ai })` takes everything it needs as arguments, so tests build an app around an in-memory database and a stub model.

## Decisions

### Verify every parse against the document

Reading a PDF table is error-prone, and a silently dropped row makes every later number wrong. So a parser's output is never trusted on its own: the importer recomputes each figure the document prints and compares. This caught a real bug during development. A margin barcode shared a baseline with one transaction row, the row was skipped, and the count and total checks failed by exactly that row. The fixture generator now reproduces that layout as a regression test.

### A statement is a scope, not a date range

A statement lists what was *posted* in its period, so a purchase made the evening before the period opens belongs to it. Filtering by purchase date gives a total that is close to the statement's but not equal. Reports therefore accept either a date range or an `importId`; the statement scope selects by import and matches the printed total exactly, and it is compared with the previous statement on the same account rather than with a block of days.

### Money is integer cents; dates are ISO strings

No floating-point arithmetic touches an amount. Dates are calendar dates without a timezone, because that is what a statement prints.

### Deterministic first, model second

Built-in parsers and rules handle everything they can, offline and for free. The model is for perception only (an unfamiliar layout, an unfamiliar merchant name, phrasing an observation). Arithmetic, deduplication and storage decisions stay in code. A merchant the model categorizes is saved as a rule, so it is asked once.

### Categorization precedence

Transaction type, then rules (yours, then model-suggested, then built-in, longest pattern first), then the bank's own category, then Uncategorized. A category set by hand is marked `manual` and no later pass overrides it.

### Idempotent imports

Three levels: the file's SHA-256 (same file again), a per-transaction fingerprint of account, date, amount, merchant prefix and occurrence number (overlapping files, or the same statement as PDF and CSV), and a receipt fingerprint. An import can be rolled back; foreign keys cascade.

### `node:sqlite` and type stripping

Node's built-in SQLite driver means no native addon to compile, and running `.ts` files directly means no server build step. The cost is a Node 22.18+ requirement. The container image is correspondingly small and has no toolchain in it.

### Hand-built charts

The charts are React components over SVG with d3-scale for the math. That keeps full control of marks, labels, keyboard access and the table view each chart offers, at about the same size as configuring a chart library.

### One contract file

`server/src/contracts.ts` holds the Zod request schemas and the response types. The web app imports the types across the workspace boundary, which gives end-to-end type safety without code generation.

## Testing strategy

| Level | Tool | Why at this level |
|---|---|---|
| Unit | `node --test` | Parsers, money, dates, analytics arithmetic: pure functions with exact answers |
| HTTP | Supertest | Status codes, validation, security guards, with an in-memory database per test |
| Component | Vitest + Testing Library | UI behaviour against a mocked API |
| Contract | Postman CLI | The API as an external client sees it, with cross-endpoint invariants |
| Journey | Playwright + axe | The production build in a real browser, including accessibility |

The contract and journey suites start their own server on a spare port with a temporary database, and the Postman collection stops itself if the target database is not empty, so no test can touch a real ledger.
