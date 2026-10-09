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
import { styleFromTitle } from './shopify.js';

const norm = (s) => String(s || '').trim().toUpperCase();
const digits = (s) => String(s || '').replace(/[^0-9.]/g, '');

export const VERDICT_LABEL = {
  deleted: 'Product deleted in Shopify',
  size_removed: 'Size removed in Shopify',
  recreated_on_ebay: 'Re-created in Shopify — the new one is on eBay too (duplicate)',
  recreated_not_synced: 'Re-created in Shopify — the new one is NOT on eBay yet',
  no_style: 'Not in Shopify — no style code in the title to say more',
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
