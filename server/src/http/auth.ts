import type { Permission } from '@stellar/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Container } from '../container.js';
import { safeEqual } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { AuthenticatedSession } from '../services/auth/authService.js';
import { can } from '../services/auth/rbac.js';
import { enforceRateLimit } from './security.js';
import { RATE_RULES } from '../services/security/rateLimiter.js';

declare module 'fastify' {
  interface FastifyRequest {
    staff: AuthenticatedSession | null;
  }
}

export function registerSessionDecorator(app: FastifyInstance): void {
  app.decorateRequest('staff', null);
}

export function setSessionCookie(c: Container, reply: FastifyReply, token: string): void {
  reply.setCookie(c.config.session.cookieName, token, {
    httpOnly: true,
    secure: c.config.session.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: Math.floor(c.config.session.ttlMs / 1000),
  });
}

export function clearSessionCookie(c: Container, reply: FastifyReply): void {
  reply.clearCookie(c.config.session.cookieName, {
    httpOnly: true,
    secure: c.config.session.cookieSecure,
    sameSite: 'strict',
    path: '/',
  });
}

/** Resolves the session cookie; enforces CSRF tokens on state-changing requests. */
export function requireStaff(c: Container): preHandlerAsyncHookHandler {
  return async function (this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies[c.config.session.cookieName];
    const session = c.auth.authenticate(token);
    if (!session) {
      if (token) clearSessionCookie(c, reply);
      throw unauthorized('Your session has expired. Please sign in again.');
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const header = request.headers['x-csrf-token'];
      if (typeof header !== 'string' || !safeEqual(header, session.csrfToken))
        throw forbidden('Security token mismatch. Please reload the page.');
    }
    enforceRateLimit(c.rateLimiter, reply, `admin:${session.user.id}`, RATE_RULES.adminApi);
    request.staff = session;
  };
}

export function requirePermission(permission: Permission): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest) => {
    if (!request.staff || !can(request.staff.user.role, permission)) throw forbidden();
  };
}

export function staffCan(request: FastifyRequest, permission: Permission): boolean {
  return request.staff !== null && can(request.staff.user.role, permission);
}
