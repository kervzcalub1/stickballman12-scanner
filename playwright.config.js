// Playwright E2E config. Smoke-tests the real app (Vite dev server + /api +
// Postgres) in headless Chromium. Auth uses a minted session token (see
// e2e/helpers/auth.js) so tests don't depend on per-user passwords.
import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Load .env into the TEST process so env-gated specs see the same config the dev
// server does (e.g. ADMIN_PASSWORD for the real-login smoke test, R2_* for the
// photo paths). Same hand-rolled parser as scripts/db-setup.mjs — no dotenv dep.
// Existing process env (e.g. CI secrets) always wins.
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

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
