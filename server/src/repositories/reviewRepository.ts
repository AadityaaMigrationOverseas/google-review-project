import type { SentimentLabel, SentimentStatus } from '@stellar/shared';
import type { Database } from '../db/database.js';

export interface ReviewRow {
  id: number;
  short_link_id: number | null;
  rating: number;
  review_text: string;
  sentiment_status: SentimentStatus;
  sentiment_label: SentimentLabel | null;
  sentiment_confidence: number | null;
  sentiment_latency_ms: number | null;
  created_at: number;
  link_code: string | null;
  link_label: string | null;
}

export interface NewReview {
  shortLinkId: number | null;
  idempotencyKey: string;
  rating: number;
  text: string;
  consentVersion: string;
  ipHash: string | null;
  createdAt: number;
}

export interface SentimentUpdate {
  status: SentimentStatus;
  label: SentimentLabel | null;
  confidence: number | null;
  pPositive: number | null;
  latencyMs: number | null;
  model: string | null;
  error: string | null;
  analyzedAt: number;
}

export interface ReviewFilter {
  sentiment?: SentimentLabel | 'unanalyzed';
  rating?: number;
  cursor?: number;
  limit: number;
}

export interface ReviewStatsRow {
  total: number;
  averageRating: number | null;
  last7Days: number;
  byRating: Array<{ rating: number; n: number }>;
  bySentiment: Array<{ label: SentimentLabel | null; n: number }>;
}

export class ReviewRepository {
  private readonly insertStmt;
  private readonly sentimentStmt;
  private readonly retryableStmt;
  private readonly byKeyStmt;

  constructor(private readonly db: Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO reviews (short_link_id, idempotency_key, rating, review_text, consent_version, consented_at,
                           ip_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    this.byKeyStmt = db.prepare('SELECT id, rating, sentiment_label FROM reviews WHERE idempotency_key = ?');
    this.sentimentStmt = db.prepare(`
      UPDATE reviews SET
        sentiment_status = ?, sentiment_label = ?, sentiment_confidence = ?, sentiment_p_positive = ?,
        sentiment_latency_ms = ?, sentiment_model = ?, sentiment_error = ?, analyzed_at = ?,
        sentiment_attempts = sentiment_attempts + 1
      WHERE id = ?`);
    this.retryableStmt = db.prepare(`
      SELECT id, review_text FROM reviews
      WHERE sentiment_status IN ('pending', 'failed') AND sentiment_attempts < ? AND created_at < ?
      ORDER BY id LIMIT ?`);
  }

  insert(review: NewReview): number {
    const result = this.insertStmt.run(
      review.shortLinkId,
      review.idempotencyKey,
      review.rating,
      review.text,
      review.consentVersion,
      review.createdAt,
      review.ipHash,
      review.createdAt,
    );
    return Number(result.lastInsertRowid);
  }

  findByIdempotencyKey(key: string): { id: number; rating: number; sentiment_label: SentimentLabel | null } | null {
    return (this.byKeyStmt.get(key) as { id: number; rating: number; sentiment_label: SentimentLabel | null }) ?? null;
  }

  recordSentiment(id: number, u: SentimentUpdate): void {
    this.sentimentStmt.run(
      u.status,
      u.label,
      u.confidence,
      u.pPositive,
      u.latencyMs,
      u.model,
      u.error,
      u.analyzedAt,
      id,
    );
  }

  /** Reviews whose analysis failed or never ran, older than `before` to avoid racing in-flight work. */
  findRetryable(maxAttempts: number, before: number, limit: number): Array<{ id: number; review_text: string }> {
    return this.retryableStmt.all(maxAttempts, before, limit) as Array<{ id: number; review_text: string }>;
  }

  list(filter: ReviewFilter): ReviewRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.sentiment === 'unanalyzed') where.push('r.sentiment_label IS NULL');
    else if (filter.sentiment) {
      where.push('r.sentiment_label = ?');
      params.push(filter.sentiment);
    }
    if (filter.rating) {
      where.push('r.rating = ?');
      params.push(filter.rating);
    }
    if (filter.cursor) {
      where.push('r.id < ?');
      params.push(filter.cursor);
    }
    params.push(filter.limit);
    return this.db
      .prepare(
        `SELECT r.id, r.short_link_id, r.rating, r.review_text, r.sentiment_status, r.sentiment_label,
                r.sentiment_confidence, r.sentiment_latency_ms, r.created_at,
                l.code AS link_code, l.label AS link_label
         FROM reviews r LEFT JOIN short_links l ON l.id = r.short_link_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY r.id DESC LIMIT ?`,
      )
      .all(...params) as unknown as ReviewRow[];
  }

  stats(since7d: number): ReviewStatsRow {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS total, AVG(rating) AS averageRating,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last7Days
         FROM reviews`,
      )
      .get(since7d) as { total: number; averageRating: number | null; last7Days: number | null };
    const byRating = this.db.prepare('SELECT rating, COUNT(*) AS n FROM reviews GROUP BY rating').all() as Array<{
      rating: number;
      n: number;
    }>;
    const bySentiment = this.db
      .prepare('SELECT sentiment_label AS label, COUNT(*) AS n FROM reviews GROUP BY sentiment_label')
      .all() as Array<{ label: SentimentLabel | null; n: number }>;
    return { ...totals, last7Days: totals.last7Days ?? 0, byRating, bySentiment };
  }

  latencySamples(limit: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT sentiment_latency_ms AS ms FROM reviews
           WHERE sentiment_latency_ms IS NOT NULL ORDER BY id DESC LIMIT ?`,
        )
        .all(limit) as Array<{ ms: number }>
    ).map((r) => r.ms);
  }

  deleteCreatedBefore(cutoff: number): number {
    return Number(this.db.prepare('DELETE FROM reviews WHERE created_at < ?').run(cutoff).changes);
  }
}
