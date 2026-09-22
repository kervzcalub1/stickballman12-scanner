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
    // The suite must not be able to reach a live third-party account.
    //
    // 17TRACK registration happens at PO creation (po/create, label-add, label-update),
    // and `po-edit.spec.js` builds tracking numbers like `EDIT${Date.now()}` — so every
    // local run REGISTERED half a dozen invented numbers against the real 17TRACK
    // account. They burn quota, they sit in the dashboard forever as "Not found · Other
    // issues", and they outlive the test: teardown deletes the po_boxes rows, but the
    // registration is account-wide and permanent. 55 of them had accumulated.
    //
    // CI never had the key, so this only ever bit runs on a developer machine, where the
    // dev server loads .env. Blanking it here is enough because vite.config's devApi only
    // fills a var that is `undefined` — an empty string is already "set", so .env cannot
    // put the real key back, and `trackingConfigured()` reads false.
    //
    // CAVEAT: `reuseExistingServer` means a server YOU started (with real .env) is used
    // as-is. Don't hand-start one on this port and then run the suite against it.
    //
    // MAKE_WEBHOOK_URL goes the same way, and for a closer version of the same story: a
    // buyer's add POSTs a Telegram approval card, so every local run put cards in front
    // of the desk for pairs nobody is buying — and teardown then deleted the request, so
    // tapping one answered "that buying request does not exist". Blanked here rather than
    // guarded in the code on APP_ENV, because that guard cannot tell this suite from a
    // developer's own `npm run dev` and silently swallowed a real person's cards for half
    // an hour.
    // MAKE_RECEIPT_PARSER_URL: the receipt-by-number lookup searches REAL ordering
    // mailboxes and spends Make operations on every call.
    //
    // E2E_NO_RATE_LIMIT: the per-(ip, route) limiter is 30/min, and this suite is ~660
    // tests from one address in eight minutes. It was silently eating commits — hence
    // the `test.skip(status === 429)` lines dotted through qa-targeted and smoke — and
    // which specs it ate depended on how the 60s windows lined up with the run, so an
    // unrelated PR could go red just for adding a test file. It is refused under
    // NODE_ENV=production (api/_lib/util.js), and the server logs a line when it is off.
    env: { TRACKING_API_KEY: '', MAKE_WEBHOOK_URL: '', MAKE_RECEIPT_PARSER_URL: '', E2E_NO_RATE_LIMIT: '1' },
  },
});
