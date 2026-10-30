import { existsSync } from 'node:fs';
import { chromium, defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3200);
const useSystemChrome = !existsSync(chromium.executablePath()) && existsSync('/Applications/Google Chrome.app');

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    ...(useSystemChrome ? { channel: 'chrome' } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...(useSystemChrome ? { channel: 'chrome' } : {}) } },
    { name: 'mobile', use: { ...devices['Pixel 7'], ...(useSystemChrome ? { channel: 'chrome' } : {}) } },
  ],
  webServer: {
    command: 'node e2e/server.mjs',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(port) },
  },
});
