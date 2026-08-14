// The courier's labels PDF: stored in R2, downloadable whole or one label at a time.
//
// It used to be read for its tracking numbers and discarded, so the supplier had to hunt
// through email for the label belonging to the box in front of them. The security shape
// matters as much as the feature: these carry a ship-to address and a live courier
// barcode, so downloads are proxied and authorised, never a public bucket URL.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const auth = (role, uid) => ({
  Authorization: `Bearer ${signToken({ uid: uid ?? `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role })}`,
});
const SUPPLIER = 'E2E Labels Supplier';
const TRACK_A = '1ZLABELTESTAAA0001';
const TRACK_B = '1ZLABELTESTBBB0002';
const R2 = Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_BUCKET);

let SUPPLIER_UID; let OTHER_UID;

test.beforeAll(async () => {
  const mk = async (username) => Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1, $2, 'x', 'supplier', 'approved')
     ON CONFLICT (username) DO UPDATE SET role = 'supplier' RETURNING id`, [`E2E ${username}`, username],
  ))[0].id);
  SUPPLIER_UID = await mk('e2e_labels_supplier');
  OTHER_UID = await mk('e2e_labels_other');
});

test.afterAll(async () => {
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await q('DELETE FROM users WHERE username IN ($1, $2)', ['e2e_labels_supplier', 'e2e_labels_other']);
  await pool.end();
});

// A two-page "labels sheet", each page carrying its own tracking number as text — which
// is what the importer reads to work out which page belongs to which label.
async function labelsPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of [TRACK_A, TRACK_B]) {
    const page = doc.addPage([288, 432]); // 4x6 label
    page.drawText(t, { x: 20, y: 380, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

async function order(request) {
  const r = await request.post('/api/po/create', {
    headers: auth('ph_team'),
    data: {
      supplierName: SUPPLIER, tagCode: `LBL${Date.now() % 100000}`,
      labels: [{ trackingNumber: TRACK_A }, { trackingNumber: TRACK_B }],
    },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  const po = (await r.json()).po;
  await q('UPDATE purchase_orders SET supplier_user_id = $1 WHERE id = $2', [SUPPLIER_UID, po.id]);
  const boxes = await q('SELECT id, box_number, tracking_number FROM po_boxes WHERE po_id = $1 ORDER BY box_number', [po.id]);
  return { po, boxes };
}

// Upload straight to R2 with the presigned PUT, exactly as the browser does.
async function upload(request, poId, pdf) {
  const signed = await (await request.post('/api/po/labels-sign', { headers: auth('ph_team'), data: { poId } })).json();
  expect(signed.key).toMatch(/^po-labels\//);
  const put = await request.fetch(signed.url, { method: 'PUT', data: pdf, headers: { 'Content-Type': 'application/pdf' } });
  expect(put.status(), 'R2 PUT').toBeLessThan(300);
  return signed.key;
}

test.describe('labels file', () => {
  test.skip(!R2, 'R2 is not configured in this environment');

  test('pages map to labels by TRACKING NUMBER, not by page order', async ({ request }) => {
    const { po, boxes } = await order(request);
    const key = await upload(request, po.id, await labelsPdf());
    // Deliberately handed over in the wrong order: page order must not decide the mapping.
    const res = await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'),
      data: { poId: po.id, key, name: 'labels.pdf', pages: 2,
        pageMap: [{ tracking: TRACK_B, page: 2 }, { tracking: TRACK_A, page: 1 }] },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).matched).toBe(2);
    const rows = await q('SELECT tracking_number, label_page FROM po_boxes WHERE po_id = $1 ORDER BY box_number', [po.id]);
    expect(rows.find((r) => r.tracking_number === TRACK_A).label_page).toBe(1);
    expect(rows.find((r) => r.tracking_number === TRACK_B).label_page).toBe(2);
    expect(boxes.length).toBe(2);
  });

  test('the supplier downloads the whole sheet, and one label as a single page', async ({ request }) => {
    const { po, boxes } = await order(request);
    const key = await upload(request, po.id, await labelsPdf());
    await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'),
      data: { poId: po.id, key, pages: 2, pageMap: [{ tracking: TRACK_A, page: 1 }, { tracking: TRACK_B, page: 2 }] },
    });

    const whole = await request.get(`/api/po/label-download?poId=${po.id}`, { headers: auth('supplier', SUPPLIER_UID) });
    expect(whole.status()).toBe(200);
    expect(whole.headers()['content-type']).toBe('application/pdf');
    expect((await PDFDocument.load(await whole.body())).getPageCount()).toBe(2);

    const one = await request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${boxes[1].id}`, { headers: auth('supplier', SUPPLIER_UID) });
    expect(one.status()).toBe(200);
    const single = await PDFDocument.load(await one.body());
    expect(single.getPageCount()).toBe(1);           // just their box's label
    expect(one.headers()['content-disposition']).toContain(`label-${boxes[1].box_number}`);
    // Never cached: an address and a usable barcode.
    expect(one.headers()['cache-control']).toContain('no-store');
  });

  test('another supplier cannot download this order’s labels', async ({ request }) => {
    const { po, boxes } = await order(request);
    const key = await upload(request, po.id, await labelsPdf());
    await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'), data: { poId: po.id, key, pages: 2, pageMap: [{ tracking: TRACK_A, page: 1 }] },
    });
    expect((await request.get(`/api/po/label-download?poId=${po.id}`, { headers: auth('supplier', OTHER_UID) })).status()).toBe(403);
    expect((await request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${boxes[0].id}`, { headers: auth('supplier', OTHER_UID) })).status()).toBe(403);
    expect((await request.get(`/api/po/label-download?poId=${po.id}`)).status()).toBe(401);
  });

  test('the storage key never reaches the supplier', async ({ request }) => {
    const { po } = await order(request);
    const key = await upload(request, po.id, await labelsPdf());
    await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'), data: { poId: po.id, key, pages: 2, pageMap: [{ tracking: TRACK_A, page: 1 }] },
    });
    const mine = await (await request.get(`/api/po/get?id=${po.id}`, { headers: auth('supplier', SUPPLIER_UID) })).json();
    expect(mine.po.labels_key).toBeUndefined();
    expect(mine.po.labels_pages).toBe(2);            // they still learn there IS a sheet
    const staff = await (await request.get(`/api/po/get?id=${po.id}`, { headers: auth('ph_team') })).json();
    expect(staff.po.labels_key).toBe(key);
  });

  test('a label with no matching page says so instead of serving the wrong one', async ({ request }) => {
    const { po, boxes } = await order(request);
    const key = await upload(request, po.id, await labelsPdf());
    // Only page 1 matched; label 2 is left unmapped.
    await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'), data: { poId: po.id, key, pages: 2, pageMap: [{ tracking: TRACK_A, page: 1 }] },
    });
    const res = await request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${boxes[1].id}`, { headers: auth('supplier', SUPPLIER_UID) });
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/no page/i);
  });

  test('archiving the order takes its labels out of the bucket', async ({ request }) => {
    const { po } = await order(request);
    const key = await upload(request, po.id, await labelsPdf());
    await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'), data: { poId: po.id, key, pages: 2, pageMap: [{ tracking: TRACK_A, page: 1 }] },
    });
    await q("UPDATE purchase_orders SET status = 'reconciled' WHERE id = $1", [po.id]);
    expect((await request.post('/api/po/close', { headers: auth('ph_team'), data: { poId: po.id } })).status()).toBe(200);

    await expect.poll(async () => (await q('SELECT labels_key FROM purchase_orders WHERE id = $1', [po.id]))[0].labels_key,
      { timeout: 10_000 }).toBeNull();
    expect((await q('SELECT label_page FROM po_boxes WHERE po_id = $1', [po.id])).every((r) => r.label_page === null)).toBe(true);
  });
});

test('a client-chosen storage key is refused', async ({ request }) => {
  const { po } = await order(request);
  for (const key of ['../../etc/passwd', 'product-photos/steal.pdf', 'po-labels/../evil.pdf', 'po-labels/x.exe']) {
    const res = await request.post('/api/po/labels-attach', { headers: auth('ph_team'), data: { poId: po.id, key } });
    expect(res.status(), key).toBe(400);
  }
});

test('a supplier cannot upload or attach a labels file', async ({ request }) => {
  const { po } = await order(request);
  expect((await request.post('/api/po/labels-sign', { headers: auth('supplier', SUPPLIER_UID), data: { poId: po.id } })).status()).toBe(403);
  expect((await request.post('/api/po/labels-attach', {
    headers: auth('supplier', SUPPLIER_UID), data: { poId: po.id, key: 'po-labels/x.pdf' },
  })).status()).toBe(403);
});
