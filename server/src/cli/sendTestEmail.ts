import { randomBytes } from 'node:crypto';
import { ConfigError, loadConfig } from '../config/env.js';
import { SmtpTransport } from '../services/email/transports.js';

/**
 * Sends one authorized SMTP connectivity test to COMPLAINT_NOTIFY_TO.
 * Contains no patient data. Requires EMAIL_TRANSPORT=smtp and working credentials.
 */
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

  if (config.email.transport !== 'smtp' || !config.email.smtp.host) {
    console.error(
      [
        'Cannot send a real complaint-notification test: SMTP is not configured.',
        'Set all of the following, then run `npm run email:test` again:',
        '  EMAIL_TRANSPORT=smtp',
        '  SMTP_HOST=...          (provider hostname)',
        '  SMTP_PORT=587          (or 465 with SMTP_SECURE=true)',
        '  SMTP_USER=...',
        '  SMTP_PASSWORD=...',
        '  EMAIL_FROM="Stellar Review Portal <no-reply@your-domain>"',
        '  COMPLAINT_NOTIFY_TO=aaditya@migrationoverseas.com',
        'The sending domain must be authorised (SPF + DKIM) for EMAIL_FROM.',
      ].join('\n'),
    );
    process.exit(2);
  }

  const stamp = new Date().toISOString();
  const token = randomBytes(6).toString('hex');
  const messageId = `<smtp-test-${token}@${new URL(config.appBaseUrl).hostname}>`;
  const transport = new SmtpTransport(config.email.smtp);
  try {
    await transport.verify();
    const result = await transport.send({
      to: config.email.complaintNotifyTo,
      from: config.email.from,
      subject: `[TEST] Stellar review portal SMTP check ${token}`,
      text: [
        'This is an authorized connectivity test from the Stellar Dental Clinic review portal.',
        'It contains no patient data.',
        `Sent at: ${stamp}`,
        `App: ${config.appBaseUrl}`,
        `Token: ${token}`,
      ].join('\n'),
      html: `<p>This is an authorized connectivity test from the Stellar Dental Clinic review portal.</p>
<p>It contains no patient data.</p>
<p>Sent at: ${stamp}<br>App: ${config.appBaseUrl}<br>Token: ${token}</p>`,
      messageId,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          to: config.email.complaintNotifyTo,
          from: config.email.from,
          subject: `[TEST] Stellar review portal SMTP check ${token}`,
          messageId: result.messageId,
          token,
          sentAt: stamp,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error('SMTP test send failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    transport.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
