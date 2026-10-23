// The store-order audit table as a CSV (docs/store-orders-plan.md §4.6) — one row per
// store + a total, then every SKU/size line with a difference. Built from the SAME object
// the screen draws (`po/audit` → variance, or the frozen `audit_snapshot`), so the file and
// the screen can never disagree.
const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const m = (n) => (n == null ? '' : Number(n).toFixed(2));

export function storeAuditCsv(v) {
  const out = [];
  out.push(['Store', 'Declared pairs', 'Declared $', 'Receipt $', 'Charged $', 'Received', 'Short', 'Over', '$ owed (short)',
    'Charged − declared', 'Credit agreed', 'Credit received'].map(esc).join(','));
  for (const s of v.stores || []) {
    out.push([s.name, s.declared_units, m(s.declared_total), m(s.receipt_total), m(s.charged_total), s.received_units,
      s.short, s.over, m(s.owed), m(s.charged_minus_declared), m(s.credit_agreed), m(s.credit_received)].map(esc).join(','));
  }
  const t = v.totals || {};
  out.push(['TOTAL', t.declared_units, m(t.declared_total), m(t.receipt_total), m(t.charged_total), t.received_units,
    t.short, t.over, m(t.owed), '', '', ''].map(esc).join(','));
  if (v.untied_units) out.push(esc(`Not tied to a store: ${v.untied_units} pair(s)`));
  out.push('');
  out.push(['Store', 'SKU', 'Size', 'Declared', 'Received', 'Short', 'Over', 'Price ea', '$ owed'].map(esc).join(','));
  for (const s of v.stores || []) {
    for (const g of s.skus || []) {
      for (const z of g.sizes || []) {
        if (!z.short && !z.over) continue;
        out.push([s.name, z.sku, z.size, z.declared, z.received, z.short, z.over, m(z.price), m(z.owed)].map(esc).join(','));
      }
    }
  }
  return out.join('\n');
}

// A store's RECEIPT lines against what Joey listed for that store (plan §4.6, the
// `compareReceiptToApproved` pattern): "the receipt has 2 more of DZ5485-612 size 10 than
// the list". The list side comes from the audit row (`store.skus[].sizes[].declared`), so
// it is the same matching as the audit: SKU on letters + digits, size on its number (a
// `9W` and a `9` are one size here, as everywhere in the store audit). A receipt that
// prints no sizes is compared shoe by shoe instead — size by size would invent a gap.
const skuKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const sizeKey = (z) => String(z ?? '').trim().toUpperCase().replace(/[A-Z]+$/, '').replace(/^US\s*/, '');

export function compareReceiptToList(receiptLines, store) {
  const rows = (receiptLines || []).filter((r) => r && r.sku);
  if (!rows.length || !store) return { bySize: false, diffs: [] };
  const bySize = rows.every((r) => r.size != null && String(r.size).trim() !== '');
  const key = (sku, size) => (bySize ? `${skuKey(sku)}|${sizeKey(size)}` : skuKey(sku));
  const listed = new Map();
  const label = new Map();
  for (const g of store.skus || []) {
    for (const z of g.sizes || []) {
      if (!z.declared) continue;
      const k = key(z.sku, z.size);
      listed.set(k, (listed.get(k) || 0) + z.declared);
      if (!label.has(k)) label.set(k, { sku: z.sku, size: bySize ? z.size : null });
    }
  }
  const onReceipt = new Map();
  for (const r of rows) {
    const k = key(r.sku, r.size);
    onReceipt.set(k, (onReceipt.get(k) || 0) + (Number(r.qty) || 0));
    if (!label.has(k)) label.set(k, { sku: r.sku, size: bySize ? r.size : null });
  }
  const diffs = [];
  for (const k of new Set([...listed.keys(), ...onReceipt.keys()])) {
    const a = listed.get(k) || 0;
    const b = onReceipt.get(k) || 0;
    if (a === b) continue;
    diffs.push({ ...label.get(k), listed: a, receipt: b, diff: b - a });
  }
  diffs.sort((x, y) => String(x.sku).localeCompare(String(y.sku)) || String(x.size || '').localeCompare(String(y.size || ''), undefined, { numeric: true }));
  return { bySize, diffs };
}

// One line a person can read: "the receipt has 2 more DZ5485-612 size 10 than the list".
export function receiptDiffSentence(d) {
  const what = `${d.sku}${d.size ? ` size ${d.size}` : ''}`;
  if (!d.listed) return `on the receipt, not on the list: ${d.receipt} × ${what}`;
  if (!d.receipt) return `on the list, not on the receipt: ${d.listed} × ${what}`;
  return `the receipt has ${Math.abs(d.diff)} ${d.diff > 0 ? 'more' : 'fewer'} ${what} than the list (${d.receipt} vs ${d.listed})`;
}
