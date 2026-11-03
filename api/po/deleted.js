// GET  /api/po/deleted               -> { ok, rows }        the Deleted POs page (newest first)
// GET  /api/po/deleted?id=N          -> { ok, row }         one archived order, whole snapshot
// GET  /api/po/deleted?id=N&labels=1 -> the order's labels PDF (still in storage)
// POST /api/po/deleted { id, restore: true } -> { ok, poId, poCode }   put it back
// warehouse / ph_team / admin read; ph_team / admin restore. deleted_pos in db-setup.mjs.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listDeletedPos, getDeletedPo, restoreDeletedPo, dbConfigured } from '../_lib/db.js';
import { getObject, r2Configured } from '../_lib/r2.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, req.method === 'POST' ? ['ph_team'] : ['warehouse', 'ph_team']);   // admin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    if (req.method === 'GET') {
      const params = new URL(req.url, 'http://x').searchParams;
      if (!params.get('id')) return send(res, 200, { ok: true, rows: await listDeletedPos() });
      const id = Number(params.get('id'));
      if (!Number.isInteger(id)) return send(res, 400, { ok: false, error: 'A valid id is required.' });
      const row = await getDeletedPo(id);
      if (!row) return send(res, 404, { ok: false, error: 'That deleted order is not in the archive.' });
      if (!params.get('labels')) return send(res, 200, { ok: true, row });
      // The label PDF outlives the order in storage. Proxied like po/label-download: an
      // address and a live barcode are never served by public URL.
      const key = row.po_json?.labels_key || row.recovered?.labels_key;
      if (!key) return send(res, 404, { ok: false, error: 'No labels file was uploaded for this order.' });
      if (!r2Configured()) return send(res, 503, { ok: false, error: 'File storage is not configured.' });
      const bytes = await getObject(key);
      const filename = row.po_json?.labels_name || row.recovered?.labels_name || `${row.po_code}-labels.pdf`;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('Content-Disposition', `attachment; filename="${`${row.po_code} (deleted) - ${filename}`.replace(/[^A-Za-z0-9._() -]/g, '_')}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.end(bytes);
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
    const body = await getJsonBody(req);
    const id = Number(body.id);
    if (!Number.isInteger(id) || body.restore !== true) return send(res, 400, { ok: false, error: 'Send { id, restore: true }.' });
    const r = await restoreDeletedPo(id, user.name || user.username || String(user.uid));
    if (r.error) return send(res, 409, { ok: false, error: r.error });
    console.log(`[po/deleted] ${r.poCode} restored by ${user.username || user.uid} (${user.role})`);
    return send(res, 200, r);
  } catch (e) {
    console.error('[po/deleted]', e.message);
    return send(res, 500, { ok: false, error: 'Could not read the deleted orders.' });
  }
}
