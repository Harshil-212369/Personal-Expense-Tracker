import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

/**
 * Opens (and creates) the SQLite database and brings it to the latest schema.
 * Pass ':memory:' for an isolated database, which is what the tests do.
 */
export function openDatabase(databasePath: string): Db {
  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (databasePath !== ':memory:') {
    // WAL keeps readers unblocked during an import transaction.
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }
  migrate(db);
  return db;
}

/** Applies every `NNN_name.sql` file that has not run yet, each in its own transaction. */
export function migrate(db: Db): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
  `);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => String(row['version'])),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(file);
    });
    ran.push(file);
  }
  return ran;
}

/**
 * Runs `fn` atomically. Nested calls join the outer transaction through a
 * savepoint, so services can compose without knowing who opened it.
 */
let savepointCounter = 0;
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) {
    const name = `sp_${++savepointCounter}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
