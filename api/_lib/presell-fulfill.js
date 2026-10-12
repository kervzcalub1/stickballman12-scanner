// Pre-sell fulfilment — the status sync (docs/context/presell-fulfillment.md).
//
// Every pre-sell sale is read back from its platform until it leaves "to ship": status,
// the UPS label the platform made at the sale, tracking, and the ship-by deadline. READ-ONLY
// on both marketplaces (GETs only), so it's safe on any environment; the worker runs it where
// PRESELL_WATCH=on, and the 📦 Fulfill tab's "↻ Check now" runs it anywhere.
//   · Alias:  GET /api/v1/orders/{id}                       → { order }
//   · StockX: GET /selling/orders/{orderNumber}             → shipment (label, tracking, ship by)
//             GET /selling/orders/{orderNumber}/shipping-document (once) → instruction PDFs
// StockX calls go through the shared rate-limited queue (sxFetch); a 429 ends the pass.
import { presellSalesToTrack, updatePresellSaleShip } from './db.js';
import { aliasGetOrder } from './alias.js';
import { stockxGetOrder, stockxShippingDocument, stockxConfigured } from './stockx.js';
import { orderShipInfo, stockxDocs } from '../../src/lib/presellFulfill.js';

// Each order at most once per this, unless never read (a fresh sale is read on the next pass).
const RECHECK_MS = 10 * 60_000;
const lastRead = new Map();   // sale id → ms
let lastPass = null;          // what the tab shows: { at, read, changed, errors, stoppedBy }
let running = null;

export const fulfillLastPass = () => lastPass;

const live = {
  alias: async (sale) => {
    const r = await aliasGetOrder(sale.order_id);
    if (!r.ok) return { ok: false, status: r.status, error: `Alias answered HTTP ${r.status}` };
    return { ok: true, info: orderShipInfo('alias', r.data?.order || r.data) };
  },
  stockx: async (sale) => {
    if (!stockxConfigured()) return { ok: false, error: 'StockX is not configured.' };
    const r = await stockxGetOrder(sale.order_id);
    if (!r.ok) return { ok: false, status: r.status, error: `StockX answered HTTP ${r.status}` };
    let docs = null;
    // The instruction PDFs, once, while it still has to ship (they don't change).
    if (!sale.has_docs && r.data?.status && orderShipInfo('stockx', r.data).ship_state === 'to_ship') {
      const d = await stockxShippingDocument(sale.order_id);
      if (d.status === 429) return { ok: false, status: 429, error: 'StockX: too many requests' };
      if (d.ok) docs = stockxDocs(d.data);
    }
    return { ok: true, info: orderShipInfo('stockx', r.data, docs) };
  },
};

// One pass. force = re-read everything open now (the button). fetchers = test fakes.
export async function syncFulfillment({ force = false, fetchers = live, now = Date.now } = {}) {
  if (running) return running;   // the button and the worker never overlap
  running = (async () => {
    const out = { at: new Date(now()).toISOString(), read: 0, changed: 0, errors: [], stoppedBy: null };
    const sales = await presellSalesToTrack(400);
    for (const s of sales) {
      if (!force && s.ship_state && now() - (lastRead.get(Number(s.id)) || 0) < RECHECK_MS) continue;
      const f = fetchers[s.platform];
      if (!f) continue;
      let r;
      try { r = await f(s); } catch (e) { r = { ok: false, error: e.message }; }
      lastRead.set(Number(s.id), now());
      if (!r.ok) {
        if (r.status === 429 || /too many|429/i.test(String(r.error || ''))) { out.stoppedBy = `${s.platform} rate limit`; break; }
        out.errors.push({ id: Number(s.id), platform: s.platform, order: s.order_id, error: r.error || 'read failed' });
        continue;
      }
      out.read++;
      if (r.info && (await updatePresellSaleShip(s.id, r.info))) out.changed++;
    }
    out.open = sales.length;
    lastPass = out;
    if (out.errors.length) console.error('[presell-fulfill]', out.errors.length, 'orders could not be read; first:', out.errors[0]);
    return out;
  })();
  try { return await running; } finally { running = null; }
}
