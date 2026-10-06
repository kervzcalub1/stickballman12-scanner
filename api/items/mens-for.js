// GET /api/items/mens-for?sku=GS-CODE -> { ok, mens: { sku, name, image } | null }
// The men's code a Grade School style code was last RECEIVED AS (receiving.md, "GS
// received as men's") — the suggestion Receive New offers on the next box of it.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, lastMensFor } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const sku = String(new URL(req.url, 'http://x').searchParams.get('sku') || '').trim().toUpperCase();
  if (!sku || sku.length > 40) return send(res, 400, { ok: false, error: 'Which style code?' });
  try {
    const r = await lastMensFor(sku);
    return send(res, 200, { ok: true, mens: r ? { sku: r.sku, name: r.name, image: r.image_url } : null });
  } catch (e) {
    console.error('[items/mens-for]', e.message);
    return send(res, 500, { ok: false, error: 'Could not look that up.' });
  }
}
