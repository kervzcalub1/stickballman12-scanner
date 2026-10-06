// GET /api/receipts/list?buyer=<id|none>&store=&state=&from=YYYY-MM-DD&to=&q=  -> { ok, rows, byBuyer, stores, states }
// GET /api/receipts/list?id=<id>                                             -> { ok, receipt }  (one, in full)
// The Receipts page (docs/context/receipts.md). Staff only: a receipt is money and an
// address — suppliers register their purchase emails but don't browse the mailbox.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listEmailReceipts, getEmailReceipt } from '../_lib/db.js';

const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const p = new URL(req.url, 'http://x').searchParams;
  try {
    if (p.get('id')) {
      const id = Number(p.get('id'));
      if (!Number.isSafeInteger(id) || id <= 0) return send(res, 400, { ok: false, error: 'Which receipt?' });
      const receipt = await getEmailReceipt(id);
      if (!receipt) return send(res, 404, { ok: false, error: 'That receipt no longer exists.' });
      return send(res, 200, { ok: true, receipt });
    }
    const buyerRaw = String(p.get('buyer') || '');
    const buyer = buyerRaw === 'none' ? 'none' : (Number.isSafeInteger(Number(buyerRaw)) && Number(buyerRaw) > 0 ? Number(buyerRaw) : null);
    const out = await listEmailReceipts({
      buyer, store: String(p.get('store') || '').trim().slice(0, 40) || null,
      state: String(p.get('state') || '').trim().slice(0, 20) || null,
      from: ymd(p.get('from')), to: ymd(p.get('to')), q: String(p.get('q') || '').trim().slice(0, 80) || null,
    });
    return send(res, 200, { ok: true, ...out });
  } catch (e) {
    console.error('[receipts/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load receipts.' });
  }
}
