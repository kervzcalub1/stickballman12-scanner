// GET  /api/admin/merge-suppliers?from=…&to=…  -> { ok, preview }
// POST /api/admin/merge-suppliers { from, to } -> { ok, result }
//
// One person typed two ways ("Erick" and "Erick lujano"). SUPERADMIN ONLY, and in two
// halves on purpose: the preview counts exactly what would move, because nobody should
// confirm an irreversible merge from a name alone.
//
// Names only — batches, purchase orders, and the dropdown. The supplier's login account
// and payout preset are deliberately untouched; the preview reports them so the reader
// knows they exist and are staying put.
import { send, applySecurity, rateLimit, requireSuperadmin, getJsonBody } from '../_lib/util.js';
import { previewSupplierMerge, mergeSuppliers, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireSuperadmin(req, res);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    if (req.method === 'GET') {
      const p = new URL(req.url, 'http://x').searchParams;
      const preview = await previewSupplierMerge(p.get('from'), p.get('to'));
      if (preview.error) return send(res, 400, { ok: false, error: preview.error });
      return send(res, 200, { ok: true, preview });
    }
    if (req.method === 'POST') {
      const body = await getJsonBody(req);
      const result = await mergeSuppliers(body.from, body.to, user.name || user.username);
      if (result.error) return send(res, 400, { ok: false, error: result.error });
      console.log('[merge-suppliers]', user.username, `${result.from} -> ${result.to}`,
        `${result.batches} batches, ${result.pos} POs`);
      return send(res, 200, { ok: true, result });
    }
    return send(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('[merge-suppliers]', e.message);
    return send(res, 500, { ok: false, error: 'The merge could not be completed.' });
  }
}
