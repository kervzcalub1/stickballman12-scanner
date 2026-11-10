// GET /api/items/cost-lookup?q=<SKU or name>  -> { ok, rows, truncated }
//
// The Costs page's "Cost lookup" tab: every purchase line for a shoe, from BOTH ways we
// buy it, as one spreadsheet (docs/context/costs.md → "Cost lookup"):
//   · supplier PO lines — the declared shelf price → landed cost through the supplier's
//     preset, with the SAME code receiving and "Fill costs from POs" use
//     (presetForShipment + landedFromShelf). No preset → cost blank, never the shelf
//     price (owner's rule, 2026-09-30 — costs.md);
//   · online order lines — the actual cost per pair (`orderCosts`: coupon, tax and
//     shipping share, gift card %, cashback %). Cancelled / not-delivered pairs are left
//     out: they cost nothing, and the order's money is already carried by the rest.
// A blank `q` returns the newest lines. Read-only. Same roles as the rest of the page.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listPoCostLines, listOnlineOrdersForCost, presetForShipment } from '../_lib/db.js';
import { landedFromShelf, costOrNull } from '../../src/lib/costs.js';
import { orderCosts, isCancelled, orderCode, orderStage, STAGE_LABEL } from '../../src/lib/onlineOrders.js';
import { codeMatches } from '../../src/lib/costLookup.js';

const PO_STATUS = { draft: 'Draft', shipped: 'Shipped', receiving: 'Receiving', reconciled: 'Reconciled', closed: 'Closed' };
const usd = (n) => `$${Number(n).toFixed(2)}`;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const url = new URL(req.url, 'http://localhost');
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
  // A search is narrow, so it can go deep; the unsearched view is "what we bought lately".
  const poLimit = q ? 1000 : 200;
  const ooLimit = q ? 400 : 100;

  try {
    const [poLines, orders] = await Promise.all([listPoCostLines(q, poLimit), listOnlineOrdersForCost(q, ooLimit)]);

    // One preset per PO — the same (PO, supplier name) question receiving asks.
    const presets = new Map();
    for (const l of poLines) {
      if (presets.has(l.po_id)) continue;
      presets.set(l.po_id, (await presetForShipment({ poId: l.po_id, supplierName: l.supplier_name || '' })).preset);
    }

    const rows = [];
    for (const l of poLines) {
      const preset = presets.get(l.po_id);
      const shelf = costOrNull(l.unit_cost);
      const cost = shelf == null ? null : landedFromShelf(shelf, l.tip, preset, { sku: l.sku, size: l.size });
      rows.push({
        source: 'po',
        ref: l.po_code,
        party: [l.supplier_name, l.store_name].filter(Boolean).join(' · '),
        bought_on: l.bought_on,
        sku: l.sku, name: l.name, size: l.size, gender: l.gender,
        qty: Number(l.qty) || 0,
        paid: shelf,
        cost,
        status: PO_STATUS[l.status] || l.status,
        note: shelf == null ? 'No price on the PO'
          : cost == null ? 'No preset for this supplier — link one to see the landed cost'
            : `${usd(shelf)} shelf through the “${preset?.name || 'supplier'}” preset`,
      });
    }

    for (const o of orders) {
      const all = Array.isArray(o.lines) ? o.lines : [];
      const { lines } = orderCosts(o, all);
      const stage = STAGE_LABEL[orderStage({ ...o, lines: all })] || '';
      for (const l of lines) {
        if (isCancelled(l) || !(Number(l.qty) > 0)) continue;
        if (!codeMatches(q, l.sku, l.name)) continue;
        const p = l.parts || {};
        const bits = [`${usd(p.price)} price`];
        if (p.coupon) bits.push(`− ${usd(p.coupon)} coupon`);
        if (p.tax) bits.push(`+ ${usd(p.tax)} tax`);
        if (p.shipping) bits.push(`+ ${usd(p.shipping)} shipping`);
        if (p.gc) bits.push(`− ${usd(p.gc)} gift card`);
        if (p.cashback) bits.push(`− ${usd(p.cashback)} cashback`);
        rows.push({
          source: 'online',
          ref: orderCode(o.id),
          party: [o.store, o.order_number ? `#${o.order_number}` : ''].filter(Boolean).join(' · '),
          bought_on: o.bought_on,
          sku: l.sku, name: l.name, size: l.size, gender: null,
          qty: Number(l.qty) || 0,
          paid: costOrNull(l.unit_price),
          cost: l.each,
          status: stage,
          note: bits.join(' '),
        });
      }
    }

    rows.sort((a, b) => String(b.bought_on || '').localeCompare(String(a.bought_on || '')));
    return send(res, 200, {
      ok: true,
      rows,
      truncated: poLines.length >= poLimit || orders.length >= ooLimit,
    });
  } catch (e) {
    console.error('[items/cost-lookup]', e.message);
    return send(res, 500, { ok: false, error: 'Could not look up costs.' });
  }
}
