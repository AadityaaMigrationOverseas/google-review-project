import { isRole, SENTIMENT_LABELS, type SentimentLabel } from '@stellar/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Container } from '../../container.js';
import { badRequest } from '../../lib/errors.js';
import { requirePermission, requireStaff, staffCan } from '../auth.js';
import { ipHashOf } from '../security.js';

function parseId(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('Invalid id.');
  return id;
}

function parsePaging(q: Record<string, unknown>): { cursor?: number; limit: number } {
  const limit = q.limit === undefined ? 25 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest('limit must be 1–100.');
  const cursor = q.cursor === undefined || q.cursor === '' ? undefined : parseId(q.cursor);
  return { cursor, limit };
}

export function registerAdminRoutes(app: FastifyInstance, c: Container): void {
  const audit = (request: FastifyRequest, action: string, entity?: string, entityId?: number) =>
    c.audit.record({
      userId: request.staff?.user.id ?? null,
      action,
      entity,
      entityId,
      ipHash: ipHashOf(request, c.config.appSecret),
      now: c.clock.now(),
    });

  app.register(async (admin) => {
    admin.addHook('preHandler', requireStaff(c));

    admin.get('/api/admin/stats', { preHandler: requirePermission('reviews:read') }, async () => c.stats.get());

    admin.get('/api/admin/reviews', { preHandler: requirePermission('reviews:read') }, async (request) => {
      const q = request.query as Record<string, unknown>;
      const sentiment = q.sentiment as string | undefined;
      if (sentiment && sentiment !== 'unanalyzed' && !(SENTIMENT_LABELS as readonly string[]).includes(sentiment))
        throw badRequest('Invalid sentiment filter.');
      const rating = q.rating === undefined || q.rating === '' ? undefined : Number(q.rating);
      if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5))
        throw badRequest('Invalid rating filter.');
      return c.reviews.list({
        ...parsePaging(q),
        sentiment: (sentiment || undefined) as SentimentLabel | 'unanalyzed' | undefined,
        rating,
      });
    });

    admin.get('/api/admin/complaints', { preHandler: requirePermission('complaints:read') }, async (request) => {
      const q = request.query as Record<string, unknown>;
      return c.complaints.list({ ...parsePaging(q), status: q.status }, staffCan(request, 'complaints:read_pii'));
    });

    admin.get('/api/admin/complaints/:id', { preHandler: requirePermission('complaints:read') }, async (request) => {
      const id = parseId((request.params as { id: string }).id);
      const showPii = staffCan(request, 'complaints:read_pii');
      const dto = c.complaints.get(id, showPii);
      if (showPii) audit(request, 'complaint.view_pii', 'complaint', id);
      return dto;
    });

    admin.patch(
      '/api/admin/complaints/:id',
      { preHandler: requirePermission('complaints:update') },
      async (request) => {
        const id = parseId((request.params as { id: string }).id);
        const { status } = (request.body ?? {}) as { status?: unknown };
        const dto = c.complaints.updateStatus(id, status, staffCan(request, 'complaints:read_pii'));
        audit(request, `complaint.status.${dto.status}`, 'complaint', id);
        return dto;
      },
    );

    admin.post(
      '/api/admin/complaints/:id/retry-notification',
      { preHandler: requirePermission('notifications:retry') },
      async (request) => {
        const id = parseId((request.params as { id: string }).id);
        const dto = c.complaints.retryNotification(id, staffCan(request, 'complaints:read_pii'));
        audit(request, 'complaint.notification_retry', 'complaint', id);
        return dto;
      },
    );

    admin.get('/api/admin/links', { preHandler: requirePermission('links:read') }, async () => ({
      items: c.links.list(),
    }));

    admin.post('/api/admin/links', { preHandler: requirePermission('links:write') }, async (request, reply) => {
      const link = c.links.create((request.body ?? {}) as Record<string, unknown>, request.staff!.user.id);
      audit(request, 'link.create', 'short_link', link.id);
      reply.code(201);
      return link;
    });

    admin.patch('/api/admin/links/:id', { preHandler: requirePermission('links:write') }, async (request) => {
      const id = parseId((request.params as { id: string }).id);
      const link = c.links.update(id, (request.body ?? {}) as Record<string, unknown>);
      audit(request, 'link.update', 'short_link', id);
      return link;
    });

    admin.get(
      '/api/admin/links/:id/qr.svg',
      { preHandler: requirePermission('links:read') },
      async (request, reply) => {
        const id = parseId((request.params as { id: string }).id);
        reply.header('Content-Type', 'image/svg+xml; charset=utf-8');
        reply.header('Cache-Control', 'private, max-age=300');
        return c.links.qrSvg(id);
      },
    );

    admin.get('/api/admin/users', { preHandler: requirePermission('users:manage') }, async () => ({
      items: c.auth.listUsers(),
    }));

    admin.post('/api/admin/users', { preHandler: requirePermission('users:manage') }, async (request, reply) => {
      const b = (request.body ?? {}) as Record<string, unknown>;
      if (!isRole(b.role)) throw badRequest('Please choose a valid role.', { role: 'Choose a role.' });
      const user = await c.auth.createUser({ email: b.email, name: b.name, password: b.password, role: b.role });
      audit(request, 'user.create', 'staff_user', user.id);
      reply.code(201);
      return user;
    });

    admin.patch('/api/admin/users/:id', { preHandler: requirePermission('users:manage') }, async (request) => {
      const id = parseId((request.params as { id: string }).id);
      const b = (request.body ?? {}) as Record<string, unknown>;
      if (b.role !== undefined && !isRole(b.role)) throw badRequest('Invalid role.');
      if (b.disabled !== undefined && typeof b.disabled !== 'boolean') throw badRequest('Invalid disabled flag.');
      const user = c.auth.updateUser(request.staff!.user.id, id, {
        role: b.role as never,
        disabled: b.disabled as boolean | undefined,
      });
      audit(request, 'user.update', 'staff_user', id);
      return user;
    });
  });
}
