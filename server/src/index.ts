import { ConfigError, loadConfig } from './config/env.js';
import { createContainer } from './container.js';
import { buildApp } from './http/app.js';
import { createLogger } from './lib/createLogger.js';

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
