import type { StatsDto } from '@stellar/shared';
import type { Clock } from '../lib/clock.js';
import type { ComplaintRepository } from '../repositories/complaintRepository.js';
import type { OutboxRepository } from '../repositories/outboxRepository.js';
import type { ReviewRepository } from '../repositories/reviewRepository.js';
import type { SentimentService } from './sentiment/sentimentService.js';

export class StatsService {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly complaints: ComplaintRepository,
    private readonly outbox: OutboxRepository,
    private readonly sentiment: SentimentService,
    private readonly clock: Clock,
  ) {}

  get(): StatsDto {
    const r = this.reviews.stats(this.clock.now() - 7 * 86_400_000);
    const byRating: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of r.byRating) byRating[row.rating] = row.n;
    const bySentiment = { positive: 0, negative: 0, neutral: 0, uncertain: 0, unanalyzed: 0 };
    for (const row of r.bySentiment) bySentiment[row.label ?? 'unanalyzed'] += row.n;

    const c = this.complaints.countsByStatus();
    const o = this.outbox.countsByStatus();
    const engine = this.sentiment.status();
    return {
      reviews: {
        total: r.total,
        averageRating: r.averageRating === null ? null : Math.round(r.averageRating * 100) / 100,
        byRating,
        bySentiment,
        last7Days: r.last7Days,
      },
      complaints: {
        total: c.open + c.in_progress + c.resolved,
        open: c.open,
        inProgress: c.in_progress,
        resolved: c.resolved,
      },
      notifications: { pending: o.pending + o.sending, failed: o.failed, sent: o.sent },
      sentimentEngine: engine,
    };
  }
}
