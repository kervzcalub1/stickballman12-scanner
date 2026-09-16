// Correcting a style code the catalogue got wrong off the box UPC (inventory.md).
//
// The real case: Jordan re-coded 553558-100 → 553558-136 for size 10.5 in 2022 and kept
// the barcode (196149780863), so every scan of that box lands as -100 while the box says
// -136. The fix is one field on the unit, with the option of fixing every pair that was
// scanned in the same wrong way — same old code, same size, same UPC — and never a pair
// of a different size, which may genuinely still be -100.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const OLD = 'E2E-553558-100';
const NEW = 'E2E-553558-136';
const UPC = '196149780863';
const ORIGIN = 'E2E sku edit';

test.beforeAll(async () => { await cleanup(); });
test.afterAll(async () => { await cleanup(); await pool.end(); });
async function cleanup() {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = ANY($1))', [[OLD, NEW]]);
  await q('DELETE FROM items WHERE sku = ANY($1)', [[OLD, NEW]]);
  await q('DELETE FROM batches WHERE origin = $1 AND NOT EXISTS (SELECT 1 FROM items WHERE batch_id = batches.id)', [ORIGIN]);
}

// Three 10.5s under the same box UPC (the set the catalogue got wrong), and one 9 of
// the same old code that must NOT move with them.
async function seed(page) {
  const res = await page.evaluate(async ([sku, upc, origin]) => {
    const r = await fetch('/api/batches/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}` },
      body: JSON.stringify({
        kind: 'existing', noShelf: true, batch: { origin },
        items: [
          { name: 'Air Jordan 1 Retro High OG (old)', sku, size: '10.5', upc, withBox: true, source: 'manual' },
          { name: 'Air Jordan 1 Retro High OG (old)', sku, size: '10.5', upc, withBox: true, source: 'manual' },
          { name: 'Air Jordan 1 Retro High OG (old)', sku, size: '10.5', upc, withBox: true, source: 'manual' },
          { name: 'Air Jordan 1 Retro High OG (old)', sku, size: '9', upc: '196149780856', withBox: true, source: 'manual' },
        ],
      }),
    });
    return { status: r.status, body: await r.json() };
  }, [OLD, UPC, ORIGIN]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.vins;
}

const call = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, {
    method: m,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, body: await r.json() };
}, [method, path, body || null]);

test('the endpoint fixes one pair, or every pair scanned in the same way — never a different size', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  const vins = await seed(page);
  const [a, b, c, nine] = vins;
  // Existing stock is stamped as listed everywhere (it is already on sale); make it
  // fresh receiving for this test, with exactly one of the three on a store.
  await q('UPDATE items SET synced_alias = false, synced_stockx = false, synced_shopify = false, added_to_intel_inv = false WHERE vin = ANY($1)', [vins]);
  await q('UPDATE items SET synced_stockx = true WHERE vin = $1', [b]);

  // The preview counts the OTHER pairs scanned the same way: the two other 10.5s, not the 9.
  const pre = await call(page, 'GET', `/api/items/set-sku?vin=${a}`);
  expect(pre.status, JSON.stringify(pre.body)).toBe(200);
  expect(pre.body.siblings.map((s) => s.vin).sort()).toEqual([b, c].sort());
  expect(pre.body.siblings.find((s) => s.vin === b).listed).toBe(true);

  // Same code is refused; a nonsense code is refused.
  expect((await call(page, 'POST', '/api/items/set-sku', { vin: a, sku: OLD })).status).toBe(400);
  expect((await call(page, 'POST', '/api/items/set-sku', { vin: a, sku: '!!' })).status).toBe(400);

  // Just this pair, with the catalogue's name for the new code riding along.
  const one = await call(page, 'POST', '/api/items/set-sku', {
    vin: a, sku: NEW, scope: 'one', product: { name: 'Air Jordan 1 Retro High OG (new)', colorway: 'White/Black' }, reason: 'box says -136',
  });
  expect(one.status).toBe(200);
  expect(one.body.updated).toBe(1);
  expect(one.body.listed).toBe(0);
  expect(one.body.item.sku).toBe(NEW);
  expect(one.body.item.name).toBe('Air Jordan 1 Retro High OG (new)');
  expect(one.body.item.upc).toBe(UPC);                       // the barcode is the truth; it stays
  const note = one.body.events.find((e) => e.type === 'note' && /SKU changed/.test(e.details?.text));
  expect(note.details.text).toContain(`${OLD} → ${NEW}`);
  expect(note.details.text).toContain('box says -136');

  // The rest, from b: same_upc takes b and c, counts the listed one, leaves the 9.
  const rest = await call(page, 'POST', '/api/items/set-sku', { vin: b, sku: NEW, scope: 'same_upc' });
  expect(rest.status).toBe(200);
  expect(rest.body.updated).toBe(2);
  expect(rest.body.listed).toBe(1);
  const rows = await q('SELECT vin, sku, name FROM items WHERE vin = ANY($1) ORDER BY vin', [vins]);
  expect(rows.find((r) => r.vin === c).sku).toBe(NEW);
  expect(rows.find((r) => r.vin === c).name).toBe('Air Jordan 1 Retro High OG (old)');   // no product given → name kept
  expect(rows.find((r) => r.vin === nine).sku).toBe(OLD);
});

test('the pencil beside the SKU opens the fix, and the detail shows the new code', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  const [vin] = await seed(page);
  await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(vin);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.getByRole('button', { name: 'Correct the style code' }).click();
  const modal = page.locator('.modal');
  await expect(modal).toContainText(`on record as ${OLD}`);
  await expect(modal).toContainText('scanned in as');
  await modal.locator('input[placeholder*="553558-136"]').fill(NEW);
  await modal.getByRole('button', { name: `Change to ${NEW}` }).click();
  await expect(page.locator('.notice')).toContainText(`1 pair changed to ${NEW}`);
  await expect(page.locator('.details dl').first()).toContainText(NEW);
});
