// POST /api/presell-listings/create
//   { activate, inTransit?, transitNote?, expectedOn?, items:[{ sku, size, qty, name?, image?, upc?, alias?:{ price }, stockx?:{ price } }] }
//   -> { ok, lines:[{ sku, size, stockId, alias?:{wanted,created,results}, stockx?:{…} }], created, failed }
// Pre-sell Listings (docs/context/presell-listings.md): `qty` pairs are ADDED to the
// SKU + size stock row, then each ticked platform is listed up to the pairs left.
// Nothing touches inventory or Shopify. Prices are whole US dollars per platform.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, upsertPresellStock } from '../_lib/db.js';
import { topUp } from '../_lib/presell-create.js';
import { aliasListingKey } from '../_lib/alias.js';
import { stockxConfigured } from '../_lib/stockx.js';
import { landedFromShelf } from '../../src/lib/costs.js';

const MAX_PAIRS = 100;
const text = (v, max) => { const t = String(v ?? '').trim().slice(0, max); return t || null; };
const price = (p) => { const n = Number(p?.price); return Number.isFinite(n) && n >= 1 && n <= 100_000 ? Math.round(n) * 100 : NaN; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']); // admin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 })) return send(res, 429, { ok: false, error: 'Please wait a moment before listing again.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const b = await getJsonBody(req);
  const activate = b.activate === true;
  // In transit (presell-arrival.js): these pairs are still on their way; when the warehouse
  // receives the SKU + size, the unsold listings are deleted and the group is told.
  const inTransit = b.inTransit === true;
  const transitNote = inTransit ? text(b.transitNote, 200) : null;
  const expectedOn = inTransit && /^\d{4}-\d{2}-\d{2}$/.test(String(b.expectedOn || '')) ? b.expectedOn : null;
  // Cost (2026-10-10): the supplier preset as used for THIS purchase (maybe edited), applied
  // to each line's shelf price. The server computes the landed cost itself — same formula as
  // everywhere (landedFromShelf) — rather than trusting a number from the browser.
  const pct = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 0; };
  const amt = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : 0; };
  const cs = b.costStack && typeof b.costStack === 'object' ? b.costStack : null;
  const costStack = cs ? {
    preset: text(cs.preset, 60), presetId: Number(cs.presetId) || null, edited: cs.edited === true,
    taxPct: pct(cs.taxPct), giftPct: pct(cs.giftPct), storePct: pct(cs.storePct), promoPct: pct(cs.promoPct),
    cashbackPct: pct(cs.cashbackPct), tipAmt: amt(cs.tipAmt), shippingAmt: amt(cs.shippingAmt),
  } : null;
  const lines = [];
  for (const [i, l] of (Array.isArray(b.items) ? b.items : []).entries()) {
    const sku = text(l?.sku, 60)?.toUpperCase();
    const size = text(l?.size, 20);
    const qty = Number(l?.qty ?? 1);
    const at = `Line ${i + 1}${sku ? ` (${sku}${size ? ` size ${size}` : ''})` : ''}`;
    if (!sku || !size) return send(res, 400, { ok: false, error: `Line ${i + 1} needs a SKU and a size.` });
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) return send(res, 400, { ok: false, error: `${at}: the quantity has to be a whole number from 1 to 50.` });
    const want = {};
    for (const p of ['alias', 'stockx']) {
      if (!l?.[p]) continue;
      const c = price(l[p]);
      if (Number.isNaN(c)) return send(res, 400, { ok: false, error: `${at} needs a ${p === 'alias' ? 'Alias' : 'StockX'} price from $1 to $100,000.` });
      want[p] = c;
    }
    if (!Object.keys(want).length) return send(res, 400, { ok: false, error: `${at}: tick Alias, StockX or both.` });
    const shelf = Number(l?.shelfPrice);
    const shelfPrice = Number.isFinite(shelf) && shelf > 0 && shelf <= 100_000 ? Math.round(shelf * 100) / 100 : null;
    lines.push({ sku, size, qty, want, name: text(l?.name, 200), image: text(l?.image, 500), upc: text(l?.upc, 20),
      shelfPrice, unitCost: shelfPrice != null && costStack ? landedFromShelf(shelfPrice, null, costStack) : null });
  }
  if (!lines.length) return send(res, 400, { ok: false, error: 'Add at least one pair to list.' });
  const pairs = lines.reduce((n, l) => n + l.qty * Object.keys(l.want).length, 0);
  if (pairs > MAX_PAIRS) return send(res, 400, { ok: false, error: `That is ${pairs} listings — at most ${MAX_PAIRS} at a time.` });
  if (lines.some((l) => l.want.alias) && !aliasListingKey()) return send(res, 503, { ok: false, error: 'Alias listing is not configured on the server.' });
  if (lines.some((l) => l.want.stockx) && !stockxConfigured()) return send(res, 503, { ok: false, error: 'StockX is not configured on the server.' });

  const actor = user.name || user.username || null;
  const cache = {};
  const out = [];
  try {
    for (const l of lines) {
      const stock = await upsertPresellStock({ sku: l.sku, size: l.size, name: l.name, image: l.image, upc: l.upc, addQty: l.qty, inTransit, transitNote, expectedOn,
        shelfPrice: l.shelfPrice, unitCost: l.unitCost, costStack: l.shelfPrice != null ? costStack : null }, actor);
      const row = { sku: l.sku, size: l.size, stockId: Number(stock.id) };
      for (const [platform, priceCents] of Object.entries(l.want)) {
        row[platform] = await topUp(stock, platform, { priceCents, active: activate }, actor, cache);
      }
      out.push(row);
    }
  } catch (e) {
    console.error('[presell-listings/create]', e.message);
    return send(res, 500, { ok: false, error: 'Could not finish listing — check the Listings tab for what went through.', lines: out });
  }
  const all = out.flatMap((r) => ['alias', 'stockx'].flatMap((p) => r[p]?.results || []));
  return send(res, 200, { ok: true, lines: out, created: all.filter((x) => x.ok).length, failed: all.filter((x) => !x.ok).length });
}
