// Receiving must say WHOSE manifest it is checking the boxes against.
//
// The order counts po_lines the same either way, so nothing here is about which list is
// used — it is about what the person unpacking is told. A list PH typed from a photo is
// our transcription of a supplier's claim, not their scan, and a mismatch against it is
// as likely to be our typo as a missing pair. Getting that wrong sends someone to argue a
// shortage they invented.
//
// The supplier-scanned case asserts on ABSENCE deliberately: that is the expected answer,
// and a banner that fires on every order is one nobody reads by the second week.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';
loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-6);
const SUP = { username: `mf_sup_${stamp}`, name: 'Andrew Reyes' };
// A REAL ph_team row: `entered_by` is a users(id) FK, and po/scan deliberately leaves it
// NULL for a non-numeric uid — so the demo e2e-ph token can never resolve to a name.
const PH = { username: `mf_ph_${stamp}`, name: 'Maria Santos' };
const made = [];

test.afterAll(async () => {
  if (made.length) await q(`DELETE FROM purchase_orders WHERE id = ANY($1)`, [made]);
  await q(`DELETE FROM users WHERE id = ANY($1)`, [[SUP.id, PH.id].filter(Boolean)]);
  await pool.end();
});

// Seeded straight into the DB rather than through /api/po/create + /api/po/scan.
// Those endpoints are rate-limited (30 POs/min per IP) and a full-suite run spends that
// budget on the other PO specs before reaching this one, so going through the API made
// this test fail for a reason that has nothing to do with what it asserts. The UI is
// what is under test here, not PO creation.
async function makePo(code, lines) {
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, tag_code, date_of_purchase,
       expected_boxes, created_by)
     VALUES ('Andrew Reyes', $1, $2, '2026-09-02', 1, 'e2e') RETURNING id, po_code`,
    [SUP.id, code]))[0];
  made.push(po.id);
  const box = (await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status, created_by)
     VALUES ($1, 1, $2, 'pending', 'e2e') RETURNING id`,
    [po.id, `1Z99${code}${stamp}`]))[0];
  for (const l of lines) {
    // `onBehalf` is the whole subject of this spec: entered_by is a users(id) FK and
    // po/scan deliberately stores NULL for a non-numeric uid, so the named case needs a
    // real ph_team row (PH.id) and the flag set together.
    await q(
      `INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected, entered_by, entered_on_behalf)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [po.id, box.id, l.sku, l.size, l.name, l.qty, l.onBehalf ? PH.id : null, !!l.onBehalf]);
  }
  return po;
}

test('banner + sheet name the manifest source', async ({ page }) => {
  SUP.id = Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,$2,'s2$00$00','supplier','approved') RETURNING id`,
    [SUP.name, SUP.username]))[0].id);
  PH.id = Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,$2,'s2$00$00','ph_team','approved') RETURNING id`,
    [PH.name, PH.username]))[0].id);

  const AIR = { sku: 'CQ6639-700', name: "Nike Air Max 90" };
  const JA = { sku: 'IQ6755-300', name: "Nike Ja 3" };
  // A — the supplier scanned it themselves
  const A = await makePo('AAA', [{ ...AIR, size: '7W', qty: 2 }]);
  // B — the supplier never scanned; PH entered it on their behalf
  const B = await makePo('BBB', [{ ...JA, size: '9', qty: 3, onBehalf: true }]);
  // C — nothing declared at all
  const C = await makePo('CCC', []);
  // D — mixed
  const D = await makePo('DDD', [
    { ...AIR, size: '8W', qty: 4 },
    { ...JA, size: '10', qty: 1, onBehalf: true },
  ]);

  await loginAs(page, 'warehouse');
  await page.setViewportSize({ width: 900, height: 1000 });

  const openPo = async (code) => {
    await page.goto('/receiving');
    await page.getByRole('button', { name: 'Receive against a purchase order' }).click();
    await page.locator('.po-picker input').first().fill(code);
    await page.locator('.po-picker .searchrow button').first().click();
    await expect(page.locator('.po-receive-banner')).toBeVisible({ timeout: 15000 });
  };

  // A — supplier's own scan: deliberately silent
  await openPo(A.po_code);
  await expect(page.locator('.po-manifest-src')).toHaveCount(0);

  // B — PH on their behalf
  await openPo(B.po_code);
  const b = page.locator('.po-manifest-src');
  await expect(b).toBeVisible();
  await expect(b).toContainText('Entered on the supplier’s behalf');
  await expect(b).toContainText('Maria Santos');
  await expect(b).toHaveClass(/warn/);


  // C — nothing declared
  await openPo(C.po_code);
  const c = page.locator('.po-manifest-src');
  await expect(c).toContainText('No manifest');
  await expect(c).toHaveClass(/bad/);

  // D — mixed
  await openPo(D.po_code);
  const d = page.locator('.po-manifest-src');
  await expect(d).toContainText('Part entered');
});
