// GET /api/po/receipt-file?poId=…&receiptId=…[&download=1]
// (supplier: a receipt they uploaded on their own order / ph_team / admin)
// Streams a store receipt from our bucket — the file never gets a public URL.
import { send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPo, getPoStoreReceipt, dbConfigured } from '../_lib/db.js';
import { getObject, r2Configured } from '../_lib/r2.js';

const TYPE = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'File storage is not configured.' });

  const params = new URL(req.url, 'http://x').searchParams;
  const poId = Number(params.get('poId'));
  const receiptId = Number(params.get('receiptId'));
  if (!Number.isInteger(poId) || !Number.isInteger(receiptId)) return send(res, 400, { ok: false, error: 'Which receipt?' });

  try {
    const po = await getPo(poId);
    const r = await getPoStoreReceipt(receiptId);
    if (!po || !r || Number(r.po_id) !== poId || !r.r2_key) return send(res, 404, { ok: false, error: 'That receipt does not exist.' });
    if (user.role === 'supplier' && !isPrivileged(user.role)
      && (Number(po.supplier_user_id) !== Number(user.uid) || Number(r.uploaded_by_id) !== Number(user.uid)))
      return send(res, 403, { ok: false, error: 'You do not have access to this receipt.' });
    const bytes = await getObject(r.r2_key);
    const ext = String(r.r2_key).split('.').pop().toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', r.content_type || TYPE[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', String(bytes.length));
    const name = (r.name || `${po.po_code}-receipt-${r.id}.${ext}`).replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Disposition', `${params.get('download') ? 'attachment' : 'inline'}; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.end(bytes);
  } catch (e) {
    console.error('[po/receipt-file]', e.message);
    return send(res, 500, { ok: false, error: 'Could not fetch that receipt.' });
  }
}
