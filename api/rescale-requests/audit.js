// POST /api/rescale-requests/audit { id, actualSizes:[{size,qty,vins?}], note? } -> { ok }
// Warehouse records the ACTUAL qty per size counted on the shelf and closes the
// request. Both roles then see reported-vs-actual.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { auditRescaleRequest, dbConfigured } from '../_lib/db.js';
import { VIN_RE } from '../_lib/vins.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const id = Number(body.id) || 0;
  if (!id) return send(res, 400, { ok: false, error: 'Missing request id.' });

  // Sanitize actual counts: [{ size, qty, vins? }] — qty 0 is allowed (none on shelf).
  //
  // `vins` is WHICH pairs were scanned for that size, when the count was made by
  // scanning rather than typing (docs/context/rescale.md). It is evidence, not the
  // count: `qty` still decides, because a row can be corrected by hand afterwards and a
  // pair with no readable sticker is typed in with no VIN at all. Kept deduped and
  // capped so a stuck gun can't write a megabyte of JSONB.
  const actualSizes = (Array.isArray(body.actualSizes) ? body.actualSizes : [])
    .map((s) => {
      const vins = [...new Set((Array.isArray(s.vins) ? s.vins : [])
        .map((v) => String(v ?? '').trim().toUpperCase())
        .filter((v) => VIN_RE.test(v)))].slice(0, 500);
      const row = {
        size: String(s.size ?? '').trim().slice(0, 24),
        qty: Math.max(0, Math.min(9999, Number(s.qty) || 0)),
      };
      // Omitted when empty, rather than written as []. A typed count then stores exactly
      // what it always stored, so nothing that reads `actual_sizes` — the compare grid,
      // the PH listing seed, the advisor — sees a shape it has not seen before.
      return vins.length ? { ...row, vins } : row;
    })
    .filter((s) => s.size)
    .slice(0, 100);
  if (!actualSizes.length) return send(res, 400, { ok: false, error: 'Enter the actual count for at least one size.' });

  const note = String(body.note || '').trim().slice(0, 2000) || null;

  try {
    const ok = await auditRescaleRequest(id, actualSizes, note, user.name || user.username || '');
    if (!ok) return send(res, 404, { ok: false, error: 'Request not found or already audited.' });
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('[rescale-requests/audit]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the audit.' });
  }
}
