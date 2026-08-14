// POST /api/po/labels-attach  (ph_team / admin)
//   { poId, key, name?, pages?, pageMap?: [{ tracking, page }] }
// Records an uploaded labels PDF against the order and maps its pages to labels. The map
// is keyed on the tracking number READ OFF each page, not page order — see attachPoLabels.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getPo, attachPoLabels, clearPoLabels, dbConfigured } from '../_lib/db.js';
import { deleteObject, r2Configured } from '../_lib/r2.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const key = String(body.key ?? '').trim();
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });
  // Only a key this server minted (po-labels/<code>-<ts>.pdf) — never an arbitrary path.
  if (!/^po-labels\/[A-Za-z0-9._-]+\.pdf$/.test(key)) return send(res, 400, { ok: false, error: 'Invalid file key.' });

  const pageMap = (Array.isArray(body.pageMap) ? body.pageMap : [])
    .slice(0, 500)
    .map((m) => ({ tracking: String(m?.tracking ?? '').slice(0, 60), page: Number(m?.page) }))
    .filter((m) => m.tracking && Number.isInteger(m.page) && m.page > 0);

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    // Replacing an earlier sheet: drop the old object so a superseded label can't be
    // pulled later, and so the bucket doesn't collect every corrected re-upload.
    const previous = po.labels_key && po.labels_key !== key ? await clearPoLabels(poId) : null;

    const r = await attachPoLabels({
      poId, key,
      name: String(body.name ?? '').trim().slice(0, 200) || null,
      pages: Number.isInteger(Number(body.pages)) ? Number(body.pages) : null,
      pageMap,
      uploadedBy: user.name || user.username || null,
    });
    if (previous && r2Configured()) {
      deleteObject(previous).catch((e) => console.warn('[po/labels-attach] old file:', e.message));
    }
    return send(res, 200, { ok: true, ...r });
  } catch (e) {
    console.error('[po/labels-attach]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the labels file.' });
  }
}
