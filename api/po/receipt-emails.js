// GET /api/po/receipt-emails?poId=…&total=…  (ph_team / admin)
// Ingested email receipts (api/receipts/ingest-raw) that could be one of this store
// order's receipts: around the order's dates, the closest total first. Staff only — the
// mailboxes are ours. Attached with po/audit `receipt_email`.
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { getPo, listEmailReceiptCandidates, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['ph_team'])) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const params = new URL(req.url, 'http://x').searchParams;
  const poId = Number(params.get('poId'));
  const total = params.get('total') == null || params.get('total') === '' ? null : Number(params.get('total'));
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid order is required.' });
  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    const receipts = await listEmailReceiptCandidates(poId, { total: Number.isFinite(total) ? total : null });
    return send(res, 200, { ok: true, receipts });
  } catch (e) {
    console.error('[po/receipt-emails]', e.message);
    return send(res, 500, { ok: false, error: 'Could not list the email receipts.' });
  }
}
