// Pre-sell Listings — IN TRANSIT (docs/context/presell-listings.md). Alex, 2026-10-10: list a
// shipment while it's on the truck; when the warehouse receives that SKU + size, the unsold
// listings are DELETED and the pre-sell group is told how many sold in transit (set aside,
// inbound only the rest). Marketplaces and Telegram are fakes — nothing leaves the machine.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loadEnv } from './helpers/auth.js';

loadEnv();
test.describe.configure({ mode: 'serial' });
const stamp = `${Date.now()}`.slice(-7);
const SKU = `QAIT-${stamp}`;
let db; let S;
const ids = { stock: [], batch: [] };

const fakes = () => {
  const removed = [];
  const sent = [];
  const platform = (name) => ({ remove: async (l) => { removed.push(`${name}:${l.external_id}`); return { ok: true, status: 'deleted' }; } });
  return { removed, sent, opts: { enabled: true, platforms: { alias: platform('alias'), stockx: platform('stockx') }, notify: async (lines) => { sent.push(lines); } } };
};
async function listed(size, { qty = 12, sold = 0, inTransit = true } = {}) {
  const stock = (await S.upsertPresellStock({ sku: SKU, size, name: 'QA In Transit Shoe', addQty: qty, inTransit, transitNote: 'PO 1042', expectedOn: '2026-10-12' }, 'e2e')).id;
  ids.stock.push(stock);
  if (sold) await db.query(`UPDATE presell_stock SET sold = $2 WHERE id = $1`, [stock, sold]);
  for (const [p, n] of [['alias', 2], ['stockx', 2]]) for (let i = 0; i < n; i++) {
    await db.query(`INSERT INTO presell_listings (stock_id, platform, external_id, price_cents, status) VALUES ($1, $2, $3, 20000, 'live')`, [stock, p, `${SKU}-${size}-${p}-${i}`]);
  }
  return stock;
}
async function batch(kind = 'receiving') {
  const { rows } = await db.query(`INSERT INTO batches (batch_code, kind, date_received) VALUES ($1, $2, CURRENT_DATE) RETURNING id, batch_code`, [`QAIT${stamp}${ids.batch.length}`, kind]);
  ids.batch.push(rows[0].id);
  return rows[0];
}

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  S = await import('../api/_lib/db.js');
});
test.afterAll(async () => {
  if (!db) return;
  await db.query(`DELETE FROM presell_stock WHERE sku = $1`, [SKU]);
  await db.query(`DELETE FROM batches WHERE id = ANY($1)`, [ids.batch]);
  await db.end();
});

test('receiving the SKU + size deletes every unsold listing, once, and says how many to set aside', async () => {
  const stock = await listed('8', { qty: 12, sold: 2 });
  const { onItemsReceived } = await import('../api/_lib/presell-arrival.js');
  const b = await batch();
  const f = fakes();
  // "US8" / "8" / "8.0"-style differences don't stop the match; another size doesn't trigger.
  const out = await onItemsReceived(b.id, [{ sku: SKU.toLowerCase(), size: 'US 8' }, { sku: SKU, size: '9' }], f.opts);
  expect(out).toHaveLength(1);
  expect(f.removed.sort()).toEqual([`alias:${SKU}-8-alias-0`, `alias:${SKU}-8-alias-1`, `stockx:${SKU}-8-stockx-0`, `stockx:${SKU}-8-stockx-1`].sort());
  const { rows } = await db.query(`SELECT status FROM presell_listings WHERE stock_id = $1`, [stock]);
  expect(rows.map((r) => r.status)).toEqual(['deleted', 'deleted', 'deleted', 'deleted']);
  const st = (await db.query(`SELECT arrived_at, arrived_batch FROM presell_stock WHERE id = $1`, [stock])).rows[0];
  expect(st.arrived_at).not.toBeNull();
  expect(st.arrived_batch).toBe(b.batch_code);
  const text = f.sent[0].map((l) => (typeof l === 'string' ? l : l.b)).join('\n');
  expect(text).toContain('ARRIVED');
  expect(text).toContain('Deleted: Alias 2, StockX 2');
  expect(text).toContain('Sold while in transit: 2 of 12');
  expect(text).toContain('inbound and list only 10');
  // The next box of the same size: already arrived, nothing happens again.
  const again = fakes();
  expect(await onItemsReceived(b.id, [{ sku: SKU, size: '8' }], again.opts)).toEqual([]);
  expect(again.sent).toHaveLength(0);
});

test('Existing Stock counting is not an arrival; a row listed without the tick is never touched', async () => {
  const transit = await listed('10');
  const normal = await listed('11', { inTransit: false });
  const { onItemsReceived } = await import('../api/_lib/presell-arrival.js');
  const f = fakes();
  expect(await onItemsReceived((await batch('existing')).id, [{ sku: SKU, size: '10' }], f.opts)).toEqual([]);
  expect(await onItemsReceived((await batch()).id, [{ sku: SKU, size: '11' }], f.opts)).toEqual([]);
  expect(f.removed).toHaveLength(0);
  const { rows } = await db.query(`SELECT id, arrived_at FROM presell_stock WHERE id = ANY($1)`, [[transit, normal]]);
  expect(rows.every((r) => r.arrived_at === null)).toBe(true);
});

test('only where PRESELL_WATCH=on: anywhere else a receive never reaches a marketplace', async () => {
  await listed('12');
  const { onItemsReceived, arrivalsEnabled } = await import('../api/_lib/presell-arrival.js');
  expect(arrivalsEnabled({})).toBe(false);
  expect(arrivalsEnabled({ PRESELL_WATCH: 'on' })).toBe(true);
  const f = fakes();
  expect(await onItemsReceived((await batch()).id, [{ sku: SKU, size: '12' }], { ...f.opts, enabled: false })).toEqual([]);
  expect(f.removed).toHaveLength(0);
});

test('listing the same SKU + size in transit again re-arms it; listing it plainly leaves the flag', async () => {
  const id = await listed('13');
  await db.query(`UPDATE presell_stock SET arrived_at = now() WHERE id = $1`, [id]);
  await S.upsertPresellStock({ sku: SKU, size: '13', addQty: 1 }, 'e2e');            // plain: arrived stays
  expect((await db.query(`SELECT in_transit, arrived_at FROM presell_stock WHERE id = $1`, [id])).rows[0].arrived_at).not.toBeNull();
  await S.upsertPresellStock({ sku: SKU, size: '13', addQty: 1, inTransit: true, transitNote: 'PO 2' }, 'e2e');
  const r = (await db.query(`SELECT in_transit, arrived_at, transit_note, qty FROM presell_stock WHERE id = $1`, [id])).rows[0];
  expect(r).toMatchObject({ in_transit: true, arrived_at: null, transit_note: 'PO 2', qty: 14 });
});

test('the two kinds of sale read differently: source it vs set it aside on arrival', async () => {
  const { handleSale } = await import('../api/_lib/presell.js');
  const sale = async (inTransit, size) => {
    const stock = (await S.upsertPresellStock({ sku: SKU, size, name: 'QA Sale Shoe', addQty: 12, inTransit, transitNote: inTransit ? 'PO 1042' : null }, 'e2e')).id;
    // One listing — the one that sold — so nothing is left to take down (no marketplace call).
    const { rows } = await db.query(`INSERT INTO presell_listings (stock_id, platform, external_id, price_cents, status) VALUES ($1, 'alias', $2, 20000, 'live') RETURNING *`, [stock, `${SKU}-sale-${size}`]);
    const sent = [];
    await handleSale({ listing: rows[0], platform: 'alias', orderId: `ORD-${size}-${stamp}`, priceCents: 20000, payoutCents: 18000, soldAt: new Date().toISOString(), raw: {} },
      { notify: async (lines) => { sent.push(lines.map((l) => (typeof l === 'string' ? l : l.b)).join('\n')); } });
    return sent[0];
  };
  const plain = await sale(false, '14');
  expect(plain).toContain('PRE-SELL SALE — Alias — SOURCE IT');
  expect(plain).toContain("We don't have this pair");
  expect(plain).not.toContain('IN-TRANSIT');
  const transit = await sale(true, '15');
  expect(transit).toContain('IN-TRANSIT SALE — Alias');
  expect(transit).toContain('Shipment: PO 1042');
  expect(transit).toContain('set 1 pair of size 15 aside');
  expect(transit).toContain('Inbound the other 11');
  expect(transit).not.toContain('SOURCE IT');
});
