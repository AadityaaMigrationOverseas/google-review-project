import type { Clock } from '../../lib/clock.js';
import type { Logger } from '../../lib/logger.js';
import type { OutboxRepository, OutboxRow } from '../../repositories/outboxRepository.js';
import { PermanentEmailError, type EmailMessage, type EmailTransport } from './types.js';

/** Builds the message for an outbox row; returns null if its source record is gone. */
export type MessageRenderer = (row: OutboxRow) => EmailMessage | null;

export interface EmailOutboxOptions {
  maxAttempts: number;
  pollIntervalMs: number;
  leaseMs?: number;
  backoffMs?: number[];
}

const DEFAULT_BACKOFF = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000];

/**
 * Delivers queued notifications. Rows are claimed atomically, so a message is
 * never handed to the transport twice concurrently, and the stable
 * Message-ID lets receivers drop duplicates if a crash follows a send.
 */
export class EmailOutbox {
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<number> | null = null;
  private rerun = false;
  private readonly leaseMs: number;
  private readonly backoff: number[];

  constructor(
    private readonly repo: OutboxRepository,
    private readonly transport: EmailTransport | null,
    private readonly render: MessageRenderer,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly opts: EmailOutboxOptions,
  ) {
    this.leaseMs = opts.leaseMs ?? 120_000;
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
  }

  start(): void {
    if (!this.transport || this.timer) return;
    this.timer = setInterval(() => void this.kick(), this.opts.pollIntervalMs);
    this.timer.unref();
    void this.kick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.draining;
    this.transport?.close?.();
  }

  /** Triggers delivery now; concurrent calls coalesce into one extra pass. */
  kick(): Promise<number> {
    if (!this.transport) return Promise.resolve(0);
    if (this.draining) {
      this.rerun = true;
      return this.draining;
    }
    this.draining = (async () => {
      let total = 0;
      do {
        this.rerun = false;
        total += await this.drainOnce();
      } while (this.rerun);
      return total;
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drainOnce(): Promise<number> {
    let processed = 0;
    for (;;) {
      const row = this.repo.claimNext(this.clock.now(), this.leaseMs);
      if (!row) return processed;
      processed++;
      await this.deliver(row);
    }
  }

  private async deliver(row: OutboxRow): Promise<void> {
    const message = this.render(row);
    if (!message) {
      this.repo.markFailed(row.id, 'source record no longer exists', this.clock.now());
      return;
    }
    try {
      const { messageId } = await this.transport!.send(message);
      this.repo.markSent(row.id, this.clock.now(), messageId);
      this.logger.info({ outboxId: row.id, kind: row.kind, attempt: row.attempts }, 'notification sent');
    } catch (err) {
      const error = truncate((err as Error).message ?? String(err));
      const now = this.clock.now();
      if (err instanceof PermanentEmailError || row.attempts >= this.opts.maxAttempts) {
        this.repo.markFailed(row.id, error, now);
        this.logger.error({ outboxId: row.id, attempt: row.attempts, error }, 'notification permanently failed');
      } else {
        const delay = this.backoff[Math.min(row.attempts - 1, this.backoff.length - 1)]!;
        this.repo.scheduleRetry(row.id, now + delay, error, now);
        this.logger.warn(
          { outboxId: row.id, attempt: row.attempts, retryInMs: delay, error },
          'notification failed; will retry',
        );
      }
    }
  }
}

function truncate(s: string): string {
  return s.length > 500 ? `${s.slice(0, 497)}...` : s;
}
