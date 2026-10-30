import { randomUUID } from 'node:crypto';
import {
  classifyReviewStatus,
  CONSENT_VERSION,
  isValidShortCode,
  nextStepFor,
  validateComplaintInput,
  validateReviewInput,
  type FormTokenResponse,
  type SentimentPreviewResponse,
  type SubmitComplaintResponse,
  type SubmitReviewResponse,
} from '@stellar/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Container } from '../../container.js';
import { AppError, validationFailed } from '../../lib/errors.js';
import type { FormTokenProblem } from '../../services/security/formTokenService.js';
import { RATE_RULES } from '../../services/security/rateLimiter.js';
import { enforceRateLimit, ipHashOf } from '../security.js';

const FORM_PURPOSES = new Set(['review', 'complaint']);
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9-]{16,64}$/;
const ESCALATION_CONFIRMATION_MESSAGE =
  "Your message has been sent directly to the doctor's management desk. We will contact you within 24–48 hours.";

const TOKEN_MESSAGES: Record<FormTokenProblem, string> = {
  too_fast: 'That was quick! Please take a moment to check your answers, then submit again.',
  expired: 'This form has expired. Please reload the page and try again.',
  invalid: 'This form could not be verified. Please reload the page and try again.',
  reused: 'This form was already submitted. Please reload the page to send another response.',
};

function body(request: FastifyRequest): Record<string, unknown> {
  return typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
}

function checkFormToken(c: Container, token: unknown, purpose: string): void {
  const problem = c.formTokens.consume(token, purpose);
  if (problem) throw new AppError(problem === 'too_fast' ? 425 : 400, `form_${problem}`, TOKEN_MESSAGES[problem]);
}

/** Bots fill every field; humans never see the honeypot. */
function isHoneypotTripped(payload: Record<string, unknown>): boolean {
  return typeof payload.website === 'string' && payload.website.trim() !== '';
}

export function registerPublicRoutes(app: FastifyInstance, c: Container): void {
  app.get(
    '/api/public/form-token',
    async (request, reply): Promise<FormTokenResponse & { linkValid: boolean | null }> => {
      const ipHash = ipHashOf(request, c.config.appSecret);
      enforceRateLimit(c.rateLimiter, reply, `token:${ipHash}`, RATE_RULES.formToken);
      const q = request.query as { purpose?: string; link?: string };
      const purpose = q.purpose && FORM_PURPOSES.has(q.purpose) ? q.purpose : 'review';
      let linkValid: boolean | null = null;
      if (q.link !== undefined && q.link !== '')
        linkValid = isValidShortCode(q.link) && c.links.resolve(q.link) !== null;
      return {
        formToken: c.formTokens.issue(purpose),
        googleReviewUrl: c.googleReviews.url,
        consentVersion: CONSENT_VERSION,
        linkValid,
      };
    },
  );

  app.post('/api/public/reviews', async (request, reply: FastifyReply): Promise<SubmitReviewResponse> => {
    const ipHash = ipHashOf(request, c.config.appSecret);
    enforceRateLimit(c.rateLimiter, reply, `review:${ipHash}`, RATE_RULES.reviewSubmit);
    const payload = body(request);
    if (isHoneypotTripped(payload)) {
      request.log.warn({ ipHash }, 'review honeypot tripped');
      reply.code(201);
      return { id: 0, googleReviewUrl: c.googleReviews.url, sentiment: null, next: 'complaint', duplicate: false };
    }
    const parsed = validateReviewInput(payload);
    if (!parsed.ok) throw validationFailed(parsed.errors);

    // A retry of an already-accepted submission replays the original result,
    // even though its single-use form token has been consumed.
    const replay = c.reviews.findByIdempotencyKey(payload.idempotencyKey);
    if (replay) {
      reply.code(200);
      return {
        id: replay.id,
        googleReviewUrl: c.googleReviews.url,
        sentiment: replay.sentiment,
        next: nextStepFor(replay.rating, replay.sentiment),
        duplicate: true,
      };
    }
    checkFormToken(c, payload.formToken, 'review');

    const { id, sentiment, duplicate } = await c.reviews.submit(parsed.value, payload.idempotencyKey, { ipHash });
    reply.code(duplicate ? 200 : 201);
    return {
      id,
      googleReviewUrl: c.googleReviews.url,
      sentiment,
      next: nextStepFor(parsed.value.rating, sentiment),
      duplicate,
    };
  });

  app.post('/api/public/complaints', async (request, reply): Promise<SubmitComplaintResponse> => {
    const ipHash = ipHashOf(request, c.config.appSecret);
    const payload = body(request);

    // A retry of an already-accepted submission returns the original reference.
    const existing =
      typeof payload.idempotencyKey === 'string' ? c.complaints.findReference(payload.idempotencyKey) : null;
    if (existing) return { reference: existing };

    enforceRateLimit(c.rateLimiter, reply, `complaint:${ipHash}`, RATE_RULES.complaintSubmit);
    if (isHoneypotTripped(payload)) {
      request.log.warn({ ipHash }, 'complaint honeypot tripped');
      reply.code(201);
      return { reference: 'SDC-RECEIVED' };
    }
    const parsed = validateComplaintInput(payload);
    if (!parsed.ok) throw validationFailed(parsed.errors);
    checkFormToken(c, payload.formToken, 'complaint');

    const result = c.complaints.submit(parsed.value, payload.idempotencyKey, { ipHash });
    reply.code(result.created ? 201 : 200);
    return { reference: result.reference };
  });

  // Step 2: Real-time debounced sentiment preview (caches C++ prediction for instant submit).
  app.post('/api/sentiment/preview', async (request, reply): Promise<SentimentPreviewResponse> => {
    const ipHash = ipHashOf(request, c.config.appSecret);
    enforceRateLimit(c.rateLimiter, reply, `preview:${ipHash}`, RATE_RULES.sentimentPreview);
    const payload = body(request);
    const reviewText =
      typeof payload.reviewText === 'string'
        ? payload.reviewText
        : typeof payload.text === 'string'
          ? payload.text
          : '';
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
    return c.sentiment.preview(reviewText, sessionId);
  });

  // Step 3: Authoritative review submission endpoint.
  app.post('/api/reviews/submit', async (request, reply: FastifyReply): Promise<SubmitReviewResponse> => {
    const ipHash = ipHashOf(request, c.config.appSecret);
    enforceRateLimit(c.rateLimiter, reply, `review:${ipHash}`, RATE_RULES.reviewSubmit);
    const payload = body(request);
    if (isHoneypotTripped(payload)) {
      request.log.warn({ ipHash }, 'review honeypot tripped');
      reply.code(201);
      return {
        id: 0,
        reviewId: '0',
        status: 'NEGATIVE',
        googleUrl: c.googleReviews.url,
        googleReviewUrl: c.googleReviews.url,
        googleDestinationKind: c.googleReviews.kind,
        sentiment: null,
        next: 'complaint',
        duplicate: false,
      };
    }

    const parsed = validateReviewInput({ consent: true, ...payload });
    if (!parsed.ok) throw validationFailed(parsed.errors);

    const rawKey =
      typeof payload.idempotencyKey === 'string' && IDEMPOTENCY_PATTERN.test(payload.idempotencyKey)
        ? payload.idempotencyKey
        : typeof payload.sessionId === 'string' && IDEMPOTENCY_PATTERN.test(payload.sessionId)
          ? payload.sessionId
          : randomUUID();

    const replay = c.reviews.findByIdempotencyKey(rawKey);
    if (replay) {
      const next = nextStepFor(replay.rating, replay.sentiment);
      const status = classifyReviewStatus(replay.rating, replay.sentiment);
      reply.code(200);
      return {
        id: replay.id,
        reviewId: String(replay.id),
        status,
        googleUrl: c.googleReviews.url,
        googleReviewUrl: c.googleReviews.url,
        googleDestinationKind: c.googleReviews.kind,
        sentiment: replay.sentiment,
        next,
        duplicate: true,
      };
    }

    const { id, sentiment, duplicate } = await c.reviews.submit(parsed.value, rawKey, { ipHash });
    const next = nextStepFor(parsed.value.rating, sentiment);
    const status = classifyReviewStatus(parsed.value.rating, sentiment);

    c.audit.record({
      userId: null,
      action: `review.submit.${status.toLowerCase()}`,
      entity: 'review',
      entityId: id,
      ipHash,
      now: c.clock.now(),
    });

    reply.code(duplicate ? 200 : 201);
    return {
      id,
      reviewId: String(id),
      status,
      googleUrl: c.googleReviews.url,
      googleReviewUrl: c.googleReviews.url,
      googleDestinationKind: c.googleReviews.kind,
      sentiment,
      next,
      duplicate,
    };
  });

  // Step 5: Internal escalation / complaint submission endpoint.
  app.post('/api/complaints/submit', async (request, reply): Promise<SubmitComplaintResponse> => {
    const ipHash = ipHashOf(request, c.config.appSecret);
    const payload = body(request);

    const rawKey =
      typeof payload.idempotencyKey === 'string' && IDEMPOTENCY_PATTERN.test(payload.idempotencyKey)
        ? payload.idempotencyKey
        : randomUUID();

    const existing = c.complaints.findReference(rawKey);
    if (existing) {
      return {
        status: 'RESOLVED_QUEUED',
        reference: existing,
        message: ESCALATION_CONFIRMATION_MESSAGE,
      };
    }

    enforceRateLimit(c.rateLimiter, reply, `complaint:${ipHash}`, RATE_RULES.complaintSubmit);
    if (isHoneypotTripped(payload)) {
      request.log.warn({ ipHash }, 'complaint honeypot tripped');
      reply.code(201);
      return {
        status: 'RESOLVED_QUEUED',
        reference: 'SDC-RECEIVED',
        message: ESCALATION_CONFIRMATION_MESSAGE,
      };
    }

    const parsed = validateComplaintInput({ consent: true, ...payload });
    if (!parsed.ok) throw validationFailed(parsed.errors);

    const result = c.complaints.submit(parsed.value, rawKey, { ipHash });
    c.audit.record({
      userId: null,
      action: 'complaint.submit',
      entity: 'complaint',
      entityId: result.reference,
      ipHash,
      now: c.clock.now(),
    });
    request.log.info(
      {
        reference: result.reference,
        reviewId: payload.reviewId ?? null,
        rating: parsed.value.rating,
      },
      'doctor alert triggered for patient escalation',
    );

    reply.code(result.created ? 201 : 200);
    return {
      status: 'RESOLVED_QUEUED',
      reference: result.reference,
      message: ESCALATION_CONFIRMATION_MESSAGE,
    };
  });
}
