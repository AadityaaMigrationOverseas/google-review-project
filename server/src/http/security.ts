import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { forbidden, tooManyRequests } from '../lib/errors.js';
import { hashIp } from '../lib/crypto.js';
import type { RateLimiter, RateRule } from '../services/security/rateLimiter.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function registerSecurityHeaders(app: FastifyInstance, config: AppConfig): void {
  const isProd = config.env === 'production';
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    ...(isProd ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  app.addHook('onSend', async (request, reply) => {
    reply.header('Content-Security-Policy', csp);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    // Short codes in URLs must not leak to third parties (including Google).
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (isProd) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const url = request.url;
    if (url.startsWith('/api/') || url.startsWith('/admin') || url.startsWith('/r/')) {
      reply.header('X-Robots-Tag', 'noindex, nofollow');
    }
    if (url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });
}

/**
 * Rejects state-changing requests initiated by other sites. Together with
 * SameSite=Strict cookies, JSON-only bodies and per-session CSRF tokens on
 * staff routes this closes cross-site request forgery.
 */
export function registerOriginCheck(app: FastifyInstance, config: AppConfig): void {
  const allowed = new Set(config.allowedOrigins);
  app.addHook('onRequest', async (request) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!allowed.has(origin)) throw forbidden('Cross-origin request blocked.');
      return;
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') throw forbidden('Cross-origin request blocked.');
  });
}

export function ipHashOf(request: FastifyRequest, secret: string): string | null {
  return hashIp(secret, request.ip);
}

export function enforceRateLimit(limiter: RateLimiter, reply: FastifyReply, key: string, rule: RateRule): void {
  const decision = limiter.consume(key, rule);
  reply.header('RateLimit-Remaining', String(decision.remaining));
  if (!decision.allowed) {
    reply.header('Retry-After', String(decision.retryAfterSec));
    throw tooManyRequests(decision.retryAfterSec);
  }
}
