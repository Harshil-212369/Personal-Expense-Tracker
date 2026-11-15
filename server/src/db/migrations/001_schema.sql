-- LedgerLens schema.
-- Conventions: money is integer cents; dates are ISO 'YYYY-MM-DD' text;
-- amount_cents > 0 is money leaving the account, < 0 is money coming back.

CREATE TABLE categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  -- 'expense' counts toward spending; 'excluded' (card payments, reward
  -- credits) is kept for the audit trail but left out of every analytic.
  kind        TEXT    NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'excluded')),
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE accounts (
  id           INTEGER PRIMARY KEY,
  institution  TEXT NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'credit' CHECK (type IN ('credit', 'chequing', 'savings', 'cash')),
  -- Only ever the last four digits. Full card numbers are never stored.
  last4        TEXT CHECK (last4 IS NULL OR (length(last4) = 4 AND last4 NOT GLOB '*[^0-9]*')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX accounts_identity ON accounts (institution, ifnull(last4, ''), name);

CREATE TABLE imports (
  id                  INTEGER PRIMARY KEY,
  -- SHA-256 of the uploaded bytes: importing the same file twice is a no-op.
  sha256              TEXT    NOT NULL UNIQUE,
  filename            TEXT    NOT NULL,
  kind                TEXT    NOT NULL,
  parser              TEXT    NOT NULL DEFAULT 'deterministic' CHECK (parser IN ('deterministic', 'ai')),
  account_id          INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  period_start        TEXT,
  period_end          TEXT,
  rows_parsed         INTEGER NOT NULL DEFAULT 0,
  rows_inserted       INTEGER NOT NULL DEFAULT 0,
  rows_duplicate      INTEGER NOT NULL DEFAULT 0,
  -- 1 when every figure printed on the document matched what was parsed.
  reconciled          INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0, 1)),
  checks_json         TEXT    NOT NULL DEFAULT '[]',
  warnings_json       TEXT    NOT NULL DEFAULT '[]',
  imported_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE receipts (
  id              INTEGER PRIMARY KEY,
  import_id       INTEGER REFERENCES imports (id) ON DELETE CASCADE,
  merchant        TEXT    NOT NULL,
  store_ref       TEXT,
  purchased_on    TEXT    NOT NULL,
  purchased_time  TEXT,
  subtotal_cents  INTEGER NOT NULL,
  tax_cents       INTEGER NOT NULL DEFAULT 0,
  total_cents     INTEGER NOT NULL,
  savings_cents   INTEGER NOT NULL DEFAULT 0,
  payment_method  TEXT,
  card_last4      TEXT,
  item_count      INTEGER NOT NULL DEFAULT 0,
  arithmetic_ok   INTEGER NOT NULL DEFAULT 0 CHECK (arithmetic_ok IN (0, 1)),
  fingerprint     TEXT    NOT NULL UNIQUE,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE receipt_items (
  id                INTEGER PRIMARY KEY,
  receipt_id        INTEGER NOT NULL REFERENCES receipts (id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  department        TEXT,
  name              TEXT    NOT NULL,
  quantity          REAL,
  unit              TEXT,
  unit_price_cents  INTEGER,
  total_cents       INTEGER NOT NULL,
  -- Per-line promotional saving printed under the item ("Saving 2.50").
  saving_cents      INTEGER NOT NULL DEFAULT 0,
  taxable           INTEGER NOT NULL DEFAULT 0 CHECK (taxable IN (0, 1))
) STRICT;

CREATE INDEX receipt_items_receipt ON receipt_items (receipt_id);
CREATE INDEX receipt_items_name ON receipt_items (name COLLATE NOCASE);

CREATE TABLE transactions (
  id               INTEGER PRIMARY KEY,
  import_id        INTEGER REFERENCES imports (id) ON DELETE CASCADE,
  account_id       INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  txn_date         TEXT    NOT NULL CHECK (txn_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  post_date        TEXT,
  description      TEXT    NOT NULL,
  merchant         TEXT    NOT NULL,
  location         TEXT,
  amount_cents     INTEGER NOT NULL,
  type             TEXT    NOT NULL DEFAULT 'purchase'
                   CHECK (type IN ('purchase', 'refund', 'payment', 'credit', 'fee', 'interest')),
  category_id      INTEGER NOT NULL REFERENCES categories (id),
  -- Who decided the category, so a re-run of the rules never overwrites a human.
  category_source  TEXT    NOT NULL DEFAULT 'default'
                   CHECK (category_source IN ('manual', 'rule', 'ai', 'bank', 'default')),
  bank_category    TEXT,
  notes            TEXT,
  receipt_id       INTEGER REFERENCES receipts (id) ON DELETE SET NULL,
  -- Deterministic identity used to drop duplicates across overlapping files.
  fingerprint      TEXT    NOT NULL UNIQUE,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX transactions_date ON transactions (txn_date);
CREATE INDEX transactions_category ON transactions (category_id, txn_date);
CREATE INDEX transactions_merchant ON transactions (merchant COLLATE NOCASE);
CREATE INDEX transactions_import ON transactions (import_id);
CREATE UNIQUE INDEX transactions_receipt ON transactions (receipt_id) WHERE receipt_id IS NOT NULL;

CREATE TABLE rules (
  id           INTEGER PRIMARY KEY,
  -- Case-insensitive substring matched against the raw bank description.
  pattern      TEXT    NOT NULL COLLATE NOCASE CHECK (length(trim(pattern)) >= 2),
  category_id  INTEGER NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  -- user (300) beats ai (200) beats seed (100); ties go to the longest pattern.
  source       TEXT    NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'ai', 'seed')),
  priority     INTEGER NOT NULL DEFAULT 300,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (pattern, source)
) STRICT;
