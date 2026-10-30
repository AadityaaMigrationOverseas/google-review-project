import type { Database } from '../db/database.js';

export interface AuditEntry {
  userId: number | null;
  action: string;
  entity?: string;
  entityId?: string | number;
  ipHash: string | null;
  now: number;
}

export class AuditRepository {
  private readonly insertStmt;

  constructor(private readonly db: Database) {
    this.insertStmt = db.prepare(
      'INSERT INTO audit_log (user_id, action, entity, entity_id, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
  }

  record(e: AuditEntry): void {
    this.insertStmt.run(
      e.userId,
      e.action,
      e.entity ?? null,
      e.entityId === undefined ? null : String(e.entityId),
      e.ipHash,
      e.now,
    );
  }

  deleteCreatedBefore(cutoff: number): number {
    return Number(this.db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff).changes);
  }
}
