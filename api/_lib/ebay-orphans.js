// eBay listings no longer in Shopify (docs/context/ebay-listings.md → "Not in Shopify").
//
// DPL (Shopify → eBay) keys every eBay size on its Custom label = the Shopify variant SKU,
// which our system generates. So an eBay size whose SKU no Shopify variant has is ORPHANED:
// a sale there deducts nothing anywhere — an oversell waiting to happen (owner, 2026-10-10:
// "I wanna get rid of them"). The verdict says what most likely happened in Shopify:
//   deleted               the style isn't in Shopify at all (deleted, or sold out and removed)
//   size_removed          the style is there, this size isn't
//   recreated_on_ebay     the same style + size exists under a NEW SKU, and that one is on eBay
//                         too — the old listing is a duplicate
//   recreated_not_synced  … under a new SKU that is NOT on eBay — the new one never synced
//   no_style              the eBay title has no style code to search by
//   no_sku                eBay gave this size NO Custom label — nothing to look up, so it is
//                         NOT judged (in_shopify null): never offered for ending. A whole
//                         listing with no sizes and no SKU is how a missed variation read
//                         looks (2026-11-04: 25 multi-size listings were shown as "1 size ·
//                         SKU —  · Size removed", and End would have ended every size).
import { styleFromTitle } from './shopify.js';

const norm = (s) => String(s || '').trim().toUpperCase();
const digits = (s) => String(s || '').replace(/[^0-9.]/g, '');

export const VERDICT_LABEL = {
  deleted: 'Product deleted in Shopify',
  size_removed: 'Size removed in Shopify',
  recreated_on_ebay: 'Re-created in Shopify — the new one is on eBay too (duplicate)',
  recreated_not_synced: 'Re-created in Shopify — the new one is NOT on eBay yet',
  no_style: 'Not in Shopify — no style code in the title to say more',
  no_sku: 'No Custom label (SKU) on eBay — can’t be checked in Shopify',
};

// ebayRows: ebay_listings rows · variants: shopifyAllVariants().variants
export function shopifyVerdicts(ebayRows, variants) {
  const shopSkus = new Set(variants.map((v) => norm(v.sku)).filter(Boolean));
  const ebaySkus = new Set(ebayRows.map((e) => norm(e.sku)).filter(Boolean));
  const byStyleSize = new Map();
  const styles = new Set();
  for (const v of variants) {
    const st = norm(v.style);
    if (!st) continue;
    styles.add(st);
    const k = `${st}|${digits(v.size)}`;
    if (!byStyleSize.has(k)) byStyleSize.set(k, []);
    byStyleSize.get(k).push(v);
  }
  return ebayRows.map((e) => {
    const base = { item_id: e.item_id, variation_key: e.variation_key };
    if (!e.sku) return { ...base, in_shopify: null, verdict: 'no_sku', new_sku: null };
    if (e.sku && shopSkus.has(norm(e.sku))) return { ...base, in_shopify: true, verdict: null, new_sku: null };
    const st = norm(e.style || styleFromTitle(e.title));
    if (!st) return { ...base, in_shopify: false, verdict: 'no_style', new_sku: null };
    const same = byStyleSize.get(`${st}|${digits(e.size)}`) || [];
    if (same.length) {
      const onEbay = same.some((v) => ebaySkus.has(norm(v.sku)));
      return { ...base, in_shopify: false, verdict: onEbay ? 'recreated_on_ebay' : 'recreated_not_synced', new_sku: same.map((v) => v.sku).join(' / ') };
    }
    return { ...base, in_shopify: false, verdict: styles.has(st) ? 'size_removed' : 'deleted', new_sku: null };
  });
}

// Right before a listing is ended: what eBay holds NOW (`live` = rowsFromItem of a fresh
// GetItem) against the rows the last pull saved. Ending ends EVERY size eBay has, so every
// one of them must be a size we checked and found gone from Shopify. Returns the reason to
// refuse, or null when it may go ahead (the live Shopify re-check of `skus` still follows).
export function liveEndCheck(rows, live) {
  const sz = (r) => (r.size ? `size ${r.size}` : 'a size');
  if (!live?.length) return 'eBay returned no sizes for this listing — not ended.';
  const blank = live.filter((r) => !r.sku);
  if (blank.length) return `eBay has ${blank.map(sz).join(', ')} with no Custom label (SKU) — it can’t be checked in Shopify, so the listing is not ended.`;
  const known = new Map(rows.map((r) => [norm(r.sku), r]));
  const missed = live.filter((r) => !known.has(norm(r.sku)));
  if (missed.length) return `eBay has ${missed.map((r) => `${sz(r)} (${r.sku})`).join(', ')} that the last pull didn’t — pull again; not ended.`;
  const kept = live.filter((r) => known.get(norm(r.sku)).in_shopify !== false);
  if (kept.length) return `${kept.map((r) => `${sz(r)} (${r.sku})`).join(', ')} ${kept.length === 1 ? 'is' : 'are'} still in Shopify — not ended.`;
  return null;
}
