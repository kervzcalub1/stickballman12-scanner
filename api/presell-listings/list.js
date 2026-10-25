// GET /api/presell-listings/list?tab=stock|listings|sales|pos|boxgrid&view=&platform=&q=&stock=&from=&to=
//   tab=boxgrid&po=&sku=  → the 📦 Box contents grid for one SKU on one PO
//   (docs/presell-box-tracking-plan.md)
// from / to = YYYY-MM-DD (EST): Stock by the day first listed, Listings by the day created,
// Sales by the day sold.
// Pre-sell Listings (docs/context/presell-listings.md) — the three read views.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listPresellStock, listPresellListings, listPresellSales, presellPoOptions, presellPoStatus,
  presellBoxesFor, presellPoBoxGrid } from '../_lib/db.js';

const VIEWS = new Set(['all', 'live', 'off', 'pending', 'sold', 'deleted', 'failed']);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const p = new URL(req.url, 'http://x').searchParams;
  const q = String(p.get('q') || '').trim().slice(0, 80) || null;
  const day = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(String(p.get(k) || '')) ? p.get(k) : null);
  const from = day('from'); const to = day('to');
  try {
    const tab = p.get('tab');
    if (tab === 'stock') {
      // Each row against its order (store-orders-plan §4.9): listed vs what it lists, at risk.
      const rows = await listPresellStock({ q, from, to });
      const st = new Map((await presellPoStatus(rows.map((r) => r.po_id).filter(Boolean)))
        .filter((x) => x.current).map((x) => [x.stock_id, x]));
      // What's in each box (one of our labels), from the PO — docs/presell-box-tracking-plan.md.
      const boxes = await presellBoxesFor(rows);
      return send(res, 200, { ok: true, rows: rows.map((r) => {
        const x = st.get(Number(r.id));
        const bx = boxes.get(Number(r.id));
        const b = { boxes: bx?.boxes || [], box_pos: bx?.pos || [] };
        return x ? { ...r, ...b, po_listed: x.listed_all, po_expected: x.expected, over_cap: x.over_cap,
          po_sold: x.sold, po_received: x.received, po_landed: x.landed, at_risk: x.at_risk, arrived_any: x.arrived_any } : { ...r, ...b };
      }) });
    }
    if (tab === 'boxgrid') {
      const poId = Number(p.get('po'));
      const sku = String(p.get('sku') || '').trim().slice(0, 80);
      if (!(poId > 0) || !sku) return send(res, 400, { ok: false, error: 'Which order and shoe?' });
      const grid = await presellPoBoxGrid(poId, sku);
      if (!grid) return send(res, 404, { ok: false, error: 'That purchase order no longer exists.' });
      return send(res, 200, { ok: true, ...grid });
    }
    // A date range is a report: every sale in it, not just the latest 300.
    if (tab === 'sales') return send(res, 200, { ok: true, rows: await listPresellSales({ from, to, limit: from || to ? 5000 : 300 }) });
    if (tab === 'pos') return send(res, 200, { ok: true, pos: await presellPoOptions() });
    const platform = ['alias', 'stockx'].includes(p.get('platform')) ? p.get('platform') : null;
    const stockId = Number(p.get('stock')) > 0 ? Number(p.get('stock')) : null;
    const out = await listPresellListings({ view: VIEWS.has(p.get('view')) ? p.get('view') : 'all', platform, q, stockId, from, to, limit: from || to ? 5000 : 1000 });
    return send(res, 200, { ok: true, ...out });
  } catch (e) {
    console.error('[presell-listings/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the pre-sell listings.' });
  }
}
