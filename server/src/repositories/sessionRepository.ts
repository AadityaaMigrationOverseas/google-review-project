import type { Database } from '../db/database.js';

export interface SessionRow {
  token_hash: string;
  user_id: number;
  csrf_token: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

export class SessionRepository {
  private readonly getStmt;
  private readonly touchStmt;

  constructor(private readonly db: Database) {
    this.getStmt = db.prepare('SELECT * FROM sessions WHERE token_hash = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?');
  }

  insert(s: SessionRow & { ip_hash: string | null; user_agent: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip_hash, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.token_hash, s.user_id, s.csrf_token, s.created_at, s.last_seen_at, s.expires_at, s.ip_hash, s.user_agent);
  }

  get(tokenHash: string): SessionRow | undefined {
    return this.getStmt.get(tokenHash) as SessionRow | undefined;
  }

  touch(tokenHash: string, now: number): void {
    this.touchStmt.run(now, tokenHash);
  }

  delete(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteForUser(userId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  deleteExpired(now: number, idleCutoff: number): number {
    return Number(
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(now, idleCutoff).changes,
    );
  }
}
