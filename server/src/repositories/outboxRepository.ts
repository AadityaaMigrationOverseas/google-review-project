import type { NotificationStatus } from '@stellar/shared';
import type { Database } from '../db/database.js';

export interface OutboxRow {
  id: number;
  dedupe_key: string;
  kind: string;
  complaint_id: number | null;
  to_address: string;
  status: NotificationStatus;
  attempts: number;
  next_attempt_at: number;
}

export interface NewOutboxMessage {
  dedupeKey: string;
  kind: string;
  complaintId: number | null;
  to: string;
  now: number;
}

export class OutboxRepository {
  private readonly enqueueStmt;
  private readonly claimStmt;
  private readonly sentStmt;
  private readonly retryStmt;
  private readonly failStmt;

  constructor(private readonly db: Database) {
    // ON CONFLICT DO NOTHING makes enqueueing idempotent per dedupe key.
    this.enqueueStmt = db.prepare(`
      INSERT INTO email_outbox (dedupe_key, kind, complaint_id, to_address, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (dedupe_key) DO NOTHING`);
    // Atomic claim: only one dispatcher can move a row into 'sending'. Rows
    // stuck in 'sending' after a crash become claimable once the lease expires.
    this.claimStmt = db.prepare(`
      UPDATE email_outbox
      SET status = 'sending', locked_until = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = (
        SELECT id FROM email_outbox
        WHERE (status = 'pending' AND next_attempt_at <= ?)
           OR (status = 'sending' AND locked_until < ?)
        ORDER BY next_attempt_at LIMIT 1
      )
      RETURNING id, dedupe_key, kind, complaint_id, to_address, status, attempts, next_attempt_at`);
    this.sentStmt = db.prepare(`
      UPDATE email_outbox SET status = 'sent', sent_at = ?, provider_message_id = ?, last_error = NULL,
             locked_until = NULL, updated_at = ?
      WHERE id = ?`);
    this.retryStmt = db.prepare(`
      UPDATE email_outbox SET status = 'pending', next_attempt_at = ?, last_error = ?, locked_until = NULL, updated_at = ?
      WHERE id = ?`);
    this.failStmt = db.prepare(`
      UPDATE email_outbox SET status = 'failed', last_error = ?, locked_until = NULL, updated_at = ?
      WHERE id = ?`);
  }

  enqueue(m: NewOutboxMessage): boolean {
    return this.enqueueStmt.run(m.dedupeKey, m.kind, m.complaintId, m.to, m.now, m.now, m.now).changes > 0;
  }

  claimNext(now: number, leaseMs: number): OutboxRow | undefined {
    return this.claimStmt.get(now + leaseMs, now, now, now) as OutboxRow | undefined;
  }

  markSent(id: number, now: number, providerMessageId: string | null): void {
    this.sentStmt.run(now, providerMessageId, now, id);
  }

  scheduleRetry(id: number, nextAttemptAt: number, error: string, now: number): void {
    this.retryStmt.run(nextAttemptAt, error, now, id);
  }

  markFailed(id: number, error: string, now: number): void {
    this.failStmt.run(error, now, id);
  }

  /** Re-queues a permanently failed notification after manual intervention. */
  requeueForComplaint(complaintId: number, now: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE email_outbox SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?
           WHERE complaint_id = ? AND status = 'failed'`,
        )
        .run(now, now, complaintId).changes > 0
    );
  }

  countsByStatus(): Record<NotificationStatus, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status').all() as Array<{
      status: NotificationStatus;
      n: number;
    }>;
    const out: Record<NotificationStatus, number> = { pending: 0, sending: 0, sent: 0, failed: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  get(id: number): (OutboxRow & { last_error: string | null; sent_at: number | null }) | undefined {
    return this.db.prepare('SELECT * FROM email_outbox WHERE id = ?').get(id) as
      (OutboxRow & { last_error: string | null; sent_at: number | null }) | undefined;
  }
}
