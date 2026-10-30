import type { SessionDto } from '@stellar/shared';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import type { AuthenticatedSession } from '../../services/auth/authService.js';
import { permissionsFor } from '../../services/auth/rbac.js';
import { RATE_RULES } from '../../services/security/rateLimiter.js';
import { clearSessionCookie, requireStaff, setSessionCookie } from '../auth.js';
import { enforceRateLimit, ipHashOf } from '../security.js';

export function toSessionDto(s: AuthenticatedSession): SessionDto {
  return { user: s.user, permissions: permissionsFor(s.user.role), csrfToken: s.csrfToken };
}

export function registerAuthRoutes(app: FastifyInstance, c: Container): void {
  app.post('/api/auth/login', async (request, reply): Promise<SessionDto> => {
    const ipHash = ipHashOf(request, c.config.appSecret);
    enforceRateLimit(c.rateLimiter, reply, `login:${ipHash}`, RATE_RULES.loginPerIp);
    const b = (request.body ?? {}) as { email?: unknown; password?: unknown };
    try {
      const { token, session } = await c.auth.login(b.email, b.password, {
        ipHash,
        userAgent: request.headers['user-agent'] ?? null,
      });
      setSessionCookie(c, reply, token);
      c.audit.record({ userId: session.user.id, action: 'auth.login', ipHash, now: c.clock.now() });
      return toSessionDto(session);
    } catch (err) {
      c.audit.record({ userId: null, action: 'auth.login_failed', ipHash, now: c.clock.now() });
      throw err;
    }
  });

  app.get('/api/auth/session', { preHandler: requireStaff(c) }, async (request): Promise<SessionDto> =>
    toSessionDto(request.staff!),
  );

  app.post('/api/auth/logout', { preHandler: requireStaff(c) }, async (request, reply) => {
    c.auth.logout(request.staff!.tokenHash);
    clearSessionCookie(c, reply);
    c.audit.record({
      userId: request.staff!.user.id,
      action: 'auth.logout',
      ipHash: ipHashOf(request, c.config.appSecret),
      now: c.clock.now(),
    });
    reply.code(204);
  });
}
