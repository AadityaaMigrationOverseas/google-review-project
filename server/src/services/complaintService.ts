import {
  CONSENT_VERSION,
  isComplaintStatus,
  type ComplaintDto,
  type ComplaintInput,
  type ComplaintStatus,
  type Page,
} from '@stellar/shared';
import { isUniqueViolation, transaction, type Database } from '../db/database.js';
import type { Clock } from '../lib/clock.js';
import { randomReference } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { ComplaintRepository, ComplaintWithNotificationRow } from '../repositories/complaintRepository.js';
import type { OutboxRepository, OutboxRow } from '../repositories/outboxRepository.js';
import type { EmailOutbox } from './email/emailOutbox.js';
import { renderComplaintNotification } from './email/templates.js';
import type { EmailMessage } from './email/types.js';

export const COMPLAINT_NOTIFICATION = 'complaint_notification';
const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{16,64}$/;

export interface ComplaintNotificationOptions {
  to: string;
  from: string;
  dashboardBaseUrl: string;
  includeDetails: boolean;
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

export function maskPhone(phone: string): string {
  return `${'•'.repeat(Math.max(0, phone.length - 3))}${phone.slice(-3)}`;
}

export function toComplaintDto(r: ComplaintWithNotificationRow, showPii: boolean): ComplaintDto {
  return {
    id: r.id,
    reference: r.reference,
    firstName: r.first_name,
    lastName: showPii ? r.last_name : `${r.last_name.slice(0, 1)}.`,
    email: showPii ? r.email : maskEmail(r.email),
    phone: showPii ? r.phone : maskPhone(r.phone),
    piiVisible: showPii,
    rating: r.rating,
    details: r.details,
    status: r.status,
    notificationStatus: r.notification_status,
    notificationAttempts: r.notification_attempts ?? 0,
    notificationError: r.notification_error,
    notificationSentAt: r.notification_sent_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ComplaintService {
  constructor(
    private readonly db: Database,
    private readonly complaints: ComplaintRepository,
    private readonly outboxRepo: OutboxRepository,
    private readonly outbox: EmailOutbox,
    private readonly clock: Clock,
    private readonly notify: ComplaintNotificationOptions,
  ) {}

  /**
   * Stores the complaint and queues the clinic notification in one
   * transaction. Re-submitting with the same idempotency key (double tap,
   * network retry) returns the original reference without a second email.
   */
  submit(
    input: ComplaintInput,
    idempotencyKey: unknown,
    meta: { ipHash: string | null },
  ): { reference: string; created: boolean } {
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey))
      throw badRequest('Invalid submission key. Please reload the page and try again.');

    const result = transaction(this.db, () => {
      const existing = this.complaints.findByIdempotencyKey(idempotencyKey);
      if (existing) return { reference: existing.reference, created: false };

      const now = this.clock.now();
      let id = 0;
      let reference = '';
      for (let attempt = 0; attempt < 5 && !id; attempt++) {
        reference = randomReference();
        try {
          id = this.complaints.insert({
            ...input,
            reference,
            idempotencyKey,
            consentVersion: CONSENT_VERSION,
            ipHash: meta.ipHash,
            createdAt: now,
          });
        } catch (err) {
          if (!isUniqueViolation(err) || this.complaints.findByIdempotencyKey(idempotencyKey)) throw err;
        }
      }
      if (!id) throw new Error('could not allocate complaint reference');
      this.outboxRepo.enqueue({
        dedupeKey: `${COMPLAINT_NOTIFICATION}:${id}`,
        kind: COMPLAINT_NOTIFICATION,
        complaintId: id,
        to: this.notify.to,
        now,
      });
      return { reference, created: true };
    });

    if (result.created) void this.outbox.kick();
    return result;
  }

  findReference(idempotencyKey: string): string | null {
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return null;
    return this.complaints.findByIdempotencyKey(idempotencyKey)?.reference ?? null;
  }

  /** Renderer used by the outbox at delivery time (keeps patient data out of the queue). */
  readonly renderNotification = (row: OutboxRow): EmailMessage | null => {
    if (row.kind !== COMPLAINT_NOTIFICATION || !row.complaint_id) return null;
    const c = this.complaints.findById(row.complaint_id);
    if (!c) return null;
    const rendered = renderComplaintNotification({
      reference: c.reference,
      firstName: c.first_name,
      lastName: c.last_name,
      email: c.email,
      phone: c.phone,
      rating: c.rating,
      details: c.details,
      createdAt: c.created_at,
      dashboardUrl: `${this.notify.dashboardBaseUrl}/admin#/complaints/${c.id}`,
      // The clinic inbox must always receive the review plus name, phone and email.
      includeDetails: true,
    });
    const domain = /@([^>]+)>?$/.exec(this.notify.from)?.[1] ?? 'stellar-review-portal.local';
    return {
      ...rendered,
      to: row.to_address,
      from: this.notify.from,
      messageId: `<${row.dedupe_key.replace(/[^A-Za-z0-9_.-]/g, '-')}@${domain}>`,
      headers: { 'X-Entity-Ref-ID': c.reference, 'Auto-Submitted': 'auto-generated' },
    };
  };

  list(filter: { status?: unknown; cursor?: number; limit: number }, showPii: boolean): Page<ComplaintDto> {
    const status = isComplaintStatus(filter.status) ? filter.status : undefined;
    const rows = this.complaints.list({ status, cursor: filter.cursor, limit: filter.limit + 1 });
    const hasMore = rows.length > filter.limit;
    const items = rows.slice(0, filter.limit).map((r) => toComplaintDto(r, showPii));
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  get(id: number, showPii: boolean): ComplaintDto {
    const row = this.complaints.findById(id);
    if (!row) throw notFound('Complaint not found.');
    return toComplaintDto(row, showPii);
  }

  updateStatus(id: number, status: unknown, showPii: boolean): ComplaintDto {
    if (!isComplaintStatus(status)) throw badRequest('Invalid status.');
    if (!this.complaints.updateStatus(id, status as ComplaintStatus, this.clock.now()))
      throw notFound('Complaint not found.');
    return this.get(id, showPii);
  }

  retryNotification(id: number, showPii: boolean): ComplaintDto {
    if (!this.complaints.findById(id)) throw notFound('Complaint not found.');
    if (!this.outboxRepo.requeueForComplaint(id, this.clock.now()))
      throw badRequest('Only failed notifications can be retried.');
    void this.outbox.kick();
    return this.get(id, showPii);
  }
}
