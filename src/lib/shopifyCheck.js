// "What does Shopify hold for this shoe?" — Inventory's Check Shopify button
// (docs/context/inventory.md). Pure: shapes the live variants shopifyLiveForStyle reads.
//
// Shopify, not our SH tick, is the answer: Nikki lists to II, II lists to Shopify, and
// Shopify lists to every other platform. Our own records are connected but not kept in
// step with it (II owns that sync), so this shows Shopify's numbers and nothing of ours.

// Sizes match on the label with spaces, case and a leading "US" taken out — "9 W" is
// "9W" — and nothing looser: "7.5" and "7.5W" are different shoes.
export const sizeKey = (v) => String(v ?? '').trim().replace(/^us\s*/i, '').replace(/\s+/g, '').toLowerCase();

const sizeNum = (s) => { const m = String(s).match(/[\d.]+/); return m ? parseFloat(m[0]) : Infinity; };

/**
 * @param variants [{ productId, productTitle, status, url?, size, qty, price }]
 * @returns [{ title, status, url, total, sizes: [{ size, qty, price }] }] — one per Shopify
 *          product, sizes in shoe order. qty is Shopify's own number (negatives = oversold).
 */
export function shopifyHoldings(variants = []) {
  const by = new Map();
  for (const v of variants) {
    const k = v.productId || v.productTitle;
    if (!by.has(k)) by.set(k, { title: v.productTitle, status: v.status, url: v.url || null, total: 0, sizes: [] });
    const p = by.get(k);
    const qty = v.qty == null ? null : Number(v.qty);
    p.sizes.push({ size: v.size || '?', qty, price: v.price ?? null });
    if (qty > 0) p.total += qty;
  }
  const out = [...by.values()];
  for (const p of out) p.sizes.sort((a, b) => sizeNum(a.size) - sizeNum(b.size) || a.size.localeCompare(b.size));
  // The product actually selling first; archived copies after.
  return out.sort((a, b) => (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1) || b.total - a.total);
}
