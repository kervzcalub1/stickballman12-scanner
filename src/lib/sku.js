// Style codes on a SKU string.
//
// A re-released shoe is sold under more than one code and the app carries them all in
// one slash-joined string ("315122-111/CW2288-111") — see `skuCodes` in
// `api/_lib/util.js`, the server-side twin of this file, and `docs/context/receiving.md`.
// This is the client's copy: same separators, same de-duplication, so the two halves
// can never disagree about what a code boundary is.

export function skuCodes(raw) {
  const seen = new Set();
  return String(raw || '').split(/[/,|]/)
    .map((c) => c.trim().replace(/\s+/g, '-'))
    .filter((c) => {
      if (!c) return false;
      const k = c.toUpperCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

export const joinSkuCodes = (codes) => (codes || []).join('/');

// Do these two SKU strings name any of the same shoe? Overlap, not equality: a request
// raised against ONE code of a dual-code shoe is still a request against the row that
// carries both, and comparing the strings would say they were unrelated.
export function skuCodesOverlap(a, b) {
  const A = new Set(skuCodes(a).map((c) => c.toUpperCase()));
  return skuCodes(b).some((c) => A.has(c.toUpperCase()));
}
