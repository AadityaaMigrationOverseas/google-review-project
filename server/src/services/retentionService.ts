import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { AuditRepository } from '../repositories/auditRepository.js';
import type { ComplaintRepository } from '../repositories/complaintRepository.js';
import type { ReviewRepository } from '../repositories/reviewRepository.js';
import type { AuthService } from './auth/authService.js';

const DAY_MS = 86_400_000;
const AUDIT_RETENTION_DAYS = 730;

/** Deletes records past the clinic's configured retention periods (0 = keep). */
export class RetentionService {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly complaints: ComplaintRepository,
    private readonly audit: AuditRepository,
    private readonly auth: AuthService,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly policy: { reviewsDays: number; complaintsDays: number },
  ) {}

  purge(): { reviews: number; complaints: number; sessions: number; audit: number } {
    const now = this.clock.now();
    const result = {
      reviews: this.policy.reviewsDays ? this.reviews.deleteCreatedBefore(now - this.policy.reviewsDays * DAY_MS) : 0,
      complaints: this.policy.complaintsDays
        ? this.complaints.deleteCreatedBefore(now - this.policy.complaintsDays * DAY_MS)
        : 0,
      sessions: this.auth.purgeExpiredSessions(),
      audit: this.audit.deleteCreatedBefore(now - AUDIT_RETENTION_DAYS * DAY_MS),
    };
    this.logger.info(result, 'retention purge complete');
    return result;
  }
}
