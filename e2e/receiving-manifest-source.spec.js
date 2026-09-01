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
import { signToken } from '../api/_lib/util.js';
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

const phTok = () => signToken({ uid: String(PH.id), username: PH.username, name: PH.name, role: 'ph_team' });

async function makePo(request, baseURL, code) {
  const r = await (await request.post(`${baseURL}/api/po/create`, {
    headers: { Authorization: `Bearer ${phTok()}` },
    data: { supplierName: 'Andrew Reyes', supplierUserId: SUP.id, tagCode: code,
      dateOfPurchase: '2026-09-02', labels: [{ trackingNumber: `1Z99${code}${stamp}` }] },
  })).json();
  made.push(r.po.id);
  return r;
}

test('banner + sheet name the manifest source', async ({ page, request, baseURL }) => {
  SUP.id = Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,$2,'s2$00$00','supplier','approved') RETURNING id`,
    [SUP.name, SUP.username]))[0].id);
  PH.id = Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,$2,'s2$00$00','ph_team','approved') RETURNING id`,
    [PH.name, PH.username]))[0].id);
  const supTok = signToken({ uid: String(SUP.id), username: SUP.username, name: SUP.name, role: 'supplier' });

  // A — the supplier scanned it themselves
  const A = await makePo(request, baseURL, 'AAA');
  await request.post(`${baseURL}/api/po/scan`, { headers: { Authorization: `Bearer ${supTok}` },
    data: { poBoxId: Number(A.boxes[0].id), sku: 'CQ6639-700', name: "Nike Air Max 90", size: '7W', qty: 2 } });

  // B — the supplier never scanned; PH entered it on their behalf
  const B = await makePo(request, baseURL, 'BBB');
  await request.post(`${baseURL}/api/po/scan`, { headers: { Authorization: `Bearer ${phTok()}` },
    data: { poBoxId: Number(B.boxes[0].id), sku: 'IQ6755-300', name: "Nike Ja 3", size: '9', qty: 3 } });

  // C — nothing declared at all
  const C = await makePo(request, baseURL, 'CCC');

  // D — mixed
  const D = await makePo(request, baseURL, 'DDD');
  await request.post(`${baseURL}/api/po/scan`, { headers: { Authorization: `Bearer ${supTok}` },
    data: { poBoxId: Number(D.boxes[0].id), sku: 'CQ6639-700', name: "Nike Air Max 90", size: '8W', qty: 4 } });
  await request.post(`${baseURL}/api/po/scan`, { headers: { Authorization: `Bearer ${phTok()}` },
    data: { poBoxId: Number(D.boxes[0].id), sku: 'IQ6755-300', name: "Nike Ja 3", size: '10', qty: 1 } });

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
  await openPo(A.po.po_code);
  await expect(page.locator('.po-manifest-src')).toHaveCount(0);

  // B — PH on their behalf
  await openPo(B.po.po_code);
  const b = page.locator('.po-manifest-src');
  await expect(b).toBeVisible();
  await expect(b).toContainText('Entered on the supplier’s behalf');
  await expect(b).toContainText('Maria Santos');
  await expect(b).toHaveClass(/warn/);


  // C — nothing declared
  await openPo(C.po.po_code);
  const c = page.locator('.po-manifest-src');
  await expect(c).toContainText('No manifest');
  await expect(c).toHaveClass(/bad/);

  // D — mixed
  await openPo(D.po.po_code);
  const d = page.locator('.po-manifest-src');
  await expect(d).toContainText('Part entered');
});
