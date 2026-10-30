import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidEmail } from '@stellar/shared';

export const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export type EmailTransportKind = 'smtp' | 'console' | 'disabled';

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  logLevel: string;
  trustProxy: boolean | string;
  appBaseUrl: string;
  allowedOrigins: string[];
  staticDir: string;
  databasePath: string;
  appSecret: string;
  googleReviewUrl: string;
  /** When set, the review destination becomes Google's direct "write a review" dialog for this place. */
  googlePlaceId: string | null;
  shortLinks: {
    baseUrl: string;
    /** When set, requests for this host may use root-level codes (https://host/AbC123x). */
    host: string | null;
    codeLength: number;
  };
  session: { ttlMs: number; idleMs: number; cookieName: string; cookieSecure: boolean };
  forms: { minFillMs: number; tokenTtlMs: number };
  sentiment: {
    enabled: boolean;
    binaryPath: string;
    modelPath: string;
    vocabPath: string;
    workers: number;
    requestTimeoutMs: number;
    startupTimeoutMs: number;
    maxQueue: number;
    neutralThreshold: number;
    uncertainThreshold: number;
    retryIntervalMs: number;
  };
  email: {
    transport: EmailTransportKind;
    from: string;
    complaintNotifyTo: string;
    includeDetails: boolean;
    maxAttempts: number;
    pollIntervalMs: number;
    smtp: { host: string; port: number; secure: boolean; user: string | null; password: string | null };
  };
  retention: { reviewsDays: number; complaintsDays: number };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

class Reader {
  readonly problems: string[] = [];
  constructor(private readonly env: Env) {}

  str(key: string, fallback?: string): string {
    const v = this.env[key]?.trim();
    if (v) return v;
    if (fallback === undefined) {
      this.problems.push(`${key} is required`);
      return '';
    }
    return fallback;
  }

  optional(key: string): string | null {
    const v = this.env[key]?.trim();
    return v ? v : null;
  }

  int(key: string, fallback: number, min: number, max: number): number {
    const raw = this.env[key]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      this.problems.push(`${key} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return n;
  }

  num(key: string, fallback: number, min: number, max: number): number {
    const raw = this.env[key]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      this.problems.push(`${key} must be a number between ${min} and ${max}`);
      return fallback;
    }
    return n;
  }

  bool(key: string, fallback: boolean): boolean {
    const raw = this.env[key]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    this.problems.push(`${key} must be true or false`);
    return fallback;
  }

  url(key: string, fallback: string | undefined, { httpsOnly }: { httpsOnly: boolean }): string {
    const raw = this.str(key, fallback);
    if (!raw) return raw;
    try {
      const u = new URL(raw);
      if (httpsOnly ? u.protocol !== 'https:' : !['http:', 'https:'].includes(u.protocol)) {
        this.problems.push(`${key} must use ${httpsOnly ? 'https' : 'http(s)'}`);
      }
      return raw.replace(/\/+$/, '');
    } catch {
      this.problems.push(`${key} must be a valid URL`);
      return raw;
    }
  }

  email(key: string, fallback?: string): string {
    const v = this.str(key, fallback);
    if (v && !isValidEmail(extractAddress(v))) this.problems.push(`${key} must be a valid email`);
    return v;
  }
}

/** Accepts both "a@b.c" and "Name <a@b.c>". */
function extractAddress(value: string): string {
  const match = /<([^>]+)>\s*$/.exec(value);
  return (match?.[1] ?? value).trim().toLowerCase();
}

function resolvePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

export function loadConfig(env: Env = process.env): AppConfig {
  const r = new Reader(env);
  const nodeEnv = r.str('NODE_ENV', 'development');
  if (!['development', 'production', 'test'].includes(nodeEnv))
    r.problems.push('NODE_ENV must be development, production or test');
  const isProd = nodeEnv === 'production';

  const port = r.int('PORT', 3000, 1, 65535);
  const appBaseUrl = r.url('APP_BASE_URL', isProd ? undefined : `http://localhost:${port}`, {
    httpsOnly: isProd,
  });

  let appSecret = r.optional('APP_SECRET') ?? '';
  if (!appSecret) {
    if (isProd) r.problems.push('APP_SECRET is required in production (min. 32 characters)');
    appSecret = randomBytes(32).toString('hex');
  } else if (appSecret.length < 32) {
    r.problems.push('APP_SECRET must be at least 32 characters');
  }

  // Fastify ignores hop counts (spoofable), so proxies must be named by address/CIDR or keyword.
  const trustProxyRaw = r.optional('TRUST_PROXY');
  let trustProxy: boolean | string = false;
  if (trustProxyRaw) {
    if (/^\d+$/.test(trustProxyRaw)) {
      r.problems.push('TRUST_PROXY must list proxy addresses (e.g. "loopback" or "10.0.0.0/8"), not a hop count');
    } else if (/^(true|false|yes|no|on|off)$/i.test(trustProxyRaw)) {
      trustProxy = r.bool('TRUST_PROXY', false);
    } else {
      trustProxy = trustProxyRaw;
    }
  }

  const shortBase = r.url('SHORT_LINK_BASE_URL', `${appBaseUrl}/r`, { httpsOnly: isProd });
  const shortHost = r.optional('SHORT_LINK_HOST')?.toLowerCase() ?? null;

  const transport = r.str('EMAIL_TRANSPORT', isProd ? 'smtp' : 'console') as EmailTransportKind;
  if (!['smtp', 'console', 'disabled'].includes(transport))
    r.problems.push('EMAIL_TRANSPORT must be smtp, console or disabled');
  if (isProd && transport !== 'smtp')
    r.problems.push('EMAIL_TRANSPORT must be smtp in production so complaints reach the clinic');

  const smtpRequired = transport === 'smtp';
  const smtp = {
    host: smtpRequired ? r.str('SMTP_HOST') : (r.optional('SMTP_HOST') ?? ''),
    port: r.int('SMTP_PORT', 587, 1, 65535),
    secure: r.bool('SMTP_SECURE', false),
    user: r.optional('SMTP_USER'),
    password: r.optional('SMTP_PASSWORD'),
  };
  if (smtp.user && !smtp.password) r.problems.push('SMTP_PASSWORD is required when SMTP_USER is set');

  const extraOrigins = (r.optional('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  // The Vite dev server proxies API calls from its own origin.
  if (nodeEnv === 'development') extraOrigins.push('http://localhost:5173', 'http://127.0.0.1:5173');

  const cookieSecure = r.bool('COOKIE_SECURE', isProd);

  const config: AppConfig = {
    env: nodeEnv as AppConfig['env'],
    host: r.str('HOST', isProd ? '0.0.0.0' : '127.0.0.1'),
    port,
    logLevel: r.str('LOG_LEVEL', nodeEnv === 'test' ? 'silent' : 'info'),
    trustProxy,
    appBaseUrl,
    allowedOrigins: [
      ...new Set([safeOrigin(appBaseUrl), safeOrigin(shortBase), ...extraOrigins].filter(Boolean)),
    ] as string[],
    staticDir: resolvePath(r.str('STATIC_DIR', 'web/dist')),
    databasePath: resolvePath(r.str('DATABASE_PATH', 'data/portal.sqlite')),
    appSecret,
    googleReviewUrl: r.url(
      'GOOGLE_REVIEW_URL',
      'https://search.google.com/local/writereview?placeid=ChIJfXYa4oPPXzkRD1P8S7a9swU',
      {
        httpsOnly: true,
      },
    ),
    googlePlaceId: r.optional('GOOGLE_PLACE_ID'),
    shortLinks: {
      baseUrl: shortBase,
      host: shortHost,
      codeLength: r.int('SHORT_LINK_CODE_LENGTH', 7, 6, 16),
    },
    session: {
      ttlMs: r.int('SESSION_TTL_HOURS', 12, 1, 24 * 30) * 3_600_000,
      idleMs: r.int('SESSION_IDLE_MINUTES', 60, 5, 24 * 60) * 60_000,
      // The __Host- prefix makes browsers reject the cookie unless it is Secure,
      // host-only and Path=/, which blocks subdomain cookie injection.
      cookieName: cookieSecure ? '__Host-sdc_session' : 'sdc_session',
      cookieSecure,
    },
    forms: {
      minFillMs: r.int('FORM_MIN_FILL_MS', 2500, 0, 60_000),
      tokenTtlMs: r.int('FORM_TOKEN_TTL_MINUTES', 120, 5, 24 * 60) * 60_000,
    },
    sentiment: {
      enabled: r.bool('SENTIMENT_ENABLED', true),
      binaryPath: resolvePath(r.str('SENTIMENT_BINARY', 'sentiment-engine/build/sentiment_server')),
      modelPath: resolvePath(r.str('SENTIMENT_MODEL_PATH', 'sentiment-engine/models/distilbert-sst2.onnx')),
      vocabPath: resolvePath(r.str('SENTIMENT_VOCAB_PATH', 'sentiment-engine/models/vocab.txt')),
      workers: r.int('SENTIMENT_WORKERS', 1, 1, 16),
      requestTimeoutMs: r.int('SENTIMENT_TIMEOUT_MS', 1000, 100, 60_000),
      startupTimeoutMs: r.int('SENTIMENT_STARTUP_TIMEOUT_MS', 30_000, 1000, 300_000),
      maxQueue: r.int('SENTIMENT_MAX_QUEUE', 100, 1, 10_000),
      neutralThreshold: r.num('SENTIMENT_NEUTRAL_THRESHOLD', 0.75, 0.5, 0.999),
      uncertainThreshold: r.num('SENTIMENT_UNCERTAIN_THRESHOLD', 0.6, 0.5, 0.999),
      retryIntervalMs: r.int('SENTIMENT_RETRY_INTERVAL_SECONDS', 300, 10, 86_400) * 1000,
    },
    email: {
      transport,
      from: r.email('EMAIL_FROM', smtpRequired ? undefined : 'Stellar Review Portal <no-reply@localhost.test>'),
      complaintNotifyTo: r.email('COMPLAINT_NOTIFY_TO', 'dhruvi@stellardentalclinic.com'),
      includeDetails: r.bool('EMAIL_INCLUDE_DETAILS', true),
      maxAttempts: r.int('EMAIL_MAX_ATTEMPTS', 6, 1, 20),
      pollIntervalMs: r.int('EMAIL_POLL_INTERVAL_SECONDS', 30, 1, 3600) * 1000,
      smtp,
    },
    retention: {
      reviewsDays: r.int('RETENTION_REVIEWS_DAYS', 0, 0, 36_500),
      complaintsDays: r.int('RETENTION_COMPLAINTS_DAYS', 0, 0, 36_500),
    },
  };

  if (config.sentiment.uncertainThreshold >= config.sentiment.neutralThreshold) {
    r.problems.push('SENTIMENT_UNCERTAIN_THRESHOLD must be lower than SENTIMENT_NEUTRAL_THRESHOLD');
  }
  if (config.googlePlaceId && !/^[A-Za-z0-9_-]{10,}$/.test(config.googlePlaceId)) {
    r.problems.push('GOOGLE_PLACE_ID has an unexpected format');
  }
  if (r.problems.length > 0) throw new ConfigError(r.problems);
  return config;
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
