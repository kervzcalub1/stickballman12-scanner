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
