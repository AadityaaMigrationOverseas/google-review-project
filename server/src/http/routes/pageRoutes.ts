import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Container } from '../../container.js';
import { RATE_RULES } from '../../services/security/rateLimiter.js';
import { enforceRateLimit, ipHashOf } from '../security.js';

const PAGES = {
  review: 'review.html',
  complaint: 'complaint.html',
  privacy: 'privacy.html',
  admin: 'admin.html',
  invalidLink: 'link-invalid.html',
  notFound: '404.html',
} as const;

export async function registerPageRoutes(app: FastifyInstance, c: Container): Promise<void> {
  const root = c.config.staticDir;
  const built = existsSync(path.join(root, PAGES.review));
  if (!built) {
    app.log.warn({ root }, 'frontend build not found; run `npm run build -w web` or use the Vite dev server');
  }

  await app.register(fastifyStatic, {
    root: built ? root : process.cwd(),
    serve: built,
    prefix: '/',
    index: false,
    wildcard: false,
    preCompressed: true,
    setHeaders(res, filePath) {
      // Hashed build assets never change; HTML must always be revalidated.
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.header('Cache-Control', 'no-cache');
      }
    },
  });

  const page = (reply: FastifyReply, file: string, status = 200) => {
    if (!built) return reply.code(503).type('text/plain').send('Frontend not built. Run `npm run build:app`.');
    return reply.code(status).sendFile(file, { cacheControl: false });
  };

  const serveShortLink = async (request: FastifyRequest, reply: FastifyReply, code: string) => {
    enforceRateLimit(c.rateLimiter, reply, `link:${ipHashOf(request, c.config.appSecret)}`, RATE_RULES.shortLinkLookup);
    const id = c.links.resolve(code);
    reply.header('Cache-Control', 'no-store');
    if (id === null) return page(reply, PAGES.invalidLink, 404);
    c.links.recordClick(id);
    return page(reply, PAGES.review);
  };

  app.get('/', (request, reply) => page(reply, PAGES.review));
  app.get('/review', (request, reply) => page(reply, PAGES.review));
  app.get('/complaint', (request, reply) => page(reply, PAGES.complaint));
  app.get('/privacy', (request, reply) => page(reply, PAGES.privacy));
  app.get('/admin', (request, reply) => page(reply, PAGES.admin));
  app.get('/r/:code', (request, reply) => serveShortLink(request, reply, (request.params as { code: string }).code));

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? '';
    // On a dedicated short-link host, https://host/AbC123x works without the /r prefix.
    const host = (request.hostname ?? '').split(':')[0]?.toLowerCase();
    if (request.method === 'GET' && c.config.shortLinks.host && host === c.config.shortLinks.host) {
      const code = pathname.slice(1);
      if (/^[A-Za-z0-9]{6,16}$/.test(code)) return serveShortLink(request, reply, code);
    }
    if (pathname.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    }
    return page(reply, PAGES.notFound, 404);
  });
}
