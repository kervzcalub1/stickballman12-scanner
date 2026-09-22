// Receiving against a purchase order, scan-first.
//
// The manifest checklist used to be the INPUT: find the row for the pair in your hand,
// tick it, then scan its sticker — and the next sticker landed on the first ticked row
// in display order, whatever order the hands were working in. With twenty SKUs in a
// box that is a lookup per pair, and the warehouse read it as "scan them in the app's
// order" (Brent, Sept 2026). They found the back door instead: leave, come back through
// the Batch page, and scan in plain rapid mode.
//
// So the scan is the input and the checklist is the scoreboard. These two helpers are
// pure so the matching rule and the box summary can be tested without a browser:
//   • matchManifestRow — which expected row a scanned code belongs to, if any
//   • manifestSummary  — expected / received / missing / extra / off-by per SKU+size

import { compareSizes } from './codes.js';

// A UPC printed with or without its leading zeros is the same barcode: Nike strips
// them, the manifest PDF keeps them, a gun sends whatever the label says.
export const upcKey = (s) => String(s || '').replace(/\D/g, '').replace(/^0+/, '');
export const skuKey = (s) => String(s || '').trim().toUpperCase().replace(/[\s-]/g, '');

const got = (s) => Math.max(0, Number(s?.qty) || 0);
const exp = (s) => (s?.expectedQty == null ? null : Math.max(0, Number(s.expectedQty) || 0));

/**
 * Which manifest row a scanned code belongs to.
 *
 * Only EXPECTED rows are candidates — a row the box was supposed to hold. The order of
 * the rules is the order of certainty:
 *   1. the code is the UPC on one of the size rows → that exact size ("upc")
 *   2. the code is the SKU of an expected shoe:
 *        – exactly one of its sizes is still to pull → that size ("sku")
 *        – several are → the person has to say which ("ambiguous", with the candidates)
 *        – none are → every size is already in → still "ambiguous" over all sizes,
 *          because an extra pair of an expected shoe is a real thing to record
 *   3. nothing → null; the caller resolves it through the catalogue as an unexpected pair
 *
 * `{ item, size, by }` on a hit; `{ item, candidates, by: 'ambiguous' }` when the size
 * has to be chosen; null when the shoe is not on this label at all.
 */
export function matchManifestRow(items, code) {
  const c = String(code || '').trim();
  if (!c) return null;
  const expected = (items || []).filter((it) => it && it.expected && !it.pending);

  const uk = upcKey(c);
  if (uk.length >= 8) {
    for (const item of expected) {
      const size = item.sizes.find((s) => s.upc && upcKey(s.upc) === uk);
      if (size) return { item, size, by: 'upc' };
    }
  }

  const sk = skuKey(c);
  if (!sk) return null;
  const item = expected.find((it) => skuKey(it.sku) === sk);
  if (!item) return null;
  const sorted = [...item.sizes].sort((a, b) => compareSizes(a.size, b.size));
  const open = sorted.filter((s) => exp(s) != null && got(s) < exp(s));
  if (open.length === 1) return { item, size: open[0], by: 'sku' };
  return { item, candidates: open.length ? open : sorted, by: 'ambiguous' };
}

/**
 * The box, once the scanning is done: one line per SKU + size with what was expected,
 * what came out, and the difference — the five answers the warehouse asked for.
 *
 * States, one per row:
 *   ok         expected N, received N
 *   missing    expected N, received 0     (nothing of this size came out)
 *   short      expected N, received < N   (some did)
 *   over       expected N, received > N   (more of an expected size than declared)
 *   unexpected not on the manifest at all (a pair, or a size, the label never declared)
 * Sorted worst first — missing and unexpected are what someone has to act on.
 */
const STATE_ORDER = ['missing', 'unexpected', 'short', 'over', 'ok'];
export function manifestSummary(items) {
  const rows = [];
  for (const it of items || []) {
    if (!it || it.pending) continue;
    for (const s of it.sizes || []) {
      const e = it.expected ? exp(s) : null;
      const g = got(s);
      if (e == null && g === 0) continue;   // an empty unexpected row is nothing
      let state;
      if (e == null || e === 0) state = 'unexpected';
      else if (g === 0) state = 'missing';
      else if (g < e) state = 'short';
      else if (g > e) state = 'over';
      else state = 'ok';
      rows.push({
        // A line the catalogue couldn't resolve has no SKU yet; the code that was
        // scanned is what somebody has to go and look at.
        key: `${it.key}:${s.key}`, sku: it.sku || it.code || '', name: it.name || '', size: String(s.size || ''),
        dimensions: s.dimensions || null,
        expected: e, received: g, delta: e == null ? g : g - e, state,
        // How the count was made. A scan is a pair that was in a hand; a tick claims a
        // whole row in one tap. They produce the same number, so the difference has to
        // travel with the row or it is lost at exactly the moment somebody is deciding
        // whether to believe it (docs/context/purchase-orders.md).
        scanned: Math.min(g, Number(s.scanned) || 0),
        byHand: Math.max(0, g - Math.min(g, Number(s.scanned) || 0)),
      });
    }
  }
  rows.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)
    || a.sku.localeCompare(b.sku) || compareSizes(a.size, b.size));
  // `received` is what came in AGAINST the label — an undeclared pair is `extra`, not a
  // fourth of four. Over-counts on an expected row are likewise capped at the row.
  const t = { expected: 0, received: 0, missing: 0, extra: 0, scanned: 0, byHand: 0, rows: rows.length, clean: true };
  for (const r of rows) {
    t.expected += r.expected || 0;
    if (r.state !== 'unexpected') t.received += Math.min(r.received, r.expected);
    if (r.state === 'missing' || r.state === 'short') t.missing += (r.expected - r.received);
    if (r.state === 'over') t.extra += r.delta;
    if (r.state === 'unexpected') t.extra += r.received;
    if (r.state !== 'ok') t.clean = false;
    t.scanned += r.scanned;
    t.byHand += r.byHand;
  }
  return { rows, totals: t };
}
