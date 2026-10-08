// GET /api/items/mens-for?sku=GS-CODE[&name=GS name]
//   -> { ok, mens: { sku, name, image, source: 'history' | 'catalogue' } | null, candidates: [...] }
// The men's code for a Grade School style code (receiving.md, "GS received as men's"):
//   1. what it was last RECEIVED AS here — a person already confirmed that one;
//   2. else FOUND in the Alias catalogue: the men's product with the same name minus the kid
//      markers (aliasMensCounterpart). The warehouse can't see the men's code anywhere on a
//      GS box, so asking them to type it stopped the conversion on the first box of a shoe.
// Either way it is only OFFERED — the dialog shows the shoe and a person confirms it.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, lastMensFor } from '../_lib/db.js';
import { aliasMensCounterpart } from '../_lib/alias.js';

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
    if (r) return send(res, 200, { ok: true, mens: { sku: r.sku, name: r.name, image: r.image_url, source: 'history' }, candidates: [] });
    const name = String(new URL(req.url, 'http://x').searchParams.get('name') || '').trim().slice(0, 200);
    // A catalogue that is slow or down is "no suggestion", never an error: typing the code
    // still works exactly as before.
    const found = await aliasMensCounterpart(sku, name).catch(() => ({ best: null, candidates: [] }));
    return send(res, 200, {
      ok: true,
      mens: found.best ? { ...found.best, source: 'catalogue' } : null,
      candidates: found.candidates,
    });
  } catch (e) {
    console.error('[items/mens-for]', e.message);
    return send(res, 500, { ok: false, error: 'Could not look that up.' });
  }
}
