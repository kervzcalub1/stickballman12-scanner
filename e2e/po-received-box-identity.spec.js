// A received box is identified by its TRACKING NUMBER, not by the number someone typed
// while unpacking it.
//
// The situation (PO-100003, 2026-08-15): nine labels shipped, eight boxes were received
// one day and the ninth — label 6 — turned up the next. "+ Add box" appends max+1, so it
// was recorded as "box 10", and the reconciliation evidence then read 1,2,3,4,5,7,8,9,10
// against an order that only ever had nine labels. The carton's tracking number said all
// along which label it was.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const auth = (role) => ({
  Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role })}`,
});

const SUPPLIER = 'E2E BoxId Supplier';
const SKU = 'E2E-BOXID-1';
const stamp = `${Date.now()}${Math.floor(performance.now())}`;
const TRACK = { one: `E2EBOXID${stamp}A`, six: `E2EBOXID${stamp}B` };

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  const rows = await q('SELECT id, batch_id FROM items WHERE sku = $1', [SKU]);
  for (const r of rows) await q('DELETE FROM item_events WHERE item_id = $1', [r.id]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q('UPDATE batches SET po_id = NULL WHERE supplier_name = $1', [SUPPLIER]);
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  for (const id of [...new Set(rows.map((r) => r.batch_id).filter(Boolean))]) {
    await q('DELETE FROM batch_boxes WHERE batch_id = $1', [id]);
    await q('DELETE FROM batches WHERE id = $1', [id]);
  }
  await q('DELETE FROM batches WHERE supplier_name = $1', [SUPPLIER]);
  await pool.end();
});

// One order for the whole file, built on first use. `po/create` is rate-limited to 30/min
// per IP and every spec in the suite creates orders from the same address, so a fixture per
// test starves the ones that run late — the tests here are ordered (serial) and share it.
let F = null;
const getFixture = async (request) => { F = F || await fixture(request); return F; };

// An order with two labels; the SECOND one's box arrives late and gets recorded under a
// number nobody's label carries.
async function fixture(request) {
  // The order is seeded with SQL rather than through `po/create`: that endpoint is rate
  // limited to 30/min per IP and the suite's other specs have usually spent the window by
  // the time this file runs. The order is setup here, not the thing under test — what IS
  // under test is how a received box is matched back to these labels.
  const [po] = await q(
    `INSERT INTO purchase_orders (supplier_name, tag_code, expected_boxes, status, created_by)
     VALUES ($1, $2, 2, 'shipped', 'e2e') RETURNING id, po_code, status`,
    [SUPPLIER, `BID${stamp.slice(-5)}`],
  );
  await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status, created_by)
     VALUES ($1, 1, $2, 'shipped', 'e2e'), ($1, 2, $3, 'shipped', 'e2e')`,
    [po.id, TRACK.one, TRACK.six],
  );
  const full = await (await request.get(`/api/po/get?id=${po.id}`, { headers: auth('ph_team') })).json();

  // An open receiving batch against the order, label 1 received in the normal way…
  const open = await (await request.post('/api/batches/create-open', {
    headers: auth('warehouse'),
    data: { batch: { buyer: 'stickballman12', supplier: SUPPLIER, dateReceived: new Date().toISOString().slice(0, 10), expectedBoxes: 3, poId: po.id } },
  })).json();
  const batchId = Number(open.batch?.id ?? open.id);

  const commitBox = async (trackingNumber, boxNumber) => {
    const added = await (await request.post('/api/batches/add-box', {
      headers: auth('warehouse'), data: { batchId, trackingNumber, boxNumber },
    })).json();
    const res = await request.post('/api/batches/box-commit', {
      headers: auth('warehouse'),
      data: { batchId, boxId: Number(added.box.id), items: [{ name: 'E2E BoxId Runner', sku: SKU, size: '9', cost: 50, withBox: true }] },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    return Number(added.box.id);
  };
  // Expecting three keeps the batch open after two commits (it auto-completes at
  // received == expected), so the last test can still add a box to it.
  await commitBox(TRACK.one, 1);
  // …and label 2's box, which turned up last, recorded as "box 7" the way max+1 would.
  const lateBoxId = await commitBox(TRACK.six, 7);
  return { po, batchId, lateBoxId, labels: full.boxes };
}

test('a late box is reported under its LABEL\'s number, with what was typed kept beside it', async ({ request }) => {
  const f = await getFixture(request);
  const rc = await (await request.get(`/api/po/reconciliation?poId=${f.po.id}`, { headers: auth('ph_team') })).json();
  const boxes = rc.received_boxes;

  // Two boxes, numbered as the order's own labels are — no gap, no phantom box 7.
  expect(boxes.map((b) => b.box_number)).toEqual([1, 2]);
  const late = boxes.find((b) => Number(b.id) === f.lateBoxId);
  expect(late.box_number).toBe(2);            // the label its tracking belongs to
  expect(late.recorded_box_number).toBe(7);   // what was typed while unpacking
  expect(late.matched_label).toBe(true);
  expect(late.units).toBe(1);
  // A box whose number was never in doubt says nothing extra.
  expect(boxes.find((b) => b.box_number === 1).recorded_box_number).toBeNull();
});

test('the evidence sheet on screen says which number came from where', async ({ page, request }) => {
  const f = await getFixture(request);
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/reconciliation?po=${f.po.id}`);
  const received = page.locator('.rcn-received');
  await expect(received).toBeVisible({ timeout: 15_000 });
  const late = received.locator('.rcn-rbox').filter({ hasText: TRACK.six });
  await expect(late).toContainText('Box 2');
  await expect(late.locator('.rcn-rbox-renamed')).toContainText('recorded while unpacking as box 7');
});

test('a box carrying no label tracking keeps the number the warehouse gave it', async ({ request }) => {
  const f = await getFixture(request);
  const added = await (await request.post('/api/batches/add-box', {
    headers: auth('warehouse'), data: { batchId: f.batchId, trackingNumber: `E2EBOXID${stamp}UNKNOWN`, boxNumber: 9 },
  })).json();
  await request.post('/api/batches/box-commit', {
    headers: auth('warehouse'),
    data: { batchId: f.batchId, boxId: Number(added.box.id), items: [{ name: 'E2E BoxId Runner', sku: SKU, size: '10', cost: 50, withBox: true }] },
  });
  const rc = await (await request.get(`/api/po/reconciliation?poId=${f.po.id}`, { headers: auth('ph_team') })).json();
  const stray = rc.received_boxes.find((b) => Number(b.id) === Number(added.box.id));
  expect(stray.box_number).toBe(9);           // nothing to correct it against
  expect(stray.recorded_box_number).toBeNull();
  expect(stray.matched_label).toBe(false);
});

// The order's own chip, which is what the user actually reads first. `purchase_orders.status`
// stops at 'receiving' and an order received with nothing declared never auto-reconciles, so
// PO-100003 sat reading "Receiving" with all nine labels delivered and 54 pairs counted.
test('once every label has landed, the order stops calling itself Receiving', async ({ page, request }) => {
  const f = await getFixture(request);
  await q(`UPDATE po_boxes SET status = 'delivered' WHERE po_id = $1`, [Number(f.po.id)]);
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/po-status?po=${f.po.id}`);
  // The order opens on its own page; its chip lives in that page's header.
  await expect(page.locator('.po-detail')).toContainText(f.po.po_code, { timeout: 15_000 });
  // `:not(.kind)` because the header carries two chips now — where the order IS, and
  // what it's FOR (shoes vs empty shoe boxes). This assertion is about the first.
  await expect(page.locator('.po-detail-id .po-chip:not(.kind)')).toHaveText('Delivered · to reconcile');
});

test('a draft order whose labels have all gone is not still "Filling"', async ({ page, request }) => {
  const f = await getFixture(request);
  // Shipped but nothing delivered yet, and the order row still says draft.
  await q(`UPDATE po_boxes SET status = 'shipped' WHERE po_id = $1`, [Number(f.po.id)]);
  await q(`UPDATE purchase_orders SET status = 'draft' WHERE id = $1`, [Number(f.po.id)]);
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/po-status?po=${f.po.id}`);
  // A multi-label order says how many of its labels are moving, not just that some are.
  await expect(page.locator('.po-detail-id .po-chip:not(.kind)')).toHaveText(/^\d+\/\d+ shipped$/, { timeout: 15_000 });
});

// The reported bug. Tracking is registered when the PO is CREATED, so 17TRACK acknowledges
// every label within minutes and moves it to `pre_transit` — the label exists, the box is
// still on the supplier's floor. `shipped_count` counted anything that wasn't `pending`,
// so an order read "Shipped" from the moment it was raised, before a thing was packed.
test('a label the carrier has not collected is NOT counted as shipped', async ({ page, request }) => {
  const f = await getFixture(request);
  await q(`UPDATE purchase_orders SET status = 'draft' WHERE id = $1`, [Number(f.po.id)]);
  for (const st of ['pre_transit', 'packed']) {
    await q(`UPDATE po_boxes SET status = $2 WHERE po_id = $1`, [Number(f.po.id), st]);
    const list = await (await request.get('/api/po/list', { headers: auth('ph_team') })).json();
    const row = list.pos.find((x) => Number(x.id) === Number(f.po.id));
    expect(row.shipped_count, `${st} must not read as shipped`).toBe(0);
  }
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/po-status?po=${f.po.id}`);
  await expect(page.locator('.po-detail-id .po-chip:not(.kind)')).toHaveText('Filling', { timeout: 15_000 });
});

test('the chip counts how many of the order’s labels are actually moving', async ({ request }) => {
  const f = await getFixture(request);
  const boxes = await q(`SELECT id FROM po_boxes WHERE po_id = $1 ORDER BY box_number`, [Number(f.po.id)]);
  await q(`UPDATE po_boxes SET status = 'pre_transit' WHERE po_id = $1`, [Number(f.po.id)]);
  await q(`UPDATE po_boxes SET status = 'in_transit' WHERE id = $1`, [boxes[0].id]);
  const list = await (await request.get('/api/po/list', { headers: auth('ph_team') })).json();
  const row = list.pos.find((x) => Number(x.id) === Number(f.po.id));
  // One moving out of however many the fixture has — the denominator is the order's own
  // labels, and a reship would not be one of them.
  expect(row.shipped_count).toBe(1);
  expect(row.box_count).toBe(boxes.length);
});
