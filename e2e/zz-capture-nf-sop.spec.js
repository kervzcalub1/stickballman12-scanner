// THROWAWAY: screenshots for SOP-NEW-SHIPMENT.pdf, from the real UI. Delete after.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const OUT = 'sop-nf-shots';
const SUPPLIER = 'Nine Line Kicks';
let SUP;
const H = (tok) => ({ Authorization: `Bearer ${tok}` });

test.beforeAll(async () => {
  SUP = Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,'sop_nf_sup','x','supplier','approved')
     ON CONFLICT (username) DO UPDATE SET role='supplier', name=$1 RETURNING id`, [SUPPLIER]))[0].id);
});
test.afterAll(async () => {
  await q('DELETE FROM purchase_orders WHERE supplier_user_id = $1', [SUP]);
  await q(`DELETE FROM users WHERE username = 'sop_nf_sup'`);
  await pool.end();
});

const shot = async (page, name, sel = '.app') => {
  await page.waitForTimeout(800);
  const el = page.locator(sel).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.screenshot({ path: `${OUT}/${name}.png` });
};
const asUser = (page, tok, u) => page.addInitScript(([t, j]) => {
  sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', j);
}, [tok, JSON.stringify(u)]);
const stubCatalog = (page) => page.route('**/api/sku-search', (r) => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ ok: true, product: { name: 'Nike Dunk Low Retro', sku: 'DD1391-100', colorway: 'White/Black', sizes: ['8','8.5','9','9.5','10','10.5','11','12'] } }),
}));

test('capture', async ({ browser, request }) => {
  test.setTimeout(240_000);
  const supTok = signToken({ uid: SUP, username: 'sop_nf_sup', name: SUPPLIER, role: 'supplier' });
  const phTok = signToken({ uid: 'sop-ph', username: 'sop_ph', name: 'PH Team', role: 'ph_team' });

  const ctx = await browser.newContext({ viewport: { width: 880, height: 1500 }, deviceScaleFactor: 2 });
  const sup = await ctx.newPage();
  await stubCatalog(sup);
  await asUser(sup, supTok, { username: 'sop_nf_sup', name: SUPPLIER, role: 'supplier' });

  // 1. the list with New shipment open
  await sup.goto('/orders'); await sup.waitForTimeout(1800);
  await sup.getByRole('button', { name: /New shipment/i }).click();
  await sup.waitForTimeout(400);
  await sup.locator('.sup-new input[type=number]').fill('4');
  await sup.locator('.sup-new input:not([type=number])').fill('Last Dance');
  await shot(sup, '01-new-shipment', '.card.sup-new');

  await sup.getByRole('button', { name: /Open shipment/i }).click();
  await sup.waitForTimeout(2500);
  await shot(sup, '02-order-opened', '.wrap-narrow > .card');

  // 2. declare into a box (real UI, stubbed catalogue only)
  await sup.getByRole('button', { name: /^Add items$/ }).first().click();
  await sup.waitForTimeout(600);
  await sup.getByPlaceholder(/Scan or type UPC/i).fill('DD1391-100');
  await sup.getByRole('button', { name: 'Add', exact: true }).click();
  await sup.waitForTimeout(1500);
  for (const s of ['9', '9.5']) {
    const chip = sup.locator('.size-chip', { hasText: new RegExp(`^${s}$`) }).first();
    if (await chip.count()) await chip.click();
  }
  const rows = sup.locator('.po-size-line');
  for (let i = 0; i < await rows.count(); i++) {
    await rows.nth(i).locator('.po-size-money input').first().fill('80');
  }
  await shot(sup, '03-declare', '.modal.additem');
  await sup.getByRole('button', { name: /Add \d+ unit/i }).click();
  await sup.waitForTimeout(1200);
  await sup.locator('.modal .btn.icon.ghost').first().click().catch(() => {});
  await sup.waitForTimeout(900);

  // fill the rest through the API so the "ask" step is legitimate
  const po = (await q('SELECT * FROM purchase_orders WHERE supplier_user_id = $1 ORDER BY id DESC LIMIT 1', [SUP]))[0];
  const boxes = await q('SELECT * FROM po_boxes WHERE po_id = $1 ORDER BY box_number', [po.id]);
  for (const b of boxes.slice(1)) {
    await request.post('/api/po/scan', { headers: H(supTok),
      data: { poBoxId: b.id, sku: 'DD1391-100', name: 'Nike Dunk Low Retro', size: '10', qty: 5, unitCost: 80 } });
  }
  await sup.reload(); await sup.waitForTimeout(2200);
  await shot(sup, '04-boxes', '.wrap-narrow > .card');

  await sup.getByRole('button', { name: /Ask for labels/i }).click();
  await sup.waitForTimeout(1800);
  await shot(sup, '05-asked', '.wrap-narrow > .card');

  // 3. PH: the queue and the assign form
  const ph = await ctx.newPage();
  await asUser(ph, phTok, { username: 'sop_ph', name: 'PH Team', role: 'ph_team' });
  await ph.goto('/ph/po-status'); await ph.waitForTimeout(2200);
  await shot(ph, '06-ph-list', '.po-list');
  await ph.goto(`/ph/po-status?po=${po.id}`); await ph.waitForTimeout(2200);
  await ph.getByRole('button', { name: /Assign labels/i }).click();
  await ph.waitForTimeout(900);
  await shot(ph, '07-ph-assign', '.po-assign');

  // assign, so the "after" state is real
  await request.post('/api/po/assign-labels', { headers: H(phTok), data: { poId: po.id,
    assignments: boxes.map((b, i) => ({ boxId: Number(b.id), trackingNumber: `1Z999AA101234567${10 + i}`, carrierKey: 100002 })) } });
  await sup.reload(); await sup.waitForTimeout(2200);
  await shot(sup, '08-labelled', '.wrap-narrow > .card');
  await ctx.close();
  console.log('PO', po.po_code);
});
