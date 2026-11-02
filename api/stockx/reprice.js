// POST /api/stockx/reprice { listingIds:[…], rule, offset?, minProfit?, allowNoCost? }
//        -> { ok, queued, skipped:[{ listingId, state, why }] }
// POST /api/stockx/reprice { cancel: true }   -> { ok, cancelled }   stop what's still queued
// GET  /api/stockx/reprice                    -> { ok, edits, queue } the log, newest first
//
// The SERVER works out every price itself from the last pull (src/lib/stockxReprice.js — the
// same rules the screen previews): what the browser sends is which listings and which rule,
// never a price. Locked, Pre-sell, already-low, no-cost and under-the-floor listings are
// skipped with the reason. Accepted changes are QUEUED; stockx-reprice-worker.js sends them
// at StockX's pace, so a run survives a closed tab or a restart. PH + admin.
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured, listStockxListings, queueStockxEdits, recentStockxEdits, stockxQueueSummary, cancelQueuedStockxEdits } from '../_lib/db.js';
import { planListing, ruleLabel, RULES } from '../../src/lib/stockxReprice.js';

const MAX = 3000;

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);   // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const by = user.name || user.username || '';
  try {
    if (req.method === 'GET') return send(res, 200, { ok: true, edits: await recentStockxEdits(), queue: await stockxQueueSummary() });
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
    const b = await getJsonBody(req);
    if (b.cancel) return send(res, 200, { ok: true, cancelled: await cancelQueuedStockxEdits(by) });

    const ids = [...new Set((Array.isArray(b.listingIds) ? b.listingIds : []).map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (!ids.length) return send(res, 400, { ok: false, error: 'Which listings?' });
    if (ids.length > MAX) return send(res, 400, { ok: false, error: `At most ${MAX} at a time.` });
    const rule = RULES.some(([k]) => k === b.rule) ? b.rule : 'standard';
    const opts = {
      rule,
      offset: Math.max(0, Math.min(500, Math.round(Number(b.offset) || 0))),
      minProfit: Number.isFinite(Number(b.minProfit)) ? Math.max(0, Math.min(500, Number(b.minProfit))) : 5,
      allowNoCost: b.allowNoCost === true,
    };
    const rows = await listStockxListings(ids);
    const byId = new Map(rows.map((r) => [String(r.listing_id), r]));
    const skipped = [];
    const edits = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) { skipped.push({ listingId: id, state: 'unknown', why: 'Not in the last pull — pull again.' }); continue; }
      if (['queued', 'sent'].includes(r.last_status)) { skipped.push({ listingId: id, state: 'busy', why: 'A price change is already on its way for this listing.' }); continue; }
      const p = planListing(r, opts);
      if (p.state !== 'change' && p.state !== 'floored') { skipped.push({ listingId: id, state: p.state, why: p.why }); continue; }
      edits.push({ listing_id: id, product_name: r.product_name, style_id: r.style_id, size: r.size, old_amount: r.amount,
        new_amount: p.price, standard_lowest: r.standard_lowest, direct_lowest: r.direct_lowest,
        rule: `${ruleLabel(rule, opts.offset)}${p.state === 'floored' ? ` (floor $${p.floor})` : ''} · min profit $${opts.minProfit}` });
    }
    const queued = await queueStockxEdits(edits, by);
    return send(res, 200, { ok: true, queued: queued.length, skipped });
  } catch (e) {
    console.error('[stockx/reprice]', e.message);
    return send(res, 500, { ok: false, error: 'Could not queue the price changes.' });
  }
}
