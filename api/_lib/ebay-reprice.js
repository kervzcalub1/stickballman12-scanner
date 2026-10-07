// eBay reprice — the market price for one style code + size (docs/context/ebay-reprice.md).
//
// The same answer /api/get-price gives (results[0].resolved: the first PRICE_HIERARCHY
// level with a real price), computed in-process through the STRICT Alias helpers so the
// outcome is always one of:
//   ok          { valueCents, rank, label, name }
//   null_price  the shoe is in the catalogue, nothing priced at this size
//   not_listed  Alias carries no matching style code (an honest catalogue miss)
//   bad_size    the size has no number in it to ask about
//   error       Alias failed / timed out — RETRYABLE, never a verdict on the shoe
// The public endpoint folds "Alias was unhappy" into 404, which is why the skill had to
// retry every 404 ten times; here only `error` needs a retry.
import { aliasCatalogLookupStrict, aliasAvailabilityCentsStrict } from './alias.js';
import { PRICE_HIERARCHY } from './pricing.js';

// One catalogue call per STYLE, not per size — a 12-size listing used to cost 12. Only
// honest answers are cached (a failure throws past the cache), for 30 minutes.
const CATALOG_TTL_MS = 30 * 60_000;
const catalog = new Map();
async function catalogFor(sku) {
  const key = sku.toUpperCase();
  const hit = catalog.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value;
  const value = await aliasCatalogLookupStrict(sku);
  catalog.set(key, { at: Date.now(), value });
  if (catalog.size > 5000) catalog.delete(catalog.keys().next().value);
  return value;
}

export async function priceStyleSize(sku, size) {
  const out = { sku, size };
  if (!/\d/.test(String(size))) return { ...out, status: 'bad_size' };
  try {
    const c = await catalogFor(sku);
    if (!c) return { ...out, status: 'not_listed' };
    out.name = c.name;
    const consigned = await aliasAvailabilityCentsStrict({ catalogId: c.catalogId, size, consigned: true });
    // Rank 1 (consigned GI) answers most sizes in ONE call; the With You call only fires
    // when it is empty — the same 1-or-2-call shape as aliasPriceWithBasis.
    let withYou = null;
    for (const h of PRICE_HIERARCHY) {
      if (!h.consigned && !withYou) withYou = await aliasAvailabilityCentsStrict({ catalogId: c.catalogId, size, consigned: false }) || {};
      const v = (h.consigned ? consigned : withYou)?.[h.field];
      if (v != null) return { ...out, status: 'ok', valueCents: v, rank: h.rank, label: h.label };
    }
    return { ...out, status: 'null_price' };
  } catch (e) {
    const why = e?.name === 'AliasUpstreamError' ? e.message
      : e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'Alias timed out' : `Could not reach Alias (${e?.message || 'network'})`;
    return { ...out, status: 'error', error: why };
  }
}
