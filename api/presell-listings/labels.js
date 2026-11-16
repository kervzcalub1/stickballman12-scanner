// POST /api/presell-listings/labels { platform: 'alias' | 'stockx', ids: [presell_sales.id …], with?: 'instructions' }
//      with: 'instructions' (StockX only) = StockX's shipping-instructions sheet + the label, per order.
//      -> ONE PDF: those orders' shipping labels, in the order given (the pick list's order).
//         Headers: X-Labels-Included (count), X-Labels-Missing (URI-encoded JSON
//         [{ order_id, reason }] — the ones that could not go in).
// Pre-sell fulfilment (docs/context/presell-fulfillment.md → "Labels by platform"). One file
// per PLATFORM on purpose: Alias and StockX parcels are packed and handed over separately.
// The label links are read from our own rows — the request only names which orders.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, presellSalesForLabels, markPresellSalesProgress } from '../_lib/db.js';
import { mergeLabels, LABELS_MAX } from '../_lib/presell-labels.js';

const PLATFORMS = new Set(['alias', 'stockx']);
const estYmd = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);   // admin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 12 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  try {
    const b = await getJsonBody(req);
    const platform = String(b.platform || '').toLowerCase();
    if (!PLATFORMS.has(platform)) return send(res, 400, { ok: false, error: 'Pick a platform: Alias or StockX.' });
    const withDoc = b.with === 'instructions' ? 'instructions' : 'label';
    if (withDoc === 'instructions' && platform !== 'stockx') return send(res, 400, { ok: false, error: 'Only StockX has shipping instructions.' });
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return send(res, 400, { ok: false, error: 'No orders were sent.' });
    if (ids.length > LABELS_MAX) return send(res, 400, { ok: false, error: `Too many orders at once (${ids.length}). Download at most ${LABELS_MAX} labels at a time — search or filter first.` });

    const rows = await presellSalesForLabels(ids, platform);
    // The caller's order (the pick list's), not the database's.
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const sales = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!sales.length) return send(res, 404, { ok: false, error: 'None of those orders were found on that platform.' });

    const { bytes, included, missing } = await mergeLabels(sales, { with: withDoc });
    if (!bytes) {
      return send(res, 502, { ok: false, error: `No label could be downloaded${missing[0] ? ` (${missing[0].reason})` : ''}. Press “Check status now”, then try again.`, missing });
    }
    // The orders in this file count as "label printed" (who, when) — the first time only.
    // Best-effort: the PDF still goes out if the stamp fails.
    const got = new Set(included.map(String));
    await markPresellSalesProgress(sales.filter((s) => got.has(String(s.order_id))).map((s) => s.id), 'printed', true, user.name || user.username || null)
      .catch((e) => console.error('[presell-listings/labels] printed stamp:', e.message));
    const name = `presell-${withDoc === 'instructions' ? 'instructions-labels' : 'labels'}-${platform}_${estYmd()}.pdf`;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('X-Labels-Included', String(included.length));
    res.setHeader('X-Labels-Missing', encodeURIComponent(JSON.stringify(missing.slice(0, 60))));
    // Buyers' addresses and live UPS barcodes — never let a shared cache hold on to one.
    res.setHeader('Cache-Control', 'private, no-store');
    return res.end(bytes);
  } catch (e) {
    console.error('[presell-listings/labels]', e.message);
    return send(res, 500, { ok: false, error: 'Could not build the labels PDF.' });
  }
}
