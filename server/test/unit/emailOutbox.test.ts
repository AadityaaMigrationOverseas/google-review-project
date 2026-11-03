import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../../src/db/database.js';
import { runMigrations } from '../../src/db/migrate.js';
import { silentLogger } from '../../src/lib/logger.js';
import { OutboxRepository } from '../../src/repositories/outboxRepository.js';
import { EmailOutbox } from '../../src/services/email/emailOutbox.js';
import { MemoryTransport } from '../../src/services/email/transports.js';
import { PermanentEmailError, type EmailMessage, type EmailTransport } from '../../src/services/email/types.js';
import { FakeClock } from '../helpers.js';

const message = (key: string): EmailMessage => ({
  to: 'aaditya@migrationoverseas.com',
  from: 'portal@clinic.test',
  subject: 'New complaint',
  text: 't',
  html: '<p>t</p>',
  messageId: `<${key}@clinic.test>`,
});

describe('EmailOutbox', () => {
  let db: Database;
  let repo: OutboxRepository;
  let clock: FakeClock;
  let mail: MemoryTransport;

  const outbox = (transport: EmailTransport = mail, maxAttempts = 3) =>
    new EmailOutbox(repo, transport, (row) => message(row.dedupe_key), clock, silentLogger, {
      maxAttempts,
      pollIntervalMs: 60_000,
      backoffMs: [1000, 5000],
      leaseMs: 10_000,
    });

  const enqueue = (key = 'complaint:1') =>
    repo.enqueue({ dedupeKey: key, kind: 'complaint_notification', complaintId: null, to: 'x@y.z', now: clock.now() });

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    repo = new OutboxRepository(db);
    clock = new FakeClock();
    mail = new MemoryTransport();
  });

  it('enqueues idempotently per dedupe key', () => {
    expect(enqueue()).toBe(true);
    expect(enqueue()).toBe(false);
    expect(repo.countsByStatus().pending).toBe(1);
  });

  it('delivers and marks messages as sent', async () => {
    enqueue();
    expect(await outbox().kick()).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.messageId).toBe('<complaint:1@clinic.test>');
    expect(repo.get(1)).toMatchObject({ status: 'sent', attempts: 1, last_error: null });
    expect(await outbox().kick()).toBe(0);
    expect(mail.sent).toHaveLength(1);
  });

  it('retries transient failures with backoff, then gives up', async () => {
    enqueue();
    mail.failures.push(new Error('ECONNREFUSED'), new Error('ETIMEDOUT'), new Error('421 try later'));
    const ob = outbox();

    await ob.kick();
    expect(repo.get(1)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'ECONNREFUSED' });
    expect(await ob.kick()).toBe(0); // not yet due

    clock.advance(1000);
    await ob.kick();
    expect(repo.get(1)).toMatchObject({ status: 'pending', attempts: 2 });
    expect(repo.get(1)!.next_attempt_at).toBe(clock.now() + 5000);

    clock.advance(5000);
    await ob.kick();
    expect(repo.get(1)).toMatchObject({ status: 'failed', attempts: 3, last_error: '421 try later' });
    expect(mail.sent).toHaveLength(0);
  });

  it('does not retry permanent rejections', async () => {
    enqueue();
    mail.failures.push(new PermanentEmailError('SMTP 550 mailbox unavailable'));
    await outbox().kick();
    expect(repo.get(1)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('never hands the same message to two concurrent dispatchers', async () => {
    enqueue('a');
    enqueue('b');
    let inFlight = 0;
    let maxInFlightPerMessage = 0;
    const seen = new Map<string, number>();
    const slow: EmailTransport = {
      name: 'slow',
      async send(m) {
        inFlight++;
        seen.set(m.messageId, (seen.get(m.messageId) ?? 0) + 1);
        maxInFlightPerMessage = Math.max(maxInFlightPerMessage, ...seen.values());
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return { messageId: m.messageId };
      },
    };
    await Promise.all([outbox(slow).kick(), outbox(slow).kick(), outbox(slow).kick()]);
    expect(maxInFlightPerMessage).toBe(1);
    expect([...seen.values()]).toEqual([1, 1]);
    expect(inFlight).toBe(0);
  });

  it('reclaims messages whose sender crashed after the lease expires', async () => {
    enqueue();
    expect(repo.claimNext(clock.now(), 10_000)).toBeDefined(); // simulated crash: never completed
    expect(await outbox().kick()).toBe(0);
    clock.advance(10_001);
    expect(await outbox().kick()).toBe(1);
    expect(repo.get(1)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('can be re-queued manually after permanent failure', async () => {
    db.prepare(
      `INSERT INTO complaints (reference, idempotency_key, first_name, last_name, email, phone, rating, details,
         consent_version, consented_at, created_at, updated_at)
       VALUES ('SDC-1', 'k', 'A', 'B', 'a@b.co', '123', 1, 'd', 'v', 0, 0, 0)`,
    ).run();
    repo.enqueue({ dedupeKey: 'c1', kind: 'complaint_notification', complaintId: 1, to: 'x@y.z', now: clock.now() });
    mail.failures.push(new PermanentEmailError('550'));
    await outbox().kick();
    expect(repo.requeueForComplaint(1, clock.now())).toBe(true);
    await outbox().kick();
    expect(repo.get(1)).toMatchObject({ status: 'sent' });
  });
});
