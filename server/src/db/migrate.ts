import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './database.js';
import { transaction } from './database.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/** Applies pending `NNN_name.sql` migrations in order; returns the names applied. */
export function runMigrations(db: Database, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  ) STRICT`);

  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map((r) => r.name),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
    });
    newlyApplied.push(file);
  }
  return newlyApplied;
}
