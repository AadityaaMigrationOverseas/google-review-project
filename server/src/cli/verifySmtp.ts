import { ConfigError, loadConfig } from '../config/env.js';
import { SmtpTransport } from '../services/email/transports.js';

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

  if (config.email.transport !== 'smtp') {
    console.error(
      `EMAIL_TRANSPORT is "${config.email.transport}". Set EMAIL_TRANSPORT=smtp, SMTP_HOST, EMAIL_FROM (and SMTP_USER/SMTP_PASSWORD if required) then retry.`,
    );
    process.exit(2);
  }
  if (!config.email.smtp.host) {
    console.error('SMTP_HOST is empty. Set it to your provider hostname (for example smtp.gmail.com).');
    process.exit(2);
  }

  const transport = new SmtpTransport(config.email.smtp);
  try {
    await transport.verify();
    console.log(
      `SMTP verified: ${config.email.smtp.host}:${config.email.smtp.port} (secure=${config.email.smtp.secure}) as ${config.email.from}`,
    );
  } catch (err) {
    console.error('SMTP verification failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    transport.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
