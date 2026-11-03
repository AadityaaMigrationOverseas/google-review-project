import { existsSync } from 'node:fs';
import type { AppConfig } from './config/env.js';
import { openDatabase, type Database } from './db/database.js';
import { runMigrations } from './db/migrate.js';
import { systemClock, type Clock } from './lib/clock.js';
import type { Logger } from './lib/logger.js';
import { AuditRepository } from './repositories/auditRepository.js';
import { ComplaintRepository } from './repositories/complaintRepository.js';
import { OutboxRepository } from './repositories/outboxRepository.js';
import { ReviewRepository } from './repositories/reviewRepository.js';
import { SessionRepository } from './repositories/sessionRepository.js';
import { ShortLinkRepository } from './repositories/shortLinkRepository.js';
import { UserRepository } from './repositories/userRepository.js';
import { AuthService } from './services/auth/authService.js';
import { PasswordHasher } from './services/auth/password.js';
import { ComplaintService } from './services/complaintService.js';
import { EmailOutbox } from './services/email/emailOutbox.js';
import { ConsoleTransport, SmtpTransport } from './services/email/transports.js';
import type { EmailTransport } from './services/email/types.js';
import { GoogleReviewDestinationService } from './services/google/reviewDestination.js';
import { RetentionService } from './services/retentionService.js';
import { ReviewService } from './services/reviewService.js';
import { FormTokenService } from './services/security/formTokenService.js';
import { RateLimiter } from './services/security/rateLimiter.js';
import { CppSentimentEngine } from './services/sentiment/cppEngine.js';
import { SentimentService } from './services/sentiment/sentimentService.js';
import type { SentimentAnalyzer } from './services/sentiment/types.js';
import { ShortLinkService } from './services/shortLinkService.js';
import { StatsService } from './services/statsService.js';

export interface Container {
  config: AppConfig;
  db: Database;
  clock: Clock;
  logger: Logger;
  rateLimiter: RateLimiter;
  formTokens: FormTokenService;
  auth: AuthService;
  sentiment: SentimentService;
  reviews: ReviewService;
  complaints: ComplaintService;
  links: ShortLinkService;
  googleReviews: GoogleReviewDestinationService;
  stats: StatsService;
  retention: RetentionService;
  outbox: EmailOutbox;
  emailTransport: EmailTransport | null;
  audit: AuditRepository;
  analyzer: SentimentAnalyzer | null;
  /** Starts background work (engine processes, email delivery, retry loops). */
  start(): void;
  close(): Promise<void>;
}

export interface ContainerOverrides {
  db?: Database;
  clock?: Clock;
  /** `null` disables sentiment analysis. */
  analyzer?: SentimentAnalyzer | null;
  /** `null` disables email delivery (messages stay queued). */
  emailTransport?: EmailTransport | null;
  passwordHasher?: PasswordHasher;
}

function createTransport(config: AppConfig, logger: Logger): EmailTransport | null {
  switch (config.email.transport) {
    case 'smtp':
      return new SmtpTransport(config.email.smtp);
    case 'console':
      return new ConsoleTransport(logger);
    default:
      return null;
  }
}

function createAnalyzer(config: AppConfig, logger: Logger): CppSentimentEngine | null {
  const s = config.sentiment;
  if (!s.enabled) return null;
  for (const [label, file] of [
    ['engine binary', s.binaryPath],
    ['model', s.modelPath],
    ['vocabulary', s.vocabPath],
  ] as const) {
    if (!existsSync(file))
      logger.error(
        { file },
        `sentiment ${label} not found; reviews will be stored and re-analysed once it is available`,
      );
  }
  return new CppSentimentEngine({
    command: s.binaryPath,
    args: ['--model', s.modelPath, '--vocab', s.vocabPath],
    workers: s.workers,
    requestTimeoutMs: s.requestTimeoutMs,
    startupTimeoutMs: s.startupTimeoutMs,
    maxQueue: s.maxQueue,
    logger,
  });
}

export function createContainer(config: AppConfig, logger: Logger, overrides: ContainerOverrides = {}): Container {
  const clock = overrides.clock ?? systemClock;
  const db = overrides.db ?? openDatabase(config.databasePath);
  runMigrations(db);

  const reviewRepo = new ReviewRepository(db);
  const complaintRepo = new ComplaintRepository(db);
  const outboxRepo = new OutboxRepository(db);
  const linkRepo = new ShortLinkRepository(db);
  const userRepo = new UserRepository(db);
  const sessionRepo = new SessionRepository(db);
  const audit = new AuditRepository(db);

  const ownedEngine = overrides.analyzer === undefined ? createAnalyzer(config, logger) : null;
  const analyzer = overrides.analyzer === undefined ? ownedEngine : overrides.analyzer;
  const sentiment = new SentimentService(
    analyzer,
    { neutral: config.sentiment.neutralThreshold, uncertain: config.sentiment.uncertainThreshold },
    clock,
    logger,
  );
  const googleReviews = new GoogleReviewDestinationService({
    reviewUrl: config.googleReviewUrl,
    placeId: config.googlePlaceId,
  });

  const links = new ShortLinkService(linkRepo, clock, {
    baseUrl: config.shortLinks.baseUrl,
    codeLength: config.shortLinks.codeLength,
  });
  const reviews = new ReviewService(reviewRepo, links, sentiment, clock, logger);

  const transport = overrides.emailTransport === undefined ? createTransport(config, logger) : overrides.emailTransport;
  // The outbox renders messages through the complaint service, which in turn
  // enqueues into the outbox; the late-bound closure breaks the cycle.
  const outbox: EmailOutbox = new EmailOutbox(
    outboxRepo,
    transport,
    (row) => complaints.renderNotification(row),
    clock,
    logger,
    {
      maxAttempts: config.email.maxAttempts,
      pollIntervalMs: config.email.pollIntervalMs,
    },
  );
  const complaints: ComplaintService = new ComplaintService(db, complaintRepo, outboxRepo, outbox, clock, {
    to: config.email.complaintNotifyTo,
    from: config.email.from,
    dashboardBaseUrl: config.appBaseUrl,
    includeDetails: config.email.includeDetails,
  });

  const auth = new AuthService(userRepo, sessionRepo, overrides.passwordHasher ?? new PasswordHasher(), clock, {
    sessionTtlMs: config.session.ttlMs,
    sessionIdleMs: config.session.idleMs,
  });

  const retention = new RetentionService(reviewRepo, complaintRepo, audit, auth, clock, logger, config.retention);
  let retentionTimer: NodeJS.Timeout | null = null;

  return {
    config,
    db,
    clock,
    logger,
    rateLimiter: new RateLimiter(clock),
    formTokens: new FormTokenService(config.appSecret, clock, config.forms.minFillMs, config.forms.tokenTtlMs),
    auth,
    sentiment,
    reviews,
    complaints,
    links,
    googleReviews,
    stats: new StatsService(reviewRepo, complaintRepo, outboxRepo, sentiment, clock),
    retention,
    outbox,
    emailTransport: transport,
    audit,
    analyzer,
    start() {
      ownedEngine?.start();
      outbox.start();
      reviews.startRetryLoop(config.sentiment.retryIntervalMs);
      retentionTimer = setInterval(() => {
        try {
          retention.purge();
        } catch (err) {
          logger.error({ err }, 'retention purge failed');
        }
      }, 6 * 3_600_000);
      retentionTimer.unref();
    },
    async close() {
      reviews.stopRetryLoop();
      if (retentionTimer) clearInterval(retentionTimer);
      await outbox.stop();
      await analyzer?.close();
      if (!overrides.db) db.close();
    },
  };
}
