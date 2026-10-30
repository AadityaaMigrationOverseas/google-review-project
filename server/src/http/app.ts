import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { ApiError } from '@stellar/shared';
import type { Container } from '../container.js';
import { AppError } from '../lib/errors.js';
import { randomToken } from '../lib/crypto.js';
import { registerSessionDecorator } from './auth.js';
import { registerAdminRoutes } from './routes/adminRoutes.js';
import { registerAuthRoutes } from './routes/authRoutes.js';
import { registerPageRoutes } from './routes/pageRoutes.js';
import { registerPublicRoutes } from './routes/publicRoutes.js';
import { registerOriginCheck, registerSecurityHeaders } from './security.js';
import type { FastifyBaseLogger } from 'fastify';

export async function buildApp(c: Container, logger: FastifyBaseLogger): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger,
    // Fastify accepts a hop count at runtime; its typings omit `number`.
    trustProxy: c.config.trustProxy,
    bodyLimit: 32 * 1024,
    genReqId: () => randomToken(9),
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 64 },
  });

  // JSON only: browsers cannot send cross-site JSON without a CORS preflight,
  // which this server never grants.
  app.removeContentTypeParser(['text/plain']);

  await app.register(fastifyCookie);
  registerSessionDecorator(app);
  registerSecurityHeaders(app, c.config);
  registerOriginCheck(app, c.config);

  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    let status = 500;
    let payload: ApiError = { error: 'internal', message: 'Something went wrong. Please try again.' };
    if (err instanceof AppError) {
      status = err.statusCode;
      payload = { error: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) };
    } else if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      status = err.statusCode;
      const messages: Record<number, string> = {
        413: 'Your message is too long.',
        415: 'Unsupported content type.',
      };
      payload = { error: err.code ?? 'bad_request', message: messages[status] ?? 'Invalid request.' };
    }
    if (status >= 500) request.log.error({ err }, 'unhandled error');
    else request.log.info({ code: payload.error, status }, 'request rejected');
    reply.code(status).send(payload);
  });

  app.get('/healthz', async (request, reply) => {
    let db = true;
    try {
      c.db.prepare('SELECT 1').get();
    } catch {
      db = false;
    }
    const sentiment = c.analyzer?.status().ready ?? false;
    reply.code(db ? 200 : 503);
    return { status: db ? 'ok' : 'degraded', db, sentimentReady: sentiment };
  });

  registerPublicRoutes(app, c);
  registerAuthRoutes(app, c);
  registerAdminRoutes(app, c);
  await registerPageRoutes(app, c);
  return app;
}
