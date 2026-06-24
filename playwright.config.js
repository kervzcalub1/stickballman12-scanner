// Playwright E2E config. Smoke-tests the real app (Vite dev server + /api +
// Postgres) in headless Chromium. Auth uses a minted session token (see
// e2e/helpers/auth.js) so tests don't depend on per-user passwords.
import { defineConfig, devices } from '@playwright/test';

// Fixed port so baseURL is deterministic (strictPort makes Vite fail rather than
// drift to another port). Override with E2E_PORT if 5189 is taken.
const PORT = Number(process.env.E2E_PORT) || 5189;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,        // shared dev server + DB — keep runs serial & predictable
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // Auto-start the dev server for the run (reuse a running one locally).
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
