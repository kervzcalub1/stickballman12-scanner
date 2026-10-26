// Receipts that print a UPC per item instead of a style code (Nike Factory, 2026-10-27).
// The reader's lines go through: the GS1 check digit, the receiving UPC lookup, and the size
// it names against the size printed — a row that fails any of it keeps its price, loses its
// style code, and says why (api/_lib/receipt-ai.js `resolveReceiptUpcs`). The lookup is
// stubbed here: no test calls StockX, Nike or OpenAI.
import { test, expect } from '@playwright/test';

test('the check digit catches a misread UPC', async () => {
  const { gtinValid } = await import('../src/lib/gtin.js');
  // Read right off the Nike receipt…
  for (const u of ['00196975508242', '00196604935609', '00196154520201', '00199777304012', '196975508242'])
    expect(gtinValid(u)).toBe(true);
  // …and the five the model misread on it (a digit changed, swapped or dropped).
  for (const u of ['00196604335609', '00196755082424', '0019696132729', '00196975503717', '00198968686102'])
    expect(gtinValid(u)).toBe(false);
  expect(gtinValid('12345678')).toBe(false);   // too short to name a shoe
});

test('UPCs become style codes — checked, repaired from the other reading, or left for a person', async () => {
  const mod = await import('../api/_lib/receipt-ai.js');
  const known = {
    '00196154520164': { sku: 'DO9328-004', scannedSize: '10', fb: { name: 'Nike Metcon 8 Photon Dust Anthracite' } },
    '00196969132729': { sku: 'DZ3324-003', scannedSize: '10.5', fb: { name: 'Jordan Tatum 1' } },
    '00196975508242': { sku: 'DV1403-003', scannedSize: '11.5', fb: { name: "Nike Air Max 1 '86 OG Golf" } },
    '00199777304012': { sku: 'IX8478-410', scannedSize: '14', fb: { name: 'Air Jordan 1 Retro Low OG Howard University' } },
  };
  const asked = [];
  const keep = mod.IO.resolveUpc;
  mod.IO.resolveUpc = async (u) => { asked.push(u); return known[u] || null; };
  try {
    const row = (name, upc, size, price, extra = {}) => ({ name, upc, size, qty: 1, totalPrice: price, sku: '', source: 'ocr', ...extra });
    const first = [
      row('NIKE METCON 8', '00196154520164', '10', 53.99),
      row('NIKE METCON 8', '00196154520164', '10', 53.99),          // same UPC twice → looked up once
      row('JORDAN TATUM 1', '0019696132729', '10.5', 47.99),          // dropped digit — the other reading has it
      row('AIR JORDAN 5 RETRO OG', '00198968686102', '10.5', 129),    // misread in both readings
      row("NIKE AIR MAX 1 '86 OG G", '00196975508242', '9', 41.98),   // real UPC, but a different size
      row('NIKE PEGASUS PREMIUM RR', '00196154520171', '10.5', 71.98),// valid, unknown to every source
      row('PEGASUS', '00199777304012', '14', 65.98),                  // the UPC names another shoe
      { sku: 'HQ7978-001', size: '9', qty: 1, totalPrice: 120, source: 'ocr' },  // a printed style code, as before
    ];
    const second = [row('JORDAN TATUM 1', '00196969132729', '10.5', 47.99)];
    const out = await mod.resolveReceiptUpcs(first, second);

    expect(out[0]).toMatchObject({ sku: 'DO9328-004', size: '10' });
    expect(out[0].note).toBeUndefined();
    expect(asked.filter((u) => u === '00196154520164')).toHaveLength(1);
    expect(out[2]).toMatchObject({ sku: 'DZ3324-003', upc: '00196969132729' });
    expect(out[2].note).toMatch(/misread on this line — taken from the other reading/);
    expect(out[3]).toMatchObject({ sku: '', totalPrice: 129 });
    expect(out[3].note).toMatch(/fails its check digit/);
    expect(out[4].sku).toBe('');
    expect(out[4].note).toMatch(/is DV1403-003 size 11\.5, but the receipt says size 9/);
    expect(out[5].sku).toBe('');
    expect(out[5].note).toMatch(/isn't in StockX, Nike or our stock/);
    expect(out[6].sku).toBe('IX8478-410');
    expect(out[6].note).toMatch(/Check it's the same shoe/);
    expect(out[7]).toEqual(first[7]);

    // The receipt's check points at those notes rather than a vague "missing a style code".
    const { checkReceiptRead } = await import('../src/lib/receiptCheck.js');
    const check = checkReceiptRead({ rows: out, subtotal: 547.91, itemsSold: 8 });
    expect(check.problems).toContain("3 lines need their style code typed in — the UPC couldn't be trusted (see the note on each).");
  } finally { mod.IO.resolveUpc = keep; }
});

test('a receipt lying on its side is cropped to the paper and stood upright', async () => {
  const { createRequire } = await import('node:module');
  const sharp = createRequire(import.meta.url)('sharp');
  const { imageForModel } = await import('../api/_lib/receipt-ai.js');
  // A dark counter with a long white strip across it, like the Nike photo.
  const strip = await sharp({ create: { width: 1800, height: 260, channels: 3, background: '#f4f4f4' } }).png().toBuffer();
  const photo = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#3a3a3a' } })
    .composite([{ input: strip, left: 300, top: 700 }]).jpeg().toBuffer();
  const { b64 } = await imageForModel(photo);
  const m = await sharp(Buffer.from(b64, 'base64')).metadata();
  expect(m.height).toBeGreaterThan(m.width * 4);   // upright, and the counter cropped away
  // Not a photo at all → the bytes go as they are, nothing throws.
  const junk = await imageForModel(Buffer.from('not really a jpeg'));
  expect(Buffer.from(junk.b64, 'base64').toString()).toBe('not really a jpeg');
});
