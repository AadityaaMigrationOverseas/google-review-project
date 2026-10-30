import { CONSENT_VERSION, type Page, type ReviewDto, type ReviewInput, type SentimentLabel } from '@stellar/shared';
import { isUniqueViolation } from '../db/database.js';
import type { Clock } from '../lib/clock.js';
import { badRequest } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { ReviewRepository, ReviewRow } from '../repositories/reviewRepository.js';
import { isRatingMismatch, type SentimentService } from './sentiment/sentimentService.js';
import type { ShortLinkService } from './shortLinkService.js';

const MAX_SENTIMENT_ATTEMPTS = 3;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{16,64}$/;

export function toReviewDto(r: ReviewRow): ReviewDto {
  return {
    id: r.id,
    rating: r.rating,
    text: r.review_text,
    sentiment: r.sentiment_label,
    sentimentConfidence: r.sentiment_confidence,
    sentimentStatus: r.sentiment_status,
    sentimentLatencyMs: r.sentiment_latency_ms,
    mismatch: isRatingMismatch(r.rating, r.sentiment_label),
    linkCode: r.link_code,
    linkLabel: r.link_label,
    createdAt: r.created_at,
  };
}

export class ReviewService {
  private retryTimer: NodeJS.Timeout | null = null;
  private retrying = false;

  constructor(
    private readonly reviews: ReviewRepository,
    private readonly links: ShortLinkService,
    private readonly sentiment: SentimentService,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /**
   * Stores the review and returns the C++ verdict (null if the engine could
   * not analyse it). A retry carrying the same idempotency key (double tap,
   * dropped connection, refreshed form token) replays the original result
   * instead of creating a duplicate.
   */
  async submit(
    input: ReviewInput,
    idempotencyKey: unknown,
    meta: { ipHash: string | null },
  ): Promise<{ id: number; sentiment: SentimentLabel | null; duplicate: boolean }> {
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey))
      throw badRequest('Invalid submission key. Please reload the page and try again.');

    const existing = this.reviews.findByIdempotencyKey(idempotencyKey);
    if (existing) return { id: existing.id, sentiment: existing.sentiment_label, duplicate: true };

    const shortLinkId = input.linkCode ? this.links.resolve(input.linkCode) : null;
    let id: number;
    try {
      id = this.reviews.insert({
        shortLinkId,
        idempotencyKey,
        rating: input.rating,
        text: input.text,
        consentVersion: CONSENT_VERSION,
        ipHash: meta.ipHash,
        createdAt: this.clock.now(),
      });
    } catch (err) {
      // Two near-simultaneous retries: the loser returns the winner's row.
      const raced = isUniqueViolation(err) ? this.reviews.findByIdempotencyKey(idempotencyKey) : null;
      if (!raced) throw err;
      return { id: raced.id, sentiment: raced.sentiment_label, duplicate: true };
    }
    const update = await this.sentiment.evaluate(input.text);
    this.reviews.recordSentiment(id, update);
    return { id, sentiment: update.label, duplicate: false };
  }

  findByIdempotencyKey(key: unknown): { id: number; rating: number; sentiment: SentimentLabel | null } | null {
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) return null;
    const row = this.reviews.findByIdempotencyKey(key);
    return row ? { id: row.id, rating: row.rating, sentiment: row.sentiment_label } : null;
  }

  list(filter: {
    sentiment?: SentimentLabel | 'unanalyzed';
    rating?: number;
    cursor?: number;
    limit: number;
  }): Page<ReviewDto> {
    const rows = this.reviews.list({ ...filter, limit: filter.limit + 1 });
    const hasMore = rows.length > filter.limit;
    const items = rows.slice(0, filter.limit).map(toReviewDto);
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  /** Re-runs analysis for reviews whose engine call failed (e.g. engine restart). */
  async retryFailedSentiment(batchSize = 20): Promise<number> {
    if (this.retrying) return 0;
    this.retrying = true;
    try {
      const rows = this.reviews.findRetryable(MAX_SENTIMENT_ATTEMPTS, this.clock.now() - 30_000, batchSize);
      for (const row of rows) this.reviews.recordSentiment(row.id, await this.sentiment.evaluate(row.review_text));
      if (rows.length) this.logger.info({ count: rows.length }, 'retried sentiment analysis');
      return rows.length;
    } finally {
      this.retrying = false;
    }
  }

  startRetryLoop(intervalMs: number): void {
    this.retryTimer = setInterval(() => {
      this.retryFailedSentiment().catch((err) => this.logger.error({ err }, 'sentiment retry loop failed'));
    }, intervalMs);
    this.retryTimer.unref();
  }

  stopRetryLoop(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
  }
}
