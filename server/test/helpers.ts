import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { loadConfig, type AppConfig } from '../src/config/env.js';
import { createContainer, type Container, type ContainerOverrides } from '../src/container.js';
import { openDatabase } from '../src/db/database.js';
import { buildApp } from '../src/http/app.js';
import { silentLogger } from '../src/lib/logger.js';
import { PasswordHasher } from '../src/services/auth/password.js';
import { MemoryTransport } from '../src/services/email/transports.js';
import { CppSentimentEngine } from '../src/services/sentiment/cppEngine.js';
import type { SentimentAnalyzer } from '../src/services/sentiment/types.js';

export const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));
export const REAL_ENGINE = {
  binary: fileURLToPath(new URL('../../sentiment-engine/build/sentiment_server', import.meta.url)),
  model: fileURLToPath(new URL('../../sentiment-engine/models/distilbert-sst2.onnx', import.meta.url)),
  vocab: fileURLToPath(new URL('../../sentiment-engine/models/vocab.txt', import.meta.url)),
};
export const realEngineAvailable =
  existsSync(REAL_ENGINE.binary) && existsSync(REAL_ENGINE.model) && existsSync(REAL_ENGINE.vocab);

export class FakeClock {
  constructor(public t = Date.UTC(2026, 9, 1)) {}
  now = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export function fakeEngine(mode = 'normal', opts: Partial<ConstructorParameters<typeof CppSentimentEngine>[0]> = {}) {
  const engine = new CppSentimentEngine({
    command: process.execPath,
    args: [FAKE_ENGINE, '--mode', mode],
    workers: 1,
    requestTimeoutMs: 1000,
    startupTimeoutMs: 3000,
    maxQueue: 10,
    logger: silentLogger,
    restartBaseDelayMs: 50,
    restartMaxDelayMs: 200,
    ...opts,
  });
  engine.start();
  return engine;
}

export function realEngine(workers = 1): CppSentimentEngine {
  const engine = new CppSentimentEngine({
    command: REAL_ENGINE.binary,
    args: ['--model', REAL_ENGINE.model, '--vocab', REAL_ENGINE.vocab],
    workers,
    requestTimeoutMs: 5000,
    startupTimeoutMs: 30_000,
    maxQueue: 100,
    logger: silentLogger,
  });
  engine.start();
  return engine;
}

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    APP_SECRET: 'test-secret-test-secret-test-secret-123',
    APP_BASE_URL: 'http://portal.test',
    DATABASE_PATH: ':memory:',
    EMAIL_TRANSPORT: 'console',
    FORM_MIN_FILL_MS: '1000',
    ...env,
  });
}

export interface TestApp {
  app: FastifyInstance;
  c: Container;
  clock: FakeClock;
  mail: MemoryTransport;
  close(): Promise<void>;
}

export async function createTestApp(
  opts: { env?: Record<string, string>; analyzer?: SentimentAnalyzer | null } & ContainerOverrides = {},
): Promise<TestApp> {
  const clock = new FakeClock();
  const mail = new MemoryTransport();
  const config = testConfig(opts.env);
  const c = createContainer(config, silentLogger, {
    db: openDatabase(':memory:'),
    clock,
    analyzer: opts.analyzer === undefined ? null : opts.analyzer,
    emailTransport: mail,
    passwordHasher: new PasswordHasher({ N: 2 ** 10, r: 8, p: 1 }),
  });
  const app = await buildApp(c, pino({ level: 'silent' }));
  await app.ready();
  return {
    app,
    c,
    clock,
    mail,
    async close() {
      await app.close();
      await c.close();
      c.db.close();
    },
  };
}

let ipCounter = 1;
/** Unique client address per call so per-IP rate limits don't couple tests. */
export const freshIp = () => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

export async function formToken(t: TestApp, purpose: 'review' | 'complaint', ip: string, link?: string) {
  const res = await t.app.inject({
    method: 'GET',
    url: `/api/public/form-token?purpose=${purpose}${link ? `&link=${link}` : ''}`,
    remoteAddress: ip,
  });
  const body = res.json() as { formToken: string; linkValid: boolean | null; googleReviewUrl: string };
  t.clock.advance(1500);
  return body;
}

export async function submitReview(t: TestApp, body: Record<string, unknown> = {}, ip = freshIp()) {
  const { formToken: token } = await formToken(t, 'review', ip);
  return t.app.inject({
    method: 'POST',
    url: '/api/public/reviews',
    remoteAddress: ip,
    headers: { origin: 'http://portal.test' },
    payload: {
      rating: 5,
      text: 'Wonderful care from the whole team.',
      consent: true,
      formToken: token,
      idempotencyKey: crypto.randomUUID(),
      ...body,
    },
  });
}

export const validComplaint = () => ({
  firstName: 'Asha',
  lastName: 'Patel',
  email: 'asha.patel@example.com',
  phone: '+91 98765 43210',
  rating: 2,
  details: 'I waited over an hour past my appointment time and nobody explained why.',
  consent: true,
  idempotencyKey: crypto.randomUUID(),
});

export async function createStaff(t: TestApp, role: 'admin' | 'manager' | 'staff', email = `${role}@clinic.test`) {
  const password = 'Correct-Horse-9-battery';
  await t.c.auth.createUser({ email, name: `Test ${role}`, password, role });
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: freshIp(),
    headers: { origin: 'http://portal.test' },
    payload: { email, password },
  });
  const cookie = res.cookies.find((ck) => ck.name === 'sdc_session')!;
  const { csrfToken } = res.json() as { csrfToken: string };
  return {
    email,
    password,
    csrfToken,
    headers: { cookie: `sdc_session=${cookie.value}`, 'x-csrf-token': csrfToken, origin: 'http://portal.test' },
  };
}
