import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

export function openDatabase(filePath: string): Database {
  if (filePath !== ':memory:') mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA secure_delete = ON;
  `);
  return db;
}

/** Runs `fn` inside an IMMEDIATE transaction, rolling back on any error. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    (('errcode' in err && (err as { errcode: number }).errcode === 2067) ||
      /UNIQUE constraint failed/.test(err.message))
  );
}
