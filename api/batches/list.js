// GET /api/batches/list?kind=…&q=…&page=N&excludeOpen=1
//   ->  { ok, batches, total, page, pageSize }
// Recent receiving batches with item counts/totals.
//
// `q` searches instead of listing — by the tracking number on the parcel (batch-level or
// any box's), or the batch code. That runs in SQL across every batch rather than
// filtering this window, because the box in someone's hand is as likely to be from March
// as from this week (see searchBatches).
//
// PH READS THIS TOO (2026-08-27). They price what the warehouse receives, so "which
// batch did this parcel become" is their question as much as the floor's — but
// PH_EXCLUDED_KINDS still holds: in-store buys and existing stock are invisible to them,
// enforced HERE from the session role, never from a query parameter the client sends.
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { listBatches, searchBatches, dbConfigured } from '../_lib/db.js';

// One page of rows. Both lists and the search use it, so "page 2" means the same
// thing everywhere and the client can label a pager without guessing.
const PAGE_SIZE = 25;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const params = new URL(req.url, 'http://x').searchParams;
  const kindParam = params.get('kind');
  const kind = ['rescale', 'receiving', 'instore', 'existing'].includes(kindParam) ? kindParam : null;
  const q = (params.get('q') || '').trim().slice(0, 64);
  const phSafe = user.role === 'ph_team';
  // One page, not "the newest hundred". A batch from March is reachable by paging or by
  // searching for its tracking number — never by scrolling a window that silently ends.
  const page = Math.max(1, Math.min(10_000, Number(params.get('page')) || 1));
  // The Batch page lists open batches in their own card, so it asks for the rest here.
  // Receiving's per-kind list does not — it shows every batch of that kind, open included.
  const excludeOpen = params.get('excludeOpen') === '1';
  const offset = (page - 1) * PAGE_SIZE;
  try {
    const batches = q
      ? await searchBatches(q, { phSafe, limit: PAGE_SIZE, offset })
      : await listBatches(PAGE_SIZE, kind, { phSafe, offset, excludeOpen });
    // The window count rides on every row; an empty page has no row to carry it, which
    // is only true when there is nothing to count (or you paged past the end).
    const total = batches[0]?.total_count ?? 0;
    return send(res, 200, { ok: true, batches, total, page, pageSize: PAGE_SIZE, searched: !!q });
  } catch (e) {
    console.error('[batches/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load batches.' });
  }
}
