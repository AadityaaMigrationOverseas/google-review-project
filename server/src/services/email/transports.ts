import nodemailer from 'nodemailer';
import type { Logger } from '../../lib/logger.js';
import { PermanentEmailError, type EmailMessage, type EmailTransport } from './types.js';

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
}

export class SmtpTransport implements EmailTransport {
  readonly name = 'smtp';
  private readonly transporter;

  constructor(opts: SmtpOptions) {
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      // Never fall back to plaintext when the server offers STARTTLS.
      requireTLS: !opts.secure,
      auth: opts.user ? { user: opts.user, pass: opts.password ?? '' } : undefined,
      pool: true,
      maxConnections: 2,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2' },
    });
  }

  async send(m: EmailMessage): Promise<{ messageId: string | null }> {
    try {
      const info = await this.transporter.sendMail({
        from: m.from,
        to: m.to,
        subject: m.subject,
        text: m.text,
        html: m.html,
        messageId: m.messageId,
        headers: m.headers,
      });
      return { messageId: info.messageId ?? null };
    } catch (err) {
      const code = (err as { responseCode?: number }).responseCode;
      // 55x = mailbox unavailable / policy rejection: retrying will not help.
      if (code && code >= 550 && code < 560) throw new PermanentEmailError(`SMTP ${code}: ${(err as Error).message}`);
      throw err;
    }
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  close(): void {
    this.transporter.close();
  }
}

/** Development transport: logs envelope metadata only, never message bodies (patient data). */
export class ConsoleTransport implements EmailTransport {
  readonly name = 'console';
  constructor(private readonly logger: Logger) {}

  async send(m: EmailMessage): Promise<{ messageId: string | null }> {
    this.logger.info({ to: m.to, subject: m.subject, messageId: m.messageId }, 'email (console transport)');
    return { messageId: m.messageId };
  }
}

/** Test double that records messages and can be told to fail. */
export class MemoryTransport implements EmailTransport {
  readonly name = 'memory';
  readonly sent: EmailMessage[] = [];
  failures: Array<Error> = [];

  async send(m: EmailMessage): Promise<{ messageId: string | null }> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push(m);
    return { messageId: m.messageId };
  }
}
