import type { ComplaintStatus, NotificationStatus } from '@stellar/shared';
import type { Database } from '../db/database.js';

export interface ComplaintRow {
  id: number;
  reference: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  rating: number;
  details: string;
  status: ComplaintStatus;
  created_at: number;
  updated_at: number;
}

export interface ComplaintWithNotificationRow extends ComplaintRow {
  notification_status: NotificationStatus | null;
  notification_attempts: number | null;
  notification_error: string | null;
  notification_sent_at: number | null;
}

export interface NewComplaint {
  reference: string;
  idempotencyKey: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  rating: number;
  details: string;
  consentVersion: string;
  ipHash: string | null;
  createdAt: number;
}

const SELECT_WITH_NOTIFICATION = `
  SELECT c.id, c.reference, c.first_name, c.last_name, c.email, c.phone, c.rating, c.details,
         c.status, c.created_at, c.updated_at,
         o.status AS notification_status, o.attempts AS notification_attempts,
         o.last_error AS notification_error, o.sent_at AS notification_sent_at
  FROM complaints c
  LEFT JOIN email_outbox o ON o.complaint_id = c.id AND o.kind = 'complaint_notification'`;

export class ComplaintRepository {
  private readonly insertStmt;
  private readonly byKeyStmt;
  private readonly byIdStmt;

  constructor(private readonly db: Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO complaints (reference, idempotency_key, first_name, last_name, email, phone, rating,
                              details, consent_version, consented_at, ip_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.byKeyStmt = db.prepare('SELECT id, reference FROM complaints WHERE idempotency_key = ?');
    this.byIdStmt = db.prepare(`${SELECT_WITH_NOTIFICATION} WHERE c.id = ?`);
  }

  insert(c: NewComplaint): number {
    const result = this.insertStmt.run(
      c.reference,
      c.idempotencyKey,
      c.firstName,
      c.lastName,
      c.email,
      c.phone,
      c.rating,
      c.details,
      c.consentVersion,
      c.createdAt,
      c.ipHash,
      c.createdAt,
      c.createdAt,
    );
    return Number(result.lastInsertRowid);
  }

  findByIdempotencyKey(key: string): { id: number; reference: string } | undefined {
    return this.byKeyStmt.get(key) as { id: number; reference: string } | undefined;
  }

  findById(id: number): ComplaintWithNotificationRow | undefined {
    return this.byIdStmt.get(id) as ComplaintWithNotificationRow | undefined;
  }

  list(filter: { status?: ComplaintStatus; cursor?: number; limit: number }): ComplaintWithNotificationRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.status) {
      where.push('c.status = ?');
      params.push(filter.status);
    }
    if (filter.cursor) {
      where.push('c.id < ?');
      params.push(filter.cursor);
    }
    params.push(filter.limit);
    return this.db
      .prepare(
        `${SELECT_WITH_NOTIFICATION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY c.id DESC LIMIT ?`,
      )
      .all(...params) as unknown as ComplaintWithNotificationRow[];
  }

  updateStatus(id: number, status: ComplaintStatus, now: number): boolean {
    return (
      this.db.prepare('UPDATE complaints SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id).changes > 0
    );
  }

  countsByStatus(): Record<ComplaintStatus, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM complaints GROUP BY status').all() as Array<{
      status: ComplaintStatus;
      n: number;
    }>;
    const out: Record<ComplaintStatus, number> = { open: 0, in_progress: 0, resolved: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  deleteCreatedBefore(cutoff: number): number {
    return Number(this.db.prepare('DELETE FROM complaints WHERE created_at < ?').run(cutoff).changes);
  }
}
