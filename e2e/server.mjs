// Boots the production build against a throwaway database for Playwright.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data', 'e2e');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

export const E2E = {
  port: Number(process.env.E2E_PORT ?? 3200),
  adminEmail: 'e2e-admin@stellardentalclinic.com',
  adminPassword: 'E2e-Test-Passw0rd!',
};

const env = {
  PATH: process.env.PATH,
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: String(E2E.port),
  APP_BASE_URL: `http://127.0.0.1:${E2E.port}`,
  APP_SECRET: 'e2e-only-secret-e2e-only-secret-e2e-only',
  DATABASE_PATH: join(dataDir, 'portal.sqlite'),
  COOKIE_SECURE: 'false',
  TRUST_PROXY: 'loopback',
  FORM_MIN_FILL_MS: '200',
  EMAIL_TRANSPORT: 'console',
  LOG_LEVEL: 'warn',
};

const seed = spawnSync(
  process.execPath,
  ['server/dist/cli/createUser.js', '--email', E2E.adminEmail, '--name', 'E2E Admin', '--role', 'admin'],
  { cwd: root, env: { ...env, STAFF_PASSWORD: E2E.adminPassword }, stdio: 'inherit' },
);
if (seed.status !== 0) process.exit(seed.status ?? 1);

const server = spawn(process.execPath, ['server/dist/index.js'], { cwd: root, env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
server.on('exit', (code) => process.exit(code ?? 0));
