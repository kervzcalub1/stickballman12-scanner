// A tab left open across a deploy asks the server for a chunk filename that no longer
// exists. Every lazily-loaded chunk statically imports the main bundle, so its own
// content-hash moves on EVERY deploy — and the warehouse keeps the app open all shift
// while we sometimes ship several times a day. This is routine, not exotic.
//
// Reported live on the PO page: tapping "Per box" produced the raw browser message
//   Failed to fetch dynamically imported module: …/assets/jspdf.es.min-CdzdfD2v.js
// which names a URL and tells the person nothing they can do about it.
//
// Simulated by 404-ing the vendor chunk, which is exactly what the server does to a
// stale filename.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import pg from 'pg';
import { loadEnv } from './helpers/auth.js';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const auth = () => ({ Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` });
const SUPPLIER = 'E2E Stale Chunk';

let PO;
test.beforeAll(async ({ request }) => {
  const r = await request.post('/api/po/create', {
    headers: auth(),
    data: { supplierName: SUPPLIER, tagCode: 'STALE', labels: [{ trackingNumber: `E2E-STALE-${Date.now()}` }] },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  PO = (await r.json()).po;
});
test.afterAll(async () => {
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await pool.end();
});

test('a stale chunk says what happened and offers the one thing that fixes it', async ({ page }) => {
  await loginAs(page, 'ph_team');
  // The server's answer to a filename from a previous deploy.
  await page.route(/jspdf/i, (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto(`/ph/po-status?po=${PO.id}`);
  await expect(page.getByText(PO.po_code).first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: /Per box/i }).first().click();

  // Not the raw browser message, and not a URL.
  await expect(page.getByText(/app was updated while this tab was open/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/dynamically imported module/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Reload$/ })).toBeVisible();
});
