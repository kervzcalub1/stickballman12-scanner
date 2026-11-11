// The courier's labels PDF: stored in R2, downloadable whole or one label at a time.
//
// It used to be read for its tracking numbers and discarded, so the supplier had to hunt
// through email for the label belonging to the box in front of them. The security shape
// matters as much as the feature: these carry a ship-to address and a live courier
// barcode, so downloads are proxied and authorised, never a public bucket URL.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { labelPagesOnly } from '../src/trackingOcr.js';
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

// The real shape of a sheet bought from UPS CampusShip: a packing slip after every label,
// so two labels arrive as FOUR pages. Each label page carries its tracking number; the
// slips carry none, which is exactly how the two are told apart.
async function labelsPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of [TRACK_A, TRACK_B]) {
    const label = doc.addPage([612, 792]);
    label.drawText(t, { x: 20, y: 700, size: 12, font });
    const slip = doc.addPage([612, 792]);
    slip.drawText('PACKING SLIP', { x: 20, y: 700, size: 12, font });
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

// Attaching doesn't touch R2 — it records where each label lives in the stored file — so
// this one runs everywhere.
test('a second sheet is ADDED: labels it does not carry keep their old file', async ({ request }) => {
  const { po } = await order(request);
  const attach = (tag, pageMap, pages) => request.post('/api/po/labels-attach', {
    headers: auth('ph_team'),
    data: { poId: po.id, key: `po-labels/${po.po_code}-${tag}.pdf`, name: `${tag}.pdf`, pages, pageMap },
  });
  await attach('first', [{ tracking: TRACK_A, page: 1 }, { tracking: TRACK_B, page: 3 }], 4);
  const files1 = await q('SELECT id FROM po_label_files WHERE po_id = $1', [po.id]);
  expect(files1).toHaveLength(1);

  // A second sheet carrying label B only (the courier re-issued it). It's ADDED — the order
  // now holds two files — B moves to the newest file that has it, and A, which the new
  // sheet doesn't carry, keeps printing from the first one.
  const res = await attach('second', [{ tracking: TRACK_B, page: 1 }], 2);
  expect(res.status(), await res.text()).toBe(200);
  const files = await q('SELECT id, name FROM po_label_files WHERE po_id = $1 ORDER BY id', [po.id]);
  expect(files.map((f) => f.name)).toEqual(['first.pdf', 'second.pdf']);
  const rows = await q('SELECT tracking_number, label_file_id, label_page, label_page_end FROM po_boxes WHERE po_id = $1', [po.id]);
  const a = rows.find((r) => r.tracking_number === TRACK_A);
  const b = rows.find((r) => r.tracking_number === TRACK_B);
  expect([Number(a.label_file_id), a.label_page, a.label_page_end]).toEqual([Number(files[0].id), 1, 2]);
  expect([Number(b.label_file_id), b.label_page, b.label_page_end]).toEqual([Number(files[1].id), 1, 2]);

  // A key minted for ANOTHER order is refused, even in the right shape.
  const other = await request.post('/api/po/labels-attach', {
    headers: auth('ph_team'), data: { poId: po.id, key: 'po-labels/PO-SOMEONE-ELSE-1.pdf', pages: 1 },
  });
  expect(other.status()).toBe(400);
});

test('deleting one file unmaps only its labels — and one an older file also has falls back to it', async ({ request }) => {
  const { po, boxes } = await order(request);
  const attach = (tag, pageMap, pages) => request.post('/api/po/labels-attach', {
    headers: auth('ph_team'),
    data: { poId: po.id, key: `po-labels/${po.po_code}-${tag}.pdf`, name: `${tag}.pdf`, pages, pageMap },
  });
  await attach('a', [{ tracking: TRACK_A, page: 1 }], 2);                                      // A only
  await attach('ab', [{ tracking: TRACK_A, page: 1 }, { tracking: TRACK_B, page: 3 }], 4);    // both: newest wins
  const [fa, fab] = (await q('SELECT id FROM po_label_files WHERE po_id = $1 ORDER BY id', [po.id])).map((f) => Number(f.id));
  let rows = await q('SELECT tracking_number, label_file_id FROM po_boxes WHERE po_id = $1', [po.id]);
  expect(rows.every((r) => Number(r.label_file_id) === fab)).toBe(true);

  const del = await request.post('/api/po/labels-remove', { headers: auth('ph_team'), data: { poId: po.id, fileId: fab } });
  expect(del.status(), await del.text()).toBe(200);
  expect(await del.json()).toMatchObject({ remapped: 1, unmapped: 1 });
  rows = await q('SELECT tracking_number, label_file_id, label_page, label_page_end FROM po_boxes WHERE po_id = $1', [po.id]);
  const a = rows.find((r) => r.tracking_number === TRACK_A);
  const b = rows.find((r) => r.tracking_number === TRACK_B);
  expect([Number(a.label_file_id), a.label_page, a.label_page_end]).toEqual([fa, 1, 2]);   // back on the file that still has it
  expect([b.label_file_id, b.label_page, b.label_page_end]).toEqual([null, null, null]);  // nothing else carries B
  expect(await q('SELECT id FROM po_label_files WHERE po_id = $1', [po.id])).toHaveLength(1);

  // Suppliers can't delete; a file on another order can't be reached through this one.
  expect((await request.post('/api/po/labels-remove', { headers: auth('supplier', SUPPLIER_UID), data: { poId: po.id, fileId: fa } })).status()).toBe(403);
  const { po: po2 } = await order(request);
  expect((await request.post('/api/po/labels-remove', { headers: auth('ph_team'), data: { poId: po2.id, fileId: fa } })).status()).toBe(404);
  expect(boxes).toHaveLength(2);
});

test('a deleted order keeps every labels file in its archive, and Restore puts the mapping back', async ({ request }) => {
  const { po } = await order(request);
  const attach = (tag, pageMap, pages) => request.post('/api/po/labels-attach', {
    headers: auth('ph_team'),
    data: { poId: po.id, key: `po-labels/${po.po_code}-${tag}.pdf`, name: `${tag}.pdf`, pages, pageMap },
  });
  await attach('one', [{ tracking: TRACK_A, page: 1 }], 1);
  await attach('two', [{ tracking: TRACK_B, page: 1 }], 1);
  const before = await q('SELECT id, tracking_number, label_file_id, label_page FROM po_boxes WHERE po_id = $1 ORDER BY id', [po.id]);
  const del = await request.post('/api/po/delete', { headers: auth('ph_team'), data: { poId: po.id, confirm: po.po_code } });
  expect(del.status(), await del.text()).toBe(200);
  const arch = (await q('SELECT id, children FROM deleted_pos WHERE po_id = $1', [po.id]))[0];
  expect(arch.children.po_label_files.map((f) => f.name)).toEqual(['one.pdf', 'two.pdf']);
  const list = (await (await request.get('/api/po/deleted', { headers: auth('ph_team') })).json()).rows.find((r) => Number(r.id) === Number(arch.id));
  expect(list.label_file_count).toBe(2);
  const res = await request.post('/api/po/deleted', { headers: auth('ph_team'), data: { id: Number(arch.id), restore: true } });
  expect(res.status(), await res.text()).toBe(200);
  expect((await q('SELECT name FROM po_label_files WHERE po_id = $1 ORDER BY id', [po.id])).map((f) => f.name)).toEqual(['one.pdf', 'two.pdf']);
  expect(await q('SELECT id, tracking_number, label_file_id, label_page FROM po_boxes WHERE po_id = $1 ORDER BY id', [po.id])).toEqual(before);
  await q('DELETE FROM deleted_pos WHERE id = $1', [arch.id]);
});

test.describe('labels file', () => {
  test.skip(!R2, 'R2 is not configured in this environment');

  test('pages map to labels by TRACKING NUMBER, not by page order', async ({ request }) => {
    const { po, boxes } = await order(request);
    const key = await upload(request, po.id, await labelsPdf());
    // Deliberately handed over in the wrong order: page order must not decide the mapping.
    const res = await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'),
      data: { poId: po.id, key, name: 'labels.pdf', pages: 4,
        pageMap: [{ tracking: TRACK_B, page: 3 }, { tracking: TRACK_A, page: 1 }] },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).matched).toBe(2);
    const rows = await q('SELECT tracking_number, label_page FROM po_boxes WHERE po_id = $1 ORDER BY box_number', [po.id]);
    expect(rows.find((r) => r.tracking_number === TRACK_A).label_page).toBe(1);
    expect(rows.find((r) => r.tracking_number === TRACK_B).label_page).toBe(3);
    expect(boxes.length).toBe(2);
  });

  test('each label owns the pages up to the next one — its packing slip rides along', async ({ request }) => {
    const { po } = await order(request);
    const key = await upload(request, po.id, await labelsPdf());
    await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'),
      data: { poId: po.id, key, pages: 4, pageMap: [{ tracking: TRACK_A, page: 1 }, { tracking: TRACK_B, page: 3 }] },
    });
    const rows = await q('SELECT tracking_number, label_page, label_page_end FROM po_boxes WHERE po_id = $1 ORDER BY box_number', [po.id]);
    const a = rows.find((r) => r.tracking_number === TRACK_A);
    const b = rows.find((r) => r.tracking_number === TRACK_B);
    expect([a.label_page, a.label_page_end]).toEqual([1, 2]);   // label + its slip
    expect([b.label_page, b.label_page_end]).toEqual([3, 4]);   // last one runs to the end
  });

  test('the supplier downloads the whole sheet, and one label with its slip', async ({ request }) => {
    const { po, boxes } = await order(request);
    const key = await upload(request, po.id, await labelsPdf());
    await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'),
      data: { poId: po.id, key, pages: 4, pageMap: [{ tracking: TRACK_A, page: 1 }, { tracking: TRACK_B, page: 3 }] },
    });

    const whole = await request.get(`/api/po/label-download?poId=${po.id}`, { headers: auth('supplier', SUPPLIER_UID) });
    expect(whole.status()).toBe(200);
    expect(whole.headers()['content-type']).toBe('application/pdf');
    expect((await PDFDocument.load(await whole.body())).getPageCount()).toBe(4);

    const one = await request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${boxes[1].id}`, { headers: auth('supplier', SUPPLIER_UID) });
    expect(one.status()).toBe(200);
    const single = await PDFDocument.load(await one.body());
    // The label AND the packing slip that follows it — the slip goes in that box.
    expect(single.getPageCount()).toBe(2);
    expect(one.headers()['content-disposition']).toContain(`label-${boxes[1].box_number}`);
    // Never cached: an address and a usable barcode.
    expect(one.headers()['cache-control']).toContain('no-store');
  });

  test('another supplier cannot download this order’s labels', async ({ request }) => {
    const { po, boxes } = await order(request);
    const key = await upload(request, po.id, await labelsPdf());
    await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'), data: { poId: po.id, key, pages: 4, pageMap: [{ tracking: TRACK_A, page: 1 }] },
    });
    expect((await request.get(`/api/po/label-download?poId=${po.id}`, { headers: auth('supplier', OTHER_UID) })).status()).toBe(403);
    expect((await request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${boxes[0].id}`, { headers: auth('supplier', OTHER_UID) })).status()).toBe(403);
    expect((await request.get(`/api/po/label-download?poId=${po.id}`)).status()).toBe(401);
  });

  test('the storage key never reaches the supplier', async ({ request }) => {
    const { po } = await order(request);
    const key = await upload(request, po.id, await labelsPdf());
    await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'), data: { poId: po.id, key, pages: 4, pageMap: [{ tracking: TRACK_A, page: 1 }] },
    });
    const mine = await (await request.get(`/api/po/get?id=${po.id}`, { headers: auth('supplier', SUPPLIER_UID) })).json();
    expect(mine.po.labels_key).toBeUndefined();
    expect(mine.labelFiles).toHaveLength(1);         // they still learn there IS a sheet
    expect(mine.labelFiles[0].pages).toBe(4);
    expect(mine.labelFiles[0].uploaded_by).toBe('Our team');
    expect(JSON.stringify(mine)).not.toContain(key);
    // Nobody's screen needs the key: the file list never carries it.
    const staff = await (await request.get(`/api/po/get?id=${po.id}`, { headers: auth('ph_team') })).json();
    expect(staff.labelFiles).toHaveLength(1);
    expect(JSON.stringify(staff.labelFiles)).not.toContain(key);
  });

  test('a label with no matching page says so instead of serving the wrong one', async ({ request }) => {
    const { po, boxes } = await order(request);
    const key = await upload(request, po.id, await labelsPdf());
    // Only page 1 matched; label 2 is left unmapped.
    await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'), data: { poId: po.id, key, pages: 4, pageMap: [{ tracking: TRACK_A, page: 1 }] },
    });
    const res = await request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${boxes[1].id}`, { headers: auth('supplier', SUPPLIER_UID) });
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/no page/i);
  });

  test('archiving the order takes ALL its labels files out of the bucket', async ({ request }) => {
    const { po } = await order(request);
    const key = await upload(request, po.id, await labelsPdf());
    await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'), data: { poId: po.id, key, pages: 4, pageMap: [{ tracking: TRACK_A, page: 1 }] },
    });
    const key2 = await upload(request, po.id, await labelsPdf());
    await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'), data: { poId: po.id, key: key2, pages: 4, pageMap: [{ tracking: TRACK_B, page: 3 }] },
    });
    expect(await q('SELECT id FROM po_label_files WHERE po_id = $1', [po.id])).toHaveLength(2);
    await q("UPDATE purchase_orders SET status = 'reconciled' WHERE id = $1", [po.id]);
    expect((await request.post('/api/po/close', { headers: auth('ph_team'), data: { poId: po.id } })).status()).toBe(200);

    await expect.poll(async () => (await q('SELECT count(*)::int AS n FROM po_label_files WHERE po_id = $1', [po.id]))[0].n,
      { timeout: 10_000 }).toBe(0);
    expect((await q('SELECT label_page FROM po_boxes WHERE po_id = $1', [po.id])).every((r) => r.label_page === null)).toBe(true);
    const { getObject } = await import('../api/_lib/r2.js');
    for (const k of [key, key2]) {
      await expect.poll(() => getObject(k).then(() => 'still there', () => 'gone'), { timeout: 10_000 }).toBe('gone');
    }
  });
});

// Labels bought in PARTS (2026-11-12): a supplier asks for 30 and wants 7 first. The 7 go
// up as one PDF, the other 23 as another a week later — and the first 7 must keep
// printing. Each label page here gets its own WIDTH, so a download proves which page of
// which file came back without having to parse the PDF's text.
// 1Z + 16: a UPS shape the PDF reader recognises. TAG changes per order (serial workers),
// so no two orders in the run share a tracking number.
const STAMP = String(Date.now()).slice(-8);
let TAG = 'A';
const T = (i) => `1ZM${TAG}${STAMP}K${String(i).padStart(5, '0')}`;
const widthOf = (sheet, i) => (sheet === 1 ? 300 : 500) + i;                  // unique per page per file

async function sheetPdf(sheet, numbers, { slips = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const i of numbers) {
    doc.addPage([widthOf(sheet, i), 792]).drawText(T(i), { x: 20, y: 700, size: 12, font });
    if (slips) doc.addPage([612, 792]).drawText('PACKING SLIP', { x: 20, y: 700, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

async function partsOrder(request, n) {
  TAG = String.fromCharCode(TAG.charCodeAt(0) + 1);
  const r = await request.post('/api/po/create', {
    headers: auth('ph_team'),
    data: {
      supplierName: SUPPLIER, tagCode: `PRT${Date.now() % 100000}`,
      labels: Array.from({ length: n }, (_, k) => ({ trackingNumber: T(k + 1) })),
    },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  const po = (await r.json()).po;
  await q('UPDATE purchase_orders SET supplier_user_id = $1 WHERE id = $2', [SUPPLIER_UID, po.id]);
  const boxes = await q('SELECT id, box_number, tracking_number FROM po_boxes WHERE po_id = $1 ORDER BY box_number', [po.id]);
  return { po, boxes, box: (i) => boxes.find((b) => b.tracking_number === T(i)) };
}

const pageMapOf = (numbers, { slips = false } = {}) => numbers.map((i, k) => ({ tracking: T(i), page: slips ? k * 2 + 1 : k + 1 }));

async function widthsOf(res) {
  expect(res.status(), await res.text().catch(() => '')).toBe(200);
  const doc = await PDFDocument.load(await res.body());
  return doc.getPages().map((p) => Math.round(p.getWidth()));
}

// The browser PUTs the file straight to R2. The bucket's CORS rules are for the real app's
// origins, so the test server's origin is proxied through Playwright — the bytes still
// land in R2 for real, exactly as they would from the app.
async function proxyR2(page) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, PUT, OPTIONS', 'access-control-allow-headers': '*' };
  await page.route(/r2\.cloudflarestorage\.com/, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const res = await route.fetch();
    return route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
  });
}

// Drop files on an element the way a browser does: a real DataTransfer carrying File objects.
async function dropFiles(page, locator, files) {
  const dt = await page.evaluateHandle((fs) => {
    const d = new DataTransfer();
    for (const f of fs) d.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'application/pdf' }));
    return d;
  }, files.map((f) => ({ name: f.name, bytes: [...f.buffer] })));
  await locator.dispatchEvent('dragover', { dataTransfer: dt });
  await locator.dispatchEvent('drop', { dataTransfer: dt });
}

test.describe('labels in several PDFs', () => {
  test.skip(!R2, 'R2 is not configured in this environment');

  test('7 labels now, 23 next week: both sheets print per box, and the first 7 survive the second upload', async ({ request }) => {
    const { po, box } = await partsOrder(request, 30);
    const first = [1, 2, 3, 4, 5, 6, 7];
    const rest = Array.from({ length: 23 }, (_, k) => k + 8);

    const k1 = await upload(request, po.id, await sheetPdf(1, first, { slips: true }));
    const a1 = await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'), data: { poId: po.id, key: k1, name: 'first-7.pdf', pages: 14, pageMap: pageMapOf(first, { slips: true }) },
    });
    expect((await a1.json()).matched).toBe(7);

    // Next week's sheet re-includes label 7 (the courier re-issued it) — the newest file
    // that carries a label wins, so 7 moves; 1–6 aren't in it and stay on the first file.
    const second = [7, ...rest];
    const k2 = await upload(request, po.id, await sheetPdf(2, second));
    const a2 = await request.post('/api/po/labels-attach', {
      headers: auth('ph_team'), data: { poId: po.id, key: k2, name: 'next-23.pdf', pages: second.length, pageMap: pageMapOf(second) },
    });
    expect((await a2.json()).matched).toBe(24);

    const sup = auth('supplier', SUPPLIER_UID);
    // Label 3 — from the FIRST file, with its packing slip.
    expect(await widthsOf(await request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${box(3).id}`, { headers: sup })))
      .toEqual([widthOf(1, 3), 612]);
    // Label 20 — from the second file.
    expect(await widthsOf(await request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${box(20).id}`, { headers: sup })))
      .toEqual([widthOf(2, 20)]);
    // Label 7 — the re-issued one, from the newest file.
    expect(await widthsOf(await request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${box(7).id}`, { headers: sup })))
      .toEqual([widthOf(2, 7)]);

    // "Download all labels": every file, oldest first, as one PDF the warehouse prints.
    const all = await request.get(`/api/po/label-download?poId=${po.id}`, { headers: sup });
    const widths = await widthsOf(all);
    expect(widths).toHaveLength(14 + 24);
    expect(widths[0]).toBe(widthOf(1, 1));
    expect(widths[14]).toBe(widthOf(2, 7));
    expect(all.headers()['cache-control']).toContain('no-store');

    // One file on its own, as uploaded.
    const files = (await (await request.get(`/api/po/get?id=${po.id}`, { headers: sup })).json()).labelFiles;
    expect(files.map((f) => [f.name, f.labels])).toEqual([['first-7.pdf', 6], ['next-23.pdf', 24]]);
    expect(await widthsOf(await request.get(`/api/po/label-download?poId=${po.id}&fileId=${files[0].id}`, { headers: sup })))
      .toHaveLength(14);
    // Another supplier reaches none of it.
    expect((await request.get(`/api/po/label-download?poId=${po.id}&fileId=${files[0].id}`, { headers: auth('supplier', OTHER_UID) })).status()).toBe(403);
  });

  test('a legacy single-file order (before many files) still downloads, whole and per box', async ({ request }) => {
    const { po, box } = await partsOrder(request, 2);
    // The old shape exactly: the file on purchase_orders.labels_*, page pointers on the
    // boxes, NO po_label_files row (what an order looks like before db:setup reaches it).
    const key = `po-labels/${po.po_code}-${Date.now()}.pdf`;
    const { putObject } = await import('../api/_lib/r2.js');
    await putObject(key, await sheetPdf(1, [1, 2], { slips: true }));
    await q(`UPDATE purchase_orders SET labels_key = $2, labels_name = 'old.pdf', labels_pages = 4, labels_uploaded_by = 'Kim',
               labels_uploaded_at = now() WHERE id = $1`, [po.id, key]);
    await q('UPDATE po_boxes SET label_page = 1, label_page_end = 2 WHERE id = $1', [box(1).id]);
    await q('UPDATE po_boxes SET label_page = 3, label_page_end = 4 WHERE id = $1', [box(2).id]);
    expect(await q('SELECT id FROM po_label_files WHERE po_id = $1', [po.id])).toHaveLength(0);

    const sup = auth('supplier', SUPPLIER_UID);
    expect(await widthsOf(await request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${box(2).id}`, { headers: sup })))
      .toEqual([widthOf(1, 2), 612]);
    expect(await widthsOf(await request.get(`/api/po/label-download?poId=${po.id}`, { headers: sup }))).toHaveLength(4);
    // Adopted as a file of its own — and a new sheet now ADDS beside it.
    const files = await q('SELECT id, key, name, uploaded_by FROM po_label_files WHERE po_id = $1', [po.id]);
    expect(files.map((f) => [f.key, f.name, f.uploaded_by])).toEqual([[key, 'old.pdf', 'Kim']]);
    const k2 = await upload(request, po.id, await sheetPdf(2, [2]));
    await request.post('/api/po/labels-attach', { headers: auth('ph_team'), data: { poId: po.id, key: k2, pages: 1, pageMap: pageMapOf([2]) } });
    expect(await widthsOf(await request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${box(1).id}`, { headers: sup })))
      .toEqual([widthOf(1, 1), 612]);
    expect(await widthsOf(await request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${box(2).id}`, { headers: sup })))
      .toEqual([widthOf(2, 2)]);

    // Deleting the legacy file clears the old columns too, so it isn't adopted back.
    const del = await request.post('/api/po/labels-remove', { headers: auth('ph_team'), data: { poId: po.id, fileId: Number(files[0].id) } });
    expect(del.status()).toBe(200);
    expect((await q('SELECT labels_key FROM purchase_orders WHERE id = $1', [po.id]))[0].labels_key).toBeNull();
    expect((await (await request.get(`/api/po/get?id=${po.id}`, { headers: auth('ph_team') })).json()).labelFiles).toHaveLength(1);
    expect((await request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${box(1).id}`, { headers: sup })).status()).toBe(404);
  });

  test('on screen: several PDFs picked at once are each saved, and one can be deleted', async ({ page }) => {
    // Sheets read in the browser, so the order is made through the API first.
    const { po, box } = await partsOrder(page.request, 5);
    await proxyR2(page);
    await loginAs(page, 'ph_team');
    await page.goto(`/ph/po-status?po=${po.id}`);
    const panel = page.locator('.po-labels-file');
    await expect(panel).toContainText('Not uploaded yet');
    await panel.locator('input[type="file"]').setInputFiles([
      { name: 'part-1.pdf', mimeType: 'application/pdf', buffer: await sheetPdf(1, [1, 2], { slips: true }) },
      { name: 'part-2.pdf', mimeType: 'application/pdf', buffer: await sheetPdf(2, [3, 4, 5]) },
    ]);
    await expect(panel.locator('.po-label-files li')).toHaveCount(2, { timeout: 30_000 });
    await expect(panel).toContainText('2 PDFs');
    await expect(panel.locator('li', { hasText: 'part-1.pdf' })).toContainText('2 labels print from it');
    await expect(panel.locator('li', { hasText: 'part-2.pdf' })).toContainText('3 labels print from it');
    await expect(panel.locator('li', { hasText: 'part-1.pdf' })).toContainText('EST');
    const rows = await q('SELECT tracking_number, label_page, label_page_end, f.name FROM po_boxes b JOIN po_label_files f ON f.id = b.label_file_id WHERE b.po_id = $1', [po.id]);
    expect(rows.find((r) => r.tracking_number === T(2))).toMatchObject({ name: 'part-1.pdf', label_page: 3, label_page_end: 4 });
    expect(rows.find((r) => r.tracking_number === T(5))).toMatchObject({ name: 'part-2.pdf', label_page: 3, label_page_end: 3 });
    // Each box's Print label button is there for labels from both files.
    expect(await widthsOf(await page.request.get(`/api/po/label-download?poId=${po.id}&poBoxId=${box(4).id}`, { headers: auth('ph_team') })))
      .toEqual([widthOf(2, 4)]);

    // Delete part-2: only its three labels lose their page.
    page.once('dialog', (d) => d.accept());
    await panel.locator('li', { hasText: 'part-2.pdf' }).getByRole('button', { name: 'Delete' }).click();
    await expect(panel.locator('li', { hasText: 'part-2.pdf' })).toHaveCount(0, { timeout: 15_000 });
    await expect(panel.locator('li', { hasText: 'part-1.pdf' })).toBeVisible();
    const after = await q('SELECT tracking_number, label_file_id FROM po_boxes WHERE po_id = $1', [po.id]);
    expect(after.filter((r) => r.label_file_id).map((r) => r.tracking_number).sort()).toEqual([T(1), T(2)]);

    // Two more dropped on the panel at once: part-2 again, and a re-issued label 1. Each is
    // its own file; label 1 moves to the newest file carrying it, label 2 stays on part-1.
    await dropFiles(page, panel, [
      { name: 'part-2-again.pdf', buffer: await sheetPdf(2, [3, 4, 5]) },
      { name: 'reissued-1.pdf', buffer: await sheetPdf(2, [1]) },
    ]);
    await expect(panel.locator('.po-label-files li')).toHaveCount(3, { timeout: 30_000 });
    const now = await q('SELECT b.tracking_number, f.name FROM po_boxes b JOIN po_label_files f ON f.id = b.label_file_id WHERE b.po_id = $1', [po.id]);
    const fileOf = (i) => now.find((r) => r.tracking_number === T(i))?.name;
    expect([fileOf(1), fileOf(2), fileOf(3), fileOf(5)]).toEqual(['reissued-1.pdf', 'part-1.pdf', 'part-2-again.pdf', 'part-2-again.pdf']);
  });

  test('on screen: drop-off receipts over three days — two picked at once, then one more', async ({ page }) => {
    const { po } = await partsOrder(page.request, 3);
    // Boxes gone (and already announced, so no Telegram alert fires from the test).
    await q("UPDATE po_boxes SET status = 'shipped', dropoff_alerted_at = now() WHERE po_id = $1", [po.id]);
    await q("UPDATE purchase_orders SET status = 'shipped' WHERE id = $1", [po.id]);
    const receiptPdf = async (label) => {
      const doc = await PDFDocument.create();
      doc.addPage([400, 300]).drawText(label, { x: 20, y: 200, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
      return Buffer.from(await doc.save());
    };
    await proxyR2(page);
    await loginAs(page, 'ph_team');
    await page.goto(`/ph/po-status?po=${po.id}`);
    const panel = page.locator('.po-dropoff');
    await expect(panel).toContainText('Not in yet');
    await panel.locator('input[type="file"]').setInputFiles([
      { name: 'dropoff-day1.pdf', mimeType: 'application/pdf', buffer: await receiptPdf('7 boxes') },
      { name: 'dropoff-day2.pdf', mimeType: 'application/pdf', buffer: await receiptPdf('10 boxes') },
    ]);
    await expect(panel).toContainText('2 receipts saved.', { timeout: 30_000 });
    await expect(panel.locator('.po-dropoff-list li')).toHaveCount(2);
    // Day three's dropped on the panel instead of picked.
    await dropFiles(page, panel, [{ name: 'dropoff-day3.pdf', buffer: await receiptPdf('13 boxes') }]);
    await expect(panel).toContainText('Receipt saved.', { timeout: 30_000 });
    await expect(panel.locator('.po-dropoff-list li')).toHaveCount(3);
    await expect(panel).toContainText('Drop-off receipts (3)');
    for (const n of ['dropoff-day1.pdf', 'dropoff-day2.pdf', 'dropoff-day3.pdf']) {
      await expect(panel.locator('li', { hasText: n })).toContainText('EST');
    }
    expect((await q('SELECT name FROM po_dropoff_receipts WHERE po_id = $1 ORDER BY id', [po.id])).map((r) => r.name))
      .toEqual(['dropoff-day1.pdf', 'dropoff-day2.pdf', 'dropoff-day3.pdf']);
    const { deleteObject } = await import('../api/_lib/r2.js');
    for (const r of await q('SELECT r2_key FROM po_dropoff_receipts WHERE po_id = $1', [po.id])) await deleteObject(r.r2_key).catch(() => {});
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


// Which pages of an imported sheet are labels. Pure, so it's tested directly — the
// alternative is nine real rows and eight blank ones to delete by hand, every time.
test.describe('label vs packing slip', () => {
  test('pages with no tracking number are not labels', () => {
    const sheet = [
      { page: 1, value: '1Z1' }, { page: 2, value: '' },     // label, slip
      { page: 3, value: '1Z2' }, { page: 4, value: '' },
    ];
    const r = labelPagesOnly(sheet);
    expect(r.labels.map((x) => x.page)).toEqual([1, 3]);
    expect(r.skipped.map((x) => x.page)).toEqual([2, 4]);
    expect(r.undecidable).toBe(false);
  });

  test('a sheet where NOTHING decoded gives every page back', () => {
    // Can't tell a slip from a label whose barcode simply failed to read — and losing a
    // label silently is far worse than showing a blank row to fill in.
    const r = labelPagesOnly([{ page: 1, value: '' }, { page: 2, value: '' }]);
    expect(r.labels).toHaveLength(2);
    expect(r.skipped).toHaveLength(0);
    expect(r.undecidable).toBe(true);
  });

  test('a clean sheet with no slips is unaffected', () => {
    const r = labelPagesOnly([{ page: 1, value: '1Z1' }, { page: 2, value: '1Z2' }]);
    expect(r.labels).toHaveLength(2);
    expect(r.skipped).toHaveLength(0);
  });
});
