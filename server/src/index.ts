import { ConfigError, loadConfig } from './config/env.js';
import { createContainer } from './container.js';
import { buildApp } from './http/app.js';
import { createLogger } from './lib/createLogger.js';
import type { Logger } from './lib/logger.js';
import type { EmailTransport } from './services/email/types.js';

async function verifySmtp(transport: EmailTransport | null, production: boolean, logger: Logger) {
  if (!transport?.verify) return;
  try {
    await transport.verify();
    logger.info('smtp connection verified');
  } catch (err) {
    logger.error({ err }, 'smtp verification failed');
    if (production) throw err;
    logger.warn('continuing without a verified smtp connection (non-production)');
  }
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);
  if (!process.env.APP_SECRET) logger.warn('APP_SECRET not set; using an ephemeral secret (development only)');

  const container = createContainer(config, logger);
  await verifySmtp(container.emailTransport, config.env === 'production', logger);
  const app = await buildApp(container, logger);
  container.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await app.close();
      await container.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
