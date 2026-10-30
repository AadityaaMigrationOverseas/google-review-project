import { pino, type Logger as PinoLogger } from 'pino';

export function createLogger(level: string): PinoLogger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.email',
        '*.phone',
      ],
      censor: '[redacted]',
    },
  });
}
