// GET  /api/admin/merge-batches?source=…&target=…  -> { ok, preview }
// POST /api/admin/merge-batches { source, target }  -> { ok, result }
//
// Two batches that are really one inbound. SUPERADMIN ONLY, preview-then-apply for the
// same reason as the supplier merge: this moves stock, and it cannot be undone from the
// screen. The preview names every box that would move and says where the loose units land.
//
// The losing batch is emptied, never deleted (`merged_into_batch_id`) — its code is on
// printed labels and in PO history, so a code that stops resolving is a dead end.
import { send, applySecurity, rateLimit, requireSuperadmin, getJsonBody } from '../_lib/util.js';
import { previewBatchMerge, mergeBatches, dbConfigured } from '../_lib/db.js';

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
      const preview = await previewBatchMerge(Number(p.get('source')), Number(p.get('target')));
      if (preview.error) return send(res, 400, { ok: false, error: preview.error });
      return send(res, 200, { ok: true, preview });
    }
    if (req.method === 'POST') {
      const body = await getJsonBody(req);
      const result = await mergeBatches(Number(body.source), Number(body.target), user.name || user.username);
      if (result.error) return send(res, 400, { ok: false, error: result.error });
      console.log('[merge-batches]', user.username, `${result.source} -> ${result.target}`,
        `${result.items} items, ${result.boxes} boxes`);
      return send(res, 200, { ok: true, result });
    }
    return send(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('[merge-batches]', e.message);
    return send(res, 500, { ok: false, error: 'The merge could not be completed.' });
  }
}
